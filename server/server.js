'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const HTML = path.join(__dirname, '..', 'index.html');
const ALLOWED_ORIGIN = process.env.FRONTEND_ORIGIN || '*';

function setApiHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

const waiting = new Map(); // playerId -> { ws, peerId, name, joinedAt }
const clients = new Set();
const matches = new Map();
let nextBackgroundIndex = 0;

function send(ws, payload) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function turnServers() {
  const urls = String(process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!urls.length || !process.env.TURN_USERNAME || !process.env.TURN_CREDENTIAL) return [];
  return [{ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL }];
}

function removeWaiting(ws) {
  for (const [playerId, item] of waiting) {
    if (item.ws === ws) waiting.delete(playerId);
  }
}

function tryMatch() {
  // Do not copy/shuffle the entire queue. With thousands of waiting users that
  // turns every arrival into O(n) work. The Map keeps insertion order, so the
  // first two live entries can be paired immediately.
  let first=null, second=null;
  const now=Date.now();
  for (const [id,item] of waiting) {
    if (!item.peerId || !item.ws || item.ws.readyState !== 1 || now-item.joinedAt>15000) { waiting.delete(id); continue; }
    if (!first) { first=[id,item]; continue; }
    second=[id,item]; break;
  }
  if (!first || !second) return;

  const [aId,a]=first, [bId,b]=second;
  waiting.delete(aId);
  waiting.delete(bId);

  const matchId = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const backgroundIndex = nextBackgroundIndex++ % 4;
  matches.set(matchId, {
    aId, bId, aWs:a.ws, bWs:b.ws, ready:new Set(), createdAt:Date.now(),
    backgroundIndex
  });
  send(a.ws, { type: 'matched', matchId, role: 'host', peerId: b.peerId, backgroundIndex });
  send(b.ws, { type: 'matched', matchId, role: 'client', peerId: a.peerId, backgroundIndex });
}

function removeMatchesForWs(ws, notifyPeer=false) {
  for (const [matchId, match] of matches) {
    if (match.aWs !== ws && match.bWs !== ws) continue;
    matches.delete(matchId);
    if (notifyPeer) {
      const peerWs = match.aWs === ws ? match.bWs : match.aWs;
      send(peerWs, { type:'rematch', matchId, reason:'Opponent disconnected before the match was established.' });
    }
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    setApiHeaders(res);
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, waiting: waiting.size, clients: clients.size }));
  }

  if (url.pathname === '/api/turn-credentials') {
    setApiHeaders(res);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        ...turnServers()
      ]
    }));
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.createReadStream(HTML).on('error', () => {
      res.writeHead(500); res.end('Could not load Spinit');
    }).pipe(res);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws/match') return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', ws => {
  clients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'join') {
      const playerId = String(msg.playerId || '');
      const peerId = String(msg.peerId || '');
      if (!playerId || !peerId) return; // never match until the PeerJS id exists

      // A stale second tab for the same player should not create duplicate queue entries.
      const old = waiting.get(playerId);
      if (old && old.ws !== ws) {
        try { old.ws.close(4001, 'Replaced by a newer session'); } catch {}
        removeWaiting(old.ws);
      }
      waiting.set(playerId, { ws, peerId, name: String(msg.name || 'Player').slice(0, 40), joinedAt: Date.now() });
      tryMatch();
    }
    if (msg.type === 'p2pReady') {
      const match = matches.get(String(msg.matchId || ''));
      const playerId = String(msg.playerId || '');
      if (!match || (match.aWs !== ws && match.bWs !== ws)) return;
      if (playerId !== match.aId && playerId !== match.bId) return;
      match.ready.add(playerId);
      if (match.ready.has(match.aId) && match.ready.has(match.bId)) matches.delete(String(msg.matchId));
    }
    if (msg.type === 'leave') {
      removeWaiting(ws);
      removeMatchesForWs(ws, true);
    }
  });

  ws.on('close', () => { removeWaiting(ws); removeMatchesForWs(ws, true); clients.delete(ws); });
  ws.on('error', () => { removeWaiting(ws); removeMatchesForWs(ws, true); clients.delete(ws); });
});

const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const [matchId, match] of matches) {
    /* If PeerJS never establishes within 8s, release both users instead of
       leaving one of them stranded after a stale/raced connection attempt. */
    if (now - match.createdAt > 8000 && match.ready.size < 2) {
      matches.delete(matchId);
      send(match.aWs, {type:'rematch', matchId, reason:'Connection timed out — finding a new player.'});
      send(match.bWs, {type:'rematch', matchId, reason:'Connection timed out — finding a new player.'});
    }
  }
  for (const ws of clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

server.listen(PORT, () => console.log(`Spinit server listening on :${PORT}`));
process.on('SIGTERM', () => { clearInterval(heartbeat); server.close(() => process.exit(0)); });

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

/* Quick Match is deliberately server-relayed now. This removes the fragile
   PeerJS/WebRTC rendezvous race after Next/Leave. Each waiting user is one
   WebSocket; after pairing, tiny control/chat/game/media packets are relayed
   between exactly two sockets. Private rooms still use PeerJS in the browser. */
const waiting = new Map(); // playerId -> {ws,name,joinedAt}
const matches = new Map(); // matchId -> {aId,bId,aWs,bWs,createdAt,backgroundIndex}
const clients = new Set();
let nextBackgroundIndex = 0;

function send(ws, payload) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(payload)); } catch {}
  }
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

function matchForWs(ws) {
  for (const [matchId, m] of matches) {
    if (m.aWs === ws || m.bWs === ws) return [matchId, m];
  }
  return null;
}

function pairWaiting() {
  const now = Date.now();
  let first = null;
  let second = null;
  for (const [id, item] of waiting) {
    if (!item.ws || item.ws.readyState !== 1 || now - item.joinedAt > 20000) {
      waiting.delete(id);
      continue;
    }
    if (!first) first = [id, item];
    else { second = [id, item]; break; }
  }
  if (!first || !second) return;

  const [aId, a] = first;
  const [bId, b] = second;
  waiting.delete(aId);
  waiting.delete(bId);

  const matchId = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const backgroundIndex = nextBackgroundIndex++ % 4;
  matches.set(matchId, {
    aId, bId, aWs: a.ws, bWs: b.ws,
    createdAt: Date.now(), backgroundIndex
  });

  send(a.ws, { type:'matched', matchId, role:'host', backgroundIndex });
  send(b.ws, { type:'matched', matchId, role:'client', backgroundIndex });
}

function breakMatch(matchId, leavingWs, notify=true) {
  const m = matches.get(matchId);
  if (!m) return;
  matches.delete(matchId);
  if (notify) {
    const other = m.aWs === leavingWs ? m.bWs : m.aWs;
    send(other, { type:'peerLeft', matchId, reason:'Opponent left — finding a new player.' });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') { setApiHeaders(res); res.writeHead(204); return res.end(); }
  if (url.pathname === '/health') {
    res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'});
    return res.end(JSON.stringify({ok:true,waiting:waiting.size,matches:matches.size,clients:clients.size}));
  }
  if (url.pathname === '/api/turn-credentials') {
    setApiHeaders(res);
    res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'});
    return res.end(JSON.stringify({iceServers:[
      {urls:'stun:stun.l.google.com:19302'},
      {urls:'stun:stun.cloudflare.com:3478'},
      ...turnServers()
    ]}));
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.createReadStream(HTML).on('error', () => { res.writeHead(500); res.end('Could not load Spinit'); }).pipe(res);
    return;
  }
  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocketServer({noServer:true, maxPayload: 8 * 1024 * 1024});
server.on('upgrade',(req,socket,head)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(url.pathname!=='/ws/match') return socket.destroy();
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
});

wss.on('connection',ws=>{
  clients.add(ws);
  ws.isAlive=true;
  ws.on('pong',()=>{ws.isAlive=true;});

  ws.on('message',raw=>{
    let msg; try{msg=JSON.parse(raw.toString());}catch{return;}

    if(msg.type==='join'){
      const playerId=String(msg.playerId||'');
      if(!playerId) return;
      /* Replace an older socket for the same browser session. */
      const old=waiting.get(playerId);
      if(old && old.ws!==ws){try{old.ws.close();}catch{} waiting.delete(playerId);}
      /* If this player is still in an old match, release that match first. */
      const oldMatch=matchForWs(ws);
      if(oldMatch) breakMatch(oldMatch[0],ws,true);
      waiting.set(playerId,{ws,name:String(msg.name||'Player').slice(0,40),joinedAt:Date.now()});
      pairWaiting();
      return;
    }

    if(msg.type==='relay'){
      const matchId=String(msg.matchId||'');
      const m=matches.get(matchId);
      if(!m || (m.aWs!==ws && m.bWs!==ws)) return;
      const other=m.aWs===ws?m.bWs:m.aWs;
      send(other,{type:'relay',matchId,packet:msg.packet});
      return;
    }

    if(msg.type==='leave'){
      removeWaiting(ws);
      const hit=matchForWs(ws);
      if(hit) breakMatch(hit[0],ws,true);
      return;
    }
  });

  ws.on('close',()=>{
    removeWaiting(ws);
    const hit=matchForWs(ws);
    if(hit) breakMatch(hit[0],ws,true);
    clients.delete(ws);
  });
  ws.on('error',()=>{
    removeWaiting(ws);
    const hit=matchForWs(ws);
    if(hit) breakMatch(hit[0],ws,true);
    clients.delete(ws);
  });
});

const heartbeat=setInterval(()=>{
  const now=Date.now();
  for(const [id,item] of waiting){
    if(!item.ws || item.ws.readyState!==1 || now-item.joinedAt>20000) waiting.delete(id);
  }
  for(const [matchId,m] of matches){
    if(!m.aWs || !m.bWs || m.aWs.readyState!==1 || m.bWs.readyState!==1){
      breakMatch(matchId,m.aWs,false);
    }
  }
  for(const ws of clients){
    if(ws.isAlive===false){try{ws.terminate();}catch{} continue;}
    ws.isAlive=false;try{ws.ping();}catch{}
  }
},10000);

server.listen(PORT,()=>console.log(`Spinit server listening on :${PORT}`));
process.on('SIGTERM',()=>{clearInterval(heartbeat);server.close(()=>process.exit(0));});

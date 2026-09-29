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
const MAX_WAITING = 5000;
const MAX_MATCH_AGE_MS = 6 * 60 * 60 * 1000;

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
  const valid = [];
  for (const [id, item] of waiting) {
    if (!item.ws || item.ws.readyState !== 1 || now - item.joinedAt > 20000) {
      waiting.delete(id);
      continue;
    }
    valid.push([id, item]);
  }

  // Pair every currently-ready pair in one pass. This keeps large bursts of
  // simultaneous users from depending on individual join timing.
  for (let i = 0; i + 1 < valid.length; i += 2) {
    const [aId, a] = valid[i];
    const [bId, b] = valid[i + 1];
    if (!waiting.has(aId) || !waiting.has(bId)) continue;
    waiting.delete(aId);
    waiting.delete(bId);

    const matchId = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    const backgroundIndex = nextBackgroundIndex++ % 4;
    matches.set(matchId, {
      aId, bId, aWs: a.ws, bWs: b.ws, aName:a.name, bName:b.name,
      matchId, createdAt: Date.now(), backgroundIndex
    });

    send(a.ws, { type:'matched', matchId, role:'host', backgroundIndex });
    send(b.ws, { type:'matched', matchId, role:'client', backgroundIndex });
  }
}


const LUDO_TRACK=52;
const LUDO_TURN_MS=15000;
const LUDO_START={red:0,green:13};
const LUDO_SAFE=[0,8,13,21,26,34,39,47];
function ludoColor(m,id){return id===m.aId?'red':'green';}
function createLudo(m){
  const players=[m.aId,m.bId];
  const names={[m.aId]:m.aName||'Player 1',[m.bId]:m.bName||'Player 2'};
  const colors={[m.aId]:'red',[m.bId]:'green'};
  const starts={[m.aId]:LUDO_START.red,[m.bId]:LUDO_START.green};
  const pawns={[m.aId]:[-1,-1],[m.bId]:[-1,-1]};
  return {players,names,colors,starts,pawns,turn:m.aId,phase:'roll',rolled:null,validMoves:[],winner:null,safe:LUDO_SAFE.slice(),deadline:Date.now()+LUDO_TURN_MS};
}
function ludoGlobal(m,id,step){return (m.ludo.starts[id]+step)%LUDO_TRACK;}
function ludoValidMoves(m,id,roll){
  const p=m.ludo.pawns[id]||[]; const out=[];
  p.forEach((step,i)=>{if(step>=57)return;if(step===-1){if(roll===6)out.push(i);return;}if(step+roll<=57)out.push(i);});
  return out;
}
function sendLudoState(m){if(!m||!m.ludo)return;const payload={type:'ludoState',matchId:m.matchId,state:m.ludo,backgroundIndex:m.backgroundIndex};send(m.aWs,payload);send(m.bWs,payload);}
function ludoNextTurn(m){const ids=m.ludo.players,idx=ids.indexOf(m.ludo.turn);m.ludo.turn=ids[(idx+1)%ids.length];m.ludo.phase='roll';m.ludo.rolled=null;m.ludo.validMoves=[];m.ludo.deadline=Date.now()+LUDO_TURN_MS;}
function ludoApplyMove(m,playerId,pawnIndex){
  const l=m.ludo;if(l.turn!==playerId||l.phase!=='move')return false;
  const i=Number(pawnIndex),valid=l.validMoves||[];if(!Number.isInteger(i)||!valid.includes(i))return false;
  const pawns=l.pawns[playerId],old=pawns[i];const step=old===-1?0:old+l.rolled;pawns[i]=step;
  if(step<52){const global=ludoGlobal(m,playerId,step);if(!l.safe.includes(global)){const other=l.players.find(id=>id!==playerId);(l.pawns[other]||[]).forEach((os,j)=>{if(os>=0&&os<52&&ludoGlobal(m,other,os)===global)l.pawns[other][j]=-1;});}}
  if(pawns.every(x=>x>=57)){l.winner=playerId;l.phase='done';l.deadline=0;return true;}
  if(l.rolled===6){l.phase='roll';l.validMoves=[];l.rolled=null;l.deadline=Date.now()+LUDO_TURN_MS;}else ludoNextTurn(m);
  return true;
}
function ludoHandleAction(m,playerId,action,payload){
  if(!m.ludo&&action!=='start')return {ok:false,message:'Start Ludo first'};
  if(action==='start'){if(!m.ludo||m.ludo.winner)m.ludo=createLudo(m);sendLudoState(m);return {ok:true};}
  const l=m.ludo;if(l.winner)return {ok:false,message:'Game is over'};if(!l.players.includes(playerId))return {ok:false,message:'Not a player'};
  if(action==='stop'){m.ludo=null;return {ok:true,stopped:true};}
  if(action==='roll'){if(l.turn!==playerId||l.phase!=='roll')return {ok:false,message:'Not your turn'};const roll=1+Math.floor(Math.random()*6);l.rolled=roll;l.validMoves=ludoValidMoves(m,playerId,roll);l.deadline=Date.now()+LUDO_TURN_MS;if(!l.validMoves.length){l.rolled=null;if(roll===6){l.phase='roll';l.deadline=Date.now()+LUDO_TURN_MS;}else ludoNextTurn(m);}else l.phase='move';return {ok:true};}
  if(action==='move'){if(!ludoApplyMove(m,playerId,payload&&payload.pawn))return {ok:false,message:'Invalid pawn move'};return {ok:true};}
  return {ok:false,message:'Unknown Ludo action'};
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
      if(waiting.size >= MAX_WAITING && !waiting.has(playerId)){
        send(ws,{type:'queueFull',message:'Random matchmaking is busy. Please retry in a moment.'});
        return;
      }
      /* Replace an older socket for the same browser session. */
      const old=waiting.get(playerId);
      if(old && old.ws!==ws){
        const oldMatch=matchForWs(old.ws);
        if(oldMatch) breakMatch(oldMatch[0],old.ws,true);
        try{old.ws.close();}catch{} waiting.delete(playerId);
      }
      /* If this player is still in an old match, release that match first. */
      const oldMatch=matchForWs(ws);
      if(oldMatch) breakMatch(oldMatch[0],ws,true);
      waiting.set(playerId,{ws,name:String(msg.name||'Player').slice(0,40),joinedAt:Date.now()});
      pairWaiting();
      return;
    }

    if(msg.type==='ludoAction'){
      const matchId=String(msg.matchId||'');
      const m=matches.get(matchId);
      if(!m || (m.aWs!==ws && m.bWs!==ws)) return;
      const result=ludoHandleAction(m,String(msg.playerId||''),String(msg.action||''),msg.payload||{});
      if(!result.ok) send(ws,{type:'ludoError',matchId,message:result.message||'Action rejected'});
      else if(result.stopped) { send(m.aWs,{type:'ludoState',matchId,state:null,backgroundIndex:m.backgroundIndex}); send(m.bWs,{type:'ludoState',matchId,state:null,backgroundIndex:m.backgroundIndex}); }
      else sendLudoState(m);
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
  pairWaiting();
  for(const [matchId,m] of matches){
    if(!m.aWs || !m.bWs || m.aWs.readyState!==1 || m.bWs.readyState!==1){
      breakMatch(matchId,m.aWs,false);
      continue;
    }
    if(now-m.createdAt>MAX_MATCH_AGE_MS){
      breakMatch(matchId,m.aWs,true);
      continue;
    }
    if(m.ludo && !m.ludo.winner && m.ludo.deadline && now>=m.ludo.deadline){
      ludoNextTurn(m);
      sendLudoState(m);
    }
  }
  for(const ws of clients){
    if(ws.isAlive===false){try{ws.terminate();}catch{} continue;}
    ws.isAlive=false;try{ws.ping();}catch{}
  }
},10000);

const queuePairer=setInterval(pairWaiting,500);
server.listen(PORT,()=>console.log(`Spinit server listening on :${PORT}`));
process.on('SIGTERM',()=>{clearInterval(heartbeat);clearInterval(queuePairer);server.close(()=>process.exit(0));});

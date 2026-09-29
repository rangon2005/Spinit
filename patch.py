from pathlib import Path
p=Path('/mnt/data/ludo_req/index.html')
s=p.read_text()
# Replace localAction ludo start block
old="""    if(action==='ludoStart'){
      app.state.ludo=makeLudo.call(app,ids);app.state.activeGame='ludo';app.state.ts=Date.now();
      app.state.chat.push({sender:'System',text:'🎲 Ludo started — '+ids.length+' players!',ts:Date.now()});
    } else if(action==='ludoRoll'){"""
new="""    if(action==='ludoStart'){
      const selected=Array.isArray(payload?.players)?payload.players.filter(id=>ids.includes(id)).slice(0,2):[];
      if(selected.length!==2)return app.toast('Ludo needs exactly 2 players');
      app.state.ludo=makeLudo.call(app,selected);app.state.ludoRequest=null;app.state.activeGame='ludo';app.state.ts=Date.now();
      app.state.chat.push({sender:'System',text:'🎲 Ludo started — '+selected.map(id=>app.state.players[id]?.name||'Player').join(' vs '),ts:Date.now()});
    } else if(action==='ludoRequest'){
      const from=String(payload?.fromId||''); const to=String(payload?.toId||'');
      if(!ids.includes(from)||!ids.includes(to)||from===to)return;
      if(app.state.ludo)return app.toast('Ludo is already in progress');
      app.state.ludoRequest={fromId:from,toId:to,fromName:app.state.players[from]?.name||'Player',toName:app.state.players[to]?.name||'Player',ts:Date.now()};
    } else if(action==='ludoAccept'){
      const req=app.state.ludoRequest;
      if(!req||req.toId!==app.playerId||req.fromId===app.playerId)return;
      app.state.ludoRequest=null;
      app.state.ludo=makeLudo.call(app,[req.fromId,req.toId]);app.state.activeGame='ludo';app.state.ts=Date.now();
      app.state.chat.push({sender:'System',text:'🎲 Ludo started — '+req.fromName+' vs '+req.toName,ts:Date.now()});
    } else if(action==='ludoDecline'){
      if(app.state.ludoRequest?.toId===app.playerId)app.state.ludoRequest=null;
    } else if(action==='ludoRoll'){"""
if old not in s: raise SystemExit('localAction block not found')
s=s.replace(old,new,1)
# ludoStart function replace
old="""  P.ludoStart=function(){
    const n=Object.keys(this.state.players||{}).length;
    if(n<2||n>4){this.toast('Ludo needs 2–4 players');return;}
    sfx.pop();
    if(this.isQuickMatch&&this._matchWS?.readyState===1){this.sendLudoServer('start');}
    else if(this.isHost)localAction(this,'ludoStart');
    else this.sendAction('ludoStart');
  };"""
new="""  P.ludoStart=function(){
    const ids=Object.keys(this.state.players||{});
    if(ids.length<2)return this.toast('Ludo needs at least 2 players');
    sfx.pop();
    if(ids.length===2){
      if(this.isQuickMatch&&this._matchWS?.readyState===1){this.sendLudoServer('start');}
      else if(this.isHost)localAction(this,'ludoStart',{players:ids});
      else this.sendAction('ludoStart',{players:ids});
      return;
    }
    this.showLudoRequestPicker();
  };"""
if old not in s: raise SystemExit('ludoStart block not found')
s=s.replace(old,new,1)
# requestGame ludo block
old="""    if(game==='ludo'){
      const n=Object.keys(this.state.players||{}).length;if(n<2||n>4){this.toast('Ludo needs 2–4 players');return;}this.state.activeGame='ludo';this.showGame();if(!this.state.ludo)this.ludoStart();else this.renderLudo();return;
    }"""
new="""    if(game==='ludo'){
      const n=Object.keys(this.state.players||{}).length;if(n<2){this.toast('Ludo needs at least 2 players');return;}this.state.activeGame='ludo';this.showGame();if(!this.state.ludo)this.ludoStart();else this.renderLudo();return;
    }"""
if old not in s: raise SystemExit('requestGame block not found')
s=s.replace(old,new,1)
# applyAction ludo actions list
old="""    if(packet?.action==='ludoStart'||packet?.action==='ludoRoll'||packet?.action==='ludoMove'){
      if(this.isHost)localAction(this,packet.action,packet.payload||{});return;
    }"""
new="""    if(packet?.action==='ludoStart'||packet?.action==='ludoRoll'||packet?.action==='ludoMove'||packet?.action==='ludoRequest'||packet?.action==='ludoAccept'||packet?.action==='ludoDecline'){
      if(this.isHost)localAction(this,packet.action,packet.payload||{});return;
    }"""
if old not in s: raise SystemExit('applyAction block not found')
s=s.replace(old,new,1)
# Add request UI methods before renderLudo
marker="""  P.renderLudo=function(){"""
insert="""  P.showLudoRequestPicker=function(){
    const modal=document.getElementById('ludoRequestModal'),list=document.getElementById('ludoRequestList');
    if(!modal||!list)return;
    const ids=Object.keys(this.state.players||{}).filter(id=>id!==this.playerId);
    list.innerHTML=ids.map(id=>`<button onclick=\"app.sendLudoRequest('${id}')\" class=\"w-full flex items-center justify-between px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-left\"><span class=\"text-sm font-semibold\">${escName(this.state.players[id]?.name||'Player')}</span><span class=\"text-[10px] text-pink-300\">Request to Play</span></button>`).join('') || '<p class=\"text-xs text-slate-500 text-center py-3\">No other player available.</p>';
    modal.classList.remove('hidden');
  };
  P.closeLudoRequestModal=function(){document.getElementById('ludoRequestModal')?.classList.add('hidden');};
  P.sendLudoRequest=function(toId){
    this.closeLudoRequestModal();
    if(!this.state.players?.[toId])return;
    const payload={fromId:this.playerId,toId,fromName:this.playerName||'Player',toName:this.state.players[toId].name||'Player'};
    if(this.isHost)localAction(this,'ludoRequest',payload);else this.sendAction('ludoRequest',payload);
    this.toast(`Ludo request sent to ${this.state.players[toId].name||'Player'}`);
  };
  P.acceptLudoRequest=function(){
    const req=this.state.ludoRequest;if(!req||req.toId!==this.playerId)return;
    this.closeLudoInviteModal();
    if(this.isHost)localAction(this,'ludoAccept');else this.sendAction('ludoAccept');
  };
  P.declineLudoRequest=function(){
    const req=this.state.ludoRequest;if(!req||req.toId!==this.playerId)return;
    this.closeLudoInviteModal();
    if(this.isHost)localAction(this,'ludoDecline');else this.sendAction('ludoDecline');
  };
  P.closeLudoInviteModal=function(){document.getElementById('ludoInviteModal')?.classList.add('hidden');};

  P.renderLudo=function(){"""
if marker not in s: raise SystemExit('render marker not found')
s=s.replace(marker,insert,1)
# render initial message and players count
s=s.replace("2–4 players · 2 pawns each · first to Home wins.","Exactly 2 players · 2 pawns each · first to Home wins.")
# Add invite modal handling in update wrapper
old="""  const oldUI=P.updateGameUI;P.updateGameUI=function(){oldUI.call(this);if(this.state?.activeGame==='ludo')this.renderLudo();};"""
new="""  const oldUI=P.updateGameUI;P.updateGameUI=function(){oldUI.call(this);if(this.state?.activeGame==='ludo')this.renderLudo();const req=this.state?.ludoRequest;const inv=document.getElementById('ludoInviteModal');if(inv){if(req&&req.toId===this.playerId&&!this.state.ludo){document.getElementById('ludoInviteFrom').textContent=req.fromName||'Someone';inv.classList.remove('hidden');}else inv.classList.add('hidden');}};"""
if old not in s: raise SystemExit('update wrapper not found')
s=s.replace(old,new,1)
# Add modal before body closing via before </body>
modal="""
<div id="ludoRequestModal" class="hidden fixed inset-0 z-[120] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
  <div class="glass w-full max-w-sm rounded-2xl p-5 border border-slate-700 shadow-2xl">
    <div class="flex items-center justify-between mb-3"><h3 class="font-bold">🎲 Choose a Ludo opponent</h3><button onclick="app.closeLudoRequestModal()" class="text-slate-400">✕</button></div>
    <p class="text-xs text-slate-400 mb-3">Ludo is limited to exactly 2 players. Send a request to one player.</p>
    <div id="ludoRequestList" class="space-y-2"></div>
  </div>
</div>
<div id="ludoInviteModal" class="hidden fixed inset-0 z-[121] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
  <div class="glass w-full max-w-sm rounded-2xl p-5 border border-emerald-500/30 shadow-2xl text-center">
    <div class="text-3xl mb-2">🎲</div><h3 class="font-bold text-lg">Ludo request</h3>
    <p class="text-sm text-slate-300 mt-1"><span id="ludoInviteFrom">Someone</span> wants to play Ludo with you.</p>
    <p class="text-[11px] text-slate-500 mt-1">Exactly 2 players · 2 pawns each</p>
    <div class="grid grid-cols-2 gap-2 mt-4"><button onclick="app.acceptLudoRequest()" class="py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-bold text-sm">Accept</button><button onclick="app.declineLudoRequest()" class="py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 font-bold text-sm">Decline</button></div>
  </div>
</div>
"""
idx=s.rfind('</body>')
if idx<0: raise SystemExit('body close missing')
s=s[:idx]+modal+s[idx:]
p.write_text(s)

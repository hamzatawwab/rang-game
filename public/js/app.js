'use strict';
const G = {
  socket: null, myNum: null, myName: '', roomCode: '',
  gs: null, hand: [], selectedId: null, fchSelectedId: null,
  partnerData: null, pendingResult: null,
  freezeUntil: 0, frozenTrick: null, frozenWinnerName: '',
  viewingOwn: false, myViewUsed: false,
};
const TRICK_DISPLAY_MS = 5000;

// ══ SOUND ENGINE (synthesized, no files) ══════════════════════════════════════
const Snd = {
  ctx: null, muted: false, master: null,
  init(){
    if(!this.ctx){
      try{
        this.ctx = new (window.AudioContext||window.webkitAudioContext)();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.9;
        // gentle reverb-ish via short feedback delay for warmth
        this.master.connect(this.ctx.destination);
      }catch(e){}
    }
  },
  resume(){ if(this.ctx && this.ctx.state==='suspended') this.ctx.resume(); },
  _out(){ return this.master || this.ctx.destination; },
  _noise(dur, vol, t0, filterType, filterFreq, q){
    const c=this.ctx, len=Math.floor(c.sampleRate*dur);
    const buf=c.createBuffer(1,len,c.sampleRate), d=buf.getChannelData(0);
    for(let i=0;i<len;i++){ const env=Math.pow(1-i/len,1.6); d[i]=(Math.random()*2-1)*env; }
    const src=c.createBufferSource(); src.buffer=buf;
    const f=c.createBiquadFilter(); f.type=filterType||'bandpass'; f.frequency.value=filterFreq||2500; if(q)f.Q.value=q;
    const g=c.createGain(); g.gain.setValueAtTime(vol,t0);
    src.connect(f); f.connect(g); g.connect(this._out()); src.start(t0);
  },
  // Soft card place — gentle muffled paper touch on felt (warm, not harsh)
  snap(){
    if(this.muted||!this.ctx) return;
    const c=this.ctx, t=c.currentTime;
    // soft low-passed paper brush (short, quiet)
    this._noise(0.045, 0.12, t, 'lowpass', 1100, 0.5);
    // subtle felt thud body
    const o=c.createOscillator(), g=c.createGain();
    o.type='sine'; o.frequency.setValueAtTime(240,t); o.frequency.exponentialRampToValueAtTime(90,t+0.07);
    g.gain.setValueAtTime(0.09,t); g.gain.exponentialRampToValueAtTime(0.001,t+0.11);
    o.connect(g); g.connect(this._out()); o.start(t); o.stop(t+0.12);
  },
  // Realistic riffle shuffle — many short paper ticks accelerating then settling
  shuffle(){
    if(this.muted||!this.ctx) return;
    const t=this.ctx.currentTime;
    let time=0;
    for(let i=0;i<26;i++){
      const gap = 0.028 + Math.max(0, 0.02 - i*0.0008) + Math.random()*0.006;
      time += gap;
      this._noise(0.022, 0.10+Math.random()*0.06, t+time, 'bandpass', 2600+Math.random()*3200, 1.5);
    }
    // final tap/square-up
    this._noise(0.05, 0.2, t+time+0.06, 'lowpass', 1400, 0.6);
  },
  // Soft collection whoosh (cards swept together)
  collect(){
    if(this.muted||!this.ctx) return;
    const c=this.ctx, t=c.currentTime;
    for(let i=0;i<6;i++) this._noise(0.09, 0.09, t+i*0.03, 'bandpass', 1200+i*400, 0.8);
    const o=c.createOscillator(), g=c.createGain();
    o.type='sine'; o.frequency.setValueAtTime(300,t); o.frequency.exponentialRampToValueAtTime(600,t+0.22);
    g.gain.setValueAtTime(0.0001,t); g.gain.linearRampToValueAtTime(0.08,t+0.05); g.gain.exponentialRampToValueAtTime(0.001,t+0.28);
    o.connect(g); g.connect(this._out()); o.start(t); o.stop(t+0.3);
  },
  boo(){
    if(this.muted||!this.ctx) return;
    const c=this.ctx, t=c.currentTime;
    for(let v=0;v<6;v++){
      const o=c.createOscillator(), g=c.createGain();
      o.type='sawtooth';
      const f0=95+v*16+Math.random()*10;
      o.frequency.setValueAtTime(f0,t);
      o.frequency.linearRampToValueAtTime(f0*0.65, t+1.5);
      g.gain.setValueAtTime(0.0001,t);
      g.gain.linearRampToValueAtTime(0.06,t+0.18);
      g.gain.linearRampToValueAtTime(0.0001,t+1.6);
      const f=c.createBiquadFilter(); f.type='lowpass'; f.frequency.value=900;
      o.connect(f); f.connect(g); g.connect(this._out()); o.start(t); o.stop(t+1.7);
    }
  },
  // Warm triumphant arpeggio with soft bell overtones
  win(){
    if(this.muted||!this.ctx) return;
    const c=this.ctx, t=c.currentTime, notes=[523.25,659.25,783.99,1046.5,1318.5];
    notes.forEach((f,i)=>{
      const st=t+i*0.085;
      [1,2].forEach((mult,mi)=>{
        const o=c.createOscillator(), g=c.createGain();
        o.type = mi===0?'triangle':'sine'; o.frequency.value=f*mult;
        const peak = mi===0?0.16:0.05;
        g.gain.setValueAtTime(0.0001,st);
        g.gain.linearRampToValueAtTime(peak,st+0.02);
        g.gain.exponentialRampToValueAtTime(0.001,st+0.5);
        o.connect(g); g.connect(this._out()); o.start(st); o.stop(st+0.55);
      });
    });
  },
  // Gentle chime for turn/selection micro-feedback
  tick(){
    if(this.muted||!this.ctx) return;
    const c=this.ctx, t=c.currentTime;
    const o=c.createOscillator(), g=c.createGain();
    o.type='sine'; o.frequency.value=880;
    g.gain.setValueAtTime(0.0001,t); g.gain.linearRampToValueAtTime(0.06,t+0.01); g.gain.exponentialRampToValueAtTime(0.001,t+0.12);
    o.connect(g); g.connect(this._out()); o.start(t); o.stop(t+0.13);
  },
  // Dramatic challenge sting
  challenge(){
    if(this.muted||!this.ctx) return;
    const c=this.ctx, t=c.currentTime;
    const o=c.createOscillator(), g=c.createGain();
    o.type='sawtooth'; o.frequency.setValueAtTime(180,t); o.frequency.exponentialRampToValueAtTime(720,t+0.35);
    g.gain.setValueAtTime(0.0001,t); g.gain.linearRampToValueAtTime(0.12,t+0.06); g.gain.exponentialRampToValueAtTime(0.001,t+0.5);
    const f=c.createBiquadFilter(); f.type='lowpass'; f.frequency.setValueAtTime(600,t); f.frequency.linearRampToValueAtTime(3000,t+0.35);
    o.connect(f); f.connect(g); g.connect(this._out()); o.start(t); o.stop(t+0.55);
    this._noise(0.4,0.06,t,'highpass',2000,0.5);
  },
}
document.addEventListener('pointerdown', ()=>{ Snd.init(); Snd.resume(); }, { once:false });

// ══ CONFETTI ══════════════════════════════════════════════════════════════════
function confetti(count){
  const colors=['#fde047','#4ade80','#60a5fa','#f472b6','#fb923c','#a78bfa','#f87171'];
  for(let i=0;i<count;i++){
    const el=document.createElement('div');
    el.className='confetti-bit';
    el.style.left=(Math.random()*100)+'vw';
    el.style.background=colors[Math.floor(Math.random()*colors.length)];
    const sz=(6+Math.random()*7);
    el.style.width=sz+'px'; el.style.height=(sz*0.6)+'px';
    el.style.animationDuration=(2.2+Math.random()*2)+'s';
    el.style.animationDelay=(Math.random()*0.6)+'s';
    document.body.appendChild(el);
    setTimeout(()=>el.remove(), 5000);
  }
}

// ══ GOON COAT TAUNT ═══════════════════════════════════════════════════════════
function showTaunt(text, sub, ms){
  setTxt('taunt-text', text);
  setTxt('taunt-sub', sub||'');
  show('taunt');
  Snd.boo();
  setTimeout(()=>hide('taunt'), ms||2600);
}

// ── Fly the played cards to the winning team's trick counter (on collection) ──
function flyCardsToCounter(winTeam){
  const targetEl = $(winTeam === 'A' ? 'sc-a' : 'sc-b');
  if(!targetEl) return;
  const tr = targetEl.getBoundingClientRect();
  const tx = tr.left + tr.width/2, ty = tr.top + tr.height/2;
  const slots = ['ts-top','ts-left','ts-right','ts-bot'];
  slots.forEach((sid, i)=>{
    const slot = $(sid);
    if(!slot) return;
    const cardEl = slot.querySelector('.card');
    if(!cardEl) return;
    const cr = cardEl.getBoundingClientRect();
    const clone = cardEl.cloneNode(true);
    clone.style.position='fixed'; clone.style.left=cr.left+'px'; clone.style.top=cr.top+'px';
    clone.style.width=cr.width+'px'; clone.style.height=cr.height+'px'; clone.style.margin='0';
    clone.style.zIndex='600'; clone.style.pointerEvents='none';
    clone.style.transition='transform 0.7s cubic-bezier(0.5,0,0.4,1), opacity 0.7s ease';
    document.body.appendChild(clone);
    cardEl.style.visibility='hidden';
    const dx = tx-(cr.left+cr.width/2), dy = ty-(cr.top+cr.height/2);
    requestAnimationFrame(()=>{
      setTimeout(()=>{
        clone.style.transform=`translate(${dx}px,${dy}px) scale(0.28) rotate(${(i-1.5)*20}deg)`;
        clone.style.opacity='0.15';
      }, i*70);
    });
    setTimeout(()=>clone.remove(), 950+i*70);
  });
  setTimeout(()=>{ targetEl.classList.remove('bump'); void targetEl.offsetWidth; targetEl.classList.add('bump'); }, 640);
}

function fireworks(bursts){
  const colors=['#fde047','#f59e0b','#fb923c','#fbbf24','#fff'];
  for(let b=0;b<bursts;b++){
    setTimeout(()=>{
      const cx = 15+Math.random()*70, cy = 15+Math.random()*50;
      for(let i=0;i<16;i++){
        const el=document.createElement('div');
        el.className='fw-p';
        el.style.left=cx+'vw'; el.style.top=cy+'vh';
        el.style.background=colors[Math.floor(Math.random()*colors.length)];
        const ang=(i/16)*Math.PI*2, dist=40+Math.random()*70;
        el.style.setProperty('--dx', Math.cos(ang)*dist+'px');
        el.style.setProperty('--dy', Math.sin(ang)*dist+'px');
        document.body.appendChild(el);
        setTimeout(()=>el.remove(),1300);
      }
      Snd.snap();
    }, b*380);
  }
}

function showCelebrate(text, sub, ms){
  setTxt('celebrate-text', text);
  setTxt('celebrate-sub', sub||'');
  show('celebrate');
  Snd.win();
  setTimeout(()=>hide('celebrate'), ms||2400);
}

// stable per-card rotation angle from its id
function cardAngle(id){
  let h=0; for(let i=0;i<id.length;i++) h=(h*31+id.charCodeAt(i))>>>0;
  return (h%15)-7; // -7..+7 degrees
}

const SUIT_SYM  = { spades:'♠', hearts:'♥', diamonds:'♦', clubs:'♣' };
const SUIT_NAME = { spades:'Hukam', hearts:'Dil', diamonds:'Eent', clubs:'Chiri' };
const TEAM_OF   = { 1:'A', 2:'B', 3:'A', 4:'B' };
const NEXT_P    = { 1:2, 2:3, 3:4, 4:1 };
const PARTNER_OF= { 1:3, 2:4, 3:1, 4:2 };

function layout(n) {
  // Counter-clockwise table: next player sits on your RIGHT, previous on your LEFT
  const p={1:3,2:4,3:1,4:2}, nx={1:2,2:3,3:4,4:1}, pv={1:4,2:1,3:2,4:3};
  return { top:p[n], right:nx[n], left:pv[n], bottom:n };
}

function $(id){ return document.getElementById(id); }
function show(id){ $(id).classList.remove('hidden'); }
function hide(id){ $(id).classList.add('hidden'); }
function setTxt(id,t){ $(id).textContent = t; }
function isHidden(id){ return $(id).classList.contains('hidden'); }

let toastTimer;
function toast(msg, isErr){
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr?' error':'');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>el.classList.add('hidden'), 3500);
}

function openModal(id){ document.querySelectorAll('.modal').forEach(m=>m.classList.add('hidden')); $(id).classList.remove('hidden'); }
function closeModal(id){ $(id).classList.add('hidden'); }
function closeAll(){ document.querySelectorAll('.modal').forEach(m=>m.classList.add('hidden')); }
function showGame(){ $('screen-lobby').classList.replace('active','hidden'); $('screen-game').classList.replace('hidden','active'); }

// ── Card rendering ────────────────────────────────────────────────────────────
function cardCls(card){ return (card.suit==='hearts'||card.suit==='diamonds')?'red':'black'; }

const FACE_GLYPH = { K:'\u265A', Q:'\u265B', J:'\u265E' }; // ♚ ♛ ♞

function faceGlyphHTML(rank){
  const g = FACE_GLYPH[rank];
  return g ? `<span class="face-glyph">${g}</span>` : '';
}

function trickCardHTML(card, playerName, isLed){
  const sym = SUIT_SYM[card.suit];
  const led = isLed ? ' led-card':'';
  const dg  = card.aceDowngraded ? ' downgraded':'';
  const ledTag = isLed ? '<span class="led-tag">led</span>':'';
  const ang = cardAngle(card.id||'x');
  const r = card.originalRank||card.rank;
  return `<div class="card ${cardCls(card)}${led}${dg}" style="transform:rotate(${ang}deg)">
    ${ledTag}
    <span class="cr-tl">${r}</span>
    <span class="cs-tr">${sym}</span>
    <span class="ccenter">${sym}</span>
    <span class="cbot">${playerName||''}</span>
  </div>`;
}

function handCardHTML(card, playerName, sel, valid){
  const sym = SUIT_SYM[card.suit];
  const dis = valid===false ? ' disabled':'';
  const s   = sel ? ' selected':'';
  const rang = G.gs&&card.suit===G.gs.rang ? ' rang-card':'';
  return `<div class="hand-card ${cardCls(card)}${dis}${s}${rang}" data-id="${card.id}">
    <span class="cr-tl">${card.rank}</span>
    <span class="cs-tr">${sym}</span>
    <span class="ccenter">${sym}</span>
    <span class="cbot">${playerName||''}</span>
  </div>`;
}

function miniCardHTML(card){
  const sym = SUIT_SYM[card.suit];
  return `<div class="hand-card ${cardCls(card)}" style="cursor:default">
    <span class="cr-tl">${card.rank}</span>
    <span class="cs-tr">${sym}</span>
  </div>`;
}

// ── Hand rendering ────────────────────────────────────────────────────────────
// ── Force-clear the hand blur (works around stuck mobile WebKit filter layers) ──
let _prevHandSize = 0;
function renderHand(){
  const el = $('my-hand');
  if(!el) return;
  const N = G.hand.length;
  // Trigger deal-in stagger when the hand grows from a deal (0 -> many)
  const justDealt = (N > _prevHandSize && _prevHandSize <= 1 && N >= 5);
  _prevHandSize = N;
  el.innerHTML = G.hand.map((c,i)=>{
    // Fan: spread rotation -12..+12 deg, slight downward arc at edges
    const t = N>1 ? (i/(N-1))-0.5 : 0;   // -0.5..0.5
    const rot = t*24;                       // degrees
    const dip = Math.abs(t)*14;             // px downward at edges
    const sel = c.id===G.selectedId;
    const lift = sel ? -16 : 0;
    const html = handCardHTML(c, G.myName, sel, c.valid);
    const stagger = justDealt ? `;animation-delay:${i*0.05}s` : '';
    return html.replace('class="hand-card',
      `style="transform:translateY(${dip+lift}px) rotate(${rot}deg);z-index:${i}${stagger}" class="hand-card`);
  }).join('');
  if(justDealt){
    el.classList.add('dealing');
    setTimeout(()=>el.classList.remove('dealing'), 900);
  }
  el.querySelectorAll('.hand-card:not(.disabled)').forEach(hc=>{
    hc.addEventListener('click',()=>{
      if(!G.gs) return;
      const phase = G.gs.phase;
      if(phase!=='trick_play'&&phase!=='five_card_trick_play') return;
      if(getExpected(G.gs)!==G.myNum) return;
      const id = hc.dataset.id;
      if(G.selectedId===id){ G.selectedId=null; hide('btn-confirm'); hide('btn-cancel'); }
      else { G.selectedId=id; show('btn-confirm'); show('btn-cancel'); }
      renderHand();
    });
  });
}

function renderModalHand(containerId, hand, selectable, onSelect){
  const el = $(containerId);
  if(!el) return;
  el.innerHTML = hand.map(c=>miniCardHTML(c)).join('');
  if(selectable && onSelect){
    el.querySelectorAll('.hand-card').forEach(hc=>{
      hc.style.cursor='pointer';
      hc.addEventListener('click',()=>{
        el.querySelectorAll('.hand-card').forEach(e=>e.classList.remove('selected'));
        hc.classList.add('selected');
        onSelect(hc.dataset.id);
      });
    });
  }
}

// ── Expected player ───────────────────────────────────────────────────────────
function getExpected(gs){
  if(!gs||!gs.currentTrick) return gs&&gs.currentLeader;
  if(gs.currentTrick.length===0) return gs.currentLeader;
  const last = gs.currentTrick[gs.currentTrick.length-1];
  return NEXT_P[last.playerNum];
}

// ── Lobby seats ───────────────────────────────────────────────────────────────
function updateSeats(gs){
  if(!gs) return;
  for(let n=1;n<=4;n++){
    const p = gs.players[n];
    const el = $(`sp-${n}`);
    const btn = document.querySelector(`.btn-seat[data-num="${n}"]`);
    if(p&&p.name){
      el.textContent = p.name + (n===G.myNum?' (You)':'');
      el.style.color = '#4ade80';
      if(btn){ btn.disabled=true; btn.textContent='Taken'; btn.className='btn-seat'; }
    } else {
      el.textContent = 'Empty'; el.style.color = '';
      if(btn){ btn.disabled = (G.myNum!==null); btn.textContent='Take Seat'; }
    }
    const tile = document.querySelector(`.seat-tile[data-num="${n}"]`);
    if(tile) tile.classList.toggle('mine', n===G.myNum);
  }
  const filled = [1,2,3,4].filter(n=>gs.players[n]&&gs.players[n].name).length;
  $('lobby-status').textContent = `${filled}/4 players joined — waiting for all 4…`;
}

// ── Main state apply ──────────────────────────────────────────────────────────
function applyState(gs){
  G.gs = gs;

  // Lobby
  if($('panel-seats')&&!isHidden('panel-seats')) updateSeats(gs);

  if(!G.myNum) return;

  // Switch to game screen if past lobby
  if(gs.phase!=='lobby'&&gs.phase!=='dealer_selection'){
    showGame();
  }

  // Safety net: if the disconnect popup is showing but everyone is connected
  // again, dismiss it (covers any missed player_reconnected event).
  if(!isHidden('m-dc') && gs.players){
    const allConnected = [1,2,3,4].every(n => gs.players[n] && gs.players[n].connected);
    if(allConnected) hide('m-dc');
  }

  updateTopBar(gs);
  updatePlayerBoxes(gs);
  updateTrickArea(gs);
  updateScores(gs);
  updateChallengePanel(gs);
  updateTurnLabel(gs);
  updateActionBar(gs);

  // Phase modals
  const ph = gs.phase;

  // (blur logic removed — personal hand is always sharp)

  // While the result modal is showing (hand_over / series_over), don't open other modals
  const resultShowing = !isHidden('m-result') || !isHidden('m-series');

  if(ph==='rang_selection'&&G.myNum===gs.rangSelector&&!resultShowing){
    if(isHidden('m-take')&&isHidden('m-rang')) openModal('m-take');
  }

  // 5-card challenge pending: ONLY rang team sees the accept/reject modal
  if(ph==='five_card_challenge_pending' && !resultShowing){
    const myTeam = TEAM_OF[G.myNum];
    const rangTeam = gs.rangSelector ? TEAM_OF[gs.rangSelector] : null;
    if(myTeam === rangTeam) {
      // I'm on the rang team — show voting modal (open once, votes update every state)
      if(isHidden('m-5ar')){
        const callerName = (gs.fiveCard && gs.fiveCard.callerNum && gs.players[gs.fiveCard.callerNum] && gs.players[gs.fiveCard.callerNum].name) || 'Opponent';
        setTxt('fcar-info', callerName + ' placed a card face-down as the challenge lead. View your partner\'s hand — you BOTH must cast the same vote.');
        show('fcar-btns'); hide('fcar-wait');
        if(G.partnerData) displayPartnerView('fcar-pv','fcar-pv-lbl','fcar-phand');
        openModal('m-5ar');
      }
      // Always refresh vote status (updates live as votes come in)
      const rangPlayers = [1,2,3,4].filter(n=>TEAM_OF[n]===rangTeam);
      renderVoteStatus('fcar-votes', gs.fiveCardVotes, rangPlayers, gs);
    }
    // Challenger's team (P1 & P3 who called it): NO modal — challenge panel shows status
  }

  // 13-card challenge pending: ONLY opposing team (who can accept/reject) sees modal
  if(ph==='thirteen_card_challenge_pending' && !resultShowing){
    const myTeam = TEAM_OF[G.myNum];
    const callerTeam = gs.thirteenCard && gs.thirteenCard.callerNum ? TEAM_OF[gs.thirteenCard.callerNum] : null;
    const oppTeam = callerTeam === 'A' ? 'B' : 'A';
    if(myTeam === oppTeam) {
      // I'm on the opposing team — show voting modal (open once, votes update every state)
      if(isHidden('m-13ar')){
        const callerName = (gs.thirteenCard.callerNum && gs.players[gs.thirteenCard.callerNum]?.name) || 'Opponent';
        const nr = gs.thirteenCard.newRang;
        setTxt('tcar-info', callerName + ' declared a 13-card challenge with ' + SUIT_SYM[nr] + ' ' + SUIT_NAME[nr] + '. They must win ALL 13 tricks. You BOTH must cast the same vote.');
        show('tcar-btns'); hide('tcar-wait');
        if(G.partnerData) displayPartnerView('tcar-pv','tcar-pv-lbl','tcar-phand');
        openModal('m-13ar');
      }
      // Always refresh vote status (updates live as votes come in)
      const oppPlayers = [1,2,3,4].filter(n=>TEAM_OF[n]===oppTeam);
      renderVoteStatus('tcar-votes', gs.thirteenCardVotes, oppPlayers, gs);
    }
    // Challenger's team: NO modal — challenge panel shows status
  }

  // Close ONLY challenge decision modals when phase moves past them.
  // NEVER touch m-result or m-series here — those are managed by hand_over event.
  if(ph==='trick_play'||ph==='five_card_trick_play'||ph==='five_card_challenge_window'||ph==='thirteen_card_challenge_window'||ph==='hand_over'||ph==='series_over'){
    if(!isHidden('m-5ar'))  closeModal('m-5ar');
    if(!isHidden('m-13ar')) closeModal('m-13ar');
    if(!isHidden('m-5ch'))  closeModal('m-5ch');
    if(!isHidden('m-13ch')) closeModal('m-13ch');
  }
  // Close rang-selection modals only when past rang selection
  if(ph!=='rang_selection'){
    if(!isHidden('m-take')) closeModal('m-take');
    if(!isHidden('m-rang')) closeModal('m-rang');
  }
}

function renderVoteStatus(elId, votes, teamPlayers, gs){
  const el = $(elId);
  if(!el) return;
  let html = '';
  for(const n of teamPlayers){
    const v = votes ? votes[n] : null;
    const name = (gs.players[n]&&gs.players[n].name)||('P'+n);
    const me = n===G.myNum ? ' (You)' : '';
    const badge = v==='accept' ? '<span style="color:#4ade80;font-weight:700">ACCEPT</span>'
                : v==='reject' ? '<span style="color:#f87171;font-weight:700">REJECT</span>'
                : '<span style="color:#9ca3af">not voted</span>';
    html += '<div>'+name+me+': '+badge+'</div>';
  }
  const v1 = votes ? votes[teamPlayers[0]] : null;
  const v2 = votes ? votes[teamPlayers[1]] : null;
  if(v1 && v2 && v1!==v2){
    html += '<div style="color:#fbbf24;margin-top:3px">Votes do not match — change your vote until both agree.</div>';
  }
  el.innerHTML = html;
}

const RANKV = {'2':0,'3':1,'4':2,'5':3,'6':4,'7':5,'8':6,'9':7,'10':8,'J':9,'Q':10,'K':11,'A':12};
function sortRangFirst(hand){
  const rang = G.gs && G.gs.rang;
  const suitBase = { clubs:1, hearts:2, spades:3, diamonds:4 };
  return [...hand].sort((a,b)=>{
    const sa = a.suit===rang ? 0 : suitBase[a.suit];
    const sb = b.suit===rang ? 0 : suitBase[b.suit];
    if(sa!==sb) return sa-sb;
    return RANKV[b.rank]-RANKV[a.rank];
  });
}

function displayPartnerView(containerId, lblId, handId){
  if(!G.partnerData) return;
  const {partnerName, partnerHand} = G.partnerData;
  const showingOwn = G.viewingOwn;
  const hand = showingOwn ? sortRangFirst(G.hand) : sortRangFirst(partnerHand);
  setTxt(lblId, showingOwn ? 'YOUR cards:' : `${partnerName}'s cards:`);
  let html = hand.map(c=>miniCardHTML(c)).join('');
  if(!showingOwn && !G.myViewUsed){
    html += `<button class="btn btn-ghost btn-sm view-toggle" data-act="mine" style="width:100%;margin-top:6px">View My Cards (once)</button>`;
  } else if(showingOwn){
    html += `<button class="btn btn-ghost btn-sm view-toggle" data-act="back" style="width:100%;margin-top:6px">Back to ${partnerName}'s Cards</button>`;
  }
  $(handId).innerHTML = html;
  const tbtn = $(handId).querySelector('.view-toggle');
  if(tbtn){
    tbtn.addEventListener('click', ()=>{
      if(tbtn.dataset.act==='mine'){ G.viewingOwn = true; }
      else { G.viewingOwn = false; G.myViewUsed = true; }
      displayPartnerView(containerId, lblId, handId);
    });
  }
  show(containerId);
}

// ── UI updaters ───────────────────────────────────────────────────────────────
function updateTopBar(gs){
  setTxt('tb-room', G.roomCode);
  const selName = gs.rangSelector && gs.players[gs.rangSelector] ? gs.players[gs.rangSelector].name : '';
  setTxt('tb-rang', gs.rang ? `${SUIT_SYM[gs.rang]} ${gs.rangName} · ${selName}` : 'Rang: —');
  const tp = gs.phase==='trick_play'||gs.phase==='five_card_trick_play';
  setTxt('tb-trick', tp ? `T${gs.trickNumber}/${gs.totalTricks}` : gs.phase.replace(/_/g,' ').slice(0,14));
  setTxt('tb-series', `A:${gs.scores.A} | B:${gs.scores.B}`);
}

function updatePlayerBoxes(gs){
  if(!G.myNum) return;
  const L = layout(G.myNum);
  const pos = { top:L.top, left:L.left, right:L.right };
  const exp = getExpected(gs);
  const tp = gs.phase==='trick_play'||gs.phase==='five_card_trick_play';

  for(const [k,n] of Object.entries(pos)){
    const p = gs.players[n];
    if(!p) continue;
    const team = TEAM_OF[n];
    const av = $('pav-'+k);
    if(av){
      av.textContent = (p.name||'P').charAt(0).toUpperCase();
      av.className = 'pavatar team'+team;
    }
    setTxt(`pname-${k}`, p.name||`P${n}`);
    let meta = `P${n}·T${team}`;
    if(n===gs.dealer) meta += '·🂠';
    if(n===gs.rangSelector) meta += '·♛';
    const metaEl = $(`pmeta-${k}`);
    metaEl.textContent = meta;
    metaEl.className = `pbox-meta team${team}`;
    const cntEl = $(`pcnt-${k}`);
    if(cntEl) cntEl.textContent = `${p.handSize} cards`;
    const box = $(`pbox-${k}`);
    box.classList.toggle('disconnected', !p.connected);
    const isActive = tp && exp===n;
    box.classList.toggle('active', isActive);
    // Thinking dots on the active player's name
    if(isActive){
      if(!metaEl.querySelector('.thinking-dots')){
        const dots=document.createElement('span'); dots.className='thinking-dots';
        dots.innerHTML='<i></i><i></i><i></i>'; metaEl.appendChild(dots);
      }
    }
  }

  // Bottom (me)
  const mp = gs.players[G.myNum];
  setTxt('pname-bot', mp.name||`P${G.myNum}`);
  let myM = `P${G.myNum}·Team ${TEAM_OF[G.myNum]}`;
  if(G.myNum===gs.dealer) myM+='·🂠Dealer';
  if(G.myNum===gs.rangSelector) myM+='·♛Rang Sel.';
  setTxt('pmeta-bot', myM);
  // Glow my own panel when it's my turn to play
  const myBox = $('pbox-bot');
  if(myBox){
    const myTurn = tp && exp===G.myNum;
    myBox.classList.toggle('active', myTurn);
    myBox.classList.toggle('my-turn', myTurn);
    // Haptic buzz once, the moment it becomes my turn (not on every state refresh)
    if(myTurn && !G._wasMyTurn){
      try{ if(navigator.vibrate) navigator.vibrate([40,60,40]); }catch(e){}
    }
    G._wasMyTurn = myTurn;
    const mMeta = $('pmeta-bot');
    if(myTurn && mMeta && !mMeta.querySelector('.thinking-dots')){
      const dots=document.createElement('span'); dots.className='thinking-dots';
      dots.innerHTML='<i></i><i></i><i></i>'; mMeta.appendChild(dots);
    }
  }
}

function updateTrickArea(gs){
  if(!G.myNum) return;
  const L = layout(G.myNum);
  const playerToPos = { [L.top]:'top', [L.left]:'left', [L.right]:'right', [L.bottom]:'bot' };
  const ids = { top:'ts-top', left:'ts-left', right:'ts-right', bot:'ts-bot' };

  const now = Date.now();

  // Determine which cards should be shown right now (frozen snapshot or live trick)
  let showTrick = null, frozen = false;
  if(G.freezeUntil > now && G.frozenTrick){ showTrick = G.frozenTrick; frozen = true; }
  else if(gs.currentTrick){ showTrick = gs.currentTrick; }

  // Build a map: pos -> {cardId, html, isLed}
  const want = { top:null, left:null, right:null, bot:null };
  if(showTrick){
    for(let i=0;i<showTrick.length;i++){
      const played = showTrick[i];
      const pos = playerToPos[played.playerNum];
      if(!pos) continue;
      const name = (gs.players[played.playerNum]&&gs.players[played.playerNum].name)||('P'+played.playerNum);
      want[pos] = { id: played.card.id, html: trickCardHTML(played.card, name, i===0) };
    }
  }

  // Diff against what's already rendered — only update slots that CHANGED.
  // This ensures already-placed cards never re-run their entrance animation.
  for(const pos of ['top','left','right','bot']){
    const slot = $(ids[pos]);
    if(!slot) continue;
    const cur = slot.getAttribute('data-cardid') || '';
    const wantId = want[pos] ? want[pos].id : '';
    if(cur === wantId) continue;            // unchanged → leave it alone (no re-animate)
    if(!want[pos]){
      slot.innerHTML = '';
      slot.removeAttribute('data-cardid');
    } else {
      slot.innerHTML = want[pos].html;      // new card → animates in (only this one)
      slot.setAttribute('data-cardid', want[pos].id);
    }
  }

  // Winner banner
  if(frozen){
    $('winner-banner').textContent = G.frozenWinnerName;
    show('winner-banner');
  } else {
    hide('winner-banner');
  }

  const led = gs.currentTrick&&gs.currentTrick.length>0 ? gs.currentTrick[0].card : null;
  if(led){ $('led-badge').textContent='Led:'+SUIT_SYM[led.suit]; show('led-badge'); }
  else hide('led-badge');

  $('pile-badge').textContent = 'Pile:'+gs.centerPileCount+' trick'+(gs.centerPileCount!==1?'s':'');

  renderPileDisplay(gs);
}

function renderPileDisplay(gs){
  const el = $('pile-display');
  if(!el) return;
  const pile = gs.centerPile || [];
  if(pile.length===0){ el.innerHTML=''; return; }
  let html = '';
  for(const t of pile){
    html += '<div class="pile-trick"><span class="pt-num">T'+t.trickNum+'</span>';
    for(const p of t.trick){
      const c = p.card;
      const cls = (c.suit==='hearts'||c.suit==='diamonds')?'red':'black';
      html += '<div class="mini-card '+cls+'"><span class="mr">'+(c.rank)+'</span><span class="ms">'+SUIT_SYM[c.suit]+'</span></div>';
    }
    html += '</div>';
  }
  el.innerHTML = html;
}

let _prevScores = { A:null, B:null };
function updateScores(gs){
  // Counter shows tricks COLLECTED/PICKED by each team out of 13
  const a = (gs.handScores&&gs.handScores.A)||0;
  const b = (gs.handScores&&gs.handScores.B)||0;
  const elA = $('sc-a'), elB = $('sc-b');
  if(elA){ elA.textContent = a; if(_prevScores.A!==null && a!==_prevScores.A){ elA.classList.remove('bump'); void elA.offsetWidth; elA.classList.add('bump'); } }
  if(elB){ elB.textContent = b; if(_prevScores.B!==null && b!==_prevScores.B){ elB.classList.remove('bump'); void elB.offsetWidth; elB.classList.add('bump'); } }
  _prevScores.A = a; _prevScores.B = b;
}

function updateChallengePanel(gs){
  if(!G.myNum) return;
  const ph = gs.phase;
  const myTeam = TEAM_OF[G.myNum];
  const rangTeam = gs.rangSelector ? TEAM_OF[gs.rangSelector] : null;
  const nonRangTeam = rangTeam==='A'?'B':'A';

  ['btn-5ch','btn-no5ch','btn-13ch','btn-no13ch','btn-walkover','btn-wo-accept','btn-wo-reject'].forEach(id=>hide(id));
  $('btn-no5ch').classList.remove('declined');
  $('btn-no13ch').classList.remove('declined');
  setTxt('ch-status','');

  // ── WALK OVER: now lives on the 13-card challenge/voting screen ──
  const woAvailable = ph==='thirteen_card_challenge_window';
  const wo = gs.walkOver || {};
  const woReq = gs.walkOverRequests || {};
  const myReqUsed = woReq[G.myNum] || 0;
  const myReqLeft = 3 - myReqUsed;
  const iVoted13 = (gs.thirteenCardDeclines||[]).includes(G.myNum);
  if(woAvailable && wo.pending){
    const partner = PARTNER_OF[wo.proposerNum];
    const propName = (gs.players[wo.proposerNum]&&gs.players[wo.proposerNum].name)||('P'+wo.proposerNum);
    if(G.myNum===partner){
      show('btn-wo-accept'); show('btn-wo-reject');
      setTxt('ch-status', propName+' requests\nWALK OVER — decide!');
    } else if(G.myNum===wo.proposerNum){
      setTxt('ch-status','Walk over requested\nwaiting for partner…');
    } else {
      setTxt('ch-status','Opponents considering\nwalk over…');
    }
    return; // nothing else shows while a walk over is pending
  }

  if(ph==='five_card_challenge_window'){
    const declines = gs.fiveCardDeclines || [];
    if(myTeam===nonRangTeam){
      const iDeclined = declines.includes(G.myNum);
      if(!iDeclined){
        show('btn-5ch'); show('btn-no5ch');
        setTxt('ch-status', declines.length ? 'Partner declined\n— your choice…' : 'Challenge or\ndecline (both must)');
      } else {
        show('btn-no5ch');
        $('btn-no5ch').classList.add('declined');
        setTxt('ch-status','You declined ✓\nwaiting partner…');
      }
    } else {
      setTxt('ch-status','Opponents deciding\n5-card ('+declines.length+'/2 declined)');
    }
  } else if(ph==='five_card_challenge_pending'){
    setTxt('ch-status','⚡ 5-card challenge\ncalled…');
  } else if(ph==='thirteen_card_challenge_window'){
    const declines = gs.thirteenCardDeclines || [];
    if(!iVoted13){
      show('btn-13ch'); show('btn-no13ch');
      // Walk over button — only if the player still has requests left and hasn't voted
      if(myReqLeft > 0){
        show('btn-walkover');
        $('btn-walkover').innerHTML = '🏳 Walk Over<br><small>'+myReqLeft+' request'+(myReqLeft!==1?'s':'')+' left</small>';
      }
      setTxt('ch-status', declines.length+'/4 declined'+(myReqUsed>0 ? '\nWalk over: '+myReqLeft+' left' : ''));
    } else {
      show('btn-no13ch');
      $('btn-no13ch').classList.add('declined');
      setTxt('ch-status','You declined ✓\n('+declines.length+'/4)');
    }
  } else if(ph==='thirteen_card_challenge_pending'){
    setTxt('ch-status','⚡ 13-card challenge\npending…');
  }

  // Hide the whole challenge panel (incl. the ⚡ icon) when nothing is active,
  // so it doesn't sit under the left player and unbalance the layout.
  const chPanel = $('ch-panel');
  if(chPanel){
    const anyBtn = ['btn-5ch','btn-no5ch','btn-13ch','btn-no13ch','btn-walkover','btn-wo-accept','btn-wo-reject']
      .some(id => { const el=$(id); return el && !el.classList.contains('hidden'); });
    const hasStatus = ($('ch-status')?.textContent||'').trim().length > 0;
    chPanel.style.display = (anyBtn || hasStatus) ? '' : 'none';
  }
}

function updateTurnLabel(gs){
  const ph = gs.phase;
  const tp = ph==='trick_play'||ph==='five_card_trick_play';
  if(tp){
    const exp = getExpected(gs);
    if(!exp){ setTxt('turn-lbl','—'); return; }
    const name = gs.players[exp]&&gs.players[exp].name || ('P'+exp);
    setTxt('turn-lbl', exp===G.myNum ? 'Your turn — tap a card to select' : 'Waiting for '+name+'…');
  } else if(ph==='five_card_challenge_window'){
    const myTeam = TEAM_OF[G.myNum];
    const rangTeam = gs.rangSelector ? TEAM_OF[gs.rangSelector] : null;
    if(myTeam!==rangTeam) setTxt('turn-lbl','Your team can call a 5-card challenge');
    else setTxt('turn-lbl','Opponents may call a 5-card challenge');
  } else if(ph==='five_card_challenge_pending'){
    const myTeam = TEAM_OF[G.myNum];
    const rangTeam = gs.rangSelector ? TEAM_OF[gs.rangSelector] : null;
    if(myTeam===rangTeam) setTxt('turn-lbl','Accept or reject the 5-card challenge');
    else setTxt('turn-lbl','Challenge placed — waiting for rang team to decide…');
  } else if(ph==='thirteen_card_challenge_window'){
    setTxt('turn-lbl','Any player can call a 13-card challenge');
  } else if(ph==='thirteen_card_challenge_pending'){
    const callerTeam = gs.thirteenCard&&gs.thirteenCard.callerNum ? TEAM_OF[gs.thirteenCard.callerNum] : null;
    const oppTeam = callerTeam==='A'?'B':'A';
    if(TEAM_OF[G.myNum]===oppTeam) setTxt('turn-lbl','Accept or reject the 13-card challenge');
    else setTxt('turn-lbl','Challenge declared — waiting for opponents to decide…');
  } else if(ph==='rang_selection'){
    const sn = (gs.rangSelector && gs.players[gs.rangSelector]&&gs.players[gs.rangSelector].name)||('P'+gs.rangSelector);
    setTxt('turn-lbl', sn+' is selecting Rang (trump)…');
  } else if(ph==='hand_over'||ph==='series_over'){
    setTxt('turn-lbl','Round over — see result');
  } else {
    setTxt('turn-lbl', ph.replace(/_/g,' '));
  }
}

let _wasMyTurn = false;
function flashYourTurn(){
  const old=document.querySelector('.turn-attention-flash');
  if(old) old.remove();
  const flash=document.createElement('div');
  flash.className='turn-attention-flash';
  flash.setAttribute('aria-hidden','true');
  document.body.appendChild(flash);
  setTimeout(()=>flash.remove(), 1500);
}
function updateActionBar(gs){
  const tp = gs.phase==='trick_play'||gs.phase==='five_card_trick_play';
  const myTurn = tp && getExpected(gs)===G.myNum;
  // Screen-edge flash once, at the moment it becomes your turn.
  if(myTurn && !_wasMyTurn){
    flashYourTurn();
  }
  _wasMyTurn = myTurn;
  if(!myTurn){ G.selectedId=null; hide('btn-confirm'); hide('btn-cancel'); renderHand(); }

  let hint = '';
  if(myTurn && G.hand.length>0){
    const led = gs.currentTrick&&gs.currentTrick.length>0 ? gs.currentTrick[0].card : null;
    const hasInvalid = G.hand.some(c=>!c.valid);
    if(hasInvalid && led) hint=`Must follow ${SUIT_SYM[led.suit]} ${SUIT_NAME[led.suit]} · grey = illegal`;
    else if(gs.aceJustWon===G.myNum) hint='Won with Ace — leading Ace again counts as 2';
    else hint = 'Select a card to play';
  }
  setTxt('my-hint', hint);
}

// ── Socket ────────────────────────────────────────────────────────────────────
function initSocket(){
  G.socket = io();

  G.socket.on('error', ({message})=>toast(message,true));

  G.socket.on('trial_room_created', ({roomCode,playerNum})=>{
    G.roomCode=roomCode; G.myNum=playerNum;
    setTxt('trial-code', roomCode);
    hide('panel-setup'); hide('panel-seats'); show('panel-trial');
    toast('Trial room ready — you are P1 with 3 bots');
  });

  G.socket.on('room_created', ({roomCode,playerNum,mode})=>{
    G.roomCode=roomCode; G.myNum=playerNum;
    if(mode==='random_teams'){
      G.roomMode='random_teams';
      setTxt('rand-code',roomCode);
      hide('panel-setup'); hide('panel-mode'); show('panel-random');
      show('rand-waiting'); hide('rand-draw'); hide('rand-seatpick'); hide('rand-startwrap');
      setTxt('rand-pool-count','1/4');
      return;
    }
    setTxt('disp-code',roomCode);
    hide('panel-setup'); show('panel-seats');
  });

  // ── RANDOM TEAMS: pool + draw + seat pick ──
  G.socket.on('joined_pool', ({roomCode})=>{
    G.roomCode=roomCode; G.roomMode='random_teams';
    setTxt('rand-code',roomCode);
    hide('panel-setup'); hide('panel-seats'); hide('panel-mode'); show('panel-random');
    show('rand-waiting'); hide('rand-draw'); hide('rand-seatpick'); hide('rand-startwrap');
  });

  G.socket.on('team_lobby_state', ({poolCount,poolNames})=>{
    setTxt('rand-pool-count', (poolCount||0)+'/4');
    const list=$('rand-pool-list');
    if(list) list.textContent = (poolNames||[]).join(' · ');
  });

  G.socket.on('team_draw_result', ({events,teamA,teamB})=>{
    hide('rand-waiting'); show('rand-draw');
    const log=$('rand-draw-log');
    if(log){
      log.innerHTML = (events||[]).map(ev=>{
        const red = (ev.card.suit==='hearts'||ev.card.suit==='diamonds');
        const sym = SUIT_SYM[ev.card.suit]||'';
        const ace = ev.card.rank==='A' ? ' style="color:#e6c878;font-weight:700"' : '';
        return '<div'+ace+'>'+ev.name+' drew <b'+(red?' style="color:#d40000"':'')+'>'+ev.card.rank+sym+'</b></div>';
      }).join('');
      log.scrollTop = log.scrollHeight;
    }
    setTxt('rand-teams','\uD83D\uDFE2 Team A: '+(teamA||[]).join(' & ')+'   \uD83D\uDFE0 Team B: '+(teamB||[]).join(' & '));
    if(typeof Snd!=='undefined' && Snd.shuffle) Snd.shuffle();
  });

  function showRandSeatPicker(team, options){
    G.myTeam=team; G.mySeatOptions=options||[];
    show('rand-seatpick'); show('rand-startwrap');
    setTxt('rand-seat-hint','You are Team '+team+' \u2014 pick P'+options[0]+' or P'+options[1]);
    document.querySelectorAll('.rand-seat-tile').forEach(function(tile){
      var num=parseInt(tile.dataset.num);
      var btn=tile.querySelector('.btn-rand-seat');
      if(options.indexOf(num)<0){ tile.style.opacity='0.35'; if(btn) btn.disabled=true; }
      else { tile.style.opacity='1'; if(btn) btn.disabled=false; }
    });
  }

  G.socket.on('you_choose_seat', ({team,options})=>{
    showRandSeatPicker(team, options);
    setTxt('rand-seat-status','All four players pick a seat within their team.');
  });

  G.socket.on('team_seat_chosen', ({chosenSeats,ready})=>{
    const seats = Object.values(chosenSeats||{});
    [1,2,3,4].forEach(function(n){ setTxt('rsp-'+n, seats.indexOf(n)>=0?'Taken':'Open'); });
    const startBtn=$('btn-rand-start');
    if(startBtn){
      startBtn.disabled = false;   // always allow Start (password gates bot-fill)
      setTxt('rand-seat-status', ready ? 'All seats picked \u2014 ready to start!' : 'Pick your seat, then press Start (bots fill the rest)\u2026');
    }
  });

  // Server asks for the admin password to start with bots (fewer than 4 humans)
  G.socket.on('need_start_password', ({reason})=>{
    const pw = prompt('Not all 4 seats are humans.\nEnter admin password to start with bots filling the empty seats:');
    if(pw===null) return;
    G._startPw = (pw||'').trim();
    G.socket.emit('start_with_bots', { password: G._startPw });
    G._startPw = undefined;
  });

  G.socket.on('your_team_seat', ({playerNum})=>{ G.myNum=playerNum; });
  G.socket.on('team_draw_seated', ({playerNum})=>{ G.myNum=playerNum; });

  G.socket.on('trial_random_teams_created', ({roomCode,myTeam,myOptions,draw})=>{
    G.roomCode=roomCode; G.roomMode='random_teams';
    setTxt('rand-code',roomCode);
    hide('panel-setup'); hide('panel-mode'); hide('panel-seats'); show('panel-random');
    hide('rand-waiting'); show('rand-draw');
    const log=$('rand-draw-log');
    if(log && draw && draw.events){
      log.innerHTML = draw.events.map(function(ev){
        var red=(ev.card.suit==='hearts'||ev.card.suit==='diamonds');
        var sym=SUIT_SYM[ev.card.suit]||'';
        var ace=ev.card.rank==='A'?' style="color:#e6c878;font-weight:700"':'';
        return '<div'+ace+'>'+ev.name+' drew <b'+(red?' style="color:#d40000"':'')+'>'+ev.card.rank+sym+'</b></div>';
      }).join('');
    }
    setTxt('rand-teams','\uD83D\uDFE2 Team A: '+(draw.teamA||[]).join(' & ')+'   \uD83D\uDFE0 Team B: '+(draw.teamB||[]).join(' & '));
    showRandSeatPicker(myTeam, myOptions);
    hide('rand-startwrap');
    setTxt('rand-seat-status','Pick your seat \u2014 the bots fill the rest and the game starts.');
  });


  G.socket.on('joined_room', ({roomCode,playerNum,reconnected})=>{
    G.roomCode=roomCode; G.myNum=playerNum;
    setTxt('disp-code',roomCode);
    hide('panel-setup'); show('panel-seats');
    if(reconnected){ toast('Reconnected!'); showGame(); }
  });

  G.socket.on('game_state', gs=>{
    applyState(gs);
  });

  G.socket.on('your_hand', ({hand,playerNum})=>{
    if(playerNum!==G.myNum) return;
    G.hand = hand;
    renderHand();
    // After rang selector TAKES their 5 cards → close m-take and show rang modal
    if(G.gs&&G.gs.phase==='rang_selection'&&G.myNum===G.gs.rangSelector&&hand.length===5){
      $('rang-hand').innerHTML = hand.map(c=>miniCardHTML(c)).join('');
      openModal('m-rang'); // openModal closes m-take automatically
    }
  });

  G.socket.on('all_players_joined', ()=>{
    const ls=$('lobby-status'); if(ls) ls.textContent = 'All 4 players joined! Starting…';
    const rs=$('rand-seat-status'); if(rs) rs.textContent = 'Starting game…';
  });

  G.socket.on('dealer_selection_result', ({dealer,rangSelector,events})=>{
    Snd.shuffle();
    showGame();
    openModal('m-dealer');
    $('dealer-log').innerHTML='';
    hide('dealer-result'); hide('btn-dealer-ok');
    let i=0;
    const log = $('dealer-log');
    function step(){
      if(i>=events.length){
        const gs = G.gs;
        const dn = gs?.players[dealer]?.name||`P${dealer}`;
        const sn = gs?.players[rangSelector]?.name||`P${rangSelector}`;
        $('dealer-result').textContent = `${dn} got the Jack! They deal. ${sn} selects Rang.`;
        show('dealer-result'); show('btn-dealer-ok');
        return;
      }
      const ev=events[i++];
      const pn = G.gs?.players[ev.playerNum]?.name||`P${ev.playerNum}`;
      const sym = SUIT_SYM[ev.card.suit];
      const isJ = ev.card.rank==='J';
      const d = document.createElement('div');
      d.className='dealer-log-entry';
      d.textContent=`${pn}: ${ev.card.rank}${sym}${isJ?' 🃏 JACK!':''}`;
      if(isJ) d.style.color='#fde68a';
      log.appendChild(d); log.scrollTop=log.scrollHeight;
      setTimeout(step, isJ?700:60);
    }
    setTimeout(step,400);
  });

  G.socket.on('cards_taken',({playerNum})=>{
    const n = G.gs?.players[playerNum]?.name||`P${playerNum}`;
    if(playerNum!==G.myNum) toast(`${n} took 5 cards — selecting Rang…`);
    if(!isHidden('m-take')) closeModal('m-take');
  });

  G.socket.on('rang_selected',({suit,name,symbol})=>{
    closeModal('m-rang'); closeModal('m-take');
    toast(`Rang: ${symbol} ${name}`);
  });

  G.socket.on('five_card_called',({callerNum,callerName})=>{
    Snd.challenge();
    closeModal('m-5ch');
    toast(`⚡ ${callerName} called 5-card challenge!`);
    G.partnerData=null;
  });

  G.socket.on('view_partner_cards', data=>{
    G.partnerData = data;
    G.viewingOwn = false; G.myViewUsed = false;
    const ph = G.gs && G.gs.phase;
    // Display partner view in the modal if it is currently open
    if(ph==='five_card_challenge_pending' && !isHidden('m-5ar')){
      displayPartnerView('fcar-pv','fcar-pv-lbl','fcar-phand');
    }
    if(ph==='thirteen_card_challenge_pending' && !isHidden('m-13ar')){
      displayPartnerView('tcar-pv','tcar-pv-lbl','tcar-phand');
    }
    // If modal not open yet, partnerData is stored and will be shown when modal opens
  });

  G.socket.on('five_card_vote_update',({votes})=>{
    if(G.gs){ G.gs.fiveCardVotes = votes; applyState(G.gs); }
  });
  G.socket.on('thirteen_card_vote_update',({votes})=>{
    if(G.gs){ G.gs.thirteenCardVotes = votes; applyState(G.gs); }
  });

  G.socket.on('five_card_accepted',({ledSuit,ledName})=>{
    closeAll(); G.partnerData=null;
    const myTeam = G.gs ? TEAM_OF[G.myNum] : null;
    const rangTeam = G.gs && G.gs.rangSelector ? TEAM_OF[G.gs.rangSelector] : null;
    const iCalled = G.gs && G.gs.fiveCard && G.gs.fiveCard.callerNum === G.myNum;
    if(iCalled){
      toast('Your 5-card challenge was ACCEPTED! Led suit: ' + SUIT_SYM[ledSuit] + ' ' + ledName);
    } else if(myTeam === rangTeam){
      toast('Challenge accepted by your team. Led suit: ' + SUIT_SYM[ledSuit] + ' ' + ledName);
    } else {
      toast('Partner\'s challenge accepted! Led suit: ' + SUIT_SYM[ledSuit] + ' ' + ledName);
    }
  });

  G.socket.on('five_card_rejected',({scoringTeam,points,rejecterName,callerName})=>{
    // Capture iCalled BEFORE closeAll clears state
    const iCalled = G.gs && G.gs.fiveCard && G.gs.fiveCard.callerNum === G.myNum;
    closeAll(); G.partnerData=null;
    if(iCalled){
      toast('Your 5-card challenge was REJECTED by ' + (rejecterName||'opponent') + '. Your team gets ' + points + ' pt!');
    } else {
      toast((rejecterName||'Rang team') + ' rejected the 5-card challenge. Team ' + scoringTeam + ' gets ' + points + ' pt.');
    }
  });

  G.socket.on('remaining_dealt',()=>{ Snd.shuffle(); toast('All 13 cards dealt — 13-card challenge window open'); });

  G.socket.on('five_card_declined_one',({playerNum,name,declines})=>{
    if(playerNum!==G.myNum) toast(name+' declined the 5-card challenge ('+declines.length+'/2)');
  });
  G.socket.on('five_card_all_declined',()=>{
    toast('Both players declined — dealing remaining cards…');
  });
  G.socket.on('thirteen_card_declined_one',({playerNum,name,declines})=>{
    if(playerNum!==G.myNum) toast(name+' declined 13-card challenge ('+declines.length+'/4)');
  });
  G.socket.on('thirteen_card_all_declined',({firstLeader})=>{
    const ln = (G.gs&&G.gs.players[firstLeader]&&G.gs.players[firstLeader].name)||('P'+firstLeader);
    toast('All players declined — '+ln+' leads the first trick!');
  });
  G.socket.on('walk_over_proposed',({proposerName,partnerName})=>{
    toast('🏳 '+proposerName+' proposed a WALK OVER — '+partnerName+' must decide');
  });
  G.socket.on('walk_over_rejected_by_partner',({responderName,proposerName,requestsLeft})=>{
    const left = (typeof requestsLeft==='number') ? ' ('+requestsLeft+' request'+(requestsLeft!==1?'s':'')+' left)' : '';
    toast(responderName+' rejected the walk over — play continues!'+left);
  });
  G.socket.on('walk_over_accepted',({walkOverTeam,scoringTeam,points})=>{
    toast('🏳 Team '+walkOverTeam+' walked over. Team '+scoringTeam+' gets +'+points+' pt.');
  });

  G.socket.on('series_reset',({byName})=>{
    closeAll();
    G.selectedId=null; G.partnerData=null; G.hand=[]; G.frozenTrick=null; G.freezeUntil=0;
    renderHand();
    toast('SERIES RESET by '+byName+' - scores 0:0. Finding new dealer...');
  });

  G.socket.on('scores_set',({byName,scoreA,scoreB})=>{
    toast('Scores updated by '+byName+' — Team A: '+scoreA+' · Team B: '+scoreB);
  });

  G.socket.on('new_series_votes',({votes})=>{
    const names = votes.map(n=>(G.gs&&G.gs.players[n]&&G.gs.players[n].name)||('P'+n)).join(', ');
    const el=$('series-votes');
    if(el) el.innerHTML='<div>Voted ('+votes.length+'/4): '+names+'</div>';
    toast('New series vote: '+votes.length+'/4');
  });

  G.socket.on('new_series_started',()=>{
    closeAll();
    G.selectedId=null; G.partnerData=null; G.hand=[]; G.frozenTrick=null; G.freezeUntil=0;
    renderHand();
    const btn=$('btn-new-game');
    if(btn) btn.textContent='Vote: Start New Series (all 4 must vote)';
    toast('New series started - scores 0:0. Finding dealer...');
  });

  G.socket.on('hand_reset',({byName,dealer,rangSelector})=>{
    closeAll();
    G.selectedId=null; G.partnerData=null; G.hand=[]; G.frozenTrick=null; G.freezeUntil=0;
    renderHand();
    const dn=(G.gs&&G.gs.players[dealer]&&G.gs.players[dealer].name)||('P'+dealer);
    const sn=(G.gs&&G.gs.players[rangSelector]&&G.gs.players[rangSelector].name)||('P'+rangSelector);
    toast('↻ '+byName+' reset the hand. '+dn+' deals, '+sn+' selects Rang. Scores kept.');
  });

  G.socket.on('thirteen_card_called',({callerName,newRang})=>{
    Snd.challenge();
    closeModal('m-13ch');
    toast(`⚡ ${callerName} declared 13-card challenge with ${SUIT_SYM[newRang]} ${SUIT_NAME[newRang]}!`);
    G.partnerData=null;
  });

  G.socket.on('thirteen_card_accepted',({newRang,newRangName,firstLeader})=>{
    closeAll(); G.partnerData=null;
    const ln = G.gs?.players[firstLeader]?.name||`P${firstLeader}`;
    toast(`Challenge accepted! Rang: ${SUIT_SYM[newRang]} ${newRangName}. ${ln} leads.`);
  });

  G.socket.on('thirteen_card_rejected',({scoringTeam,points,rejecterName,callerName})=>{
    // Capture iCalled BEFORE closeAll clears state
    const iCalled = G.gs && G.gs.thirteenCard && G.gs.thirteenCard.callerNum === G.myNum;
    closeAll(); G.partnerData=null;
    if(iCalled){
      toast('Your 13-card challenge was REJECTED by '+(rejecterName||'opponent')+'. Your team gets '+points+' pt!');
    } else {
      toast((rejecterName||'Opponent')+' rejected the 13-card challenge. Team '+scoringTeam+' gets '+points+' pt.');
    }
  });

  G.socket.on('play_started',({firstLeader})=>{
    closeAll();
    const ln = G.gs?.players[firstLeader]?.name||`P${firstLeader}`;
    toast(`${ln} leads the first trick`);
  });

  G.socket.on('card_played',({playerNum,playerName,card,aceDowngraded,revoke,complete,trickResult})=>{
    Snd.snap();
    if(aceDowngraded) toast(playerName+"'s Ace downgraded to 2 (ace rule)",true);
    if(revoke) toast('Revoke flagged: '+playerName+' may have played wrong suit!',true);
    G.selectedId=null; hide('btn-confirm'); hide('btn-cancel');
    if(complete&&trickResult){
      // ── FREEZE the completed trick for 5 seconds with winner banner ──
      const wn = (G.gs&&G.gs.players[trickResult.winner]&&G.gs.players[trickResult.winner].name)||('P'+trickResult.winner);
      G.frozenTrick = trickResult.completedTrick ? trickResult.completedTrick.trick : null;
      G.freezeUntil = Date.now() + TRICK_DISPLAY_MS;
      let banner = '🏆 '+wn+' wins trick '+(trickResult.completedTrick?trickResult.completedTrick.trickNum:'');
      if(trickResult.collected){
        const cn = (G.gs&&G.gs.players[trickResult.collected.collector]&&G.gs.players[trickResult.collected.collector].name)||('P'+trickResult.collected.collector);
        banner += ' — collects '+trickResult.collected.count+' tricks!';
        setTimeout(()=>Snd.collect(), 200);
        // Fly the on-table cards toward the winning team's trick counter
        const winTeam = trickResult.winTeam || (TEAM_OF[trickResult.collected.collector]);
        setTimeout(()=>flyCardsToCounter(winTeam), TRICK_DISPLAY_MS - 900);
      }
      G.frozenWinnerName = banner;
      if(G.gs) updateTrickArea(G.gs);
      // Un-freeze after display time
      setTimeout(()=>{
        G.frozenTrick=null; G.frozenWinnerName='';
        if(G.gs) updateTrickArea(G.gs);
      }, TRICK_DISPLAY_MS + 50);
    }
  });

  G.socket.on('hand_over',({handResult,scores})=>{
    G.pendingResult=handResult;
    // Wait for trick freeze to finish (if active) so players see the last trick
    let wait = Math.max(400, G.freezeUntil - Date.now() + 400);
    const myTeam = TEAM_OF[G.myNum];
    const iWon = handResult && handResult.winnerTeam === myTeam;

    setTimeout(()=>{
      // GOON COAT: maximum drama, double boo
      if(handResult && handResult.type==='goon_coat'){
        const loserTeam = handResult.winnerTeam==='A'?'B':'A';
        showTaunt('GOON COAT!', 'Team '+loserTeam+' failed to collect a SINGLE set!', 3400);
        setTimeout(()=>Snd.boo(), 1500);
        setTimeout(()=>{
          if(iWon){ confetti(160); Snd.win(); }
          showHandResult(handResult,scores,G.gs);
        }, 3500);
        return;
      }
      // COAT: golden fireworks celebration
      if(handResult && handResult.type==='coat'){
        showCelebrate('COAT!', 'Team '+handResult.winnerTeam+' swept without conceding a set!', 2600);
        fireworks(5);
        setTimeout(()=>{
          if(iWon) confetti(80);
          showHandResult(handResult,scores,G.gs);
        }, 2700);
        return;
      }
      // 13-card challenge lost: roast
      if(handResult && handResult.type==='thirteen_card_fail'){
        const loserTeam = handResult.winnerTeam==='A'?'B':'A';
        showTaunt('CHALLENGE FLOPPED!', 'Team '+loserTeam+' promised all 13 tricks... and delivered a flop!', 2800);
        setTimeout(()=>{
          if(iWon){ confetti(100); Snd.win(); }
          showHandResult(handResult,scores,G.gs);
        }, 2900);
        return;
      }
      // 5-card challenge decided: roast the losing team
      if(handResult && handResult.type==='five_card_challenge'){
        const loserTeam = handResult.winnerTeam==='A'?'B':'A';
        showTaunt('NEECHY AJAO LOST!', 'Team '+loserTeam+' lost the 5-card gamble!', 2400);
        setTimeout(()=>{
          if(iWon){ confetti(90); Snd.win(); }
          showHandResult(handResult,scores,G.gs);
        }, 2500);
        return;
      }
      if(iWon){
        confetti(70);
        Snd.win();
      }
      if(handResult && handResult.seriesWinner && handResult.seriesWinner===myTeam){
        confetti(260);
      }
      showHandResult(handResult,scores,G.gs);
    }, wait);
  });

  G.socket.on('next_hand_started',({dealer,rangSelector})=>{
    closeAll(); // closes m-result too — new round is confirmed by server
    const btn = $('btn-next-hand');
    btn.disabled = false; btn.textContent = 'Start Next Round';
    G.selectedId=null; G.partnerData=null; G.hand=[]; renderHand();
    const dn = (G.gs&&G.gs.players[dealer]&&G.gs.players[dealer].name)||('P'+dealer);
    const sn = (G.gs&&G.gs.players[rangSelector]&&G.gs.players[rangSelector].name)||('P'+rangSelector);
    const isRangSel = G.myNum===rangSelector;
    if(isRangSel){
      toast('New round — You are the Rang Selector! Pick top 5 or cut the deck.');
    } else {
      toast('New round — '+dn+' deals. '+sn+' is selecting Rang (trump)...');
    }
    // m-take will open for rang selector via applyState when game_state arrives
  });

  G.socket.on('player_disconnected',({playerNum,name})=>{
    setTxt('dc-msg',`${name} (P${playerNum}) disconnected. Waiting up to 3 min…`);
    setTxt('dc-room',`To rejoin: enter name "${name}" and room code ${G.roomCode||''}`);
    show('m-dc');
  });

  G.socket.on('player_reconnected',({playerNum,name})=>{
    hide('m-dc'); toast(`${name} reconnected!`);
  });

  G.socket.on('player_timeout',({playerNum,name})=>{
    setTxt('dc-msg',`${name} (P${playerNum}) timed out. Game paused.`);
  });
}

// ── Hand result modal ─────────────────────────────────────────────────────────
function showHandResult(result,scores,gs){
  if(!result) return;
  openModal('m-result');

  const labels = {
    normal_win:          {t:'Hand Complete',              c:'#16a34a'},
    coat:                {t:'Coat! (2 pts)',               c:'#f59e0b'},
    goon_coat:           {t:'Goon Coat / Shit! (3 pts)',   c:'#dc2626'},
    five_card_challenge: {t:'5-Card Challenge Won! (3 pts)',c:'#7c3aed'},
    thirteen_card_win:   {t:'13-Card Challenge Won! (5 pts)',c:'#7c3aed'},
    thirteen_card_fail:  {t:'13-Card Challenge Failed!',   c:'#dc2626'},
    challenge_rejected:  {t:'Challenge Rejected (1 pt)',   c:'#ea580c'},
    walk_over:           {t:'Walk Over 🏳 (1 pt)',          c:'#ea580c'},
  };

  const info = labels[result.type] || {t:'Round Over', c:'#9ca3af'};
  const wt = result.winnerTeam;
  const wtPlayers = gs ? [1,2,3,4].filter(n=>TEAM_OF[n]===wt).map(n=>gs.players[n]?.name||'P'+n).join(' & ') : '';

  setTxt('hr-title','Round Over');

  let extraLines = '';
  if(result.type === 'challenge_rejected') {
    extraLines = '<div style="color:#fb923c;margin-top:4px">'
      + result.rejecterName + ' rejected the ' + result.challengeType + ' challenge called by ' + result.callerName + '.<br>'
      + result.callerName + "'s team gets <strong>+" + result.points + '</strong> point for the rejection.</div>';
  } else if(result.type === 'coat') {
    extraLines = '<div style="color:#f59e0b">Coat: rang team won and opponents never collected a single set!</div>';
  } else if(result.type === 'goon_coat') {
    extraLines = '<div style="color:#fca5a5">Goon Coat: rang team never collected a single set!</div>';
  } else if(result.type === 'thirteen_card_win') {
    extraLines = '<div style="color:#a78bfa">Challengers swept all 13 tricks!</div>';
  } else if(result.type === 'thirteen_card_fail') {
    extraLines = '<div style="color:#fca5a5">Challengers failed — opponents collected a set.</div>';
  } else if(result.type === 'walk_over') {
    extraLines = '<div style="color:#fb923c">Team '+result.walkOverTeam+' conceded the hand ('+result.proposerName+' proposed, '+result.responderName+' accepted).</div>';
  }
  if(result.earlyEnd){
    extraLines += '<div style="color:#86efac;font-size:12px;margin-top:3px">Hand concluded early — the result was already decided.</div>';
  }

  var winsLine = result.type === 'challenge_rejected'
    ? '<div>Team ' + wt + ' (' + wtPlayers + ') gets the point.</div>'
    : '<div>Team ' + wt + ' wins this round — ' + wtPlayers + '</div>';

  var body = '<div class="hr-result-type" style="background:' + info.c + '22;color:' + info.c + ';border:1px solid ' + info.c + ';border-radius:8px;padding:10px;text-align:center;font-size:17px;font-weight:700">' + info.t + '</div>'
    + winsLine
    + '<div>Points awarded: <strong style="color:#4ade80">+' + result.points + '</strong></div>'
    + extraLines;
  $('hr-body').innerHTML = body;

  var rl = gs && gs.revokeLog;
  if(rl && rl.length > 0){
    $('hr-revoke').innerHTML = 'Revoke flagged: ' + rl.map(function(r){return 'P'+r.playerNum+' trick '+r.trickNum;}).join(', ');
    show('hr-revoke');
  } else {
    hide('hr-revoke');
  }

  setTxt('hr-score-a', 'A: ' + scores.A);
  setTxt('hr-score-b', 'B: ' + scores.B);

  var nd = gs && gs.nextDealer, ns = gs && gs.nextRangSelector;
  if(nd && ns && gs){
    var dn = (gs.players[nd] && gs.players[nd].name) || ('P'+nd);
    var sn = (gs.players[ns] && gs.players[ns].name) || ('P'+ns);
    var isMe = G.myNum === ns;
    setTxt('hr-next', 'Next dealer: ' + dn + '  —  Next Rang selector: ' + sn + (isMe ? '  (YOU — you will pick trump!)' : ''));
  }

  // Show Start Next Round button to ALL players
  var btn = $('btn-next-hand');
  btn.textContent = 'Start Next Round';
  btn.style.background = '#16a34a';
  btn.style.width = '100%';
  btn.style.padding = '12px';
  btn.style.fontSize = '15px';

  if(result.seriesWinner) setTimeout(function(){ showSeriesOver(result.seriesWinner, scores, gs); }, 2000);
}


function showSeriesOver(wt,scores,gs){
  openModal('m-series');
  setTxt('series-title',`Team ${wt} Wins the Series!`);
  const wPlayers = gs?[1,2,3,4].filter(n=>TEAM_OF[n]===wt).map(n=>gs.players[n]?.name||`P${n}`).join(' & '):'';
  $('series-body').innerHTML=`
    <div style="font-size:24px;color:#fde68a;font-weight:700">🏆 Team ${wt} 🏆</div>
    <div style="font-size:15px">${wPlayers}</div>
    <div style="margin-top:8px;font-size:13px;color:#9ca3af">Final score — A: ${scores.A} · B: ${scores.B}</div>
  `;
}

// ── Event bindings ────────────────────────────────────────────────────────────
function bindEvents(){

  // Create room
  $('btn-create').addEventListener('click',()=>{
    const name=$('inp-name').value.trim();
    if(!name) return toast('Enter your name first',true);
    G.myName=name;
    hide('panel-setup'); show('panel-mode');
  });

  // ── Mode picker ──
  $('btn-mode-seat').addEventListener('click',()=>{
    G.roomMode='select_seat';
    hide('panel-mode'); show('panel-seats');
  });
  $('btn-mode-random').addEventListener('click',()=>{
    G.roomMode='random_teams';
    G.socket.emit('create_room',{ name:G.myName, mode:'random_teams' });
  });
  $('btn-mode-back').addEventListener('click',()=>{ hide('panel-mode'); show('panel-setup'); });
  $('btn-rand-back').addEventListener('click',()=>{ hide('panel-random'); show('panel-setup'); });
  $('btn-rand-copy').addEventListener('click',()=>{
    const url = location.origin + '?room=' + encodeURIComponent(G.roomCode);
    navigator.clipboard?.writeText(url); toast('Room link copied');
  });

  // Join room
  $('btn-join').addEventListener('click',()=>{
    const name=$('inp-name').value.trim();
    const suffix=$('inp-code').value.trim().toUpperCase();
    if(!name) return toast('Enter your name first',true);
    if(!suffix || suffix.length<4) return toast('Enter the 4-character room code',true);
    const code='RANG-'+suffix;
    G.myName=name; G.roomCode=code;
    // Ask the server what mode this room is, then route
    G.socket.emit('query_room_mode',{ roomCode:code });
  });

  G.socket.on('room_mode_result', ({exists,mode,phase})=>{
    if(!exists) return toast('Room not found. Check the code.',true);
    const gameInProgress = (phase && phase!=='lobby' && phase!=='team_draw');
    if(mode==='random_teams'){
      if(gameInProgress){
        // Game already started — reconnect by name to the player's original seat.
        // Do NOT show seat selection; the server restores their seat.
        G.socket.emit('join_lobby',{ roomCode:G.roomCode, name:G.myName });
        return;
      }
      // Lobby: join the pool
      G.socket.emit('join_room',{ roomCode:G.roomCode, name:G.myName });
    } else {
      if(gameInProgress){
        // Select-seat room, game running → this is a RECONNECT. Match by name to
        // the original seat and drop straight back in — no seat picker.
        G.socket.emit('join_lobby',{ roomCode:G.roomCode, name:G.myName });
        return;
      }
      // Lobby: show the seat panel so a new player can pick an open seat.
      setTxt('disp-code',G.roomCode);
      hide('panel-setup'); show('panel-seats');
      G.socket.emit('join_lobby',{ roomCode:G.roomCode, name:G.myName });
    }
  });

  $('inp-name').addEventListener('keydown',e=>{if(e.key==='Enter'){ $('inp-code').value?$('btn-join').click():$('btn-create').click(); }});
  $('inp-code').addEventListener('keydown',e=>{if(e.key==='Enter') $('btn-join').click();});
  $('inp-code').addEventListener('input',e=>{ e.target.value=e.target.value.toUpperCase(); });

  // ── Trial / Overview (bots) ──
  $('btn-trial').addEventListener('click',()=>{
    const name=$('inp-name').value.trim() || 'You';
    const code = prompt('Enter developer trial code:');
    if(code===null) return;
    G.myName=name;
    const rt = confirm('OK = Random Teams trial (ace draw)\nCancel = Select Seat trial (you are P1)');
    if(rt){
      G.socket.emit('create_trial_random_teams',{ name, trialCode: code.trim() });
    } else {
      G.socket.emit('create_trial_room',{ name, trialCode: code.trim() });
    }
  });
  $('btn-start-trial').addEventListener('click',()=>{ G.socket.emit('start_with_bots', { password: (G._startPw||undefined) }); G._startPw=undefined; });
  $('btn-trial-back').addEventListener('click',()=>{ hide('panel-trial'); show('panel-setup'); });
  $('btn-trial-copy').addEventListener('click',()=>{
    const url = location.origin + '?room=' + encodeURIComponent(G.roomCode);
    navigator.clipboard?.writeText(url); toast('Trial room link copied');
  });

  // Random Teams seat-pick buttons
  document.querySelectorAll('.btn-rand-seat').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const num=parseInt(btn.dataset.num);
      G.myNum=num;                       // remember our chosen seat immediately
      G.socket.emit('choose_team_seat',{ seatNum:num });
      setTxt('rand-seat-status','You picked P'+num+'. Waiting for the other player…');
    });
  });
  $('btn-rand-start')?.addEventListener('click',()=>{
    G.socket.emit('start_with_bots', { password: (G._startPw||undefined) });
    G._startPw = undefined;
  });
  $('btn-rand-start-early')?.addEventListener('click',()=>{
    G.socket.emit('start_with_bots', { password: (G._startPw||undefined) });
    G._startPw = undefined;
  });

  // Seat buttons
  document.querySelectorAll('.btn-seat').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const num=parseInt(btn.dataset.num);
      G.myNum=num;
      if(G.roomCode){
        G.socket.emit('join_room',{roomCode:G.roomCode,name:G.myName,playerNum:num});
      } else {
        G.socket.emit('create_room',{name:G.myName,playerNum:num});
      }
    });
  });

  // Copy link
  $('btn-copy').addEventListener('click',()=>{
    const url=`${location.origin}?room=${G.roomCode}`;
    navigator.clipboard?.writeText(url).then(()=>toast('Room link copied!')).catch(()=>{ prompt('Copy this link:',url); });
  });

  // Dealer ok
  $('btn-dealer-ok').addEventListener('click',()=>{
    closeModal('m-dealer');
    if(G.gs?.rangSelector===G.myNum) openModal('m-take');
  });

  // Take cards
  $('btn-top5').addEventListener('click',()=>G.socket.emit('take_cards',{cutAt:null}));
  $('btn-cut').addEventListener('click',()=>{
    const cut=parseInt($('inp-cut').value)||26;
    G.socket.emit('take_cards',{cutAt:cut});
  });

  // Select rang (in m-rang)
  document.querySelectorAll('#m-rang .btn-suit').forEach(btn=>{
    btn.addEventListener('click',()=>{
      G.socket.emit('select_rang',{suit:btn.dataset.suit});
      closeModal('m-rang');
    });
  });

  // Challenge panel
  $('btn-5ch').addEventListener('click',()=>{
    // Populate hand for selection
    $('fch-hand').innerHTML='';
    G.fchSelectedId=null; hide('btn-fch-ok');
    G.hand.forEach(c=>{
      const div=document.createElement('div');
      div.innerHTML=miniCardHTML(c);
      const hc=div.firstChild;
      hc.style.cursor='pointer';
      hc.dataset.id=c.id;
      hc.addEventListener('click',()=>{
        $('fch-hand').querySelectorAll('.hand-card').forEach(e=>e.classList.remove('selected'));
        hc.classList.add('selected');
        G.fchSelectedId=c.id;
        show('btn-fch-ok');
      });
      $('fch-hand').appendChild(hc);
    });
    openModal('m-5ch');
  });

  $('btn-13ch').addEventListener('click',()=>openModal('m-13ch'));
  $('btn-no5ch').addEventListener('click',()=>{
    if($('btn-no5ch').classList.contains('declined')) return;
    G.socket.emit('five_card_no_challenge');
  });
  $('btn-no13ch').addEventListener('click',()=>{
    if($('btn-no13ch').classList.contains('declined')) return;
    G.socket.emit('thirteen_card_no_challenge');
  });

  // ── Mute toggle ──
  $('btn-mute').addEventListener('click',()=>{
    Snd.muted = !Snd.muted;
    $('btn-mute').textContent = Snd.muted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
  });

  // ── Walk over buttons ──
  $('btn-walkover').addEventListener('click',()=>{
    G.socket.emit('propose_walk_over');
  });
  $('btn-wo-accept').addEventListener('click',()=>{
    // Confirm before conceding — a walk-over ends the hand and gives opponents a point.
    if(!confirm('Accept the walk over? This CONCEDES the hand and gives the opponents 1 point. This cannot be undone.')) return;
    G.socket.emit('respond_walk_over',{accept:true});
  });
  $('btn-wo-reject').addEventListener('click',()=>{
    G.socket.emit('respond_walk_over',{accept:false});
  });

  // ── Hard reset button ──
  $('btn-reset').addEventListener('click',()=>{
    $('inp-reset-code').value='';
    openModal('m-reset');
  });
  $('btn-reset-ok').addEventListener('click',()=>{
    const code = $('inp-reset-code').value.trim();
    if(!code) return toast('Enter the reset code',true);
    G.socket.emit('reset_hand',{resetCode:code});
    closeModal('m-reset');
  });
  $('btn-reset-series').addEventListener('click',()=>{
    const code = $('inp-reset-code').value.trim();
    if(!code) return toast('Enter the reset code',true);
    G.socket.emit('reset_series',{resetCode:code});
    closeModal('m-reset');
  });
  const btnSetScore = $('btn-set-score');
  if(btnSetScore) btnSetScore.addEventListener('click',()=>{
    const code = $('inp-reset-code').value.trim();
    if(!code) return toast('Enter the reset code',true);
    const a = $('inp-score-a').value.trim();
    const b = $('inp-score-b').value.trim();
    if(a===''||b==='') return toast('Enter both Team A and Team B scores',true);
    G.socket.emit('set_scores',{resetCode:code, scoreA:a, scoreB:b});
    closeModal('m-reset');
  });
  $('btn-reset-cancel').addEventListener('click',()=>closeModal('m-reset'));
  $('inp-reset-code').addEventListener('keydown',e=>{if(e.key==='Enter')$('btn-reset-ok').click();});

  // 5-card challenge modal
  $('btn-fch-ok').addEventListener('click',()=>{
    if(!G.fchSelectedId) return toast('Select a card',true);
    G.socket.emit('call_five_card',{cardId:G.fchSelectedId});
    G.fchSelectedId=null; closeModal('m-5ch');
  });
  $('btn-fch-cancel').addEventListener('click',()=>{ G.fchSelectedId=null; closeModal('m-5ch'); });

  $('btn-5-accept').addEventListener('click',()=>{ G.socket.emit('vote_five_card',{vote:'accept'}); });
  $('btn-5-reject').addEventListener('click',()=>{ G.socket.emit('vote_five_card',{vote:'reject'}); });

  // 13-card challenge modal
  document.querySelectorAll('.suit-13').forEach(btn=>{
    btn.addEventListener('click',()=>{
      G.socket.emit('call_thirteen_card',{newRang:btn.dataset.suit});
      closeModal('m-13ch');
    });
  });
  $('btn-13ch-cancel').addEventListener('click',()=>closeModal('m-13ch'));
  $('btn-13-accept').addEventListener('click',()=>{ G.socket.emit('vote_thirteen_card',{vote:'accept'}); });
  $('btn-13-reject').addEventListener('click',()=>{ G.socket.emit('vote_thirteen_card',{vote:'reject'}); });

  // Confirm / cancel play
  $('btn-confirm').addEventListener('click',()=>{
    if(!G.selectedId) return;
    G.socket.emit('play_card',{cardId:G.selectedId});
    G.selectedId=null; hide('btn-confirm'); hide('btn-cancel'); renderHand();
  });
  $('btn-cancel').addEventListener('click',()=>{ G.selectedId=null; hide('btn-confirm'); hide('btn-cancel'); renderHand(); });

  // Next hand
  $('btn-next-hand').addEventListener('click',()=>{
    G.socket.emit('next_hand');
    // Show waiting feedback; modal closes when next_hand_started arrives from server
    const btn = $('btn-next-hand');
    btn.textContent = 'Starting…';
    btn.disabled = true;
    setTimeout(()=>{ btn.disabled = false; btn.textContent = 'Start Next Round'; }, 3000);
  });

  // New series vote (all 4 must vote)
  $('btn-new-game').addEventListener('click',()=>{
    G.socket.emit('vote_new_series');
    $('btn-new-game').textContent = 'Voted - waiting for others...';
  });
}

// ── URL room code ─────────────────────────────────────────────────────────────
function checkUrl(){
  const p=new URLSearchParams(location.search).get('room');
  if(p){ $('inp-code').value = p.toUpperCase().replace('RANG-','').slice(0,4); }
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{ checkUrl(); initSocket(); bindEvents();
});

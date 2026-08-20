'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { RangEngine, SUIT_NAMES, SUIT_SYMBOLS, TEAM_OF, NEXT_P, PARTNER_OF } = require('./gameEngine');
const Bots = require('./bots');
const { anyBots } = Bots;
const TRIAL_CODE = 'hamza12333';

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors:{ origin:'*' }, pingTimeout:60000 });
const PORT = process.env.PORT || 3000;
const RESET_CODE = 'hamza12333';

app.use(express.static(path.join(__dirname,'../public')));
app.get('/', (req,res) => res.sendFile(path.join(__dirname,'../public/index.html')));

const rooms = {};
const DISCONNECT_MS = 3 * 60 * 1000;

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = 'RANG-';
  for (let i=0;i<4;i++) c += chars[Math.floor(Math.random()*chars.length)];
  return rooms[c] ? roomCode() : c;
}

function pub(engine, code) { io.to(code).emit('game_state', engine.publicState()); }

// Lobby-only broadcast for Random Teams: shows the join pool / draw progress
function pubLobby(engine, code) {
  const pool = engine.__joinPool || [];
  io.to(code).emit('team_lobby_state', {
    roomCode: code,
    poolCount: pool.length,
    poolNames: pool.map(p => p.name),
    phase: engine.state.phase,
  });
}

function hands(engine, code) {
  const s = engine.state;
  for (let n=1;n<=4;n++) {
    const p = s.players[n];
    if (p.socketId && p.connected) {
      io.to(p.socketId).emit('your_hand', { hand: engine.getValidCards(n), playerNum:n });
    }
  }
}

function toPlayer(engine, pNum, event, data) {
  const p = engine.state.players[pNum];
  if (p.socketId && p.connected) io.to(p.socketId).emit(event, data);
}

function broadcast(engine, code) { pub(engine, code); hands(engine, code); }

// ── BOT DRIVER (trial mode only) ──────────────────────────────────────────────
// Steps bots one action at a time with a natural delay, emitting the SAME socket
// events a human move would, so the client animates and shows results normally.
// Never touches any game rule — bots act only through public engine methods.
const botTimers = {};
function runBots(engine, code) {
  if (!anyBots(engine)) return;
  if (botTimers[code]) return;
  const tick = () => {
    botTimers[code] = null;
    const eng = rooms[code];
    if (!eng || !anyBots(eng)) return;
    const info = stepBotOne(eng, code);   // performs one bot action + emits events
    if (info.acted) {
      botTimers[code] = setTimeout(tick, info.delay || 800);
    } else {
      // No bot action this pass. If it's STILL a bot's turn to play (e.g. an edge
      // case left the loop idle), retry shortly so the game can never freeze on a
      // bot. Only reschedules while a bot genuinely owes an action.
      if (botOwesAction(eng)) {
        botTimers[code] = setTimeout(tick, 900);
      }
    }
  };
  botTimers[code] = setTimeout(tick, 800);
}

// True if a bot currently owes an action (its turn to play, or a bot vote/decision
// is outstanding) — used by the watchdog so the bot loop never permanently stalls.
function botOwesAction(engine) {
  const s = engine.state;
  const isBot = (n) => engine.__bots && engine.__bots.has(n);
  const ph = s.phase;
  if (ph === 'trick_play' || ph === 'five_card_trick_play') {
    let cur;
    if (s.currentTrick.length === 0) cur = s.currentLeader;
    else cur = NEXT_P[s.currentTrick[s.currentTrick.length-1].playerNum];
    return isBot(cur);
  }
  if (ph === 'rang_selection') return isBot(s.rangSelector);
  if (ph === 'five_card_challenge_window' || ph === 'five_card_challenge_pending' ||
      ph === 'thirteen_card_challenge_window' || ph === 'thirteen_card_challenge_pending') {
    return [1,2,3,4].some(n => isBot(n));
  }
  if (s.walkOver && s.walkOver.pending) {
    const partner = PARTNER_OF[s.walkOver.proposerNum];
    return isBot(partner);
  }
  return false;
}

// Perform exactly one bot action and emit matching events. Returns {acted, delay}.
function stepBotOne(engine, code) {
  const s = engine.state;
  // Per-hand memory: which bots already tried a walk-over (prevents re-propose loops)
  if (s.phase === 'rang_selection' || s.phase === 'lobby' || s.phase === 'dealer_selection') {
    engine.__woTried = null;
  }
  const NX = { 1:2, 2:3, 3:4, 4:1 };
  const isBotSeat = (n) => engine.__bots && engine.__bots.has(n);

  // WALK OVER pending resolves FIRST — the partner (if a bot) always decides,
  // so nothing else can proceed (or hang) while a walk over is outstanding.
  if (s.walkOver && s.walkOver.pending) {
    const partner = PARTNER_OF[s.walkOver.proposerNum];
    if (isBotSeat(partner)) {
      const accept = Bots.respondWalkOverDecision(engine, partner);
      const proposerName = s.players[s.walkOver.proposerNum]?.name || ('P'+s.walkOver.proposerNum);
      const responderName = s.players[partner].name;
      const r = engine.respondWalkOver(partner, accept);
      if (r.ok) {
        if (!r.accepted) {
          io.to(code).emit('walk_over_rejected_by_partner', { responderName, proposerName, requestsLeft: r.requestsLeft });
          broadcast(engine, code);
          return { acted:true, delay:700 };
        }
        io.to(code).emit('walk_over_accepted', {
          walkOverTeam:r.walkOverTeam, scoringTeam:r.scoringTeam,
          proposerName, responderName, points:r.points,
        });
        broadcast(engine, code);
        io.to(code).emit('hand_over', {
          handResult: { type:'walk_over', winnerTeam:r.scoringTeam, walkOverTeam:r.walkOverTeam,
            points:r.points, seriesWinner:r.seriesWinner, proposerName, responderName },
          scores: s.scores,
        });
        return { acted:true, delay:900 };
      }
    }
    // Partner is human → wait for their decision; bots do nothing else meanwhile.
    return { acted:false };
  }

  // RANG SELECTION
  if (s.phase === 'rang_selection' && isBotSeat(s.rangSelector)) {
    const sel = s.rangSelector;
    if (s.players[sel].hand.length === 0) {
      engine.rangSelectorTakeCards(sel, null);
      io.to(code).emit('cards_taken', { playerNum: sel });
      broadcast(engine, code);
      return { acted:true, delay:700 };
    }
    const counts = { spades:0, hearts:0, diamonds:0, clubs:0 };
    for (const c of s.players[sel].hand) counts[c.suit]++;
    let best='spades', n=-1;
    for (const suit of ['spades','hearts','diamonds','clubs']) if (counts[suit]>n){n=counts[suit];best=suit;}
    engine.selectRang(sel, best);
    io.to(code).emit('rang_selected', { suit:best, name:SUIT_NAMES[best], symbol:SUIT_SYMBOLS[best] });
    broadcast(engine, code);
    return { acted:true, delay:800 };
  }

  // 5-CARD WINDOW: bot CALLS the challenge if its 5 cards are dominant, else declines
  if (s.phase === 'five_card_challenge_window') {
    const rangTeam = TEAM_OF[s.rangSelector];
    const nonRang = [1,2,3,4].filter(n => TEAM_OF[n] !== rangTeam);
    for (const n of nonRang) {
      if (isBotSeat(n) && !s.fiveCardDeclines.includes(n)) {
        // Confident? Call Neechy Ajao, leading with the strongest card
        if (Bots.shouldCallFiveCard(engine, n)) {
          const hand = s.players[n].hand;
          const RV = Bots.RANK_VALUE;
          const trumps = hand.filter(c => c.suit === s.rang);
          const pickFrom = trumps.length ? trumps : hand;
          const lead = [...pickFrom].sort((a,b) => RV[b.rank] - RV[a.rank])[0];
          const cr = engine.callFiveCardChallenge(n, lead.id);
          if (cr.ok) {
            io.to(code).emit('five_card_called', {
              callerNum:n, callerName:s.players[n].name, callerTeam:TEAM_OF[n],
            });
            const rTeam = TEAM_OF[s.rangSelector];
            [1,2,3,4].filter(x => TEAM_OF[x] === rTeam).forEach(x => {
              toPlayer(engine, x, 'view_partner_cards', {
                partnerNum: PARTNER_OF[x], partnerName: s.players[PARTNER_OF[x]].name,
                partnerHand: engine.getHand(PARTNER_OF[x]), reason:'5-card challenge'
              });
            });
            broadcast(engine, code);
            return { acted:true, delay:1200 };
          }
        }
        const r = engine.declineFiveCard(n);
        const name = s.players[n].name;
        if (r.allDeclined) {
          io.to(code).emit('five_card_all_declined', {});
          io.to(code).emit('remaining_dealt', {});
        } else {
          io.to(code).emit('five_card_declined_one', { playerNum:n, name, declines:r.declines });
        }
        broadcast(engine, code);
        return { acted:true, delay:600 };
      }
    }
  }

  // 5-CARD PENDING: bots vote; if two bot votes MISMATCH, converge them
  if (s.phase === 'five_card_challenge_pending') {
    const rangTeam = TEAM_OF[s.rangSelector];
    const rangPlayers = [1,2,3,4].filter(n => TEAM_OF[n] === rangTeam);
    // Deadlock guard: both seats voted but disagree, and BOTH are bots → converge to reject (safe)
    const bothVoted = rangPlayers.every(n => s.fiveCardVotes[n]);
    const mismatch = bothVoted && s.fiveCardVotes[rangPlayers[0]] !== s.fiveCardVotes[rangPlayers[1]];
    if (mismatch) {
      // A bot seat converges. If its partner is HUMAN, the bot matches the human's
      // vote (respects the human). If both are bots, converge to reject (safe).
      const botSeat = rangPlayers.find(n => isBotSeat(n));
      const humanSeat = rangPlayers.find(n => !isBotSeat(n));
      const flipSeat = botSeat ?? rangPlayers[0];
      const target = humanSeat ? s.fiveCardVotes[humanSeat] : 'reject';
      const callerNum = s.fiveCard.callerNum;
      const r = engine.voteFiveCard(flipSeat, target);
      if (r.resolved === 'accept') {
        const res = r.result;
        io.to(code).emit('five_card_accepted', { revealedCard:res.revealedCard, ledSuit:res.ledSuit, ledName:SUIT_NAMES[res.ledSuit] });
        broadcast(engine, code);
      } else if (r.resolved === 'reject') {
        const res = r.result;
        const callerName = s.players[callerNum]?.name || ('P'+callerNum);
        io.to(code).emit('five_card_rejected', { scoringTeam:res.scoringTeam, points:res.points, rejecterName:'Both players', callerName });
        broadcast(engine, code);
        io.to(code).emit('hand_over', { handResult:{ type:'challenge_rejected', challengeType:'5-card', winnerTeam:res.scoringTeam, points:res.points, seriesWinner:res.seriesWinner, rejecterName:'the rang team', callerName }, scores:s.scores });
      } else {
        io.to(code).emit('five_card_vote_update', { votes:r.votes });
        broadcast(engine, code);
      }
      return { acted:true, delay:700 };
    }
    for (const n of rangPlayers) {
      if (isBotSeat(n) && !s.fiveCardVotes[n]) {
        const callerNum = s.fiveCard.callerNum;
        const myVote = Bots.voteFiveCard(engine, n);          // judged on its own cards
        const r = engine.voteFiveCard(n, myVote);
        if (!r.resolved) { io.to(code).emit('five_card_vote_update', { votes:r.votes }); broadcast(engine, code); return { acted:true, delay:600 }; }
        if (r.resolved === 'accept') {
          const res = r.result;
          io.to(code).emit('five_card_accepted', { revealedCard:res.revealedCard, ledSuit:res.ledSuit, ledName:SUIT_NAMES[res.ledSuit] });
          broadcast(engine, code);
          return { acted:true, delay:1000 };
        }
        const res = r.result;
        const callerName = s.players[callerNum]?.name || ('P'+callerNum);
        io.to(code).emit('five_card_rejected', { scoringTeam:res.scoringTeam, points:res.points, rejecterName:'Both players', callerName });
        broadcast(engine, code);
        io.to(code).emit('hand_over', { handResult:{ type:'challenge_rejected', challengeType:'5-card', winnerTeam:res.scoringTeam, points:res.points, seriesWinner:res.seriesWinner, rejecterName:'the rang team', callerName }, scores:s.scores });
        return { acted:true, delay:800 };
      }
    }
  }

  // 13-CARD WINDOW: bot CALLS only with an overwhelming hand, else declines
  if (s.phase === 'thirteen_card_challenge_window') {
    // First: a bot with a hopeless hand may request a walk over (before voting).
    if (!(s.walkOver && s.walkOver.pending)) {
      if (!engine.__woTried) engine.__woTried = new Set();
      for (const n of [1,2,3,4]) {
        if (isBotSeat(n) && !engine.__woTried.has(n)
            && !s.thirteenCardDeclines.includes(n)
            && Bots.shouldProposeWalkOver(engine, n)) {
          engine.__woTried.add(n);
          const wr = engine.proposeWalkOver(n);
          if (wr.ok) {
            io.to(code).emit('walk_over_proposed', {
              proposerNum:n, proposerName:s.players[n].name,
              partnerNum:wr.partnerNum, partnerName:s.players[wr.partnerNum].name,
            });
            broadcast(engine, code);
            return { acted:true, delay:1100 };
          }
        }
      }
    }
    for (const n of [1,2,3,4]) {
      if (isBotSeat(n) && !s.thirteenCardDeclines.includes(n) && !(s.walkOver && s.walkOver.pending)) {
        const callSuit = Bots.shouldCallThirteenCard(engine, n);
        if (callSuit) {
          const cr = engine.callThirteenCard(n, callSuit);
          if (cr.ok) {
            io.to(code).emit('thirteen_card_called', {
              callerNum:n, callerName:s.players[n].name, callerTeam:TEAM_OF[n],
              newRang:callSuit, newRangName:SUIT_NAMES[callSuit],
            });
            const oTeam = TEAM_OF[n] === 'A' ? 'B' : 'A';
            [1,2,3,4].filter(x => TEAM_OF[x] === oTeam).forEach(x => {
              toPlayer(engine, x, 'view_partner_cards', {
                partnerNum:PARTNER_OF[x], partnerName:s.players[PARTNER_OF[x]].name,
                partnerHand:engine.getHand(PARTNER_OF[x]), reason:'13-card challenge'
              });
            });
            broadcast(engine, code);
            return { acted:true, delay:1200 };
          }
        }
        const r = engine.declineThirteenCard(n);
        const name = s.players[n].name;
        if (r.allDeclined) {
          io.to(code).emit('thirteen_card_all_declined', { firstLeader:r.firstLeader });
          io.to(code).emit('play_started', { firstLeader:r.firstLeader });
        } else {
          io.to(code).emit('thirteen_card_declined_one', { playerNum:n, name, declines:r.declines });
        }
        broadcast(engine, code);
        return { acted:true, delay:600 };
      }
    }
  }

  // 13-CARD PENDING: bots vote; if two bot votes MISMATCH, converge them
  if (s.phase === 'thirteen_card_challenge_pending') {
    const cTeam = TEAM_OF[s.thirteenCard.callerNum];
    const oppTeam = cTeam === 'A' ? 'B' : 'A';
    const oppPlayers = [1,2,3,4].filter(n => TEAM_OF[n] === oppTeam);
    const bothVoted13 = oppPlayers.every(n => s.thirteenCardVotes[n]);
    const mismatch13 = bothVoted13 && s.thirteenCardVotes[oppPlayers[0]] !== s.thirteenCardVotes[oppPlayers[1]];
    if (mismatch13) {
      const botSeat = oppPlayers.find(n => isBotSeat(n));
      const humanSeat = oppPlayers.find(n => !isBotSeat(n));
      const flipSeat = botSeat ?? oppPlayers[0];
      const target = humanSeat ? s.thirteenCardVotes[humanSeat] : 'reject';
      const callerNum = s.thirteenCard.callerNum;
      const r = engine.voteThirteenCard(flipSeat, target);
      if (r.resolved === 'accept') {
        const res = r.result;
        io.to(code).emit('thirteen_card_accepted', { newRang:res.newRang, newRangName:SUIT_NAMES[res.newRang], firstLeader:res.firstLeader });
        broadcast(engine, code);
        return { acted:true, delay:700 };
      }
      if (r.resolved === 'reject') {
        const res = r.result;
        const callerName = s.players[callerNum]?.name || ('P'+callerNum);
        io.to(code).emit('thirteen_card_rejected', { scoringTeam:res.scoringTeam, points:res.points, rejecterName:'Both players', callerName });
        broadcast(engine, code);
        io.to(code).emit('hand_over', { handResult:{ type:'challenge_rejected', challengeType:'13-card', winnerTeam:res.scoringTeam, points:res.points, seriesWinner:res.seriesWinner, rejecterName:'the opposing team', callerName }, scores:s.scores });
      } else {
        io.to(code).emit('thirteen_card_vote_update', { votes:r.votes });
        broadcast(engine, code);
      }
      return { acted:true, delay:700 };
    }
    for (const n of oppPlayers) {
      if (isBotSeat(n) && !s.thirteenCardVotes[n]) {
        const callerNum = s.thirteenCard.callerNum;
        const myVote = Bots.voteThirteenCard(engine, n);       // judged on its own cards
        const r = engine.voteThirteenCard(n, myVote);
        if (!r.resolved) { io.to(code).emit('thirteen_card_vote_update', { votes:r.votes }); broadcast(engine, code); return { acted:true, delay:600 }; }
        if (r.resolved === 'accept') {
          const res = r.result;
          io.to(code).emit('thirteen_card_accepted', { newRang:res.newRang, newRangName:SUIT_NAMES[res.newRang], firstLeader:res.firstLeader });
          broadcast(engine, code);
          return { acted:true, delay:1000 };
        }
        const res = r.result;
        const callerName = s.players[callerNum]?.name || ('P'+callerNum);
        io.to(code).emit('thirteen_card_rejected', { scoringTeam:res.scoringTeam, points:res.points, rejecterName:'Both players', callerName });
        broadcast(engine, code);
        io.to(code).emit('hand_over', { handResult:{ type:'challenge_rejected', challengeType:'13-card', winnerTeam:res.scoringTeam, points:res.points, seriesWinner:res.seriesWinner, rejecterName:'the opposing team', callerName }, scores:s.scores });
        return { acted:true, delay:800 };
      }
    }
  }

  // TRICK PLAY: bot plays a legal card
  if (s.phase === 'trick_play' || s.phase === 'five_card_trick_play') {
    let cur;
    if (s.currentTrick.length === 0) cur = s.currentLeader;
    else cur = NX[s.currentTrick[s.currentTrick.length-1].playerNum];
    if (isBotSeat(cur)) {
      let choice = Bots.chooseCard(engine, cur);
      // FALLBACK: never let a bot freeze the game. If chooseCard returns nothing,
      // fall back to any legal card, then to any card the bot holds.
      if (!choice) {
        const valid = engine.getValidCards(cur).filter(c => c.valid);
        choice = valid[0] || engine.getValidCards(cur)[0] ||
                 (s.players[cur].hand && s.players[cur].hand[0]) || null;
      }
      if (choice) {
        let r = engine.playCard(cur, choice.id);
        // If that specific card was rejected, try every remaining card so we never stall.
        if (!r.ok) {
          for (const c of (s.players[cur].hand || [])) {
            r = engine.playCard(cur, c.id);
            if (r.ok) break;
          }
        }
        if (r.ok) {
          io.to(code).emit('card_played', {
            playerNum:cur, playerName:s.players[cur].name,
            card:r.card, aceDowngraded:r.aceDowngraded, revoke:r.revoke, complete:r.complete,
            trickResult: r.trickResult ? {
              winner:r.trickResult.winner, winTeam:r.trickResult.winTeam,
              completedTrick:r.trickResult.completedTrick, collected:r.trickResult.collected, isLast:r.trickResult.isLast,
            } : null,
            nextToPlay:r.nextToPlay,
          });
          broadcast(engine, code);
          if (r.complete && r.trickResult && r.trickResult.handResult) {
            io.to(code).emit('hand_over', { handResult:r.trickResult.handResult, scores:s.scores });
          }
          // Longer pause after a completed trick so the freeze/banner shows
          return { acted:true, delay: r.complete ? 5600 : 750 };
        }
      }
    }
  }

  return { acted:false };
}

io.on('connection', socket => {

  // ── lobby ──────────────────────────────────────────────────────────────────
  socket.on('create_room', ({ name, playerNum, mode }) => {
    const code = roomCode();
    rooms[code] = new RangEngine(code);
    const engine = rooms[code];
    engine.state.roomMode = (mode === 'random_teams') ? 'random_teams' : 'select_seat';

    if (engine.state.roomMode === 'random_teams') {
      // In Random Teams, players join a pool first (no fixed seat yet).
      engine.__joinPool = [{ socketId: socket.id, name: name || 'Player' }];
      socket.join(code);
      socket.data.roomCode = code; socket.data.playerNum = null; socket.data.poolName = name || 'Player';
      socket.emit('room_created', { roomCode: code, playerNum: null, mode: 'random_teams' });
      pubLobby(engine, code);
      return;
    }

    const r = engine.seatPlayer(socket.id, playerNum, name);
    if (!r.ok) return socket.emit('error', { message: r.reason });
    socket.join(code);
    socket.data.roomCode = code; socket.data.playerNum = playerNum;
    socket.emit('room_created', { roomCode: code, playerNum, mode: 'select_seat' });
    pub(engine, code);
  });

  // ── RANDOM TEAMS: a chooser picks seat P2 or P4 ────────────────────────────
  socket.on('choose_team_seat', ({ seatNum }) => {
    const { roomCode: code } = socket.data;
    const engine = rooms[code]; if (!engine) return;
    const r = engine.chooseTeamSeat(socket.id, Number(seatNum));
    if (!r.ok) return socket.emit('error', { message: r.reason });
    socket.data.playerNum = r.seatNum;
    socket.emit('your_team_seat', { playerNum: r.seatNum });

    // TRIAL: after the human picks, auto-seat their remaining bot teammate, then start.
    if (engine.__trialPendingBotSeat) {
      const td = engine.state.teamDraw;
      const humanOnA = td.teamA.includes(socket.id);
      const myTeam = humanOnA ? td.teamA : td.teamB;
      const seats = humanOnA ? [1,3] : [2,4];
      const botTeammate = myTeam.find(sid => String(sid).startsWith('BOT_'));
      const freeSeat = seats.find(s => s !== r.seatNum);
      if (botTeammate && freeSeat) engine.chooseTeamSeat(botTeammate, freeSeat);
      engine.__trialPendingBotSeat = false;

      const fin = engine.finalizeTeamDraw();
      if (!fin.ok) return socket.emit('error', { message: fin.reason });
      // mark bots + fix human socket seat
      const botSet = new Set();
      for (let n=1;n<=4;n++){ if (String(engine.state.players[n].socketId).startsWith('BOT_')) botSet.add(n); }
      engine.__bots = botSet;
      let mySeat=null; for (let n=1;n<=4;n++){ if (engine.state.players[n].socketId===socket.id) mySeat=n; }
      socket.data.playerNum = mySeat;
      io.to(mySeat && engine.state.players[mySeat].socketId).emit('team_draw_seated', { playerNum: mySeat });
      io.to(code).emit('all_players_joined', {});
      setTimeout(() => {
        io.to(code).emit('dealer_selection_result', fin.dealerResult);
        broadcast(engine, code);
        runBots(engine, code);
      }, 400);
      return;
    }

    io.to(code).emit('team_seat_chosen', {
      chosenSeats: r.chosenSeats,
      ready: engine.teamSeatsReady(),
    });
    pubLobby(engine, code);

    // Bot-filled random teams: once every pending human has picked, finalize & start.
    if (typeof engine.__botsFinalizePending === 'number') {
      engine.__botsFinalizePending -= 1;
      if (engine.__botsFinalizePending <= 0) {
        engine.__botsFinalizePending = undefined;
        const fin = engine.finalizeTeamDraw();
        if (!fin.ok) return socket.emit('error', { message: fin.reason });
        engine.__bots = new Set();
        for (let n=1;n<=4;n++){ if (String(engine.state.players[n].socketId||'').startsWith('BOT_')) engine.__bots.add(n); }
        // Fix each human's socket seat number
        for (let n=1;n<=4;n++){
          const sid = engine.state.players[n].socketId;
          if (sid && !String(sid).startsWith('BOT_')){
            const sock = io.sockets.sockets.get(sid);
            if (sock) sock.data.playerNum = n;
            io.to(sid).emit('team_draw_seated', { playerNum: n });
          }
        }
        io.to(code).emit('all_players_joined', {});
        setTimeout(() => {
          io.to(code).emit('dealer_selection_result', fin.dealerResult);
          broadcast(engine, code);
          runBots(engine, code);
        }, 500);
      }
    }
  });

  // ── RANDOM TEAMS: host presses Start once both choosers picked ─────────────
  socket.on('start_random_teams', () => {
    const { roomCode: code } = socket.data;
    const engine = rooms[code]; if (!engine) return;
    if (engine.state.phase !== 'team_draw') return;
    if (!engine.teamSeatsReady()) return socket.emit('error', { message: 'Both players must pick different seats first.' });
    const fin = engine.finalizeTeamDraw();
    if (!fin.ok) return socket.emit('error', { message: fin.reason });
    // Authoritatively tell each seated human which seat they got, and update their
    // socket.data so future actions carry the right playerNum.
    for (let n=1;n<=4;n++){
      const sid = engine.state.players[n].socketId;
      if (sid && !String(sid).startsWith('BOT_')) {
        const sock = io.sockets.sockets.get(sid);
        if (sock) sock.data.playerNum = n;
        io.to(sid).emit('team_draw_seated', { playerNum: n });
      }
    }
    io.to(code).emit('all_players_joined', {});
    // Small delay so every client applies its seat number before the game renders
    setTimeout(() => {
      io.to(code).emit('dealer_selection_result', fin.dealerResult);
      broadcast(engine, code);
      runBots(engine, code);
    }, 400);
  });

  // ── TRIAL ROOM (dev mode): you + 3 bots, password-protected ────────────────
  socket.on('create_trial_room', ({ name, trialCode }) => {
    if (trialCode !== TRIAL_CODE) {
      return socket.emit('error', { message: 'Wrong trial code.' });
    }
    const code = roomCode();
    rooms[code] = new RangEngine(code);
    const engine = rooms[code];
    // Human takes seat P1. Other seats stay OPEN so friends can join via the code;
    // any seats still empty when the host presses "Start" get filled by bots.
    engine.seatPlayer(socket.id, 1, name || 'You');
    engine.__bots = new Set();              // no bots yet — seats are open
    engine.__trialHost = socket.id;
    engine.__botFillOnStart = true;         // flag: fill empty seats with bots at start
    engine.state.roomMode = 'select_seat';  // friends joining by code pick an open seat
    socket.join(code);
    socket.data.roomCode = code; socket.data.playerNum = 1;
    socket.emit('trial_room_created', { roomCode: code, playerNum: 1 });
    pub(engine, code);
  });

  // Start the trial (or any shared room the trial host controls)
  socket.on('start_trial', () => {
    const { roomCode: code } = socket.data;
    const engine = rooms[code]; if (!engine) return;
    if (engine.state.phase !== 'lobby') return;
    // Fill any seats that are still empty with bots, so the host can start with
    // 1-3 humans + bots for the rest.
    if (engine.__botFillOnStart) {
      const botNames = { 1:'Bot One', 2:'Bot Bilal', 3:'Bot Ahmed', 4:'Bot Sara' };
      engine.__bots = engine.__bots || new Set();
      for (const n of [1,2,3,4]) {
        const pl = engine.state.players[n];
        const taken = pl && pl.name && pl.socketId && !String(pl.socketId).startsWith('BOT_');
        if (!taken) {
          engine.state.players[n].name = botNames[n];
          engine.state.players[n].socketId = 'BOT_' + n;
          engine.state.players[n].connected = true;
          engine.__bots.add(n);
        }
      }
    }
    io.to(code).emit('all_players_joined', {});
    setTimeout(() => {
      const result = engine.startDealerSelection();
      io.to(code).emit('dealer_selection_result', result);
      broadcast(engine, code);
      runBots(engine, code);
    }, 800);
  });

  // ── TRIAL ROOM in RANDOM TEAMS mode: you + 3 bots, ace draw decides teams ──
  socket.on('create_trial_random_teams', ({ name, trialCode }) => {
    if (trialCode !== TRIAL_CODE) return socket.emit('error', { message: 'Wrong trial code.' });
    const code = roomCode();
    rooms[code] = new RangEngine(code);
    const engine = rooms[code];
    engine.state.roomMode = 'random_teams';
    const pool = [
      { socketId: socket.id, name: name || 'You' },
      { socketId: 'BOT_b1', name: 'Bot Bilal' },
      { socketId: 'BOT_b2', name: 'Bot Ahmed' },
      { socketId: 'BOT_b3', name: 'Bot Sara' },
    ];
    engine.__joinPool = pool;
    engine.__trialHost = socket.id;
    socket.join(code);
    socket.data.roomCode = code; socket.data.playerNum = null;

    const draw = engine.startTeamDraw(pool);
    // Which team is the human on, and which two seats can they choose?
    const humanOnA = draw.teamA.some(x => x.socketId === socket.id);
    const myOptions = humanOnA ? [1,3] : [2,4];
    const myTeam = humanOnA ? 'A' : 'B';

    // Bots auto-pick their team seats — but LEAVE the human's two options open so
    // the human can choose. For the human's team, the bot teammate takes the seat
    // the human does NOT end up picking (resolved on start). For the opposing team,
    // both bots pick their two seats now.
    const botTeamA = draw.teamA.filter(x => String(x.socketId).startsWith('BOT_'));
    const botTeamB = draw.teamB.filter(x => String(x.socketId).startsWith('BOT_'));
    if (humanOnA) {
      // opposing team B = 2 bots -> take 2 and 4
      engine.chooseTeamSeat(botTeamB[0].socketId, 2);
      engine.chooseTeamSeat(botTeamB[1].socketId, 4);
      // human's bot teammate waits; human picks 1 or 3 in UI
    } else {
      engine.chooseTeamSeat(botTeamA[0].socketId, 1);
      engine.chooseTeamSeat(botTeamA[1].socketId, 3);
    }

    engine.__trialPendingBotSeat = true; // flag: one bot teammate still needs a seat
    socket.emit('trial_random_teams_created', {
      roomCode: code,
      myTeam, myOptions,
      draw: {
        events: draw.events.map(ev => ({ name: ev.name, card: ev.card })),
        teamA: draw.teamA.map(x => x.name),
        teamB: draw.teamB.map(x => x.name),
      },
    });
    pubLobby(engine, code);
  });

  // Enter a room's lobby channel to view/select an open seat (used by friends
  // joining a select-seat or trial room by code). Does NOT take a seat yet.
  socket.on('join_lobby', ({ roomCode: code, name }) => {
    const engine = rooms[code];
    if (!engine) return socket.emit('error', { message:'Room not found. Check the room code.' });
    if (engine.state.phase !== 'lobby') {
      // Game already running: try name-based reconnect to a disconnected seat.
      const match = [1,2,3,4].find(n => {
        const pl = engine.state.players[n];
        return pl && pl.name && pl.name === name && !pl.connected && !(engine.__bots && engine.__bots.has(n));
      });
      if (match) {
        const r = engine.reconnect(socket.id, match);
        if (r.ok) {
          socket.join(code); socket.data.roomCode = code; socket.data.playerNum = match;
          socket.emit('joined_room', { roomCode:code, playerNum:match, reconnected:true });
          broadcast(engine, code);
          io.to(code).emit('player_reconnected', { playerNum:match, name: engine.state.players[match].name });
          return;
        }
      }
      return socket.emit('error', { message:'Could not rejoin. Make sure your name matches EXACTLY what you used in the room, and the game is still running.' });
    }
    socket.join(code); socket.data.roomCode = code; socket.data.poolName = name || 'Player';
    socket.emit('lobby_joined', { roomCode: code });
    pub(engine, code);   // send current state so the seat panel shows taken/open seats
  });

  socket.on('join_room', ({ roomCode: code, name, playerNum }) => {
    const engine = rooms[code];
    if (!engine) return socket.emit('error', { message:'Room not found. Check the room code.' });
    const s = engine.state;

    // ── RANDOM TEAMS room: join the pool (no seat yet) ──
    if (s.roomMode === 'random_teams' && s.phase === 'lobby') {
      engine.__joinPool = engine.__joinPool || [];
      // Dedupe by NAME (case-insensitive) so a refresh/rejoin with the same name
      // updates the existing pool slot instead of adding a duplicate (which would
      // wrongly inflate the count to 4 and lock out the real 4th player).
      const nm = (name || 'Player');
      const existing = engine.__joinPool.find(pp => (pp.name||'').toLowerCase() === nm.toLowerCase());
      if (existing) {
        existing.socketId = socket.id;   // update to the new socket (rejoin)
      } else if (engine.__joinPool.length < 4) {
        engine.__joinPool.push({ socketId: socket.id, name: nm });
      } else {
        // Pool already has 4 DIFFERENT names and this is a new name → genuinely full.
        return socket.emit('error', { message:'This room is full (4 players already joined).' });
      }
      socket.join(code); socket.data.roomCode = code; socket.data.playerNum = null; socket.data.poolName = nm;
      socket.emit('joined_pool', { roomCode: code });
      pubLobby(engine, code);

      if (engine.__joinPool.length === 4) {
        const draw = engine.startTeamDraw(engine.__joinPool);
        io.to(code).emit('team_draw_result', {
          events: draw.events.map(ev => ({ name: ev.name, card: ev.card })),
          teamA: draw.teamA.map(x => x.name),
          teamB: draw.teamB.map(x => x.name),
        });
        // Tell each player which team they're on and which two seats they may pick
        for (const x of draw.teamA) io.to(x.socketId).emit('you_choose_seat', { team:'A', options:[1,3] });
        for (const x of draw.teamB) io.to(x.socketId).emit('you_choose_seat', { team:'B', options:[2,4] });
        pubLobby(engine, code);
      }
      return;
    }

    // ── RANDOM TEAMS, draw already happening (team_draw): re-attach a returning
    // pool member by name so a refresh during seat-picking doesn't lock them out. ──
    if (s.roomMode === 'random_teams' && s.phase === 'team_draw') {
      const nm = (name || 'Player');
      const pm = (engine.__joinPool || []).find(pp => (pp.name||'').toLowerCase() === nm.toLowerCase());
      if (pm) {
        const oldSid = pm.socketId;
        pm.socketId = socket.id;
        socket.join(code); socket.data.roomCode = code; socket.data.poolName = nm;
        // Migrate the player's identity in the active draw from old socket to new,
        // so seat-picking (which keys off socketId) still recognizes them.
        const td = s.teamDraw;
        if (td && td.active && oldSid && oldSid !== socket.id) {
          td.pool = (td.pool||[]).map(sid => sid === oldSid ? socket.id : sid);
          td.teamA = (td.teamA||[]).map(sid => sid === oldSid ? socket.id : sid);
          td.teamB = (td.teamB||[]).map(sid => sid === oldSid ? socket.id : sid);
          if (td.names && td.names[oldSid]) { td.names[socket.id] = td.names[oldSid]; delete td.names[oldSid]; }
          if (td.chosenSeats && td.chosenSeats[oldSid] != null) { td.chosenSeats[socket.id] = td.chosenSeats[oldSid]; delete td.chosenSeats[oldSid]; }
        }
        // Re-send their team + seat options if the draw is active.
        if (td && td.active) {
          const nameOf = (sid) => (td.names[sid] || '').toLowerCase();
          let team = null, options = null;
          if (td.teamA.some(sid => nameOf(sid) === nm.toLowerCase())) { team='A'; options=[1,3]; }
          else if (td.teamB.some(sid => nameOf(sid) === nm.toLowerCase())) { team='B'; options=[2,4]; }
          if (team) socket.emit('you_choose_seat', { team, options });
        }
        socket.emit('joined_pool', { roomCode: code });
        pubLobby(engine, code);
        return;
      }
    }

    const p = s.players[playerNum];

    if (p && p.name && p.name === name && !p.connected) {
      const r = engine.reconnect(socket.id, playerNum);
      if (!r.ok) return socket.emit('error', { message: r.reason });
      socket.join(code); socket.data.roomCode = code; socket.data.playerNum = playerNum;
      socket.emit('joined_room', { roomCode:code, playerNum, reconnected:true });
      broadcast(engine, code);
      io.to(code).emit('player_reconnected', { playerNum, name: p.name });
      return;
    }

    // ── Reconnect by NAME only (Random Teams: player doesn't know their seat) ──
    // If the game is in progress and a seat holds this exact name but is
    // disconnected, auto-restore them to that seat — they only entered name + room.
    if (s.phase !== 'lobby') {
      const match = [1,2,3,4].find(n => {
        const pl = s.players[n];
        return pl && pl.name && pl.name === name && !pl.connected && !(engine.__bots && engine.__bots.has(n));
      });
      if (match) {
        const r = engine.reconnect(socket.id, match);
        if (!r.ok) return socket.emit('error', { message: r.reason });
        socket.join(code); socket.data.roomCode = code; socket.data.playerNum = match;
        socket.emit('joined_room', { roomCode:code, playerNum:match, reconnected:true });
        broadcast(engine, code);
        io.to(code).emit('player_reconnected', { playerNum:match, name: s.players[match].name });
        return;
      }
    }

    // Trial room: a human may take over a bot seat at any time
    if (engine.__bots && engine.__bots.has(playerNum)) {
      engine.__bots.delete(playerNum);
      engine.state.players[playerNum].name = name || ('P'+playerNum);
      engine.state.players[playerNum].socketId = socket.id;
      engine.state.players[playerNum].connected = true;
      engine.state.seats[socket.id] = playerNum;
      socket.join(code); socket.data.roomCode = code; socket.data.playerNum = playerNum;
      socket.emit('joined_room', { roomCode:code, playerNum, reconnected:false });
      io.to(code).emit('bot_replaced', { playerNum, name });
      broadcast(engine, code);
      runBots(engine, code); // in case a remaining bot is now on turn
      return;
    }

    if (s.phase !== 'lobby') return socket.emit('error', { message:'Game in progress. Rejoin with your exact name and seat.' });

    const r = engine.seatPlayer(socket.id, playerNum, name);
    if (!r.ok) return socket.emit('error', { message: r.reason });
    socket.join(code); socket.data.roomCode = code; socket.data.playerNum = playerNum;
    socket.emit('joined_room', { roomCode:code, playerNum, reconnected:false });
    pub(engine, code);

    if (engine.allSeated()) {
      io.to(code).emit('all_players_joined', {});
      setTimeout(() => {
        const result = engine.startDealerSelection();
        io.to(code).emit('dealer_selection_result', result);
        pub(engine, code);
      }, 1000);
    }
  });

  // ── START PLAYING (with bots filling empty seats) — both modes ─────────────
  // If all 4 seats/pool are humans: start immediately (no password).
  // If fewer than 4 humans: require the admin password, then fill the rest with
  // bots. Humans keep/choose their own seats; bots auto-take the remaining ones.
  socket.on('start_with_bots', ({ password }) => {
    const { roomCode: code } = socket.data;
    const engine = rooms[code]; if (!engine) return;
    const s = engine.state;
    const BOT_NAMES = ['Bot Bilal', 'Bot Ahmed', 'Bot Sara', 'Bot One'];

    // ── SELECT SEAT MODE ──────────────────────────────────────────────────────
    if ((s.roomMode || 'select_seat') === 'select_seat') {
      if (s.phase !== 'lobby') return;
      const humanSeats = [1,2,3,4].filter(n => {
        const pl = s.players[n];
        return pl && pl.name && pl.socketId && !String(pl.socketId).startsWith('BOT_');
      });
      if (humanSeats.length === 0) return socket.emit('error', { message:'Take a seat first.' });
      const emptySeats = [1,2,3,4].filter(n => {
        const pl = s.players[n];
        return !(pl && pl.name && pl.socketId);
      });
      if (emptySeats.length > 0) {
        // Not all humans → need the admin password
        if (password !== RESET_CODE) return socket.emit('need_start_password', { reason:'fill_bots' });
        engine.__bots = engine.__bots || new Set();
        let bi = 0;
        for (const n of emptySeats) {
          s.players[n].name = BOT_NAMES[bi++ % BOT_NAMES.length];
          s.players[n].socketId = 'BOT_' + n;
          s.players[n].connected = true;
          engine.__bots.add(n);
        }
      }
      io.to(code).emit('all_players_joined', {});
      setTimeout(() => {
        const result = engine.startDealerSelection();
        io.to(code).emit('dealer_selection_result', result);
        broadcast(engine, code);
        runBots(engine, code);
      }, 800);
      return;
    }

    // ── RANDOM TEAMS MODE ─────────────────────────────────────────────────────
    if (s.roomMode === 'random_teams') {
      // Human pool = everyone who joined that isn't a bot.
      let pool = (engine.__joinPool || []).filter(p => !String(p.socketId).startsWith('BOT_'));
      if (pool.length === 0) return socket.emit('error', { message:'No players have joined yet.' });

      // ── CASE 1: the ace draw already ran (e.g. all 4 humans joined → draw fired
      // automatically). Do NOT re-draw or re-shuffle. Just finalize with whatever
      // seats are chosen, or start immediately if all seats are already picked. ──
      if (engine.state.teamDraw && engine.state.teamDraw.active && !engine.state.teamDraw.done) {
        if (engine.teamSeatsReady()) {
          const fin = engine.finalizeTeamDraw();
          if (!fin.ok) return socket.emit('error', { message: fin.reason });
          engine.__bots = new Set();
          for (let n=1;n<=4;n++){ if (String(engine.state.players[n].socketId||'').startsWith('BOT_')) engine.__bots.add(n); }
          for (let n=1;n<=4;n++){
            const sid = engine.state.players[n].socketId;
            if (sid && !String(sid).startsWith('BOT_')){
              const sock = io.sockets.sockets.get(sid);
              if (sock) sock.data.playerNum = n;
              io.to(sid).emit('team_draw_seated', { playerNum: n });
            }
          }
          io.to(code).emit('all_players_joined', {});
          setTimeout(() => {
            io.to(code).emit('dealer_selection_result', fin.dealerResult);
            broadcast(engine, code);
            runBots(engine, code);
          }, 500);
        } else {
          // Draw done but not everyone picked a seat yet — nudge the un-picked humans.
          socket.emit('error', { message:'All players must pick a seat first.' });
        }
        return;
      }

      // ── CASE 2: draw has NOT run yet and we have fewer than 4 humans → need to
      // fill with bots (password required), then draw ONCE. ──
      if (pool.length < 4 && password !== RESET_CODE) {
        return socket.emit('need_start_password', { reason:'fill_bots' });
      }

      // Fill up to 4 with bots, run the ace draw (ONE time).
      const botIds = ['BOT_b1','BOT_b2','BOT_b3'];
      const fullPool = pool.slice();
      let bi = 0;
      while (fullPool.length < 4) { fullPool.push({ socketId: botIds[bi], name: BOT_NAMES[bi] }); bi++; }
      engine.__joinPool = fullPool;

      const draw = engine.startTeamDraw(fullPool);
      s.phase = 'team_draw';

      // Seat all bots now; each human still chooses their seat from their team options.
      const teamOpts = { A:[1,3], B:[2,4] };
      const pendingHumans = [];
      for (const teamKey of ['A','B']) {
        const members = teamKey==='A' ? draw.teamA : draw.teamB;
        const opts = teamOpts[teamKey].slice();
        const humans = members.filter(x => !String(x.socketId).startsWith('BOT_'));
        const bots   = members.filter(x =>  String(x.socketId).startsWith('BOT_'));
        // Bots take the trailing seats so humans keep first pick(s).
        const botSeats = opts.slice(humans.length);
        let k = 0;
        for (const b of bots) engine.chooseTeamSeat(b.socketId, botSeats[k++]);
        for (const h of humans) pendingHumans.push({ sid:h.socketId, team:teamKey, options:opts });
      }
      engine.__bots = new Set();
      for (let n=1;n<=4;n++){ if (String(s.players[n].socketId||'').startsWith('BOT_')) engine.__bots.add(n); }
      engine.__botsFinalizePending = pendingHumans.length; // how many humans still to pick

      io.to(code).emit('team_draw_result', {
        events: draw.events.map(ev => ({ name: ev.name, card: ev.card })),
        teamA: draw.teamA.map(x => x.name),
        teamB: draw.teamB.map(x => x.name),
      });
      for (const h of pendingHumans) io.to(h.sid).emit('you_choose_seat', { team:h.team, options:h.options });
      pubLobby(engine, code);
      return;
    }
  });

  socket.on('query_room_mode', ({ roomCode: code }) => {
    const engine = rooms[code];
    if (!engine) return socket.emit('room_mode_result', { exists:false });
    socket.emit('room_mode_result', {
      exists: true,
      mode: engine.state.roomMode || 'select_seat',
      phase: engine.state.phase,
    });
  });

  socket.on('change_name', ({ name }) => {
    const { roomCode: code, playerNum } = socket.data;
    if (!code||!playerNum) return;
    const engine = rooms[code];
    if (!engine || engine.state.phase !== 'lobby') return;
    engine.state.players[playerNum].name = name;
    pub(engine, code);
  });

  // ── rang selection ─────────────────────────────────────────────────────────
  socket.on('take_cards', ({ cutAt }) => {
    const { roomCode: code, playerNum } = socket.data;
    const engine = rooms[code]; if (!engine) return;
    const r = engine.rangSelectorTakeCards(playerNum, cutAt);
    if (!r.ok) return socket.emit('error', { message: r.reason });
    toPlayer(engine, playerNum, 'your_hand', { hand: engine.getValidCards(playerNum), playerNum });
    io.to(code).emit('cards_taken', { playerNum });
    pub(engine, code);
    runBots(engine, code);
  });

  socket.on('select_rang', ({ suit }) => {
    const { roomCode: code, playerNum } = socket.data;
    const engine = rooms[code]; if (!engine) return;
    const r = engine.selectRang(playerNum, suit);
    if (!r.ok) return socket.emit('error', { message: r.reason });
    io.to(code).emit('rang_selected', { suit, name: SUIT_NAMES[suit], symbol: SUIT_SYMBOLS[suit] });
    broadcast(engine, code);
    runBots(engine, code);
  });

  // ── 5-card challenge ───────────────────────────────────────────────────────
  socket.on('five_card_no_challenge', () => {
    const { roomCode: code, playerNum } = socket.data;
    const engine = rooms[code]; if (!engine) return;
    const r = engine.declineFiveCard(playerNum);
    if (!r.ok) return socket.emit('error', { message: r.reason });
    const name = engine.state.players[playerNum].name;
    if (r.allDeclined) {
      io.to(code).emit('five_card_all_declined', {});
      io.to(code).emit('remaining_dealt', {});
    } else {
      io.to(code).emit('five_card_declined_one', { playerNum, name, declines: r.declines });
    }
    broadcast(engine, code);
    runBots(engine, code);
  });

  socket.on('call_five_card', ({ cardId }) => {
    const { roomCode: code, playerNum } = socket.data;
    const engine = rooms[code]; if (!engine) return;
    const r = engine.callFiveCardChallenge(playerNum, cardId);
    if (!r.ok) return socket.emit('error', { message: r.reason });

    io.to(code).emit('five_card_called', {
      callerNum: playerNum, callerName: engine.state.players[playerNum].name,
      callerTeam: TEAM_OF[playerNum],
    });

    const rTeam = TEAM_OF[engine.state.rangSelector];
    [1,2,3,4].filter(n => TEAM_OF[n] === rTeam).forEach(n => {
      toPlayer(engine, n, 'view_partner_cards', {
        partnerNum: PARTNER_OF[n], partnerName: engine.state.players[PARTNER_OF[n]].name,
        partnerHand: engine.getHand(PARTNER_OF[n]), reason:'5-card challenge'
      });
    });
    broadcast(engine, code);
    runBots(engine, code);
  });

  socket.on('vote_five_card', ({ vote }) => {
    const { roomCode: code, playerNum } = socket.data;
    const engine = rooms[code]; if (!engine) return;
    const callerNum = engine.state.fiveCard.callerNum;
    const r = engine.voteFiveCard(playerNum, vote);
    if (!r.ok) return socket.emit('error', { message: r.reason });

    if (!r.resolved) {
      // Votes don't match yet (or partner hasn't voted) — update the team
      io.to(code).emit('five_card_vote_update', { votes: r.votes });
      broadcast(engine, code);
      return;
    }

    if (r.resolved === 'accept') {
      const res = r.result;
      io.to(code).emit('five_card_accepted', { revealedCard:res.revealedCard, ledSuit:res.ledSuit, ledName:SUIT_NAMES[res.ledSuit] });
      broadcast(engine, code);
      runBots(engine, code);
      return;
    }

    // resolved === 'reject'
    const res = r.result;
    const callerName = engine.state.players[callerNum]?.name || `P${callerNum}`;
    io.to(code).emit('five_card_rejected', { scoringTeam:res.scoringTeam, points:res.points, rejecterName:'Both players', callerName });
    broadcast(engine, code);
    io.to(code).emit('hand_over', {
      handResult: {
        type: 'challenge_rejected', challengeType: '5-card',
        winnerTeam: res.scoringTeam, points: res.points,
        seriesWinner: res.seriesWinner, rejecterName:'the rang team', callerName,
      },
      scores: engine.state.scores,
    });
  });


  // ── 13-card challenge ──────────────────────────────────────────────────────
  socket.on('thirteen_card_no_challenge', () => {
    const { roomCode: code, playerNum } = socket.data;
    const engine = rooms[code]; if (!engine) return;
    const r = engine.declineThirteenCard(playerNum);
    if (!r.ok) return socket.emit('error', { message: r.reason });
    const name = engine.state.players[playerNum].name;
    if (r.allDeclined) {
      io.to(code).emit('thirteen_card_all_declined', { firstLeader: r.firstLeader });
      io.to(code).emit('play_started', { firstLeader: r.firstLeader });
    } else {
      io.to(code).emit('thirteen_card_declined_one', { playerNum, name, declines: r.declines });
    }
    broadcast(engine, code);
    runBots(engine, code);
  });

  socket.on('call_thirteen_card', ({ newRang }) => {
    const { roomCode: code, playerNum } = socket.data;
    const engine = rooms[code]; if (!engine) return;
    const r = engine.callThirteenCard(playerNum, newRang);
    if (!r.ok) return socket.emit('error', { message: r.reason });

    io.to(code).emit('thirteen_card_called', {
      callerNum:playerNum, callerName:engine.state.players[playerNum].name,
      callerTeam:TEAM_OF[playerNum], newRang, newRangName:SUIT_NAMES[newRang],
    });

    const oTeam = TEAM_OF[playerNum] === 'A' ? 'B' : 'A';
    [1,2,3,4].filter(n => TEAM_OF[n] === oTeam).forEach(n => {
      toPlayer(engine, n, 'view_partner_cards', {
        partnerNum:PARTNER_OF[n], partnerName:engine.state.players[PARTNER_OF[n]].name,
        partnerHand:engine.getHand(PARTNER_OF[n]), reason:'13-card challenge'
      });
    });
    broadcast(engine, code);
    runBots(engine, code);
  });

  socket.on('vote_thirteen_card', ({ vote }) => {
    const { roomCode: code, playerNum } = socket.data;
    const engine = rooms[code]; if (!engine) return;
    const callerNum = engine.state.thirteenCard.callerNum;
    const r = engine.voteThirteenCard(playerNum, vote);
    if (!r.ok) return socket.emit('error', { message: r.reason });

    if (!r.resolved) {
      io.to(code).emit('thirteen_card_vote_update', { votes: r.votes });
      broadcast(engine, code);
      return;
    }

    if (r.resolved === 'accept') {
      const res = r.result;
      io.to(code).emit('thirteen_card_accepted', { newRang:res.newRang, newRangName:SUIT_NAMES[res.newRang], firstLeader:res.firstLeader });
      broadcast(engine, code);
      runBots(engine, code);
      return;
    }

    const res = r.result;
    const callerName = engine.state.players[callerNum]?.name || `P${callerNum}`;
    io.to(code).emit('thirteen_card_rejected', { scoringTeam:res.scoringTeam, points:res.points, rejecterName:'Both players', callerName });
    broadcast(engine, code);
    io.to(code).emit('hand_over', {
      handResult: {
        type: 'challenge_rejected', challengeType: '13-card',
        winnerTeam: res.scoringTeam, points: res.points,
        seriesWinner: res.seriesWinner, rejecterName:'the opposing team', callerName,
      },
      scores: engine.state.scores,
    });
  });


  // ── card play ──────────────────────────────────────────────────────────────
  socket.on('play_card', ({ cardId }) => {
    const { roomCode: code, playerNum } = socket.data;
    const engine = rooms[code]; if (!engine) return;
    const r = engine.playCard(playerNum, cardId);
    if (!r.ok) return socket.emit('error', { message: r.reason });

    io.to(code).emit('card_played', {
      playerNum, playerName:engine.state.players[playerNum].name,
      card:r.card, aceDowngraded:r.aceDowngraded, revoke:r.revoke,
      complete:r.complete,
      trickResult: r.trickResult ? {
        winner: r.trickResult.winner,
        winTeam: r.trickResult.winTeam,
        completedTrick: r.trickResult.completedTrick,
        collected: r.trickResult.collected,
        isLast: r.trickResult.isLast,
      } : null,
      nextToPlay:r.nextToPlay,
    });

    broadcast(engine, code);

    if (r.complete && r.trickResult && r.trickResult.handResult) {
      io.to(code).emit('hand_over', { handResult:r.trickResult.handResult, scores:engine.state.scores });
    }
    runBots(engine, code);
  });

  // ── WALK OVER ──────────────────────────────────────────────────────────────
  socket.on('propose_walk_over', () => {
    const { roomCode: code, playerNum } = socket.data;
    const engine = rooms[code]; if (!engine) return;
    const r = engine.proposeWalkOver(playerNum);
    if (!r.ok) return socket.emit('error', { message: r.reason });
    const pName = engine.state.players[playerNum].name;
    const partnerName = engine.state.players[r.partnerNum].name;
    io.to(code).emit('walk_over_proposed', {
      proposerNum: playerNum, proposerName: pName,
      partnerNum: r.partnerNum, partnerName,
    });
    broadcast(engine, code);
    runBots(engine, code);
  });

  socket.on('respond_walk_over', ({ accept }) => {
    const { roomCode: code, playerNum } = socket.data;
    const engine = rooms[code]; if (!engine) return;
    const r = engine.respondWalkOver(playerNum, !!accept);
    if (!r.ok) return socket.emit('error', { message: r.reason });
    const responderName = engine.state.players[playerNum].name;
    const proposerName = engine.state.players[r.proposerNum]?.name || `P${r.proposerNum}`;

    if (!r.accepted) {
      io.to(code).emit('walk_over_rejected_by_partner', { responderName, proposerName, requestsLeft: r.requestsLeft });
      broadcast(engine, code);
      runBots(engine, code);
      return;
    }

    io.to(code).emit('walk_over_accepted', {
      walkOverTeam: r.walkOverTeam, scoringTeam: r.scoringTeam,
      proposerName, responderName, points: r.points,
    });
    broadcast(engine, code);
    io.to(code).emit('hand_over', {
      handResult: {
        type: 'walk_over',
        winnerTeam: r.scoringTeam,
        walkOverTeam: r.walkOverTeam,
        points: r.points,
        seriesWinner: r.seriesWinner,
        proposerName, responderName,
      },
      scores: engine.state.scores,
    });
  });

  // ── next hand ──────────────────────────────────────────────────────────────
  socket.on('next_hand', () => {
    const { roomCode: code } = socket.data;
    const engine = rooms[code]; if (!engine) return;
    if (engine.state.phase === 'series_over') {
      return socket.emit('error', { message: 'Series is over! Start a new game.' });
    }
    if (engine.state.phase !== 'hand_over') {
      return socket.emit('error', { message: 'Cannot start next round right now.' });
    }
    const r = engine.startNextHand();
    io.to(code).emit('next_hand_started', { dealer:r.dealer, rangSelector:r.rangSelector });
    broadcast(engine, code);
    runBots(engine, code);
  });

  // ── SET SCORES (with code) — updates series score ONLY, hand untouched ─────
  socket.on('set_scores', ({ resetCode, scoreA, scoreB }) => {
    const { roomCode: code, playerNum } = socket.data;
    const engine = rooms[code]; if (!engine) return;
    if (resetCode !== RESET_CODE) {
      return socket.emit('error', { message: 'Wrong reset code.' });
    }
    const a = parseInt(scoreA, 10), b = parseInt(scoreB, 10);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0 || a > 99 || b > 99) {
      return socket.emit('error', { message: 'Enter valid scores (0–99).' });
    }
    engine.state.scores.A = a;
    engine.state.scores.B = b;
    const name = engine.state.players[playerNum]?.name || `P${playerNum}`;
    io.to(code).emit('scores_set', { byName: name, scoreA: a, scoreB: b });
    broadcast(engine, code);
  });

  // ── HARD RESET (with code) ─────────────────────────────────────────────────
  socket.on('reset_hand', ({ resetCode }) => {
    const { roomCode: code, playerNum } = socket.data;
    const engine = rooms[code]; if (!engine) return;
    if (resetCode !== RESET_CODE) {
      return socket.emit('error', { message: 'Wrong reset code.' });
    }
    const r = engine.resetHand();
    if (!r.ok) return socket.emit('error', { message: r.reason });
    const name = engine.state.players[playerNum]?.name || `P${playerNum}`;
    io.to(code).emit('hand_reset', {
      byName: name, dealer: r.dealer, rangSelector: r.rangSelector,
    });
    broadcast(engine, code);
    runBots(engine, code);
  });

  // ── RESET SERIES (with code) ───────────────────────────────────────────────
  socket.on('reset_series', ({ resetCode }) => {
    const { roomCode: code, playerNum } = socket.data;
    const engine = rooms[code]; if (!engine) return;
    if (resetCode !== RESET_CODE) {
      return socket.emit('error', { message: 'Wrong reset code.' });
    }
    const r = engine.resetSeries();
    const name = engine.state.players[playerNum]?.name || `P${playerNum}`;
    io.to(code).emit('series_reset', { byName: name });
    io.to(code).emit('dealer_selection_result', r);
    broadcast(engine, code);
    runBots(engine, code);
  });

  // ── NEW SERIES VOTE ────────────────────────────────────────────────────────
  socket.on('vote_new_series', () => {
    const { roomCode: code, playerNum } = socket.data;
    const engine = rooms[code]; if (!engine) return;
    const r = engine.voteNewSeries(playerNum);
    if (!r.ok) return socket.emit('error', { message: r.reason });
    if (r.all) {
      io.to(code).emit('new_series_started', {});
      io.to(code).emit('dealer_selection_result', r.result);
      broadcast(engine, code);
      runBots(engine, code);
    } else {
      io.to(code).emit('new_series_votes', { votes: r.votes });
      broadcast(engine, code);
    }
  });

  // ── disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const { roomCode: code, playerNum } = socket.data;
    if (!code||!playerNum) return;
    const engine = rooms[code]; if (!engine) return;
    engine.disconnect(socket.id);
    const p = engine.state.players[playerNum];
    io.to(code).emit('player_disconnected', { playerNum, name:p.name });
    p.disconnectTimer = setTimeout(() => {
      io.to(code).emit('player_timeout', { playerNum, name:p.name });
    }, DISCONNECT_MS);
  });
});

httpServer.listen(PORT, () => console.log(`Rang server on port ${PORT}`));

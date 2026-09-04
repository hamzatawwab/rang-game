'use strict';

const { randomInt } = require('crypto');

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const SUIT_SYMBOLS = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
const SUIT_NAMES = { spades: 'Hukam', hearts: 'Dil', diamonds: 'Eent', clubs: 'Chiri' };
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VALUE = {};
RANKS.forEach((r,i) => { RANK_VALUE[r] = i; });

const TEAM_OF    = { 1:'A', 2:'B', 3:'A', 4:'B' };
const NEXT_P     = { 1:2, 2:3, 3:4, 4:1 };
const PREV_P     = { 1:4, 2:1, 3:2, 4:3 };
const PARTNER_OF = { 1:3, 2:4, 3:1, 4:2 };

function buildDeck() {
  const d = [];
  for (const suit of SUITS)
    for (const rank of RANKS)
      d.push({ suit, rank, id: `${rank}_${suit}` });
  return d;
}

function shuffle(arr) {
  const d = [...arr];
  for (let i = d.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function cardBeats(challenger, current, ledSuit, rang) {
  const cR = challenger.suit === rang;
  const curR = current.suit === rang;
  if (cR && curR) return RANK_VALUE[challenger.rank] > RANK_VALUE[current.rank];
  if (cR) return true;
  if (curR) return false;
  const cL = challenger.suit === ledSuit;
  const curL = current.suit === ledSuit;
  if (cL && curL) return RANK_VALUE[challenger.rank] > RANK_VALUE[current.rank];
  if (cL) return true;
  return false;
}

function trickWinner(trick, ledSuit, rang) {
  let best = trick[0];
  for (let i = 1; i < trick.length; i++)
    if (cardBeats(trick[i].card, best.card, ledSuit, rang)) best = trick[i];
  return best.playerNum;
}

function freshState() {
  return {
    phase: 'lobby',
    players: {
      1: { name:'', socketId:null, connected:false, hand:[], disconnectTimer:null },
      2: { name:'', socketId:null, connected:false, hand:[], disconnectTimer:null },
      3: { name:'', socketId:null, connected:false, hand:[], disconnectTimer:null },
      4: { name:'', socketId:null, connected:false, hand:[], disconnectTimer:null },
    },
    seats: {},
    dealer: null,
    rangSelector: null,
    rang: null,
    scores: { A:0, B:0 },          // series points
    handScores: { A:0, B:0 },      // tricks COLLECTED this hand (per team)
    trickWins: { A:0, B:0 },       // tricks WON this hand (live counter, per team)
    centerPile: [],                // uncollected tricks: [{trickNum, winner, trick:[{playerNum,card}]}]
    currentTrick: [],
    currentLeader: null,
    trickNumber: 0,
    totalTricks: 13,
    lastTrickWinner: null,         // for consecutive-win detection (null = fresh streak)
    aceJustWon: null,              // player who won last trick with an Ace (leading-ace downgrade rule)
    fiveCard: { active:false, callerNum:null, faceDownCard:null, pending:false },
    thirteenCard: { active:false, callerNum:null, newRang:null, pending:false },
    fiveCardDeclines: [],          // playerNums of non-rang team who pressed No Challenge
    thirteenCardDeclines: [],      // playerNums who pressed No Challenge (need all 4)
    revokeLog: [],
    nextDealer: null,
    nextRangSelector: null,
    walkOver: { proposerNum:null, pending:false },
    walkOverRequests: {},
    fiveCardVotes: {},
    thirteenCardVotes: {},
    newSeriesVotes: [],
    dealDeck: [],
    // ── Random Teams mode (ace draw for teams) ──
    roomMode: 'select_seat',       // 'select_seat' (manual) or 'random_teams'
    teamDraw: {
      active: false,
      pool: [],                    // socketIds who joined, in join order
      names: {},                   // socketId -> name
      aceWinners: [],              // socketIds who drew aces (first two, different players)
      events: [],                  // draw log: [{socketId, name, card}]
      seatAssign: {},              // socketId -> seatNum (1/3 auto, 2/4 chosen)
      chosenSeats: {},             // socketId -> seatNum (for the two choosers)
      done: false,
    },
  };
}

class RangEngine {
  constructor(code) {
    this.roomCode = code;
    this.state = freshState();
  }

  // ── seats ──────────────────────────────────────────────────────────────────
  seatPlayer(socketId, pNum, name) {
    const p = this.state.players[pNum];
    if (p.socketId && p.connected && p.socketId !== socketId)
      return { ok:false, reason:'Seat already taken by a connected player' };
    const oldNum = this.state.seats[socketId];
    if (oldNum && oldNum !== pNum) {
      this.state.players[oldNum].socketId = null;
      this.state.players[oldNum].connected = false;
    }
    p.socketId = socketId; p.name = name || `P${pNum}`; p.connected = true;
    this.state.seats[socketId] = pNum;
    return { ok:true };
  }

  reconnect(socketId, pNum) {
    const p = this.state.players[pNum];
    if (!p.name) return { ok:false, reason:'Seat was never taken' };
    if (p.disconnectTimer) { clearTimeout(p.disconnectTimer); p.disconnectTimer = null; }
    if (p.socketId && p.socketId !== socketId) delete this.state.seats[p.socketId];
    p.socketId = socketId; p.connected = true;
    this.state.seats[socketId] = pNum;
    return { ok:true };
  }

  disconnect(socketId) {
    const pNum = this.state.seats[socketId];
    if (!pNum) return null;
    this.state.players[pNum].connected = false;
    return pNum;
  }

  allSeated() { return [1,2,3,4].every(n => this.state.players[n].name && this.state.players[n].socketId); }
  allConnected() { return [1,2,3,4].every(n => this.state.players[n].connected); }

  // ── dealer selection ───────────────────────────────────────────────────────
  startDealerSelection() {
    const s = this.state;
    s.phase = 'dealer_selection';
    const deck = shuffle(buildDeck());
    let cur = 1, events = [];
    for (let i = 0; i < deck.length; i++) {
      const card = deck[i];
      events.push({ playerNum: cur, card });
      if (card.rank === 'J') {
        s.dealer = cur;
        s.rangSelector = NEXT_P[cur];
        s.phase = 'rang_selection';
        s.dealDeck = shuffle(buildDeck());
        return { dealer: cur, rangSelector: s.rangSelector, events };
      }
      cur = NEXT_P[cur];
    }
    return this.startDealerSelection();
  }

  // ── RANDOM TEAMS: ace draw for team & seat assignment ──────────────────────
  // Players join a pool. Cards deal one at a time; the first TWO different players
  // to draw an ace become partners at P1 (first ace) and P3 (second ace). The
  // remaining two players then choose P2 and P4. After seating, dealer is found
  // by the normal jack draw.
  startTeamDraw(joinList) {
    const s = this.state;
    s.roomMode = 'random_teams';
    s.phase = 'team_draw';
    s.teamDraw = {
      active: true,
      pool: joinList.map(j => j.socketId),
      names: Object.fromEntries(joinList.map(j => [j.socketId, j.name])),
      aceWinners: [],
      events: [],
      teamA: [],        // socketIds on Team A (the two ace winners)
      teamB: [],        // socketIds on Team B (the other two)
      chosenSeats: {},  // socketId -> seatNum
      done: false,
    };
    const deck = shuffle(buildDeck());
    const td = s.teamDraw;
    let idx = 0, di = 0;
    while (td.aceWinners.length < 2 && di < deck.length) {
      const sid = td.pool[idx % td.pool.length];
      const card = deck[di++];
      td.events.push({ socketId: sid, name: td.names[sid], card });
      if (card.rank === 'A' && !td.aceWinners.includes(sid)) {
        td.aceWinners.push(sid);
      }
      idx++;
    }
    if (td.aceWinners.length < 2) return this.startTeamDraw(joinList);

    // Ace winners = Team A (seats P1/P3). Others = Team B (seats P2/P4).
    td.teamA = [...td.aceWinners];
    td.teamB = td.pool.filter(sid => !td.aceWinners.includes(sid));
    return {
      ok: true,
      events: td.events,
      teamA: td.teamA.map(sid => ({ socketId: sid, name: td.names[sid] })),
      teamB: td.teamB.map(sid => ({ socketId: sid, name: td.names[sid] })),
    };
  }

  // Any of the 4 picks a seat — but only one of the two seats allowed for their team.
  chooseTeamSeat(socketId, seatNum) {
    const s = this.state;
    const td = s.teamDraw;
    if (!td.active || s.phase !== 'team_draw') return { ok:false, reason:'Not in team draw' };
    const onA = td.teamA.includes(socketId);
    const onB = td.teamB.includes(socketId);
    if (!onA && !onB) return { ok:false, reason:'You are not in this draw' };
    const allowed = onA ? [1,3] : [2,4];
    if (!allowed.includes(seatNum)) return { ok:false, reason:`Your team must pick ${allowed[0]} or ${allowed[1]}` };
    const takenBy = Object.entries(td.chosenSeats).find(([sid,seat]) => seat === seatNum && sid !== socketId);
    if (takenBy) return { ok:false, reason:'That seat is taken' };
    td.chosenSeats[socketId] = seatNum;
    return { ok:true, socketId, seatNum, chosenSeats:{...td.chosenSeats},
             names: {...td.names}, teamA:[...td.teamA], teamB:[...td.teamB] };
  }

  // Ready when all 4 have chosen and all 4 seats (1,2,3,4) are distinctly filled.
  teamSeatsReady() {
    const td = this.state.teamDraw;
    const picks = td.pool.map(sid => td.chosenSeats[sid]).filter(Boolean);
    if (picks.length !== 4) return false;
    return new Set(picks).size === 4;
  }

  finalizeTeamDraw() {
    const s = this.state;
    const td = s.teamDraw;
    if (!this.teamSeatsReady()) return { ok:false, reason:'All four players must pick distinct seats' };

    s.seats = {};
    for (let n=1;n<=4;n++){ s.players[n].socketId=null; s.players[n].connected=false; s.players[n].name=''; s.players[n].hand=[]; }

    const place = (sid, seat) => {
      s.players[seat].socketId = sid;
      s.players[seat].name = td.names[sid];
      s.players[seat].connected = true;
      s.seats[sid] = seat;
    };
    // All four players placed by their own chosen seats
    for (const sid of td.pool) place(sid, td.chosenSeats[sid]);

    td.active = false; td.done = true;
    return { ok:true, dealerResult: this.startDealerSelection() };
  }

  // ── rang selection ─────────────────────────────────────────────────────────
  rangSelectorTakeCards(pNum, cutAt) {
    const s = this.state;
    if (pNum !== s.rangSelector) return { ok:false, reason:'Not the rang selector' };
    if (s.phase !== 'rang_selection') return { ok:false, reason:'Wrong phase' };
    let deck = [...s.dealDeck];
    if (cutAt && cutAt > 0 && cutAt < deck.length) {
      deck = [...deck.slice(cutAt), ...deck.slice(0, cutAt)];
    }
    const hand = deck.splice(0, 5);
    s.players[pNum].hand = hand;
    s.dealDeck = deck;
    return { ok:true, hand };
  }

  selectRang(pNum, suit) {
    const s = this.state;
    if (pNum !== s.rangSelector) return { ok:false, reason:'Not rang selector' };
    if (!SUITS.includes(suit)) return { ok:false, reason:'Invalid suit' };
    s.rang = suit;
    let cur = NEXT_P[pNum];
    while (cur !== pNum) {
      s.players[cur].hand = s.dealDeck.splice(0, 5);
      cur = NEXT_P[cur];
    }
    s.phase = 'five_card_challenge_window';
    s.fiveCardDeclines = [];
    return { ok:true };
  }

  // ── 5-card challenge: decline (No Challenge) ───────────────────────────────
  declineFiveCard(pNum) {
    const s = this.state;
    if (s.phase !== 'five_card_challenge_window') return { ok:false, reason:'Window closed' };
    const rangTeam = TEAM_OF[s.rangSelector];
    if (TEAM_OF[pNum] === rangTeam) return { ok:false, reason:'Only the non-rang team decides on the 5-card challenge' };
    if (s.fiveCardDeclines.includes(pNum)) return { ok:false, reason:'You already declined' };
    s.fiveCardDeclines.push(pNum);

    // Both non-rang players declined → deal remaining cards
    const nonRangPlayers = [1,2,3,4].filter(n => TEAM_OF[n] !== rangTeam);
    const allDeclined = nonRangPlayers.every(n => s.fiveCardDeclines.includes(n));
    if (allDeclined) {
      this.dealRemaining();
      return { ok:true, allDeclined:true, declines:[...s.fiveCardDeclines] };
    }
    return { ok:true, allDeclined:false, declines:[...s.fiveCardDeclines] };
  }

  // ── 5-card challenge: call ─────────────────────────────────────────────────
  callFiveCardChallenge(pNum, cardId) {
    const s = this.state;
    if (s.phase !== 'five_card_challenge_window') return { ok:false, reason:'Window closed' };
    if (TEAM_OF[pNum] === TEAM_OF[s.rangSelector]) return { ok:false, reason:'Rang team cannot challenge' };
    const hand = s.players[pNum].hand;
    const idx = hand.findIndex(c => c.id === cardId);
    if (idx === -1) return { ok:false, reason:'Card not in hand' };
    const card = hand.splice(idx, 1)[0];
    s.fiveCard = { active:true, callerNum:pNum, faceDownCard:card, pending:true };
    s.fiveCardVotes = {};
    s.phase = 'five_card_challenge_pending';
    return { ok:true, card };
  }

  // ── MUTUAL VOTING: both rang-team players must cast the SAME vote ──────────
  voteFiveCard(pNum, vote) {
    const s = this.state;
    if (s.phase !== 'five_card_challenge_pending') return { ok:false, reason:'No pending challenge' };
    if (TEAM_OF[pNum] !== TEAM_OF[s.rangSelector]) return { ok:false, reason:'Only the rang team votes' };
    if (vote !== 'accept' && vote !== 'reject') return { ok:false, reason:'Invalid vote' };
    s.fiveCardVotes[pNum] = vote;
    const team = [1,2,3,4].filter(n => TEAM_OF[n] === TEAM_OF[s.rangSelector]);
    const v1 = s.fiveCardVotes[team[0]], v2 = s.fiveCardVotes[team[1]];
    if (v1 && v2 && v1 === v2) {
      if (v1 === 'accept') {
        const r = this._resolveFiveCardAccept();
        return { ok:true, resolved:'accept', result:r, votes:{...s.fiveCardVotes} };
      }
      const r = this._resolveFiveCardReject();
      return { ok:true, resolved:'reject', result:r, votes:{...s.fiveCardVotes} };
    }
    return { ok:true, resolved:null, votes:{...s.fiveCardVotes} };
  }

  _resolveFiveCardReject() {
    const s = this.state;
    const cTeam = TEAM_OF[s.fiveCard.callerNum];
    s.scores[cTeam] += 1;
    const seriesWinner = s.scores.A >= 15 ? 'A' : s.scores.B >= 15 ? 'B' : null;
    s.phase = seriesWinner ? 'series_over' : 'hand_over';
    const nd = this._rotateAfterChallengeRejected(s.fiveCard.callerNum);
    s.nextDealer = nd.nextDealer; s.nextRangSelector = nd.nextRangSelector;
    return { ok:true, scoringTeam:cTeam, points:1, seriesWinner };
  }

  _resolveFiveCardAccept() {
    const s = this.state;
    s.fiveCard.pending = false;
    const revealed = s.fiveCard.faceDownCard;
    s.currentTrick = [{ playerNum: s.fiveCard.callerNum, card: revealed }];
    s.currentLeader = s.fiveCard.callerNum;
    s.trickNumber = 1; s.totalTricks = 5;
    s.centerPile = []; s.lastTrickWinner = null; s.aceJustWon = null;
    s.trickWins = { A:0, B:0 };
    s.phase = 'five_card_trick_play';
    return { ok:true, revealedCard:revealed, ledSuit:revealed.suit, nextToPlay:NEXT_P[s.fiveCard.callerNum] };
  }

  // ── deal remaining 32 cards ────────────────────────────────────────────────
  dealRemaining() {
    const s = this.state;
    for (let round = 0; round < 2; round++) {
      let cur = NEXT_P[s.dealer];
      for (let i = 0; i < 4; i++) {
        s.players[cur].hand.push(...s.dealDeck.splice(0, 4));
        cur = NEXT_P[cur];
      }
    }
    s.phase = 'thirteen_card_challenge_window';
    s.thirteenCardDeclines = [];
    s.trickNumber = 0; s.totalTricks = 13;
    s.centerPile = []; s.currentTrick = [];
    s.lastTrickWinner = null; s.aceJustWon = null;
    s.trickWins = { A:0, B:0 };
    return { ok:true };
  }

  // ── 13-card challenge: decline (No Challenge) ──────────────────────────────
  declineThirteenCard(pNum) {
    const s = this.state;
    if (s.phase !== 'thirteen_card_challenge_window') return { ok:false, reason:'Window closed' };
    if (s.walkOver && s.walkOver.pending) return { ok:false, reason:'A walk over is pending — resolve it first' };
    if (s.thirteenCardDeclines.includes(pNum)) return { ok:false, reason:'You already declined' };
    s.thirteenCardDeclines.push(pNum);

    const allDeclined = [1,2,3,4].every(n => s.thirteenCardDeclines.includes(n));
    if (allDeclined) {
      const r = this.startNormalPlay();
      return { ok:true, allDeclined:true, declines:[...s.thirteenCardDeclines], firstLeader:r.firstLeader };
    }
    return { ok:true, allDeclined:false, declines:[...s.thirteenCardDeclines] };
  }

  callThirteenCard(pNum, newRang) {
    const s = this.state;
    if (s.phase !== 'thirteen_card_challenge_window') return { ok:false, reason:'Window closed' };
    if (s.walkOver && s.walkOver.pending) return { ok:false, reason:'A walk over is pending — resolve it first' };
    if (!SUITS.includes(newRang)) return { ok:false, reason:'Invalid suit' };
    s.thirteenCard = { active:true, callerNum:pNum, newRang, pending:true };
    s.thirteenCardVotes = {};
    s.phase = 'thirteen_card_challenge_pending';
    return { ok:true };
  }

  voteThirteenCard(pNum, vote) {
    const s = this.state;
    if (s.phase !== 'thirteen_card_challenge_pending') return { ok:false, reason:'No pending challenge' };
    const cTeam0 = TEAM_OF[s.thirteenCard.callerNum];
    const oppTeam0 = cTeam0 === 'A' ? 'B' : 'A';
    if (TEAM_OF[pNum] !== oppTeam0) return { ok:false, reason:'Only the opposing team votes' };
    if (vote !== 'accept' && vote !== 'reject') return { ok:false, reason:'Invalid vote' };
    s.thirteenCardVotes[pNum] = vote;
    const team = [1,2,3,4].filter(n => TEAM_OF[n] === oppTeam0);
    const v1 = s.thirteenCardVotes[team[0]], v2 = s.thirteenCardVotes[team[1]];
    if (v1 && v2 && v1 === v2) {
      if (v1 === 'accept') {
        const r = this._resolveThirteenCardAccept();
        return { ok:true, resolved:'accept', result:r, votes:{...s.thirteenCardVotes} };
      }
      const r = this._resolveThirteenCardReject();
      return { ok:true, resolved:'reject', result:r, votes:{...s.thirteenCardVotes} };
    }
    return { ok:true, resolved:null, votes:{...s.thirteenCardVotes} };
  }

  _resolveThirteenCardReject() {
    const s = this.state;
    const cTeam = TEAM_OF[s.thirteenCard.callerNum];
    s.scores[cTeam] += 1;
    const seriesWinner = s.scores.A >= 15 ? 'A' : s.scores.B >= 15 ? 'B' : null;
    s.phase = seriesWinner ? 'series_over' : 'hand_over';
    const nd = this._rotateAfterChallengeRejected(s.thirteenCard.callerNum);
    s.nextDealer = nd.nextDealer; s.nextRangSelector = nd.nextRangSelector;
    return { ok:true, scoringTeam:cTeam, points:1, seriesWinner };
  }

  _resolveThirteenCardAccept() {
    const s = this.state;
    s.rang = s.thirteenCard.newRang;
    s.thirteenCard.pending = false;
    s.phase = 'trick_play';
    s.currentLeader = s.thirteenCard.callerNum;
    s.trickNumber = 1;
    s.trickWins = { A:0, B:0 };
    return { ok:true, newRang:s.rang, firstLeader:s.currentLeader };
  }

  // ── WALK OVER ──────────────────────────────────────────────────────────────
  // Available ONLY after all 4 declined the 13-card challenge, before the
  // first card of trick 1 is played. Partner must accept to confirm.
  _walkOverAvailable() {
    const s = this.state;
    // Walk over now lives on the 13-card challenge/voting screen.
    return s.phase === 'thirteen_card_challenge_window';
  }

  proposeWalkOver(pNum) {
    const s = this.state;
    if (!this._walkOverAvailable()) return { ok:false, reason:'Walk over not available now' };
    if (s.walkOver.pending) return { ok:false, reason:'A walk over is already pending' };
    if (s.thirteenCardDeclines.includes(pNum)) return { ok:false, reason:'You have already voted' };
    // Each player may request at most 3 times per hand.
    s.walkOverRequests = s.walkOverRequests || {};
    const used = s.walkOverRequests[pNum] || 0;
    if (used >= 3) return { ok:false, reason:'No walk over requests left (max 3)' };
    s.walkOverRequests[pNum] = used + 1;
    s.walkOver = { proposerNum: pNum, pending: true };
    return { ok:true, proposerNum: pNum, partnerNum: PARTNER_OF[pNum], requestsUsed: s.walkOverRequests[pNum], requestsLeft: 3 - s.walkOverRequests[pNum] };
  }

  respondWalkOver(pNum, accept) {
    const s = this.state;
    if (!s.walkOver.pending) return { ok:false, reason:'No walk over pending' };
    if (pNum !== PARTNER_OF[s.walkOver.proposerNum]) return { ok:false, reason:'Only the proposer partner can decide' };

    const proposer = s.walkOver.proposerNum;

    if (!accept) {
      // Rejected by partner — cancel. Proposer may re-request if under the 3-cap.
      s.walkOver = { proposerNum:null, pending:false };
      const used = (s.walkOverRequests && s.walkOverRequests[proposer]) || 0;
      return { ok:true, accepted:false, proposerNum:proposer, requestsUsed:used, requestsLeft:3-used };
    }

    // Accepted — opponents get 1 point, hand ends
    const woTeam = TEAM_OF[proposer];
    const oppTeam = woTeam === 'A' ? 'B' : 'A';
    s.scores[oppTeam] += 1;
    const seriesWinner = s.scores.A >= 15 ? 'A' : s.scores.B >= 15 ? 'B' : null;
    s.phase = seriesWinner ? 'series_over' : 'hand_over';
    // Rotation depends on WHO conceded:
    //  • Rang selector's team walked over → rotate (selector becomes dealer,
    //    next CCW player becomes new rang selector)
    //  • Opposing team walked over → NO rotation (same dealer, same rang selector)
    const rangTeam = TEAM_OF[s.rangSelector];
    if (woTeam === rangTeam) {
      s.nextDealer = s.rangSelector;
      s.nextRangSelector = NEXT_P[s.rangSelector];
    } else {
      s.nextDealer = s.dealer;
      s.nextRangSelector = s.rangSelector;
    }
    s.walkOver = { proposerNum:null, pending:false };
    return { ok:true, accepted:true, proposerNum:proposer, walkOverTeam:woTeam, scoringTeam:oppTeam, points:1, seriesWinner };
  }

  startNormalPlay() {
    const s = this.state;
    s.phase = 'trick_play';
    s.currentLeader = s.rangSelector;
    s.trickNumber = 1; s.currentTrick = [];
    s.trickWins = { A:0, B:0 };
    return { ok:true, firstLeader:s.rangSelector };
  }

  // ── card play ──────────────────────────────────────────────────────────────
  playCard(pNum, cardId) {
    const s = this.state;
    const isFC = s.phase === 'five_card_trick_play';
    const isNormal = s.phase === 'trick_play';
    if (!isFC && !isNormal) return { ok:false, reason:'Not in trick play' };

    if (s.walkOver && s.walkOver.pending) return { ok:false, reason:'Walk over decision pending' };

    const expected = this._whoseTurn();
    if (pNum !== expected) return { ok:false, reason:'Not your turn' };

    const hand = s.players[pNum].hand;
    const idx = hand.findIndex(c => c.id === cardId);
    if (idx === -1) return { ok:false, reason:'Card not in hand' };
    const card = hand[idx];

    // ── Ace leading rule ─────────────────────────────────────────────────────
    // If you won the previous trick with an Ace, leading ANY Ace next trick
    // downgrades it to value 2.
    // Exceptions: (a) 5-card challenge trick 5 — allowed freely.
    //             (b) the LAST TWO tricks of a full hand (tricks 12 & 13) —
    //                 an Ace is never downgraded there.
    let aceDowngraded = false;
    if (s.currentTrick.length === 0 && card.rank === 'A' && s.aceJustWon === pNum) {
      const isFCFifthTrick = isFC && s.trickNumber === 5;
      // Last two tricks of the full 13-trick hand are exempt
      const isLastTwoTricks = (s.totalTricks === 13 && s.trickNumber >= 12);
      // Downgrade ONLY when there are uncollected tricks in the center pile.
      // If the ace-win collected the pile (pile now empty), leading an Ace is full value.
      const pileHasCards = s.centerPile.length > 0;
      if (!isFCFifthTrick && !isLastTwoTricks && pileHasCards) aceDowngraded = true;
    }

    // ── Revoke detection (server prevents via valid flags, but log if forced) ─
    let revoke = false;
    if (s.currentTrick.length > 0) {
      const ledSuit = s.currentTrick[0].card.suit;
      const hasLed = hand.some((c,i) => i !== idx && c.suit === ledSuit);
      if (hasLed && card.suit !== ledSuit) {
        revoke = true;
        s.revokeLog.push({ playerNum:pNum, trickNum:s.trickNumber, cardId });
      }
    }

    hand.splice(idx, 1);
    const played = aceDowngraded
      ? { ...card, rank:'2', originalRank:card.rank, aceDowngraded:true }
      : { ...card };
    s.currentTrick.push({ playerNum:pNum, card:played });

    const complete = s.currentTrick.length === 4;
    let trickResult = null;
    if (complete) trickResult = this._resolveTrick();

    return {
      ok:true, card:played, aceDowngraded, revoke,
      complete, trickResult,
      nextToPlay: complete ? null : this._whoseTurn()
    };
  }

  _whoseTurn() {
    const s = this.state;
    if (s.currentTrick.length === 0) return s.currentLeader;
    return NEXT_P[s.currentTrick[s.currentTrick.length-1].playerNum];
  }

  // ── trick resolution with FULL collection rules ────────────────────────────
  _resolveTrick() {
    const s = this.state;
    const isFC = s.phase === 'five_card_trick_play';
    const ledEntry = s.currentTrick[0];
    const ledSuit = ledEntry.card.suit;
    const winner = trickWinner(s.currentTrick, ledSuit, s.rang);
    const winTeam = TEAM_OF[winner];
    const winCard = s.currentTrick.find(t => t.playerNum === winner).card;
    const wonWithAce = (winCard.rank === 'A' && !winCard.aceDowngraded);

    // Live trick counter
    s.trickWins[winTeam] = (s.trickWins[winTeam]||0) + 1;

    // The completed trick (snapshot for client display)
    const completedTrick = { trickNum: s.trickNumber, winner, trick: [...s.currentTrick] };
    s.centerPile.push(completedTrick);

    // Ace tracking for the leading rule
    s.aceJustWon = wonWithAce ? winner : null;

    let collected = null;
    const isLast = s.trickNumber === s.totalTricks;

    if (isFC) {
      // ── 5-card challenge: no collections, winner of trick 5 takes all ─────
      if (isLast) {
        s.scores[winTeam] += 3;
        s.handScores[winTeam] = (s.handScores[winTeam]||0) + s.centerPile.length;
        collected = { collector:winner, collectorTeam:winTeam, count:s.centerPile.length, isLast:true };
        const collectedPile = [...s.centerPile];
        s.centerPile = [];
        const nd = this._rotateAfterChallengeAccepted(s.fiveCard.callerNum, winTeam);
        s.nextDealer = nd.nextDealer; s.nextRangSelector = nd.nextRangSelector;
        const seriesWinner = s.scores.A >= 15 ? 'A' : s.scores.B >= 15 ? 'B' : null;
        s.phase = seriesWinner ? 'series_over' : 'hand_over';
        const handResult = { type:'five_card_challenge', winnerTeam:winTeam, points:3, seriesWinner };
        s.currentTrick = [];
        return { winner, winTeam, completedTrick, collected, isLast:true, handResult, centerPileCount:0 };
      }
      // tricks 1-4: stay in center
      s.lastTrickWinner = winner;
      s.currentTrick = [];
      s.currentLeader = winner;
      s.trickNumber += 1;
      return { winner, winTeam, completedTrick, collected:null, isLast:false, handResult:null, centerPileCount:s.centerPile.length };
    }

    // ── NORMAL / 13-card-challenge game ──────────────────────────────────────
    if (isLast) {
      // Trick 13: winner scoops ALL remaining uncollected tricks
      s.handScores[winTeam] = (s.handScores[winTeam]||0) + s.centerPile.length;
      collected = { collector:winner, collectorTeam:winTeam, count:s.centerPile.length, isLast:true };
      s.centerPile = [];
    } else {
      const canCollect = this._checkCanCollect(winner, ledEntry);
      if (canCollect) {
        s.handScores[winTeam] = (s.handScores[winTeam]||0) + s.centerPile.length;
        collected = { collector:winner, collectorTeam:winTeam, count:s.centerPile.length, isLast:false };
        s.centerPile = [];
        // Streak resets after collection — collector must build a NEW streak
        s.lastTrickWinner = null;

        // ── Early conclusion check (outcome mathematically decided?) ──
        const earlyResult = this._checkEarlyEnd();
        if (earlyResult) {
          s.currentTrick = [];
          return { winner, winTeam, completedTrick, collected, isLast:false,
                   handResult: earlyResult, centerPileCount: 0 };
        }
      }
    }

    if (!collected) {
      // No collection: streak continues/updates normally
      s.lastTrickWinner = winner;
    }

    s.currentTrick = [];
    s.currentLeader = winner;
    s.trickNumber += 1;

    let handResult = null;
    if (isLast) {
      handResult = this._resolveHand();
    }

    return { winner, winTeam, completedTrick, collected, isLast, handResult, centerPileCount:s.centerPile.length };
  }

  // ── collection eligibility ────────────────────────────────────────────────
  _checkCanCollect(winner, ledEntry) {
    const s = this.state;
    const trickNum = s.trickNumber;
    const total = s.totalTricks;

    // Rule 1: consecutive — the same player must have won the previous trick.
    // lastTrickWinner === null means fresh streak (start of hand or just after a collection)
    if (s.lastTrickWinner !== winner) return false;

    // Rule 2: first collection cannot happen before trick 5
    // (tricks 1-4 always stay in center; earliest pair is 4&5)
    if (trickNum < 5) return false;

    // Rule 3: cannot collect if it would leave EXACTLY ONE trick remaining
    // (the last trick can never be played for a lone pile)
    // remaining tricks after this one = total - trickNum
    if (total - trickNum === 1) return false;

    // Rule 4 (FULL GAME ONLY): Trick-5 Ace-lead block.
    // If this is trick 5 AND the winner LED this trick with an Ace
    // (original rank Ace — even downgraded), collection is blocked.
    // They must win trick 6 to collect all 6.
    if (trickNum === 5) {
      const ledByWinner = ledEntry.playerNum === winner;
      const ledCardIsAce = (ledEntry.card.rank === 'A') || (ledEntry.card.originalRank === 'A');
      if (ledByWinner && ledCardIsAce) return false;
    }

    return true;
  }

  // ── EARLY HAND CONCLUSION ──────────────────────────────────────────────────
  // Called after every mid-hand collection. Ends the hand immediately when the
  // outcome is already mathematically decided:
  //  • Normal game: one team has 7+ collected AND the other has 1+ collected
  //    → only possible result is normal win (+1). Coat/Goon-Coat impossible.
  //  • 13-card challenge: opponents collect their FIRST set → challenge failed
  //    → +5 to opponents immediately.
  _checkEarlyEnd() {
    const s = this.state;

    if (s.thirteenCard.active) {
      const cTeam = TEAM_OF[s.thirteenCard.callerNum];
      const oppTeam = cTeam === 'A' ? 'B' : 'A';
      if ((s.handScores[oppTeam]||0) > 0) {
        s.scores[oppTeam] += 5;
        const nd = this._rotateAfterChallengeLost(s.thirteenCard.callerNum);
        s.nextDealer = nd.nextDealer; s.nextRangSelector = nd.nextRangSelector;
        const seriesWinner = s.scores.A >= 15 ? 'A' : s.scores.B >= 15 ? 'B' : null;
        s.phase = seriesWinner ? 'series_over' : 'hand_over';
        return { type:'thirteen_card_fail', winnerTeam:oppTeam, points:5, seriesWinner, earlyEnd:true };
      }
      return null;
    }

    const a = s.handScores.A||0, b = s.handScores.B||0;
    let winnerTeam = null;
    if (a >= 7 && b >= 1) winnerTeam = 'A';
    else if (b >= 7 && a >= 1) winnerTeam = 'B';
    if (!winnerTeam) return null;

    s.scores[winnerTeam] += 1;
    const rTeam = TEAM_OF[s.rangSelector];
    if (winnerTeam === rTeam) {
      s.nextDealer = s.dealer; s.nextRangSelector = NEXT_P[s.dealer];
    } else {
      s.nextDealer = s.rangSelector; s.nextRangSelector = NEXT_P[s.rangSelector];
    }
    const seriesWinner = s.scores.A >= 15 ? 'A' : s.scores.B >= 15 ? 'B' : null;
    s.phase = seriesWinner ? 'series_over' : 'hand_over';
    return { type:'normal_win', winnerTeam, points:1, seriesWinner, earlyEnd:true };
  }

  _resolveHand() {
    const s = this.state;
    const isTC = s.thirteenCard.active;
    let result = {};

    if (isTC) {
      const cTeam = TEAM_OF[s.thirteenCard.callerNum];
      const oppTeam = cTeam === 'A' ? 'B' : 'A';
      if ((s.handScores[oppTeam]||0) === 0) {
        s.scores[cTeam] += 5;
        result = { type:'thirteen_card_win', winnerTeam:cTeam, points:5 };
        const nd = this._rotateAfterChallengeAccepted(s.thirteenCard.callerNum, cTeam);
        s.nextDealer = nd.nextDealer; s.nextRangSelector = nd.nextRangSelector;
      } else {
        s.scores[oppTeam] += 5;
        result = { type:'thirteen_card_fail', winnerTeam:oppTeam, points:5 };
        const nd = this._rotateAfterChallengeLost(s.thirteenCard.callerNum);
        s.nextDealer = nd.nextDealer; s.nextRangSelector = nd.nextRangSelector;
      }
    } else {
      const rTeam = TEAM_OF[s.rangSelector];
      const oTeam = rTeam === 'A' ? 'B' : 'A';
      const rTricks = s.handScores[rTeam]||0;
      const oTricks = s.handScores[oTeam]||0;

      if (rTricks >= 7) {
        if (oTricks === 0) {
          s.scores[rTeam] += 2;
          result = { type:'coat', winnerTeam:rTeam, points:2 };
        } else {
          s.scores[rTeam] += 1;
          result = { type:'normal_win', winnerTeam:rTeam, points:1 };
        }
        s.nextDealer = s.dealer;
        s.nextRangSelector = NEXT_P[s.dealer];
      } else {
        if (rTricks === 0) {
          s.scores[oTeam] += 3;
          result = { type:'goon_coat', winnerTeam:oTeam, points:3 };
        } else {
          s.scores[oTeam] += 1;
          result = { type:'normal_win', winnerTeam:oTeam, points:1 };
        }
        s.nextDealer = s.rangSelector;
        s.nextRangSelector = NEXT_P[s.rangSelector];
      }
    }

    s.phase = 'hand_over';
    const seriesWinner = s.scores.A >= 15 ? 'A' : s.scores.B >= 15 ? 'B' : null;
    if (seriesWinner) s.phase = 'series_over';
    result.seriesWinner = seriesWinner;
    return result;
  }

  // ── dealer rotation ────────────────────────────────────────────────────────
  _rotateAfterChallengeRejected(callerNum) {
    return { nextDealer:PREV_P[callerNum], nextRangSelector:callerNum };
  }
  _rotateAfterChallengeAccepted(callerNum, winnerTeam) {
    if (TEAM_OF[callerNum] === winnerTeam) {
      return { nextDealer:PREV_P[callerNum], nextRangSelector:callerNum };
    }
    return this._rotateAfterChallengeLost(callerNum);
  }
  _rotateAfterChallengeLost(callerNum) {
    return { nextDealer:callerNum, nextRangSelector:NEXT_P[callerNum] };
  }

  // ── next hand ──────────────────────────────────────────────────────────────
  startNextHand() {
    const s = this.state;
    const nd = s.nextDealer, ns = s.nextRangSelector;
    this._resetHandState(nd, ns);
    return { ok:true, dealer:nd, rangSelector:ns };
  }

  // ── RESET SERIES: scores 0:0, fresh dealer selection (jack hunt) ───────────
  resetSeries() {
    const s = this.state;
    s.scores = { A:0, B:0 };
    s.newSeriesVotes = [];
    this._resetHandState(null, null);
    return this.startDealerSelection();
  }

  // ── NEW SERIES VOTE: all 4 players must vote after series_over ─────────────
  voteNewSeries(pNum) {
    const s = this.state;
    if (s.phase !== 'series_over') return { ok:false, reason:'Series is not over' };
    if (!s.newSeriesVotes.includes(pNum)) s.newSeriesVotes.push(pNum);
    if (s.newSeriesVotes.length === 4) {
      const r = this.resetSeries();
      return { ok:true, all:true, result:r };
    }
    return { ok:true, all:false, votes:[...s.newSeriesVotes] };
  }

  // ── HARD RESET: re-deal current hand, keep dealer/selector/scores ──────────
  resetHand() {
    const s = this.state;
    if (s.phase === 'lobby' || s.phase === 'dealer_selection') {
      return { ok:false, reason:'Game has not started yet' };
    }
    const d = s.dealer, rs = s.rangSelector;
    this._resetHandState(d, rs);
    return { ok:true, dealer:d, rangSelector:rs };
  }

  _resetHandState(dealer, rangSelector) {
    const s = this.state;
    Object.assign(s, {
      phase:'rang_selection', dealer, rangSelector,
      rang:null, handScores:{A:0,B:0}, trickWins:{A:0,B:0},
      centerPile:[], currentTrick:[], trickNumber:0, totalTricks:13,
      lastTrickWinner:null, aceJustWon:null,
      revokeLog:[], nextDealer:null, nextRangSelector:null,
      fiveCard:{ active:false, callerNum:null, faceDownCard:null, pending:false },
      thirteenCard:{ active:false, callerNum:null, newRang:null, pending:false },
      fiveCardDeclines:[], thirteenCardDeclines:[],
      walkOver: { proposerNum:null, pending:false },
      walkOverRequests: {},
      fiveCardVotes: {}, thirteenCardVotes: {},
      dealDeck: shuffle(buildDeck()),
    });
    for (let i=1;i<=4;i++) s.players[i].hand = [];
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  getValidCards(pNum) {
    const s = this.state;
    const hand = s.players[pNum].hand;
    const sorted = this._sortHand(hand);
    if (s.currentTrick.length === 0) return sorted.map(c => ({ ...c, valid:true }));
    const ledSuit = s.currentTrick[0].card.suit;
    const hasLed = sorted.some(c => c.suit === ledSuit);
    return sorted.map(c => ({ ...c, valid: hasLed ? c.suit === ledSuit : true }));
  }

  // Sort: group by suit (clubs, hearts, spades, diamonds), descending rank
  _sortHand(hand) {
    const suitOrder = { clubs:0, hearts:1, spades:2, diamonds:3 };
    return [...hand].sort((a,b) => {
      if (suitOrder[a.suit] !== suitOrder[b.suit]) return suitOrder[a.suit] - suitOrder[b.suit];
      return RANK_VALUE[b.rank] - RANK_VALUE[a.rank]; // descending A→2
    });
  }

  getHand(pNum) { return this._sortHand(this.state.players[pNum].hand); }

  publicState() {
    const s = this.state;
    return {
      phase: s.phase,
      roomMode: s.roomMode,
      dealer: s.dealer, rangSelector: s.rangSelector, rang: s.rang,
      rangName: s.rang ? SUIT_NAMES[s.rang] : null,
      rangSymbol: s.rang ? SUIT_SYMBOLS[s.rang] : null,
      scores: s.scores, handScores: s.handScores, trickWins: s.trickWins,
      trickNumber: s.trickNumber, totalTricks: s.totalTricks,
      centerPileCount: s.centerPile.length,
      centerPile: s.centerPile.map(t => ({
        trickNum: t.trickNum, winner: t.winner,
        trick: t.trick.map(x => ({ playerNum: x.playerNum, card: x.card })),
      })),
      currentTrick: s.currentTrick, currentLeader: s.currentLeader,
      aceJustWon: s.aceJustWon, lastTrickWinner: s.lastTrickWinner,
      nextDealer: s.nextDealer, nextRangSelector: s.nextRangSelector,
      fiveCardDeclines: [...s.fiveCardDeclines],
      thirteenCardDeclines: [...s.thirteenCardDeclines],
      walkOver: { proposerNum: s.walkOver.proposerNum, pending: s.walkOver.pending },
      walkOverRequests: {...(s.walkOverRequests||{})},
      fiveCardVotes: {...s.fiveCardVotes},
      thirteenCardVotes: {...s.thirteenCardVotes},
      newSeriesVotes: [...s.newSeriesVotes],
      players: [1,2,3,4].reduce((a,n) => {
        a[n] = {
          name: s.players[n].name, connected: s.players[n].connected,
          handSize: s.players[n].hand.length, team: TEAM_OF[n],
        };
        return a;
      }, {}),
      fiveCard: {
        active:s.fiveCard.active, callerNum:s.fiveCard.callerNum,
        pending:s.fiveCard.pending,
        viewingTeam: s.fiveCard.active && s.rangSelector ? TEAM_OF[s.rangSelector] : null,
      },
      thirteenCard: {
        active:s.thirteenCard.active, callerNum:s.thirteenCard.callerNum,
        newRang:s.thirteenCard.newRang, pending:s.thirteenCard.pending,
      },
      revokeLog: s.revokeLog,
    };
  }
}

module.exports = { RangEngine, SUIT_NAMES, SUIT_SYMBOLS, SUITS, TEAM_OF, NEXT_P, PREV_P, PARTNER_OF };


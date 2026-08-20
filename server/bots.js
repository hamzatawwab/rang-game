'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// BOT MODULE (dev/trial mode only)
// Bots play LEGAL moves with human-like card sense and evaluate their hand
// before calling/answering challenges and walk-overs.
// This module does NOT change any game rule — it only picks valid actions
// through the same public engine methods a human would use.
// ─────────────────────────────────────────────────────────────────────────────

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VALUE = {};
RANKS.forEach((r,i) => { RANK_VALUE[r] = i; });

const TEAM_OF    = { 1:'A', 2:'B', 3:'A', 4:'B' };
const NEXT_P     = { 1:2, 2:3, 3:4, 4:1 };
const PARTNER_OF = { 1:3, 2:4, 3:1, 4:2 };

function isBot(engine, pNum) { return !!(engine.__bots && engine.__bots.has(pNum)); }
function anyBots(engine) { return !!(engine.__bots && engine.__bots.size > 0); }

// ── Mirrors the engine's comparison exactly ──────────────────────────────────
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

// Who is currently winning the partially-played trick?
function currentBest(trick, ledSuit, rang) {
  if (!trick.length) return null;
  let best = trick[0];
  for (let i = 1; i < trick.length; i++) {
    if (cardBeats(trick[i].card, best.card, ledSuit, rang)) best = trick[i];
  }
  return best;
}

// Would this card be downgraded to a 2 if led right now? (mirrors engine rule)
function wouldDowngrade(engine, pNum, card) {
  const s = engine.state;
  if (s.currentTrick.length !== 0) return false;
  if (card.rank !== 'A') return false;
  if (s.aceJustWon !== pNum) return false;
  const isFCFifth = (s.phase === 'five_card_trick_play' && s.trickNumber === 5);
  if (isFCFifth) return false;
  // Last two tricks of a full hand (12 & 13) are exempt from the downgrade
  if (s.totalTricks === 13 && s.trickNumber >= 12) return false;
  return s.centerPile.length > 0;
}

function effectiveCard(engine, pNum, card) {
  if (wouldDowngrade(engine, pNum, card)) return { ...card, rank: '2' };
  return card;
}

// ─────────────────────────────────────────────────────────────────────────────
// CARD SELECTION — the "card sense"
// ─────────────────────────────────────────────────────────────────────────────
function chooseCard(engine, pNum) {
  const s = engine.state;
  const rang = s.rang;
  const all = engine.getValidCards(pNum);
  const legal = all.filter(c => c.valid);
  const pool = legal.length ? legal : all;
  if (!pool.length) return null;

  const trick = s.currentTrick;
  const isFC = (s.phase === 'five_card_trick_play');
  const totalTricks = s.totalTricks || 13;
  const tnum = s.trickNumber;
  const partnerNum = PARTNER_OF[pNum];
  const myHand = s.players[pNum].hand;

  // Count my cards per suit (for the void-creation tendency)
  const suitCounts = { spades:0, hearts:0, diamonds:0, clubs:0 };
  for (const c of myHand) suitCounts[c.suit]++;

  // Is a collection realistically near? In the normal game the first collect is
  // trick 5 (needs winning 4&5); in the 5-card game the pile is taken at trick 5.
  const collectableSoon = isFC
    ? true                              // every 5-card trick matters
    : (tnum >= 4);                      // normal game: strength matters from t4
  const earlyThrowaway = !collectableSoon;   // tricks 1-3 of a normal hand

  // ── LEADING ────────────────────────────────────────────────────────────────
  if (trick.length === 0) {
    const usable = pool.filter(c => !wouldDowngrade(engine, pNum, c));
    const cards = usable.length ? usable : pool;

    // Score every candidate; higher = more preferred to lead
    const scored = cards.map(c => {
      let score = 0;
      const rv = RANK_VALUE[c.rank];
      const isTrump = c.suit === rang;

      if (earlyThrowaway) {
        // Early: prefer leading LOW, save high cards & trumps for later
        score -= rv;                                  // lower rank scores higher
        if (isTrump) score -= 6;                      // strongly avoid leading trumps early
        // Gentle void-creation: if short in a non-trump suit, nudge to lead it out
        if (!isTrump && suitCounts[c.suit] <= 2) score += 3;
      } else {
        // From t4 on: prefer leading a strong winner outside trumps
        if (!isTrump && rv >= RANK_VALUE['K']) score += 8;   // A/K side winners
        // trick-5 collect rule: if this is trick 5 and we want to WIN to collect,
        // leading an Ace can't collect — prefer K over A of the same suit.
        if (!isFC && tnum === 5 && c.rank === 'A') score -= 5;   // discourage A lead at t5
        if (!isFC && tnum === 5 && c.rank === 'K') score += 4;   // prefer K lead at t5
        // Drawing trumps: if we hold many trumps, leading a high trump is fine
        if (isTrump && suitCounts[rang] >= 4) score += rv * 0.3;
        score += rv * 0.4;                             // mild preference for higher
      }
      return { c, score };
    });
    scored.sort((a,b) => b.score - a.score);
    return scored[0].c;
  }

  // ── FOLLOWING ───────────────────────────────────────────────────────────────
  const ledSuit = trick[0].card.suit;
  const best = currentBest(trick, ledSuit, rang);
  const partnerWinning = best && best.playerNum === partnerNum;
  const lowestFirst = [...pool].sort((a,b) => RANK_VALUE[a.rank] - RANK_VALUE[b.rank]);
  const iAmLastToPlay = (trick.length === 3);

  // Partner already winning → don't overtake; throw lowest (keep strength)
  if (partnerWinning) {
    // very mild void-creation: if we can throw off a short non-trump suit, do it
    const shortDump = lowestFirst.find(c => c.suit !== rang && suitCounts[c.suit] <= 2 && c.suit !== ledSuit);
    return (shortDump || lowestFirst[0]);
  }

  // Opponent currently winning → decide whether to fight for THIS trick
  const winners = pool
    .map(c => ({ c, eff: effectiveCard(engine, pNum, c) }))
    .filter(x => cardBeats(x.eff, best.card, ledSuit, rang));

  // On early throwaway tricks, don't burn strength to win an uncollectable trick —
  // unless winning is basically free (a low card already wins).
  if (earlyThrowaway && winners.length) {
    const cheapWin = winners
      .filter(x => x.c.suit === ledSuit && RANK_VALUE[x.eff.rank] <= RANK_VALUE['9'])
      .sort((a,b) => RANK_VALUE[a.eff.rank] - RANK_VALUE[b.eff.rank])[0];
    if (cheapWin) return cheapWin.c;             // win cheaply if we happen to
    // otherwise duck: throw the lowest, keep high cards/trumps for t4-5
    const nonTrumpLow = lowestFirst.filter(c => c.suit !== rang);
    return (nonTrumpLow.length ? nonTrumpLow : lowestFirst)[0];
  }

  if (winners.length) {
    // Prefer a non-trump winner over spending a trump when both beat the board
    const nonTrumpWins = winners.filter(x => x.c.suit !== rang);
    const set = nonTrumpWins.length ? nonTrumpWins : winners;
    set.sort((a,b) => RANK_VALUE[a.eff.rank] - RANK_VALUE[b.eff.rank]);   // cheapest winner

    // King-bait tendency (gentle): if it's an early-ish collectable moment, I hold
    // BOTH A and K of a suit that would win, and I'm NOT last to play, sometimes
    // win with the K and keep the Ace back for the actual collection.
    if (!iAmLastToPlay && (isFC ? tnum <= 4 : (tnum >= 4 && tnum <= 6))) {
      const suitOf = set[0].c.suit;
      const haveA = pool.some(c => c.suit === suitOf && c.rank === 'A');
      const haveK = pool.some(c => c.suit === suitOf && c.rank === 'K');
      const kEntry = set.find(x => x.c.suit === suitOf && x.c.rank === 'K');
      if (haveA && haveK && kEntry) return kEntry.c;   // bait with K, reserve A
    }
    return set[0].c;
  }

  // Can't win → throw lowest, keep trumps back when possible
  const nonTrumpLow = lowestFirst.filter(c => c.suit !== rang);
  return (nonTrumpLow.length ? nonTrumpLow : lowestFirst)[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// HAND EVALUATION — for challenges and walk-overs
// ─────────────────────────────────────────────────────────────────────────────
function handStrength(hand, rang) {
  let score = 0;
  for (const c of hand) {
    let pts = 0;
    if (c.rank === 'A') pts = 4;
    else if (c.rank === 'K') pts = 3;
    else if (c.rank === 'Q') pts = 2;
    else if (c.rank === 'J') pts = 1;
    if (c.suit === rang) pts += 2;
    score += pts;
  }
  score += hand.filter(c => c.suit === rang).length;
  return score;
}
function strengthPerCard(hand, rang) {
  if (!hand.length) return 0;
  return handStrength(hand, rang) / hand.length;
}

// ── CALL a 5-card challenge? Must win all 5 tricks — very demanding ──────────
function shouldCallFiveCard(engine, pNum) {
  const s = engine.state;
  const hand = s.players[pNum].hand;
  const rang = s.rang;
  if (!hand || hand.length !== 5) return false;
  const trumps = hand.filter(c => c.suit === rang);
  const topTrumps = trumps.filter(c => RANK_VALUE[c.rank] >= RANK_VALUE['Q']).length;
  const aces = hand.filter(c => c.rank === 'A').length;
  return (trumps.length >= 4 && topTrumps >= 2) ||
         (trumps.length >= 3 && topTrumps >= 2 && aces >= 1);
}

// ── CALL a 13-card challenge? Must sweep all 13 — extremely demanding ────────
function shouldCallThirteenCard(engine, pNum) {
  const s = engine.state;
  const hand = s.players[pNum].hand;
  if (!hand || hand.length !== 13) return null;
  for (const suit of SUITS) {
    const trumps = hand.filter(c => c.suit === suit);
    const topTrumps = trumps.filter(c => RANK_VALUE[c.rank] >= RANK_VALUE['J']).length;
    const aces = hand.filter(c => c.rank === 'A' && c.suit !== suit).length;
    if (trumps.length >= 9 && topTrumps >= 4 && aces >= 2) return suit;
  }
  return null;
}

// ── VOTE on a 5-card challenge called against the bot's team ─────────────────
function voteFiveCard(engine, pNum) {
  const s = engine.state;
  const hand = s.players[pNum].hand;
  const rang = s.rang;
  const trumps = hand.filter(c => c.suit === rang);
  const topTrumps = trumps.filter(c => RANK_VALUE[c.rank] >= RANK_VALUE['Q']).length;
  const strength = strengthPerCard(hand, rang);
  if (topTrumps >= 2 || (trumps.length >= 3 && strength >= 3.2)) return 'accept';
  return 'reject';
}

// ── VOTE on a 13-card challenge called against the bot's team ────────────────
function voteThirteenCard(engine, pNum) {
  const s = engine.state;
  const hand = s.players[pNum].hand;
  const newRang = (s.thirteenCard && s.thirteenCard.newRang) || s.rang;
  const trumps = hand.filter(c => c.suit === newRang).length;
  const highCards = hand.filter(c => RANK_VALUE[c.rank] >= RANK_VALUE['K']).length;
  if (trumps >= 2 || highCards >= 2) return 'accept';
  return 'reject';
}

// ── WALK OVER: propose only with a hopeless hand ─────────────────────────────
function shouldProposeWalkOver(engine, pNum) {
  const s = engine.state;
  const hand = s.players[pNum].hand;
  const rang = s.rang;
  if (!hand || hand.length !== 13) return false;
  const trumps = hand.filter(c => c.suit === rang).length;
  const highCards = hand.filter(c => RANK_VALUE[c.rank] >= RANK_VALUE['Q']).length;
  return (trumps <= 1 && highCards <= 1 && strengthPerCard(hand, rang) < 1.0);
}

// ── WALK OVER: partner's decision — ALWAYS decides, never hangs ──────────────
function respondWalkOverDecision(engine, pNum) {
  const s = engine.state;
  const hand = s.players[pNum].hand;
  const rang = s.rang;
  const trumps = hand.filter(c => c.suit === rang).length;
  const topTrumps = hand.filter(c => c.suit === rang && RANK_VALUE[c.rank] >= RANK_VALUE['Q']).length;
  const aces = hand.filter(c => c.rank === 'A').length;
  const strength = strengthPerCard(hand, rang);
  // Your partner proposed conceding because THEIR hand is poor. Only REJECT (play on)
  // if THIS hand is genuinely strong enough to carry the team. Otherwise ACCEPT.
  const confidentWin = (topTrumps >= 2) || (trumps >= 4) || (aces >= 2 && strength >= 3.0);
  return !confidentWin;   // accept unless confident
}

module.exports = {
  isBot, anyBots, chooseCard,
  handStrength, strengthPerCard,
  shouldCallFiveCard, shouldCallThirteenCard,
  voteFiveCard, voteThirteenCard,
  shouldProposeWalkOver, respondWalkOverDecision,
  RANK_VALUE, TEAM_OF, PARTNER_OF, NEXT_P,
};

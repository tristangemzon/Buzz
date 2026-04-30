import React, { useEffect, useReducer, useState } from 'react';
import { WindowChrome } from '../../components/WindowChrome';
import { InviteOverlay, GameOverBanner, WaitingOverlay, CardView, shuffleDeck, type GameProps } from './shared';

// ── Types ─────────────────────────────────────────────────────────────────────
// Card = suit*13 + rank; suit 0=♣ 1=♦ 2=♥ 3=♠

function cardSuit(c: number) { return Math.floor(c / 13); }  // 3 = spades
function cardRank(c: number) { return c % 13; }              // 0=2 … 12=A

type SpadesState = {
  phase: 'waiting' | 'dealing' | 'bidding' | 'playing' | 'scoring' | 'over';
  myHand: number[];        // sorted
  oppHandSize: number;     // how many cards opponent holds
  trick: number[];         // [oppCard] or [myCard, oppCard] or []
  trickLed: number | null; // suit led
  myBid: number | null;
  oppBid: number | null;
  myTricks: number;
  oppTricks: number;
  myScore: number;
  oppScore: number;
  myBags: number;
  oppBags: number;
  roundMsg: string;
  statusMsg: string;
  isMyTurn: boolean;       // in tricks, am I leading/responding?
  amDealer: boolean;
  spadesBroken: boolean;
};

type SpadesAction =
  | { type: 'deal'; myHand: number[]; oppHandSize: number; amDealer: boolean }
  | { type: 'myBid'; amount: number }
  | { type: 'oppBid'; amount: number }
  | { type: 'playCard'; card: number; isMine: boolean }
  | { type: 'trickEnd'; iMineWon: boolean }
  | { type: 'roundScore' }
  | { type: 'redeal'; myHand: number[]; oppHandSize: number }
  | { type: 'over'; msg: string };

function compareTrick(led: number, c1: number, c2: number): boolean {
  // Returns true if c1 beats c2
  const s1 = cardSuit(c1), s2 = cardSuit(c2);
  const lSuit = led;
  if (s1 === 3 && s2 !== 3) return true;    // c1 is spade, c2 not
  if (s2 === 3 && s1 !== 3) return false;   // c2 is spade, c1 not
  if (s1 !== lSuit && s2 === lSuit) return false;
  if (s2 !== lSuit && s1 === lSuit) return true;
  if (s1 === s2) return cardRank(c1) > cardRank(c2);
  return false; // neither followed suit nor trumped
}

const SCORE_TARGET = 500;

function initState(): SpadesState {
  return {
    phase: 'waiting', myHand: [], oppHandSize: 0, trick: [], trickLed: null,
    myBid: null, oppBid: null, myTricks: 0, oppTricks: 0,
    myScore: 0, oppScore: 0, myBags: 0, oppBags: 0,
    roundMsg: '', statusMsg: 'Waiting…',
    isMyTurn: false, amDealer: false, spadesBroken: false,
  };
}

function calcScore(bid: number, tricks: number, bags: number): { score: number; bags: number; penalty: boolean } {
  const newBags = bags + (tricks > bid ? tricks - bid : 0);
  const bagPenalty = Math.floor(newBags / 10) > Math.floor(bags / 10);
  const score = tricks >= bid ? bid * 10 + (tricks - bid) : -bid * 10;
  return { score, bags: newBags % 10, penalty: bagPenalty };
}

function spadesReducer(s: SpadesState, a: SpadesAction): SpadesState {
  switch (a.type) {
    case 'deal': {
      return { ...s, phase: 'bidding', myHand: [...a.myHand].sort((x,y) => x-y),
        oppHandSize: a.oppHandSize, trick: [], trickLed: null,
        myBid: null, oppBid: null, myTricks: 0, oppTricks: 0,
        amDealer: a.amDealer, spadesBroken: false, roundMsg: '',
        // Non-dealer bids first; dealer = initiator
        isMyTurn: !a.amDealer, // non-dealer bids first
        statusMsg: !a.amDealer ? 'Your bid (0–13):' : "Opponent's bid…" };
    }
    case 'myBid': {
      if (s.oppBid !== null) {
        // Both bid; non-dealer leads first trick (non-dealer = opponent of dealer)
        const nonDealerLeads = true; // opp of dealer leads
        const iAmNonDealer = !s.amDealer;
        return { ...s, myBid: a.amount, phase: 'playing',
          isMyTurn: iAmNonDealer,
          statusMsg: iAmNonDealer ? 'Your lead' : "Opponent's lead" };
      }
      return { ...s, myBid: a.amount, isMyTurn: false,
        statusMsg: "Opponent's bid…" };
    }
    case 'oppBid': {
      if (s.myBid !== null) {
        const iAmNonDealer = !s.amDealer;
        return { ...s, oppBid: a.amount, phase: 'playing',
          isMyTurn: iAmNonDealer,
          statusMsg: iAmNonDealer ? 'Your lead' : "Opponent's lead" };
      }
      return { ...s, oppBid: a.amount, isMyTurn: true,
        statusMsg: 'Your bid (0–13):' };
    }
    case 'playCard': {
      const spades = a.isMine
        ? s.spadesBroken || cardSuit(a.card) === 3
        : s.spadesBroken || cardSuit(a.card) === 3;
      const myHand = a.isMine ? s.myHand.filter(c => c !== a.card) : s.myHand;
      const oppSize = !a.isMine ? s.oppHandSize - 1 : s.oppHandSize;
      const trick = [...s.trick, a.card];
      const trickLed = s.trick.length === 0 ? cardSuit(a.card) : s.trickLed;
      if (trick.length === 2) {
        // Evaluate trick
        const [first, second] = trick as [number, number];
        const firstIsMine = a.isMine ? false : true; // first card played
        const firstWins = compareTrick(trickLed!, first, second);
        const iMineWon = firstIsMine ? firstWins : !firstWins;
        return { ...s, myHand, oppHandSize: oppSize, trick, trickLed,
          spadesBroken: spades, isMyTurn: false, statusMsg: 'Resolving trick…' };
      }
      // First card played; other player responds
      return { ...s, myHand, oppHandSize: oppSize, trick, trickLed, spadesBroken: spades,
        isMyTurn: !a.isMine,
        statusMsg: a.isMine ? "Opponent's turn" : 'Your turn' };
    }
    case 'trickEnd': {
      const myTricks  = s.myTricks  + (a.iMineWon ? 1 : 0);
      const oppTricks = s.oppTricks + (a.iMineWon ? 0 : 1);
      if (myTricks + oppTricks === 13) {
        return { ...s, myTricks, oppTricks, trick: [], trickLed: null,
          phase: 'scoring', statusMsg: 'Round over!' };
      }
      return { ...s, myTricks, oppTricks, trick: [], trickLed: null,
        isMyTurn: a.iMineWon,
        statusMsg: a.iMineWon ? 'You lead next trick' : 'Opponent leads next trick' };
    }
    case 'roundScore': {
      const myR  = calcScore(s.myBid!, s.myTricks, s.myBags);
      const oppR = calcScore(s.oppBid!, s.oppTricks, s.oppBags);
      const myScore  = s.myScore + myR.score - (myR.penalty ? 100 : 0);
      const oppScore = s.oppScore + oppR.score - (oppR.penalty ? 100 : 0);
      const msg = `You: ${myScore} | Opp: ${oppScore}`;
      if (myScore >= SCORE_TARGET || oppScore >= SCORE_TARGET) {
        const result = myScore > oppScore ? 'You win!' : myScore < oppScore ? 'You lose.' : 'Draw!';
        return { ...s, myScore, oppScore, myBags: myR.bags, oppBags: oppR.bags,
          phase: 'over', statusMsg: `Game over — ${result} ${msg}` };
      }
      return { ...s, myScore, oppScore, myBags: myR.bags, oppBags: oppR.bags,
        phase: 'scoring', roundMsg: msg, statusMsg: `${msg} — Next round starts…` };
    }
    case 'redeal': {
      return { ...s, phase: 'bidding', myHand: [...a.myHand].sort((x,y) => x-y),
        oppHandSize: a.oppHandSize, trick: [], trickLed: null,
        myBid: null, oppBid: null, myTricks: 0, oppTricks: 0,
        amDealer: !s.amDealer, spadesBroken: false, roundMsg: '',
        isMyTurn: s.amDealer, // was dealer, now non-dealer
        statusMsg: s.amDealer ? 'Your bid (0–13):' : "Opponent's bid…" };
    }
    case 'over': return { ...s, phase: 'over', statusMsg: a.msg };
    default: return s;
  }
}

// ── Hand component ────────────────────────────────────────────────────────────

function SpadesHand({ cards, onPlay, active, ledSuit, spadesBroken }: {
  cards: number[]; onPlay: (c: number) => void;
  active: boolean; ledSuit: number | null; spadesBroken: boolean;
}) {
  function canPlay(card: number): boolean {
    if (!active) return false;
    const suit = cardSuit(card);
    // Leading: can't lead spades unless broken or only spades left
    if (ledSuit === null) {
      if (suit === 3 && !spadesBroken)
        return cards.every(c => cardSuit(c) === 3);
      return true;
    }
    // Following: must follow suit if possible
    const hasSuit = cards.some(c => cardSuit(c) === ledSuit);
    if (hasSuit) return suit === ledSuit;
    return true; // can play anything
  }
  return (
    <div className="card-table-hand" style={{ flexWrap: 'wrap' }}>
      {cards.map(c => {
        const ok = canPlay(c);
        return (
          <div key={c} style={{ opacity: ok ? 1 : 0.5, cursor: ok ? 'pointer' : 'default',
            transform: ok ? 'translateY(-4px)' : 'none', transition: 'transform 0.1s' }}
            onClick={() => ok && onPlay(c)}>
            <CardView card={c} small />
          </div>
        );
      })}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function SpadesGame({ peerId, initiator }: GameProps) {
  const [state, dispatch] = useReducer(spadesReducer, undefined, initState);
  const [showInvite, setShowInvite] = useState(!initiator);
  const [fromName] = useState(peerId.slice(0, 8) + '…');
  const [accepted, setAccepted] = useState(false);
  const [bidInput, setBidInput] = useState('');

  useEffect(() => {
    const offs: (() => void)[] = [];
    if (initiator) {
      offs.push(window.buzz.onGameAccepted(ev => {
        if (ev.fromPeerId !== peerId) return;
        setAccepted(true);
        // Deal: initiator = dealer; cards 0-25 = dealer (initiator), 26-51 = acceptor
        const deck = shuffleDeck();
        const path = [0, ...deck];
        void window.buzz.gameMove({ toPeerId: peerId, kind: 'spades', path });
        dispatch({ type: 'deal', myHand: deck.slice(0, 26), oppHandSize: 26, amDealer: true });
      }));
      offs.push(window.buzz.onGameDeclined(ev => {
        if (ev.fromPeerId !== peerId) return;
        dispatch({ type: 'over', msg: 'Invitation declined.' });
      }));
    }
    offs.push(window.buzz.onGameMove(ev => {
      if (ev.fromPeerId !== peerId) return;
      const [code, ...rest] = ev.path;
      if (code === 0) {
        const deck = rest;
        dispatch({ type: 'deal', myHand: deck.slice(26, 52), oppHandSize: 26, amDealer: false });
      } else if (code === 1) {
        // bid
        dispatch({ type: 'oppBid', amount: rest[0] ?? 0 });
      } else if (code === 2) {
        // play card
        const card = rest[0]!;
        const prevTrickLen = state.trick.length;
        dispatch({ type: 'playCard', card, isMine: false });
        if (prevTrickLen === 1) {
          // Second card — evaluate trick
          setTimeout(() => {
            const allCards = [...state.trick, card];
            const [first, second] = allCards as [number, number];
            const firstWins = compareTrick(state.trickLed!, first, second);
            // first card was mine (I played first), second is opponent
            dispatch({ type: 'trickEnd', iMineWon: firstWins });
            if (state.myTricks + state.oppTricks + 1 === 13)
              setTimeout(() => dispatch({ type: 'roundScore' }), 1000);
          }, 400);
        }
      } else if (code === 3) {
        // redeal signal from initiator (new round)
        const deck = rest;
        dispatch({ type: 'redeal', myHand: deck.slice(26, 52), oppHandSize: 26 });
      }
    }));
    offs.push(window.buzz.onGameResigned(ev => {
      if (ev.fromPeerId !== peerId) return;
      dispatch({ type: 'over', msg: 'Opponent resigned. You win!' });
    }));
    return () => offs.forEach(f => f());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerId, initiator, state.trick, state.trickLed, state.myTricks, state.oppTricks, state.isMyTurn]);

  function handleBid() {
    const n = parseInt(bidInput, 10);
    if (isNaN(n) || n < 0 || n > 13) return;
    void window.buzz.gameMove({ toPeerId: peerId, kind: 'spades', path: [1, n] });
    dispatch({ type: 'myBid', amount: n });
    setBidInput('');
  }

  function handlePlay(card: number) {
    void window.buzz.gameMove({ toPeerId: peerId, kind: 'spades', path: [2, card] });
    const prevTrickLen = state.trick.length;
    dispatch({ type: 'playCard', card, isMine: true });
    if (prevTrickLen === 1) {
      // I'm second — resolve trick
      setTimeout(() => {
        const firstCard = state.trick[0]!;
        const firstWins = compareTrick(state.trickLed!, firstCard, card);
        dispatch({ type: 'trickEnd', iMineWon: !firstWins }); // first was opp, !firstWins means I win
        if (state.myTricks + state.oppTricks + 1 === 13)
          setTimeout(() => dispatch({ type: 'roundScore' }), 1000);
      }, 400);
    }
  }

  function startNextRound() {
    if (!initiator) return;
    const deck = shuffleDeck();
    const path = [3, ...deck];
    void window.buzz.gameMove({ toPeerId: peerId, kind: 'spades', path });
    dispatch({ type: 'redeal', myHand: deck.slice(0, 26), oppHandSize: 26 });
  }

  const statusStr = initiator && state.phase === 'waiting' ? 'Waiting for opponent to accept…' : state.statusMsg;

  return (
    <div className="game-window">
      <WindowChrome title={`Spades — ${fromName}`} />
      {showInvite && (
        <InviteOverlay gameName="Spades" fromName={fromName}
          onAccept={() => { setShowInvite(false); void window.buzz.gameAccept(peerId); }}
          onDecline={() => { setShowInvite(false); void window.buzz.gameDecline(peerId); dispatch({ type: 'over', msg: 'You declined.' }); }}
        />
      )}
      {state.phase === 'waiting' && initiator && !accepted && <WaitingOverlay msg="Waiting for opponent to accept…" />}
      {state.phase === 'over' && <GameOverBanner msg={state.statusMsg} />}

      <div className="game-status-bar">
        <span className="game-status-msg">{statusStr}</span>
        {(state.phase === 'playing' || state.phase === 'bidding') && (
          <button className="game-resign-btn"
            onClick={() => { void window.buzz.gameResign(peerId); dispatch({ type: 'over', msg: 'You resigned.' }); }}>
            Resign
          </button>
        )}
      </div>

      <div className="card-table">
        {/* Score line */}
        <div className="card-table-label">
          You: {state.myScore} ({state.myBags} bags) | Opp: {state.oppScore} ({state.oppBags} bags)
        </div>
        {/* Bids */}
        {(state.myBid !== null || state.oppBid !== null) && (
          <div className="card-table-label">
            Bids — You: {state.myBid ?? '?'} | Opp: {state.oppBid ?? '?'} &nbsp;|&nbsp;
            Tricks — You: {state.myTricks} | Opp: {state.oppTricks}
          </div>
        )}

        {/* Opponent */}
        <div className="card-table-label">{fromName} ({state.oppHandSize} cards)</div>
        <div className="card-table-hand">
          {Array(state.oppHandSize).fill(null).map((_, i) => <CardView key={i} card={0} faceDown small />)}
        </div>

        {/* Trick area */}
        <div className="card-table-community" style={{ minHeight: 80 }}>
          {state.trick.map((c, i) => <CardView key={i} card={c} />)}
          {state.trick.length === 0 && <span className="card-table-label" style={{ fontSize: 12 }}>No cards played yet</span>}
        </div>

        {/* Bidding UI */}
        {state.phase === 'bidding' && state.isMyTurn && (
          <div className="poker-actions">
            <input type="number" min={0} max={13} value={bidInput}
              onChange={e => setBidInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleBid()}
              style={{ width: 50, fontFamily: 'MS Sans Serif, Arial, sans-serif', fontSize: 12 }}
              placeholder="0–13" />
            <button className="poker-btn" onClick={handleBid}>Bid</button>
          </div>
        )}

        {/* Scoring / next round */}
        {state.phase === 'scoring' && (
          <div className="poker-actions">
            <span className="card-table-label">{state.roundMsg}</span>
            {initiator && (
              <button className="poker-btn" onClick={startNextRound}>Next Round</button>
            )}
            {!initiator && (
              <span className="card-table-label">Waiting for dealer to deal…</span>
            )}
          </div>
        )}

        {/* My hand */}
        <SpadesHand cards={state.myHand} onPlay={handlePlay}
          active={state.phase === 'playing' && state.isMyTurn}
          ledSuit={state.trick.length > 0 ? state.trickLed : null}
          spadesBroken={state.spadesBroken} />
        <div className="card-table-label">Your hand</div>
      </div>
    </div>
  );
}

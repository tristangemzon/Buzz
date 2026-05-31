import React, { useEffect, useReducer, useState } from 'react';
import { WindowChrome } from '../../components/WindowChrome';
import { InviteOverlay, GameOverBanner, WaitingOverlay, CardView, shuffleDeck, evaluateBestHand, type GameProps } from './shared';

// ── Types ─────────────────────────────────────────────────────────────────────

type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

type PokerState = {
  phase: 'waiting' | 'playing' | 'over';
  street: Street;
  // Cards as indices into the 52-card deck
  myHole: number[];      // 2 cards
  oppHole: number[];     // 2 cards (shown at showdown)
  community: number[];   // 0-5 revealed community cards
  myStack: number;
  oppStack: number;
  pot: number;
  myBet: number;         // current street bet
  oppBet: number;
  callAmount: number;
  myTurn: boolean;
  statusMsg: string;
  amDealer: boolean;     // initiator = dealer/SB
  showOpp: boolean;      // show opponent hole cards
  raiseAmount: number;
};

// ── Move codes ────────────────────────────────────────────────────────────────
// path[0]: 0=deal, 1=fold, 2=check, 3=call, 4=raise(amount=path[1])

// ── Helpers ───────────────────────────────────────────────────────────────────

const SB = 10, BB = 20, START = 500;

function communityForStreet(street: Street): number {
  switch (street) { case 'flop': return 3; case 'turn': return 4; case 'river': return 5; default: return 0; }
}

// ── Reducer ───────────────────────────────────────────────────────────────────

type DealData = { myHole: number[]; oppHole: number[]; communityAll: number[] };

type PokerAction =
  | { type: 'deal'; data: DealData; amDealer: boolean }
  | { type: 'fold'; isMine: boolean }
  | { type: 'check' }
  | { type: 'call'; isMine: boolean }
  | { type: 'raise'; amount: number; isMine: boolean }
  | { type: 'advance' }  // move to next street
  | { type: 'showdown' }
  | { type: 'over'; msg: string };

function nextStreet(s: Street): Street {
  switch (s) { case 'preflop': return 'flop'; case 'flop': return 'turn'; case 'turn': return 'river'; default: return 'showdown'; }
}

function pokerReducer(state: PokerState, action: PokerAction): PokerState {
  switch (action.type) {
    case 'deal': {
      const { myHole, oppHole, communityAll } = action.data;
      const amDealer = action.amDealer;
      // Dealer = SB, opponent = BB; SB acts first preflop
      const pot = SB + BB;
      const myBet  = amDealer ? SB : BB;
      const oppBet = amDealer ? BB : SB;
      const myStack  = START - myBet;
      const oppStack = START - oppBet;
      const callAmount = amDealer ? BB - SB : 0; // SB needs to call BB, BB already posted
      return {
        ...state, phase: 'playing', street: 'preflop',
        myHole, oppHole, community: communityAll.slice(0, 0),
        myStack, oppStack, pot, myBet, oppBet,
        callAmount,
        myTurn: amDealer, // SB acts first preflop
        amDealer, showOpp: false,
        statusMsg: amDealer ? 'Your move (SB)' : "Opponent's move",
        raiseAmount: BB * 2,
      };
    }
    case 'fold': {
      const winner = action.isMine ? "Opponent wins (you folded)." : "You win! (opponent folded)";
      return { ...state, phase: 'over', statusMsg: winner };
    }
    case 'check': {
      // Both checked, advance
      return { ...state, myTurn: false, statusMsg: "Opponent's move" };
    }
    case 'call': {
      // Someone called — pot grows, move to next street
      const newPot = state.pot + state.callAmount;
      const myStack  = action.isMine ? state.myStack - state.callAmount : state.myStack;
      const oppStack = !action.isMine ? state.oppStack - state.callAmount : state.oppStack;
      return { ...state, pot: newPot, myStack, oppStack, callAmount: 0, myBet: 0, oppBet: 0,
        statusMsg: 'Advancing…' };
    }
    case 'raise': {
      const extra = action.amount - (action.isMine ? state.myBet : state.oppBet);
      const newPot = state.pot + extra;
      const myStack  = action.isMine ? state.myStack - extra : state.myStack;
      const oppStack = !action.isMine ? state.oppStack - extra : state.oppStack;
      const callAmt  = action.isMine ? action.amount - state.oppBet : action.amount - state.myBet;
      return { ...state, pot: newPot, myStack, oppStack,
        myBet:  action.isMine ? action.amount : state.myBet,
        oppBet: !action.isMine ? action.amount : state.oppBet,
        callAmount: callAmt,
        myTurn: !action.isMine, // opponent responds
        statusMsg: action.isMine ? "Opponent's move" : 'Your move' };
    }
    case 'advance': {
      const nextSt = nextStreet(state.street);
      if (nextSt === 'showdown') {
        return { ...state, street: 'showdown', showOpp: true,
          community: state.community, statusMsg: 'Showdown!' };
      }
      const n = communityForStreet(nextSt);
      // SB acts first on flop/turn/river (post-flop)
      const myTurn = !state.amDealer; // BB acts first post-flop? Standard: non-dealer first post-flop
      return { ...state, street: nextSt, community: state.community.slice(0, n),
        myBet: 0, oppBet: 0, callAmount: 0, myTurn,
        statusMsg: myTurn ? 'Your move' : "Opponent's move",
        raiseAmount: BB };
    }
    case 'showdown': {
      const { myHole, oppHole, community } = state;
      const myCards  = [...myHole, ...community];
      const oppCards = [...oppHole, ...community];
      const myEval  = evaluateBestHand(myCards);
      const oppEval = evaluateBestHand(oppCards);
      let msg: string;
      if      (myEval.score > oppEval.score) msg = `You win! (${myEval.name})`;
      else if (myEval.score < oppEval.score) msg = `You lose. (${oppEval.name})`;
      else    msg = `Draw! (${myEval.name})`;
      return { ...state, phase: 'over', showOpp: true, statusMsg: msg };
    }
    case 'over': return { ...state, phase: 'over', statusMsg: action.msg };
    default: return state;
  }
}

// ── Initial State ─────────────────────────────────────────────────────────────

const initState: PokerState = {
  phase: 'waiting', street: 'preflop',
  myHole: [], oppHole: [], community: [],
  myStack: START, oppStack: START, pot: 0, myBet: 0, oppBet: 0,
  callAmount: 0, myTurn: false, statusMsg: 'Waiting…',
  amDealer: false, showOpp: false, raiseAmount: BB * 2,
};

// ── Component ─────────────────────────────────────────────────────────────────

export function PokerGame({ peerId, initiator }: GameProps) {
  const [state, dispatch] = useReducer(pokerReducer, initState);
  const [showInvite, setShowInvite] = useState(!initiator);
  const [fromName] = useState(peerId.slice(0, 8) + '…');
  const [accepted, setAccepted] = useState(false);
  // Track whose turn it was before action so we can advance street
  const [pendingAdvance, setPendingAdvance] = useState(false);

  useEffect(() => {
    const offs: (() => void)[] = [];
    if (initiator) {
      offs.push(window.buzz.onGameAccepted(ev => {
        if (ev.fromPeerId !== peerId) return;
        setAccepted(true);
        // Deal cards
        const deck = shuffleDeck();
        const path = [0, ...deck];
        void window.buzz.gameMove({ toPeerId: peerId, kind: 'poker', path });
        dispatch({ type: 'deal', amDealer: true, data: {
          myHole: [deck[0]!, deck[1]!],
          oppHole: [deck[2]!, deck[3]!],
          communityAll: deck.slice(4, 9),
        }});
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
        // Deal packet
        const deck = rest;
        dispatch({ type: 'deal', amDealer: false, data: {
          myHole: [deck[2]!, deck[3]!],         // acceptor gets cards 2,3
          oppHole: [deck[0]!, deck[1]!],         // initiator has cards 0,1
          communityAll: deck.slice(4, 9),
        }});
      } else if (code === 1) {
        dispatch({ type: 'fold', isMine: false });
      } else if (code === 2) {
        // Opponent checked; if we also checked / no bet owed, advance
        setPendingAdvance(true);
        dispatch({ type: 'check' }); // will set myTurn=false temporarily
      } else if (code === 3) {
        dispatch({ type: 'call', isMine: false });
        setPendingAdvance(true);
      } else if (code === 4) {
        dispatch({ type: 'raise', amount: rest[0] ?? BB * 2, isMine: false });
      }
    }));
    offs.push(window.buzz.onGameResigned(ev => {
      if (ev.fromPeerId !== peerId) return;
      dispatch({ type: 'over', msg: 'Opponent resigned. You win!' });
    }));
    return () => offs.forEach(f => f());
  }, [peerId, initiator]);

  // When pendingAdvance fires, step the street or go to showdown
  useEffect(() => {
    if (!pendingAdvance) return;
    setPendingAdvance(false);
    if (state.street === 'river') {
      dispatch({ type: 'showdown' });
    } else {
      dispatch({ type: 'advance' });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAdvance]);

  function sendMove(path: number[]) {
    void window.buzz.gameMove({ toPeerId: peerId, kind: 'poker', path });
  }

  function handleFold() { sendMove([1]); dispatch({ type: 'fold', isMine: true }); }
  function handleCheck() {
    sendMove([2]);
    // If opponent already checked (callAmount=0 and oppBet=myBet), advance
    if (state.callAmount === 0 && state.oppBet === state.myBet) {
      if (state.street === 'river') dispatch({ type: 'showdown' });
      else dispatch({ type: 'advance' });
    } else {
      dispatch({ type: 'check' });
    }
  }
  function handleCall() {
    sendMove([3]);
    dispatch({ type: 'call', isMine: true });
    if (state.street === 'river') dispatch({ type: 'showdown' });
    else dispatch({ type: 'advance' });
  }
  function handleRaise() {
    const amt = state.raiseAmount;
    sendMove([4, amt]);
    dispatch({ type: 'raise', amount: amt, isMine: true });
  }

  const { myTurn, street, callAmount } = state;
  const canCheck = callAmount === 0;
  const canCall  = callAmount > 0;

  return (
    <div className="game-window">
      <WindowChrome title={`Poker — ${fromName}`} />
      {showInvite && (
        <InviteOverlay gameName="Poker" fromName={fromName}
          onAccept={() => { setShowInvite(false); void window.buzz.gameAccept(peerId); }}
          onDecline={() => { setShowInvite(false); void window.buzz.gameDecline(peerId); dispatch({ type: 'over', msg: 'You declined.' }); }}
        />
      )}
      {state.phase === 'waiting' && initiator && !accepted && <WaitingOverlay msg="Waiting for opponent to accept…" />}
      {state.phase === 'over' && <GameOverBanner msg={state.statusMsg} />}

      <div className="game-status-bar">
        <span className="game-status-msg">{state.statusMsg}</span>
        {state.phase === 'playing' && (
          <button className="game-resign-btn"
            onClick={() => { void window.buzz.gameResign(peerId); dispatch({ type: 'over', msg: 'You resigned.' }); }}>
            Resign
          </button>
        )}
      </div>

      <div className="card-table">
        {/* Opponent area */}
        <div className="card-table-label">{fromName} — Stack: {state.oppStack} | Bet: {state.oppBet}</div>
        <div className="card-table-hand">
          {state.oppHole.map((c, i) =>
            <CardView key={i} card={c} faceDown={!state.showOpp} />
          )}
        </div>

        {/* Community + Pot */}
        <div className="card-table-label">Pot: {state.pot} — {street.toUpperCase()}</div>
        <div className="card-table-community">
          {state.community.map((c, i) => <CardView key={i} card={c} />)}
          {Array(5 - state.community.length).fill(null).map((_, i) =>
            <div key={'ph'+i} style={{ width: 42, height: 60, border: '1px dashed #6a9a6a', borderRadius: 4 }} />
          )}
        </div>

        {/* My area */}
        <div className="card-table-hand">
          {state.myHole.map((c, i) => <CardView key={i} card={c} />)}
        </div>
        <div className="card-table-label">You — Stack: {state.myStack} | Bet: {state.myBet}</div>

        {/* Action buttons */}
        {state.phase === 'playing' && myTurn && (
          <div className="poker-actions">
            <button className="poker-btn" onClick={handleFold}>Fold</button>
            {canCheck && <button className="poker-btn" onClick={handleCheck}>Check</button>}
            {canCall  && <button className="poker-btn" onClick={handleCall}>Call {callAmount}</button>}
            <button className="poker-btn" onClick={handleRaise}>
              Raise to {state.raiseAmount}
            </button>
            <button className="poker-btn" onClick={() => dispatch({ type: 'raise', amount: state.raiseAmount * 2, isMine: false })
              /* quick raise increment */}
              style={{ fontSize: 10 }}>+</button>
          </div>
        )}
        {state.phase === 'playing' && !myTurn && (
          <div className="poker-actions">
            <span className="card-table-label">Waiting for opponent…</span>
          </div>
        )}
      </div>
    </div>
  );
}

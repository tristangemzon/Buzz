import React, { useEffect, useReducer, useState } from 'react';
import { WindowChrome } from '../../components/WindowChrome';
import { InviteOverlay, GameOverBanner, type GameProps } from './shared';

// ── Types ─────────────────────────────────────────────────────────────────────

type Cell  = null | 'b' | 'w';
type Board = Cell[];

// ── Board ─────────────────────────────────────────────────────────────────────

function makeBoard(): Board {
  const b: Board = Array(64).fill(null);
  b[27] = 'w'; b[28] = 'b'; b[35] = 'b'; b[36] = 'w';
  return b;
}

function getFlips(board: Board, idx: number, color: Cell): number[] {
  if (!color || board[idx] !== null) return [];
  const opp: Cell = color === 'b' ? 'w' : 'b';
  const row = Math.floor(idx / 8), col = idx % 8;
  const flips: number[] = [];
  for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]] as [number,number][]) {
    const line: number[] = [];
    let r = row + dr!, c = col + dc!;
    while (r >= 0 && r < 8 && c >= 0 && c < 8) {
      const ci = r * 8 + c;
      if (board[ci] === opp) { line.push(ci); r += dr!; c += dc!; }
      else if (board[ci] === color) { flips.push(...line); break; }
      else break;
    }
  }
  return flips;
}


function validMoves(board: Board, color: Cell): Set<number> {
  const s = new Set<number>();
  for (let i = 0; i < 64; i++)
    if (board[i] === null && getFlips(board, i, color).length > 0) s.add(i);
  return s;
}

function applyMove(board: Board, idx: number, color: Cell): Board {
  const nb = [...board];
  nb[idx] = color;
  for (const f of getFlips(board, idx, color)) nb[f] = color;
  return nb;
}

function countPieces(board: Board): { b: number; w: number } {
  let b = 0, w = 0;
  for (const c of board) { if (c === 'b') b++; else if (c === 'w') w++; }
  return { b, w };
}

// ── State ─────────────────────────────────────────────────────────────────────

type State = {
  board: Board;
  turn: Cell;
  myColor: Cell;
  valid: Set<number>;
  phase: 'waiting' | 'playing' | 'over';
  statusMsg: string;
};

type Action =
  | { type: 'start'; myColor: Cell }
  | { type: 'placed'; idx: number; color: Cell }
  | { type: 'resign' }
  | { type: 'over'; msg: string };

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'start': {
      const board = makeBoard();
      return { board, myColor: a.myColor, turn: 'b',
        valid: validMoves(board, 'b'), phase: 'playing',
        statusMsg: a.myColor === 'b' ? 'Your move' : "Opponent's move" };
    }
    case 'placed': {
      const nb = applyMove(s.board, a.idx, a.color);
      const next: Cell = a.color === 'b' ? 'w' : 'b';
      let nextTurn: Cell = next;
      let nextValid = validMoves(nb, next);
      // If next has no moves, skip their turn
      if (nextValid.size === 0) {
        nextTurn = a.color;
        nextValid = validMoves(nb, a.color);
      }
      // If neither can move, game over
      if (nextValid.size === 0) {
        const { b, w } = countPieces(nb);
        const winner = b > w ? 'Black wins' : w > b ? 'White wins' : 'Draw';
        return { ...s, board: nb, phase: 'over', valid: new Set<number>(),
          statusMsg: `Game over — ${winner} (${b}–${w})` };
      }
      const myTurn = nextTurn === s.myColor;
      return { ...s, board: nb, turn: nextTurn, valid: nextValid,
        statusMsg: myTurn ? 'Your move' : "Opponent's move" };
    }
    case 'resign': return { ...s, phase: 'over', valid: new Set<number>(), statusMsg: 'You resigned.' };
    case 'over':   return { ...s, phase: 'over', valid: new Set<number>(), statusMsg: a.msg };
    default: return s;
  }
}

// ── Board Component ───────────────────────────────────────────────────────────

function ReversiBoard({ state, onCell }: { state: State; onCell: (i: number) => void }) {
  const cells = [];
  for (let i = 0; i < 64; i++) {
    const piece = state.board[i];
      const isValid = (state.valid as Set<number>).has(i) && state.turn === state.myColor;
    cells.push(
      <div key={i} className={`rv-cell${isValid ? ' rv-valid' : ''}`}
        onClick={() => isValid && onCell(i)}>
        {piece && <div className={`rv-piece rv-${piece}`} />}
        {isValid && !piece && <div className="rv-hint" />}
      </div>
    );
  }
  const { b, w } = countPieces(state.board);
  return (
    <div className="rv-wrap">
      <div className="rv-score">
        <span className="rv-score-b">● {b}</span>
        <span className="rv-score-w">○ {w}</span>
      </div>
      <div className="rv-board">{cells}</div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function ReversiGame({ peerId, initiator }: GameProps) {
  const [state, dispatch] = useReducer(reducer, {
    board: makeBoard(), myColor: null, turn: 'b',
    valid: new Set<number>(), phase: 'waiting', statusMsg: 'Waiting…',
  });
  const [showInvite, setShowInvite] = useState(!initiator);
  const [fromName] = useState(peerId.slice(0, 8) + '…');

  useEffect(() => {
    const offs: (() => void)[] = [];
    if (initiator) {
      // Initiator = Black, goes first
      offs.push(window.buzz.onGameAccepted(ev => {
        if (ev.fromPeerId !== peerId) return;
        dispatch({ type: 'start', myColor: 'b' });
      }));
      offs.push(window.buzz.onGameDeclined(ev => {
        if (ev.fromPeerId !== peerId) return;
        dispatch({ type: 'over', msg: 'Invitation declined.' });
      }));
    }
    offs.push(window.buzz.onGameMove(ev => {
      if (ev.fromPeerId !== peerId) return;
      const idx = ev.path[0];
      if (idx === undefined) return;
      dispatch({ type: 'placed', idx, color: state.myColor === 'b' ? 'w' : 'b' });
    }));
    offs.push(window.buzz.onGameResigned(ev => {
      if (ev.fromPeerId !== peerId) return;
      dispatch({ type: 'over', msg: 'Opponent resigned. You win!' });
    }));
    return () => offs.forEach(f => f());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerId, initiator, state.myColor]);

  function handleAccept() {
    setShowInvite(false);
    void window.buzz.gameAccept(peerId);
    dispatch({ type: 'start', myColor: 'w' }); // Acceptor = White
  }
  function handleDecline() {
    setShowInvite(false);
    void window.buzz.gameDecline(peerId);
    dispatch({ type: 'over', msg: 'You declined.' });
  }
  function handleCell(idx: number) {
    if (state.phase !== 'playing' || state.turn !== state.myColor) return;
    void window.buzz.gameMove({ toPeerId: peerId, kind: 'reversi', path: [idx] });
    dispatch({ type: 'placed', idx, color: state.myColor! });
  }
  function handleResign() {
    void window.buzz.gameResign(peerId);
    dispatch({ type: 'resign' });
  }

  const status = initiator && state.phase === 'waiting' ? 'Waiting for opponent…' : state.statusMsg;

  return (
    <div className="game-window">
      <WindowChrome title={`Reversi — ${fromName}`} />
      {showInvite && (
        <InviteOverlay gameName="Reversi" fromName={fromName}
          onAccept={handleAccept} onDecline={handleDecline} />
      )}
      {state.phase === 'over' && <GameOverBanner msg={state.statusMsg} />}
      <div className="game-status-bar">
        <span className="game-status-msg">{status}</span>
        {state.phase === 'playing' && (
          <button className="game-resign-btn" onClick={handleResign}>Resign</button>
        )}
      </div>
      <ReversiBoard state={state} onCell={handleCell} />
    </div>
  );
}

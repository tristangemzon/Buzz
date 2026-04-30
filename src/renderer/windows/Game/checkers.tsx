import React, { useEffect, useReducer, useRef, useState } from 'react';
import { WindowChrome } from '../../components/WindowChrome';
import { InviteOverlay, GameOverBanner, type GameProps } from './shared';

// ── Types ─────────────────────────────────────────────────────────────────────

type Cell  = null | 'r' | 'b' | 'R' | 'B';
type Board = Cell[];
type Move  = { path: number[] };
type Phase = 'waiting' | 'playing' | 'over';

type GameState = {
  board: Board;
  myColor: 'r' | 'b';
  turn: 'r' | 'b';
  selected: number | null;
  validMoves: Move[];
  phase: Phase;
  statusMsg: string;
};

type Action =
  | { type: 'start'; myColor: 'r' | 'b' }
  | { type: 'select'; idx: number }
  | { type: 'moveMade'; path: number[] }
  | { type: 'opponentMove'; path: number[] }
  | { type: 'opponentResign' }
  | { type: 'over'; msg: string };

// ── Board Setup ───────────────────────────────────────────────────────────────

function makeStartBoard(): Board {
  const b: Board = Array(64).fill(null);
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 8; col++)
      if ((row + col) % 2 === 1) b[row * 8 + col] = 'b';
  for (let row = 5; row < 8; row++)
    for (let col = 0; col < 8; col++)
      if ((row + col) % 2 === 1) b[row * 8 + col] = 'r';
  return b;
}

// ── Move Logic ────────────────────────────────────────────────────────────────

function isRed(c: Cell): boolean   { return c === 'r' || c === 'R'; }
function isBlack(c: Cell): boolean { return c === 'b' || c === 'B'; }
function isKing(c: Cell): boolean  { return c === 'R' || c === 'B'; }
function isEnemy(a: Cell, b: Cell): boolean {
  if (!a || !b) return false;
  return (isRed(a) && isBlack(b)) || (isBlack(a) && isRed(b));
}

function pieceDirs(piece: Cell): [number, number][] {
  const dirs: [number, number][] = [];
  if (piece === 'r' || piece === 'R') dirs.push([-1, -1], [-1, 1]);
  if (piece === 'b' || piece === 'B') dirs.push([1, -1], [1, 1]);
  if (piece === 'R' || piece === 'B') {
    if (!dirs.find(([dr]) => dr === 1))  dirs.push([1, -1], [1, 1]);
    if (!dirs.find(([dr]) => dr === -1)) dirs.push([-1, -1], [-1, 1]);
  }
  return dirs;
}

function getJumps(board: Board, from: number, piece: Cell, visited: Set<number>): Move[] {
  const row = Math.floor(from / 8), col = from % 8;
  const result: Move[] = [];
  for (const [dr, dc] of pieceDirs(piece)) {
    const lr = row + 2 * dr, lc = col + 2 * dc;
    if (lr < 0 || lr > 7 || lc < 0 || lc > 7) continue;
    const midIdx  = (row + dr) * 8 + (col + dc);
    const landIdx = lr * 8 + lc;
    const midCell = board[midIdx] ?? null;
    if (isEnemy(piece, midCell) && (board[landIdx] ?? null) === null && !visited.has(midIdx)) {
      const tmp = [...board];
      tmp[from] = null; tmp[midIdx] = null; tmp[landIdx] = piece;
      const sub = getJumps(tmp, landIdx, piece, new Set([...visited, midIdx]));
      if (sub.length === 0) result.push({ path: [from, landIdx] });
      else for (const s of sub) result.push({ path: [from, ...s.path] });
    }
  }
  return result;
}

function getSimpleMoves(board: Board, from: number, piece: Cell): Move[] {
  const row = Math.floor(from / 8), col = from % 8;
  return pieceDirs(piece)
    .map(([dr, dc]) => ({ r: row + dr, c: col + dc }))
    .filter(({ r, c }) => r >= 0 && r <= 7 && c >= 0 && c <= 7 && (board[r * 8 + c] ?? null) === null)
    .map(({ r, c }) => ({ path: [from, r * 8 + c] }));
}

function allMovesFor(board: Board, color: 'r' | 'b'): Move[] {
  const isOurs = color === 'r' ? isRed : isBlack;
  const jumps: Move[] = [], simples: Move[] = [];
  board.forEach((cell, idx) => {
    if (cell && isOurs(cell)) {
      jumps.push(...getJumps(board, idx, cell, new Set()));
      simples.push(...getSimpleMoves(board, idx, cell));
    }
  });
  return jumps.length > 0 ? jumps : simples;
}

function applyMove(board: Board, path: number[]): Board {
  const nb = [...board];
  const piece: Cell = nb[path[0] ?? 0] ?? null;
  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i]!, to = path[i + 1]!;
    const midRow = (Math.floor(from / 8) + Math.floor(to / 8)) / 2;
    const midCol = ((from % 8) + (to % 8)) / 2;
    if (Number.isInteger(midRow) && Number.isInteger(midCol)) {
      const mid = midRow * 8 + midCol;
      if (nb[mid] !== piece && nb[mid] !== null) nb[mid] = null;
    }
    nb[from] = null; nb[to] = piece;
  }
  const dest = path[path.length - 1]!;
  const dr = Math.floor(dest / 8);
  if (nb[dest] === 'r' && dr === 0) nb[dest] = 'R';
  if (nb[dest] === 'b' && dr === 7) nb[dest] = 'B';
  return nb;
}

// ── Reducer ───────────────────────────────────────────────────────────────────

function reducer(s: GameState, a: Action): GameState {
  switch (a.type) {
    case 'start': {
      const board = makeStartBoard();
      return { board, myColor: a.myColor, turn: 'b', selected: null,
        validMoves: allMovesFor(board, 'b'), phase: 'playing',
        statusMsg: a.myColor === 'b' ? 'Your move' : "Opponent's move" };
    }
    case 'select': {
      if (s.phase !== 'playing' || s.turn !== s.myColor) return s;
      const piece = s.board[a.idx];
      if (!piece) return { ...s, selected: null };
      const isOurs = s.myColor === 'r' ? isRed : isBlack;
      if (!isOurs(piece)) return { ...s, selected: null };
      return { ...s, selected: a.idx };
    }
    case 'moveMade': {
      const nb = applyMove(s.board, a.path);
      const next: 'r' | 'b' = s.turn === 'r' ? 'b' : 'r';
      if (allMovesFor(nb, next).length === 0)
        return { ...s, board: nb, phase: 'over', statusMsg: 'You win!', selected: null, validMoves: [] };
      return { ...s, board: nb, turn: next, selected: null,
        validMoves: allMovesFor(nb, next), statusMsg: "Opponent's move" };
    }
    case 'opponentMove': {
      const nb = applyMove(s.board, a.path);
      const next: 'r' | 'b' = s.turn === 'r' ? 'b' : 'r';
      const myMoves = allMovesFor(nb, s.myColor);
      if (myMoves.length === 0)
        return { ...s, board: nb, phase: 'over', statusMsg: 'You lose.', selected: null, validMoves: [] };
      return { ...s, board: nb, turn: next, selected: null, validMoves: myMoves, statusMsg: 'Your move' };
    }
    case 'opponentResign': return { ...s, phase: 'over', statusMsg: 'Opponent resigned. You win!' };
    case 'over': return { ...s, phase: 'over', statusMsg: a.msg };
    default: return s;
  }
}

// ── Board Component ───────────────────────────────────────────────────────────

function CheckersBoard({ gs, onCellClick }: { gs: GameState; onCellClick: (i: number) => void }) {
  const validDests = gs.selected !== null
    ? new Set(gs.validMoves.filter(m => m.path[0] === gs.selected).map(m => m.path[1]))
    : new Set<number>();
  const cells = [];
  for (let i = 0; i < 64; i++) {
    const isDark = (Math.floor(i / 8) + i % 8) % 2 === 1;
    const piece = gs.board[i];
    cells.push(
      <div key={i}
        className={['checkers-cell', isDark ? 'dark' : 'light',
          gs.selected === i ? 'selected' : '', validDests.has(i) ? 'valid-dest' : ''].filter(Boolean).join(' ')}
        onClick={() => isDark && onCellClick(i)}>
        {piece && <div className={`checkers-piece ${piece}`}>{isKing(piece) && <span className="king-crown">♛</span>}</div>}
        {validDests.has(i) && !piece && <div className="valid-dot" />}
      </div>
    );
  }
  return <div className="checkers-board">{cells}</div>;
}

// ── Main Component ────────────────────────────────────────────────────────────

export function CheckersGame({ peerId, initiator }: GameProps) {
  const [gs, dispatch] = useReducer(reducer, {
    board: makeStartBoard(), myColor: 'r', turn: 'b', selected: null,
    validMoves: [], phase: 'waiting', statusMsg: 'Waiting…',
  });
  const [opponentName] = useState(peerId.slice(0, 8) + '…');
  const [showInvite, setShowInvite] = useState(!initiator);
  const [inviteFrom, setInviteFrom] = useState(peerId.slice(0, 8) + '…');
  const myColorRef = useRef<'r' | 'b'>('r');

  useEffect(() => {
    const offs: (() => void)[] = [];
    if (initiator) {
      offs.push(window.buzz.onGameAccepted(ev => {
        if (ev.fromPeerId !== peerId) return;
        myColorRef.current = 'r';
        dispatch({ type: 'start', myColor: 'r' });
      }));
      offs.push(window.buzz.onGameDeclined(ev => {
        if (ev.fromPeerId !== peerId) return;
        dispatch({ type: 'over', msg: 'Invitation declined.' });
      }));
    } else {
      offs.push(window.buzz.onGameInvite(ev => {
        if (ev.fromPeerId !== peerId) return;
        setInviteFrom(ev.fromName ?? ev.fromPeerId);
      }));
    }
    offs.push(window.buzz.onGameMove(ev => {
      if (ev.fromPeerId !== peerId) return;
      dispatch({ type: 'opponentMove', path: ev.path });
    }));
    offs.push(window.buzz.onGameResigned(ev => {
      if (ev.fromPeerId !== peerId) return;
      dispatch({ type: 'opponentResign' });
    }));
    return () => offs.forEach(f => f());
  }, [peerId, initiator]);

  function handleAccept() {
    setShowInvite(false);
    void window.buzz.gameAccept(peerId);
    myColorRef.current = 'b';
    dispatch({ type: 'start', myColor: 'b' });
  }
  function handleDecline() {
    setShowInvite(false);
    void window.buzz.gameDecline(peerId);
    dispatch({ type: 'over', msg: 'You declined.' });
  }
  function handleResign() {
    void window.buzz.gameResign(peerId);
    dispatch({ type: 'over', msg: 'You resigned.' });
  }

  function handleCellClick(idx: number) {
    if (gs.phase !== 'playing' || gs.turn !== myColorRef.current) return;
    if (gs.selected === null) {
      const piece = gs.board[idx];
      if (!piece) return;
      if (!(myColorRef.current === 'r' ? isRed : isBlack)(piece)) return;
      if (!gs.validMoves.some(m => m.path[0] === idx)) return;
      dispatch({ type: 'select', idx });
    } else {
      const movesFrom = gs.validMoves.filter(m => m.path[0] === gs.selected);
      const move = movesFrom.find(m => m.path[m.path.length - 1] === idx);
      if (move) {
        void window.buzz.gameMove({ toPeerId: peerId, kind: 'checkers', path: move.path });
        dispatch({ type: 'moveMade', path: move.path });
      } else {
        const piece = gs.board[idx];
        if (piece && (myColorRef.current === 'r' ? isRed : isBlack)(piece))
          dispatch({ type: 'select', idx });
        else
          dispatch({ type: 'select', idx: -1 });
      }
    }
  }

  const status = initiator && gs.phase === 'waiting' ? 'Waiting for opponent to accept…' : gs.statusMsg;

  return (
    <div className="game-window">
      <WindowChrome title={`Checkers — ${opponentName}`} />
      {showInvite && (
        <InviteOverlay gameName="Checkers" fromName={inviteFrom}
          onAccept={handleAccept} onDecline={handleDecline} />
      )}
      {gs.phase === 'over' && <GameOverBanner msg={gs.statusMsg} />}
      <div className="game-status-bar">
        <span className="game-status-msg">{status}</span>
        {gs.phase === 'playing' && (
          <button className="game-resign-btn" onClick={handleResign}>Resign</button>
        )}
      </div>
      <CheckersBoard gs={{ ...gs, myColor: myColorRef.current }} onCellClick={handleCellClick} />
    </div>
  );
}

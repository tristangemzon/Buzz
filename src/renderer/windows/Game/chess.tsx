import React, { useEffect, useReducer, useState } from 'react';
import { WindowChrome } from '../../components/WindowChrome';
import { InviteOverlay, GameOverBanner, WaitingOverlay, type GameProps } from './shared';

// ── Piece encoding ────────────────────────────────────────────────────────────
// 'wP' | 'wN' | 'wB' | 'wR' | 'wQ' | 'wK' | 'bP' | 'bN' | 'bB' | 'bR' | 'bQ' | 'bK'
type CP = string;
type CB = (CP | null)[];
type Color = 'w' | 'b';
type Castle = { wK: boolean; wQ: boolean; bK: boolean; bQ: boolean };

const PIECE_UNICODE: Record<string, string> = {
  wK:'♔', wQ:'♕', wR:'♖', wB:'♗', wN:'♘', wP:'♙',
  bK:'♚', bQ:'♛', bR:'♜', bB:'♝', bN:'♞', bP:'♟',
};

function makeChessBoard(): CB {
  const b: CB = Array(64).fill(null);
  const back = ['R','N','B','Q','K','B','N','R'];
  for (let c = 0; c < 8; c++) {
    b[c]      = 'b' + back[c];
    b[8 + c]  = 'bP';
    b[48 + c] = 'wP';
    b[56 + c] = 'w' + back[c];
  }
  return b;
}

// ── Attack detection (no pawn forward push) ───────────────────────────────────

function isAttacked(board: CB, sq: number, by: Color): boolean {
  const row = Math.floor(sq / 8), col = sq % 8;
  // Knight
  for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]] as [number,number][]) {
    const r = row + dr, c = col + dc;
    if (r < 0 || r > 7 || c < 0 || c > 7) continue;
    if (board[r * 8 + c] === by + 'N') return true;
  }
  // Rook / Queen (straight)
  for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]] as [number,number][]) {
    let r = row + dr, c = col + dc;
    while (r >= 0 && r < 8 && c >= 0 && c < 8) {
      const p = board[r * 8 + c];
      if (p) { if (p[0] === by && (p[1] === 'R' || p[1] === 'Q')) return true; break; }
      r += dr; c += dc;
    }
  }
  // Bishop / Queen (diagonal)
  for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1]] as [number,number][]) {
    let r = row + dr, c = col + dc;
    while (r >= 0 && r < 8 && c >= 0 && c < 8) {
      const p = board[r * 8 + c];
      if (p) { if (p[0] === by && (p[1] === 'B' || p[1] === 'Q')) return true; break; }
      r += dr; c += dc;
    }
  }
  // King
  for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]] as [number,number][]) {
    const r = row + dr, c = col + dc;
    if (r < 0 || r > 7 || c < 0 || c > 7) continue;
    if (board[r * 8 + c] === by + 'K') return true;
  }
  // Pawn — attacks come from row+dir where dir is 1 for white attacker, -1 for black attacker
  const pd = by === 'w' ? 1 : -1;
  const pr = row + pd;
  if (pr >= 0 && pr < 8) {
    for (const dc of [-1, 1]) {
      const c = col + dc;
      if (c >= 0 && c <= 7 && board[pr * 8 + c] === by + 'P') return true;
    }
  }
  return false;
}

function isInCheck(board: CB, color: Color): boolean {
  const ki = board.findIndex(p => p === color + 'K');
  return ki !== -1 && isAttacked(board, ki, color === 'w' ? 'b' : 'w');
}

// ── Pseudo-legal move generation ──────────────────────────────────────────────

function pseudoMoves(board: CB, from: number, ep: number | null, castle: Castle): number[] {
  const piece = board[from]; if (!piece) return [];
  const color = piece[0] as Color, type = piece[1];
  const row = Math.floor(from / 8), col = from % 8;
  const moves: number[] = [];
  const friendly = (to: number) => board[to]?.[0] === color;
  function slide(dr: number, dc: number) {
    let r = row + dr, c = col + dc;
    while (r >= 0 && r < 8 && c >= 0 && c < 8) {
      const to = r * 8 + c;
      if (friendly(to)) break;
      moves.push(to);
      if (board[to]) break;
      r += dr; c += dc;
    }
  }
  switch (type) {
    case 'P': {
      const dir = color === 'w' ? -1 : 1;
      const sr  = color === 'w' ? 6 : 1;
      const fwd = from + dir * 8;
      if (fwd >= 0 && fwd < 64 && !board[fwd]) {
        moves.push(fwd);
        const fwd2 = from + dir * 16;
        if (row === sr && !board[fwd2]) moves.push(fwd2);
      }
      for (const dc of [-1, 1]) {
        const tc = col + dc;
        if (tc < 0 || tc > 7) continue;
        const to = (row + dir) * 8 + tc;
        if (to >= 0 && to < 64 && ((board[to] && board[to]![0] !== color) || to === ep)) moves.push(to);
      }
      break;
    }
    case 'N':
      for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]] as [number,number][]) {
        const r = row + dr, c = col + dc;
        if (r < 0 || r > 7 || c < 0 || c > 7) continue;
        const to = r * 8 + c;
        if (!friendly(to)) moves.push(to);
      }
      break;
    case 'B': for (const d of [[-1,-1],[-1,1],[1,-1],[1,1]] as [number,number][]) slide(d[0], d[1]); break;
    case 'R': for (const d of [[-1,0],[1,0],[0,-1],[0,1]] as [number,number][]) slide(d[0], d[1]); break;
    case 'Q': for (const d of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]] as [number,number][]) slide(d[0], d[1]); break;
    case 'K': {
      for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]] as [number,number][]) {
        const r = row + dr, c = col + dc;
        if (r < 0 || r > 7 || c < 0 || c > 7) continue;
        const to = r * 8 + c;
        if (!friendly(to)) moves.push(to);
      }
      if (color === 'w') {
        if (castle.wK && !board[61] && !board[62] && board[63] === 'wR') moves.push(62);
        if (castle.wQ && !board[57] && !board[58] && !board[59] && board[56] === 'wR') moves.push(58);
      } else {
        if (castle.bK && !board[5] && !board[6] && board[7] === 'bR') moves.push(6);
        if (castle.bQ && !board[1] && !board[2] && !board[3] && board[0] === 'bR') moves.push(2);
      }
      break;
    }
  }
  return moves;
}

// ── Move application ──────────────────────────────────────────────────────────

function applyChessMove(
  board: CB, from: number, to: number, promo: string | null,
  castle: Castle, ep: number | null,
): { board: CB; castle: Castle; ep: number | null } {
  const nb = [...board];
  const piece = nb[from]!;
  const color = piece[0] as Color, type = piece[1];
  let newEP: number | null = null;
  const c = { ...castle };

  // En passant capture
  if (type === 'P' && to === ep) {
    const capRow = Math.floor(ep / 8) + (color === 'w' ? 1 : -1);
    nb[capRow * 8 + (ep % 8)] = null;
  }
  // Double pawn push
  if (type === 'P' && Math.abs(to - from) === 16) newEP = (from + to) / 2;

  // Castling — move rook
  if (type === 'K') {
    if (to === from + 2) { nb[from + 1] = nb[from + 3] ?? null; nb[from + 3] = null; }
    if (to === from - 2) { nb[from - 1] = nb[from - 4] ?? null; nb[from - 4] = null; }
    if (color === 'w') { c.wK = false; c.wQ = false; }
    else               { c.bK = false; c.bQ = false; }
  }
  if (piece === 'wR') { if (from === 56) c.wQ = false; if (from === 63) c.wK = false; }
  if (piece === 'bR') { if (from === 0)  c.bQ = false; if (from === 7)  c.bK = false; }
  // Capture rook invalidates castling rights
  if (to === 56) c.wQ = false; if (to === 63) c.wK = false;
  if (to === 0)  c.bQ = false; if (to === 7)  c.bK = false;

  // Promotion
  let final = piece;
  if (type === 'P') {
    if ((color === 'w' && Math.floor(to / 8) === 0) || (color === 'b' && Math.floor(to / 8) === 7))
      final = color + (promo ?? 'Q');
  }
  nb[from] = null; nb[to] = final;
  return { board: nb, castle: c, ep: newEP };
}

// ── Legal moves ───────────────────────────────────────────────────────────────

function legalMoves(board: CB, from: number, castle: Castle, ep: number | null): number[] {
  const piece = board[from]; if (!piece) return [];
  const color = piece[0] as Color;
  const opp = color === 'w' ? 'b' : 'w';
  const pseudo = pseudoMoves(board, from, ep, castle);
  const legal: number[] = [];
  for (const to of pseudo) {
    if (piece[1] === 'K') {
      if (to === from + 2) { if (isInCheck(board, color) || isAttacked(board, from + 1, opp)) continue; }
      if (to === from - 2) { if (isInCheck(board, color) || isAttacked(board, from - 1, opp)) continue; }
    }
    const { board: nb } = applyChessMove(board, from, to, null, castle, ep);
    if (!isInCheck(nb, color)) legal.push(to);
  }
  return legal;
}

function hasAnyLegal(board: CB, color: Color, castle: Castle, ep: number | null): boolean {
  for (let i = 0; i < 64; i++) {
    if (board[i]?.[0] !== color) continue;
    if (legalMoves(board, i, castle, ep).length > 0) return true;
  }
  return false;
}

// ── State ─────────────────────────────────────────────────────────────────────

type ChessState = {
  board: CB;
  turn: Color;
  myColor: Color | null;
  castle: Castle;
  ep: number | null;
  phase: 'waiting' | 'playing' | 'over';
  selected: number | null;
  legalDests: number[];
  check: boolean;
  statusMsg: string;
  promoFrom: number | null; // pending promotion square
  promoTo: number | null;
};
type ChessAction =
  | { type: 'start'; myColor: Color }
  | { type: 'select'; from: number }
  | { type: 'move'; from: number; to: number; promo?: string }
  | { type: 'oppMove'; from: number; to: number; promo?: string }
  | { type: 'over'; msg: string };

const INIT_CASTLE: Castle = { wK: true, wQ: true, bK: true, bQ: true };

function chessReducer(s: ChessState, a: ChessAction): ChessState {
  switch (a.type) {
    case 'start': {
      const board = makeChessBoard();
      return { ...s, board, myColor: a.myColor, turn: 'w', castle: INIT_CASTLE, ep: null,
        phase: 'playing', selected: null, legalDests: [], check: false,
        statusMsg: a.myColor === 'w' ? 'Your move' : "Opponent's move" };
    }
    case 'select': {
      if (s.phase !== 'playing' || s.turn !== s.myColor) return s;
      if (s.board[a.from]?.[0] !== s.myColor) return { ...s, selected: null, legalDests: [] };
      const dests = legalMoves(s.board, a.from, s.castle, s.ep);
      return { ...s, selected: a.from, legalDests: dests };
    }
    case 'move': {
      const { board: nb, castle, ep } = applyChessMove(s.board, a.from, a.to, a.promo ?? null, s.castle, s.ep);
      const next: Color = s.turn === 'w' ? 'b' : 'w';
      const inCheck = isInCheck(nb, next);
      const anyLegal = hasAnyLegal(nb, next, castle, ep);
      if (!anyLegal) {
        const msg = inCheck ? (next === s.myColor ? 'Checkmate — you lose.' : 'Checkmate — you win!') : 'Stalemate — draw.';
        return { ...s, board: nb, castle, ep, phase: 'over', check: false, statusMsg: msg, selected: null, legalDests: [] };
      }
      return { ...s, board: nb, castle, ep, turn: next, check: inCheck,
        selected: null, legalDests: [],
        statusMsg: next === s.myColor ? (inCheck ? 'Your move (check!)' : 'Your move') : "Opponent's move" };
    }
    case 'oppMove': {
      const { board: nb, castle, ep } = applyChessMove(s.board, a.from, a.to, a.promo ?? null, s.castle, s.ep);
      const next: Color = s.turn === 'w' ? 'b' : 'w';
      const inCheck = isInCheck(nb, next);
      const anyLegal = hasAnyLegal(nb, next, castle, ep);
      if (!anyLegal) {
        const msg = inCheck ? (next === s.myColor ? 'Checkmate — you lose.' : 'Checkmate — you win!') : 'Stalemate — draw.';
        return { ...s, board: nb, castle, ep, phase: 'over', check: false, statusMsg: msg };
      }
      return { ...s, board: nb, castle, ep, turn: next, check: inCheck,
        selected: null, legalDests: [],
        statusMsg: next === s.myColor ? (inCheck ? 'Your move (check!)' : 'Your move') : "Opponent's move" };
    }
    case 'over': return { ...s, phase: 'over', statusMsg: a.msg };
    default: return s;
  }
}

// ── Board Component ───────────────────────────────────────────────────────────

function ChessBoard({ state, onSquare }: { state: ChessState; onSquare: (i: number) => void }) {
  const flipped = state.myColor === 'b';
  const kingIdx = state.check ? state.board.findIndex(p => p === state.myColor + 'K') : -1;
  const cells = [];
  for (let s = 0; s < 64; s++) {
    const i = flipped ? 63 - s : s;
    const row = Math.floor(i / 8), col = i % 8;
    const isLight = (row + col) % 2 === 0;
    const piece = state.board[i];
    const isSelected = state.selected === i;
    const isDest = state.legalDests.includes(i);
    const isCheck = i === kingIdx;
    cells.push(
      <div key={i}
        className={['chess-cell', isLight ? 'chess-light' : 'chess-dark',
          isSelected ? 'chess-selected' : '', isDest ? 'chess-dest' : '',
          isCheck ? 'chess-check' : ''].filter(Boolean).join(' ')}
        onClick={() => onSquare(i)}>
        {piece && <span className="chess-piece">{PIECE_UNICODE[piece] ?? piece}</span>}
        {isDest && !piece && <div className="chess-dot" />}
      </div>
    );
  }
  return <div className="chess-board">{cells}</div>;
}

function PromoModal({ color, onPick }: { color: Color; onPick: (p: string) => void }) {
  const pieces = ['Q','R','B','N'].map(t => color + t);
  return (
    <div className="game-overlay">
      <div className="game-overlay-box">
        <p style={{ marginBottom: 10 }}>Promote pawn:</p>
        <div className="game-overlay-actions">
          {pieces.map(p => (
            <button key={p} style={{ fontSize: 22, minWidth: 36 }} onClick={() => onPick(p[1]!)}>
              {PIECE_UNICODE[p]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function ChessGame({ peerId, initiator }: GameProps) {
  const [state, dispatch] = useReducer(chessReducer, {
    board: makeChessBoard(), turn: 'w', myColor: null, castle: INIT_CASTLE, ep: null,
    phase: 'waiting', selected: null, legalDests: [], check: false,
    statusMsg: 'Waiting…', promoFrom: null, promoTo: null,
  });
  const [showInvite, setShowInvite] = useState(!initiator);
  const [fromName] = useState(peerId.slice(0, 8) + '…');
  const [pendingPromo, setPendingPromo] = useState<{ from: number; to: number } | null>(null);

  useEffect(() => {
    const offs: (() => void)[] = [];
    if (initiator) {
      offs.push(window.buzz.onGameAccepted(ev => {
        if (ev.fromPeerId !== peerId) return;
        dispatch({ type: 'start', myColor: 'w' }); // initiator = white
      }));
      offs.push(window.buzz.onGameDeclined(ev => {
        if (ev.fromPeerId !== peerId) return;
        dispatch({ type: 'over', msg: 'Invitation declined.' });
      }));
    }
    offs.push(window.buzz.onGameMove(ev => {
      if (ev.fromPeerId !== peerId) return;
      const [from, to, promoCode] = ev.path;
      if (from === undefined || to === undefined) return;
      const promo = promoCode !== undefined ? String.fromCharCode(promoCode) : undefined;
      dispatch({ type: 'oppMove', from, to, promo });
    }));
    offs.push(window.buzz.onGameResigned(ev => {
      if (ev.fromPeerId !== peerId) return;
      dispatch({ type: 'over', msg: 'Opponent resigned. You win!' });
    }));
    return () => offs.forEach(f => f());
  }, [peerId, initiator]);

  function isPawnPromotion(from: number, to: number): boolean {
    const piece = state.board[from];
    if (!piece || piece[1] !== 'P') return false;
    const destRow = Math.floor(to / 8);
    return (piece[0] === 'w' && destRow === 0) || (piece[0] === 'b' && destRow === 7);
  }

  function commitMove(from: number, to: number, promo?: string) {
    const path: number[] = [from, to];
    if (promo) path.push(promo.charCodeAt(0));
    void window.buzz.gameMove({ toPeerId: peerId, kind: 'chess', path });
    dispatch({ type: 'move', from, to, promo });
  }

  function handleSquare(idx: number) {
    if (state.phase !== 'playing' || state.turn !== state.myColor) return;
    if (state.selected === null) {
      if (state.board[idx]?.[0] === state.myColor) dispatch({ type: 'select', from: idx });
    } else {
      if (state.legalDests.includes(idx)) {
        if (isPawnPromotion(state.selected, idx)) {
          setPendingPromo({ from: state.selected, to: idx });
        } else {
          commitMove(state.selected, idx);
        }
      } else if (state.board[idx]?.[0] === state.myColor) {
        dispatch({ type: 'select', from: idx });
      } else {
        dispatch({ type: 'select', from: -1 });
      }
    }
  }

  const status = initiator && state.phase === 'waiting' ? 'Waiting for opponent…' : state.statusMsg;

  return (
    <div className="game-window">
      <WindowChrome title={`Chess — ${fromName}`} />
      {showInvite && (
        <InviteOverlay gameName="Chess" fromName={fromName}
          onAccept={() => { setShowInvite(false); void window.buzz.gameAccept(peerId); dispatch({ type: 'start', myColor: 'b' }); }}
          onDecline={() => { setShowInvite(false); void window.buzz.gameDecline(peerId); dispatch({ type: 'over', msg: 'You declined.' }); }}
        />
      )}
      {state.phase === 'waiting' && initiator && <WaitingOverlay msg="Waiting for opponent to accept…" />}
      {state.phase === 'over' && <GameOverBanner msg={state.statusMsg} />}
      {pendingPromo && state.myColor && (
        <PromoModal color={state.myColor}
          onPick={p => { commitMove(pendingPromo.from, pendingPromo.to, p); setPendingPromo(null); }} />
      )}
      <div className="game-status-bar">
        <span className="game-status-msg">{status}</span>
        {state.phase === 'playing' && (
          <button className="game-resign-btn"
            onClick={() => { void window.buzz.gameResign(peerId); dispatch({ type: 'over', msg: 'You resigned.' }); }}>
            Resign
          </button>
        )}
      </div>
      <ChessBoard state={state} onSquare={handleSquare} />
    </div>
  );
}

import { StrictMode, useEffect, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WindowChrome } from '../../components/WindowChrome';
import '../../theme/aim5.css';

// ── Types ────────────────────────────────────────────────────────────────────

type Cell = null | 'r' | 'b' | 'R' | 'B';
type Board = Cell[];

// ── Starting Board ───────────────────────────────────────────────────────────

function makeStartBoard(): Board {
  const b: Board = Array(64).fill(null);
  // Black pieces on rows 0-2 (indices 0..23), only dark squares
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 8; col++) {
      if ((row + col) % 2 === 1) {
        b[row * 8 + col] = 'b';
      }
    }
  }
  // Red pieces on rows 5-7 (indices 40..63), only dark squares
  for (let row = 5; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      if ((row + col) % 2 === 1) {
        b[row * 8 + col] = 'r';
      }
    }
  }
  return b;
}

// ── Move Logic ───────────────────────────────────────────────────────────────

function isRed(c: Cell): boolean { return c === 'r' || c === 'R'; }
function isBlack(c: Cell): boolean { return c === 'b' || c === 'B'; }
function isKing(c: Cell): boolean { return c === 'R' || c === 'B'; }
function isEnemy(a: Cell, b: Cell): boolean {
  if (!a || !b) return false;
  return (isRed(a) && isBlack(b)) || (isBlack(a) && isRed(b));
}

type Move = { path: number[] };

function getJumps(board: Board, from: number, piece: Cell, visited: Set<number>): Move[] {
  const row = Math.floor(from / 8);
  const col = from % 8;
  const dirs: [number, number][] = [];
  if (piece === 'r' || piece === 'R') dirs.push([-1, -1], [-1, 1]);
  if (piece === 'b' || piece === 'B') dirs.push([1, -1], [1, 1]);
  if (piece === 'R' || piece === 'B') {
    // king gets all dirs (no duplicates needed — we already covered above)
    if (!dirs.find(([dr, dc]) => dr === 1 && dc === -1)) dirs.push([1, -1], [1, 1]);
    if (!dirs.find(([dr, dc]) => dr === -1 && dc === -1)) dirs.push([-1, -1], [-1, 1]);
  }
  const result: Move[] = [];
  for (const [dr, dc] of dirs) {
    const mr = row + dr, mc = col + dc;
    const lr = row + 2 * dr, lc = col + 2 * dc;
    if (lr < 0 || lr > 7 || lc < 0 || lc > 7) continue;
    const midIdx = mr * 8 + mc;
    const landIdx = lr * 8 + lc;
    const midCell = board[midIdx] ?? null;
    if (isEnemy(piece, midCell) && (board[landIdx] ?? null) === null && !visited.has(midIdx)) {
      const tempBoard = [...board];
      tempBoard[from] = null;
      tempBoard[midIdx] = null;
      tempBoard[landIdx] = piece;
      const sub = getJumps(tempBoard, landIdx, piece, new Set([...visited, midIdx]));
      if (sub.length === 0) {
        result.push({ path: [from, landIdx] });
      } else {
        for (const s of sub) {
          result.push({ path: [from, ...s.path] });
        }
      }
    }
  }
  return result;
}

function getSimpleMoves(board: Board, from: number, piece: Cell): Move[] {
  const row = Math.floor(from / 8);
  const col = from % 8;
  const dirs: [number, number][] = [];
  if (piece === 'r' || piece === 'R') dirs.push([-1, -1], [-1, 1]);
  if (piece === 'b' || piece === 'B') dirs.push([1, -1], [1, 1]);
  if (piece === 'R' || piece === 'B') {
    if (!dirs.find(([dr, dc]) => dr === 1 && dc === -1)) dirs.push([1, -1], [1, 1]);
    if (!dirs.find(([dr, dc]) => dr === -1 && dc === -1)) dirs.push([-1, -1], [-1, 1]);
  }
  return dirs
    .map(([dr, dc]) => ({ r: row + dr, c: col + dc }))
    .filter(({ r, c }) => r >= 0 && r <= 7 && c >= 0 && c <= 7 && (board[r * 8 + c] ?? null) === null)
    .map(({ r, c }) => ({ path: [from, r * 8 + c] }));
}

function allMovesFor(board: Board, color: 'r' | 'b'): Move[] {
  const isOurs = color === 'r' ? isRed : isBlack;
  const jumps: Move[] = [];
  const simples: Move[] = [];
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
    const from = path[i]!;
    const to = path[i + 1]!;
    // Capture middle square
    const midRow = (Math.floor(from / 8) + Math.floor(to / 8)) / 2;
    const midCol = ((from % 8) + (to % 8)) / 2;
    if (Number.isInteger(midRow) && Number.isInteger(midCol)) {
      const midIdx = midRow * 8 + midCol;
      if (nb[midIdx] !== piece && nb[midIdx] !== null) nb[midIdx] = null;
    }
    nb[from] = null;
    nb[to] = piece;
  }
  // King promotion
  const dest = path[path.length - 1]!;
  const destRow = Math.floor(dest / 8);
  if (nb[dest] === 'r' && destRow === 0) nb[dest] = 'R';
  if (nb[dest] === 'b' && destRow === 7) nb[dest] = 'B';
  return nb;
}

// ── Game State ───────────────────────────────────────────────────────────────

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

function reducer(s: GameState, a: Action): GameState {
  switch (a.type) {
    case 'start': {
      const board = makeStartBoard();
      return {
        board,
        myColor: a.myColor,
        turn: 'b', // black goes first
        selected: null,
        validMoves: allMovesFor(board, 'b'),
        phase: 'playing',
        statusMsg: a.myColor === 'b' ? 'Your move' : "Opponent's move",
      };
    }
    case 'select': {
      if (s.phase !== 'playing' || s.turn !== s.myColor) return s;
      const piece = s.board[a.idx];
      if (!piece) return { ...s, selected: null };
      const isOurs = s.myColor === 'r' ? isRed : isBlack;
      if (!isOurs(piece)) return { ...s, selected: null };
      // Check if any valid moves start from here
      const movesFromHere = s.validMoves.filter((m) => m.path[0] === a.idx);
      return { ...s, selected: a.idx, validMoves: movesFromHere.length > 0 ? s.validMoves : s.validMoves };
    }
    case 'moveMade': {
      const nb = applyMove(s.board, a.path);
      const nextTurn: 'r' | 'b' = s.turn === 'r' ? 'b' : 'r';
      const oppMoves = allMovesFor(nb, nextTurn);
      if (oppMoves.length === 0) {
        return { ...s, board: nb, phase: 'over', statusMsg: 'You win!', selected: null, validMoves: [] };
      }
      return {
        ...s,
        board: nb,
        turn: nextTurn,
        selected: null,
        validMoves: allMovesFor(nb, nextTurn),
        statusMsg: "Opponent's move",
        phase: 'playing',
      };
    }
    case 'opponentMove': {
      const nb = applyMove(s.board, a.path);
      const nextTurn = s.turn === 'r' ? 'b' : 'r' as 'r' | 'b';
      const myMoves = allMovesFor(nb, s.myColor);
      if (myMoves.length === 0) {
        return { ...s, board: nb, phase: 'over', statusMsg: 'You lose.', selected: null, validMoves: [] };
      }
      return {
        ...s,
        board: nb,
        turn: nextTurn,
        selected: null,
        validMoves: myMoves,
        statusMsg: 'Your move',
        phase: 'playing',
      };
    }
    case 'opponentResign':
      return { ...s, phase: 'over', statusMsg: 'Opponent resigned. You win!' };
    case 'over':
      return { ...s, phase: 'over', statusMsg: a.msg };
    default:
      return s;
  }
}

// ── Parse Window Hash ────────────────────────────────────────────────────────

function parseHash(): { peerId: string; kind: string; initiator: boolean } {
  const h = window.location.hash.replace('#', '');
  const parts = h.split(':');
  // format: peerId:kind[:initiator]
  const peerId = parts[0] ?? '';
  const kind = parts[1] ?? 'checkers';
  const initiator = parts[2] === '1';
  return { peerId, kind, initiator };
}

// ── Invite / Accept Overlay ──────────────────────────────────────────────────

function InviteOverlay({
  fromName,
  onAccept,
  onDecline,
}: {
  fromName: string;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="game-overlay">
      <div className="game-overlay-box">
        <p><strong>{fromName}</strong> wants to play Checkers!</p>
        <div className="game-overlay-actions">
          <button onClick={onAccept}>Accept</button>
          <button onClick={onDecline}>Decline</button>
        </div>
      </div>
    </div>
  );
}

// ── Board ────────────────────────────────────────────────────────────────────

function CheckersBoard({
  gs,
  onCellClick,
}: {
  gs: GameState;
  onCellClick: (idx: number) => void;
}) {
  const validDests = gs.selected !== null
    ? new Set(gs.validMoves.filter((m) => m.path[0] === gs.selected).map((m) => m.path[1]))
    : new Set<number>();

  const cells = [];
  for (let i = 0; i < 64; i++) {
    const row = Math.floor(i / 8);
    const col = i % 8;
    const isDark = (row + col) % 2 === 1;
    const piece = gs.board[i];
    const isSelected = gs.selected === i;
    const isValidDest = validDests.has(i);
    cells.push(
      <div
        key={i}
        className={[
          'checkers-cell',
          isDark ? 'dark' : 'light',
          isSelected ? 'selected' : '',
          isValidDest ? 'valid-dest' : '',
        ].filter(Boolean).join(' ')}
        onClick={() => isDark && onCellClick(i)}
      >
        {piece && (
          <div className={['checkers-piece', piece].join(' ')}>
            {isKing(piece) && <span className="king-crown">♛</span>}
          </div>
        )}
        {isValidDest && !piece && <div className="valid-dot" />}
      </div>
    );
  }
  return <div className="checkers-board">{cells}</div>;
}

// ── Main App ─────────────────────────────────────────────────────────────────

function GameApp() {
  const { peerId, initiator } = parseHash();
  const [gs, dispatch] = useReducer(reducer, {
    board: makeStartBoard(),
    myColor: 'r',
    turn: 'b',
    selected: null,
    validMoves: [],
    phase: 'waiting',
    statusMsg: 'Waiting…',
  });

  const [opponentName, setOpponentName] = useState(peerId.slice(0, 8) + '…');
  const [showInvite, setShowInvite] = useState(false);
  const [inviteFrom, setInviteFrom] = useState('');
  const myColorRef = useRef<'r' | 'b'>('r');

  // Set up IPC listeners
  useEffect(() => {
    // Initiator (invited them) = red, waits for accept
    // Acceptor = black, goes first
    if (initiator) {
      setOpponentName(peerId.slice(0, 8) + '…');
      // Wait for accept
      const off = window.buzz.onGameAccepted((ev) => {
        if (ev.fromPeerId !== peerId) return;
        myColorRef.current = 'r';
        dispatch({ type: 'start', myColor: 'r' });
      });
      const offD = window.buzz.onGameDeclined((ev) => {
        if (ev.fromPeerId !== peerId) return;
        dispatch({ type: 'over', msg: 'Invitation declined.' });
      });
      return () => { off(); offD(); };
    } else {
      // We received the invite; show overlay
      const off = window.buzz.onGameInvite((ev) => {
        if (ev.fromPeerId !== peerId) return;
        setInviteFrom(ev.fromName ?? ev.fromPeerId);
        setShowInvite(true);
      });
      // Trigger showing invite if it already came
      setShowInvite(true);
      return () => { off(); };
    }
  }, [peerId, initiator]);

  // Listen for moves and resign
  useEffect(() => {
    const offMove = window.buzz.onGameMove((ev) => {
      if (ev.fromPeerId !== peerId) return;
      dispatch({ type: 'opponentMove', path: ev.path });
    });
    const offResign = window.buzz.onGameResigned((ev) => {
      if (ev.fromPeerId !== peerId) return;
      dispatch({ type: 'opponentResign' });
    });
    return () => { offMove(); offResign(); };
  }, [peerId]);

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
    if (gs.phase !== 'playing') return;
    if (gs.turn !== myColorRef.current) return;

    if (gs.selected === null) {
      // Select a piece
      const piece = gs.board[idx];
      if (!piece) return;
      const isOurs = myColorRef.current === 'r' ? isRed : isBlack;
      if (!isOurs(piece)) return;
      const movesFromHere = gs.validMoves.filter((m) => m.path[0] === idx);
      if (movesFromHere.length === 0) return;
      dispatch({ type: 'select', idx });
    } else {
      // Try to move
      const movesFromSelected = gs.validMoves.filter((m) => m.path[0] === gs.selected);
      const move = movesFromSelected.find((m) => m.path[m.path.length - 1] === idx);
      if (move) {
        void window.buzz.gameMove({ toPeerId: peerId, kind: 'checkers', path: move.path });
        dispatch({ type: 'moveMade', path: move.path });
      } else {
        // Re-select if clicking own piece
        const piece = gs.board[idx];
        if (piece) {
          const isOurs = myColorRef.current === 'r' ? isRed : isBlack;
          if (isOurs(piece)) {
            dispatch({ type: 'select', idx });
            return;
          }
        }
        dispatch({ type: 'select', idx: -1 }); // deselect hack
      }
    }
  }

  return (
    <div className="game-window">
      <WindowChrome title={`Checkers — ${opponentName}`} />
      {showInvite && (
        <InviteOverlay
          fromName={inviteFrom || opponentName}
          onAccept={handleAccept}
          onDecline={handleDecline}
        />
      )}
      <div className="game-status-bar">
        <span className="game-status-msg">{gs.statusMsg}</span>
        {gs.phase === 'playing' && (
          <button className="game-resign-btn" onClick={handleResign}>Resign</button>
        )}
      </div>
      <CheckersBoard gs={{ ...gs, myColor: myColorRef.current }} onCellClick={handleCellClick} />
    </div>
  );
}

const el = document.getElementById('root')!;
createRoot(el).render(
  <StrictMode>
    <GameApp />
  </StrictMode>,
);

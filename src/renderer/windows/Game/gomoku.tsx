import React, { useEffect, useReducer, useState } from 'react';
import { WindowChrome } from '../../components/WindowChrome';
import { InviteOverlay, GameOverBanner, type GameProps } from './shared';

const SIZE = 15;

type Cell  = null | 'b' | 'w';
type Board = Cell[];

function makeBoard(): Board { return Array(SIZE * SIZE).fill(null); }

function checkWin(board: Board, idx: number, color: Cell): boolean {
  const row = Math.floor(idx / SIZE), col = idx % SIZE;
  for (const [dr, dc] of [[0,1],[1,0],[1,1],[1,-1]] as [number,number][]) {
    let n = 1;
    for (let sign = -1; sign <= 1; sign += 2) {
      let r = row + sign * dr, c = col + sign * dc;
      while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r * SIZE + c] === color) {
        n++; r += sign * dr; c += sign * dc;
      }
    }
    if (n >= 5) return true;
  }
  return false;
}

type State = {
  board: Board;
  turn: Cell;
  myColor: Cell;
  phase: 'waiting' | 'playing' | 'over';
  statusMsg: string;
  lastPlaced: number | null;
};
type Action =
  | { type: 'start'; myColor: Cell }
  | { type: 'placed'; idx: number; color: Cell }
  | { type: 'over'; msg: string };

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'start': return { ...s, board: makeBoard(), myColor: a.myColor, turn: 'b',
      phase: 'playing', lastPlaced: null,
      statusMsg: a.myColor === 'b' ? 'Your move' : "Opponent's move" };
    case 'placed': {
      const nb = [...s.board]; nb[a.idx] = a.color;
      if (checkWin(nb, a.idx, a.color)) {
        const winner = a.color === s.myColor ? 'You win!' : 'You lose.';
        return { ...s, board: nb, phase: 'over', lastPlaced: a.idx, statusMsg: winner, turn: null };
      }
      if (nb.every(c => c !== null))
        return { ...s, board: nb, phase: 'over', lastPlaced: a.idx, statusMsg: 'Draw!', turn: null };
      const next: Cell = a.color === 'b' ? 'w' : 'b';
      return { ...s, board: nb, turn: next, lastPlaced: a.idx,
        statusMsg: next === s.myColor ? 'Your move' : "Opponent's move" };
    }
    case 'over': return { ...s, phase: 'over', statusMsg: a.msg };
    default: return s;
  }
}

function GomokuBoard({ state, onCell }: { state: State; onCell: (i: number) => void }) {
  const cells = [];
  for (let i = 0; i < SIZE * SIZE; i++) {
    const piece = state.board[i];
    const row = Math.floor(i / SIZE), col = i % SIZE;
    const isLast = state.lastPlaced === i;
    cells.push(
      <div key={i} className="gk-cell"
        style={{
          borderRight: col < SIZE - 1 ? '1px solid #7a5c1e' : 'none',
          borderBottom: row < SIZE - 1 ? '1px solid #7a5c1e' : 'none',
        }}
        onClick={() => !piece && state.phase === 'playing' && state.turn === state.myColor && onCell(i)}>
        {piece && <div className={`gk-stone gk-${piece}${isLast ? ' gk-last' : ''}`} />}
      </div>
    );
  }
  return <div className="gk-board" style={{ gridTemplateColumns: `repeat(${SIZE}, 1fr)` }}>{cells}</div>;
}

export function GomokuGame({ peerId, initiator }: GameProps) {
  const [state, dispatch] = useReducer(reducer, {
    board: makeBoard(), myColor: null, turn: 'b',
    phase: 'waiting', statusMsg: 'Waiting…', lastPlaced: null,
  });
  const [showInvite, setShowInvite] = useState(!initiator);
  const [fromName] = useState(peerId.slice(0, 8) + '…');

  useEffect(() => {
    const offs: (() => void)[] = [];
    if (initiator) {
      offs.push(window.buzz.onGameAccepted(ev => {
        if (ev.fromPeerId !== peerId) return;
        dispatch({ type: 'start', myColor: 'b' }); // initiator = black, goes first
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
    dispatch({ type: 'start', myColor: 'w' }); // acceptor = white
  }
  function handleDecline() {
    setShowInvite(false);
    void window.buzz.gameDecline(peerId);
    dispatch({ type: 'over', msg: 'You declined.' });
  }
  function handleCell(idx: number) {
    if (state.phase !== 'playing' || state.turn !== state.myColor) return;
    void window.buzz.gameMove({ toPeerId: peerId, kind: 'gomoku', path: [idx] });
    dispatch({ type: 'placed', idx, color: state.myColor! });
  }

  const status = initiator && state.phase === 'waiting' ? 'Waiting for opponent…' : state.statusMsg;

  return (
    <div className="game-window">
      <WindowChrome title={`Gomoku — ${fromName}`} />
      {showInvite && (
        <InviteOverlay gameName="Gomoku" fromName={fromName}
          onAccept={handleAccept} onDecline={handleDecline} />
      )}
      {state.phase === 'over' && <GameOverBanner msg={state.statusMsg} />}
      <div className="game-status-bar">
        <span className="game-status-msg">{status}</span>
        {state.phase === 'playing' && (
          <button className="game-resign-btn"
            onClick={() => { void window.buzz.gameResign(peerId); dispatch({ type: 'over', msg: 'You resigned.' }); }}>
            Resign
          </button>
        )}
      </div>
      <GomokuBoard state={state} onCell={handleCell} />
    </div>
  );
}

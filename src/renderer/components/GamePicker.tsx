import React from 'react';

type GameEntry = { kind: string; label: string; icon: string; available: boolean };

const GAME_LIST: GameEntry[] = [
  { kind: 'checkers', label: 'Checkers',   icon: '🔴', available: true },
  { kind: 'chess',    label: 'Chess',      icon: '♟️', available: true },
  { kind: 'reversi',  label: 'Reversi',    icon: '⚫', available: true },
  { kind: 'gomoku',   label: 'Gomoku',     icon: '🟡', available: true },
  { kind: 'poker',    label: 'Poker',      icon: '🃏', available: true },
  { kind: 'spades',   label: 'Spades',     icon: '♠️', available: true },
];

export function GamePicker({ onSelect, onClose }: { onSelect: (kind: string) => void; onClose: () => void }) {
  return (
    <div className="game-picker-backdrop" onClick={onClose}>
      <div className="game-picker-box bevel-out" onClick={(e) => e.stopPropagation()}>
        <div className="game-picker-title">
          <span>Select a Game</span>
          <button className="game-picker-close" onClick={onClose}>✕</button>
        </div>
        <div className="game-picker-subtitle">Choose a game to invite your buddy to play</div>
        <ul className="game-picker-list">
          {GAME_LIST.map((g) => (
            <li
              key={g.kind}
              className={['game-picker-item', g.available ? 'available' : 'unavailable'].join(' ')}
              onClick={() => g.available && onSelect(g.kind)}
              title={g.available ? `Play ${g.label}` : `${g.label} — coming soon`}
            >
              <span className="game-picker-icon">{g.icon}</span>
              <span className="game-picker-label">{g.label}</span>
              {!g.available && <span className="game-picker-soon">Soon</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

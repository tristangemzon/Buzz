import React from 'react';

export interface GameProps {
  peerId: string;
  kind: string;
  initiator: boolean;
}

export function InviteOverlay({
  gameName,
  fromName,
  onAccept,
  onDecline,
}: {
  gameName: string;
  fromName: string;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="game-overlay">
      <div className="game-overlay-box">
        <p>
          <strong>{fromName}</strong> wants to play <strong>{gameName}</strong>!
        </p>
        <div className="game-overlay-actions">
          <button onClick={onAccept}>Accept</button>
          <button onClick={onDecline}>Decline</button>
        </div>
      </div>
    </div>
  );
}

export function GameOverBanner({ msg }: { msg: string }) {
  return (
    <div className="game-overlay">
      <div className="game-overlay-box">
        <p style={{ fontWeight: 'bold', margin: '0 0 12px', fontSize: 14 }}>{msg}</p>
        <div className="game-overlay-actions">
          <button onClick={() => window.close()}>Close</button>
        </div>
      </div>
    </div>
  );
}

export function WaitingOverlay({ msg }: { msg: string }) {
  return (
    <div className="game-overlay">
      <div className="game-overlay-box">
        <p style={{ margin: 0 }}>{msg}</p>
      </div>
    </div>
  );
}

// ── Card utilities ────────────────────────────────────────────────────────────

export const RANK_NAMES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const SUIT_CHARS  = ['♣', '♦', '♥', '♠'];
export const SUIT_COLORS = ['#111', '#c00', '#c00', '#111'] as const;

export function cardRank(c: number): number { return c % 13; }
export function cardSuit(c: number): number { return Math.floor(c / 13); }

export function CardView({
  card,
  faceDown,
  small,
}: {
  card: number;
  faceDown?: boolean;
  small?: boolean;
}) {
  const sm = small ? ' card-sm' : '';
  if (faceDown) return <div className={`playing-card card-back${sm}`} />;
  const r = cardRank(card);
  const s = cardSuit(card);
  return (
    <div className={`playing-card${sm}`} style={{ color: SUIT_COLORS[s] }}>
      <span className="card-rank">{RANK_NAMES[r]}</span>
      <span className="card-suit-sym">{SUIT_CHARS[s]}</span>
    </div>
  );
}

export function shuffleDeck(): number[] {
  const d = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j]!, d[i]!];
  }
  return d;
}

// Best 5-of-7 hand evaluator for Texas Hold'em
export function evaluateBestHand(cards: number[]): { score: number; name: string } {
  let best = -1;
  for (let i = 0; i < cards.length - 1; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const hand = cards.filter((_, k) => k !== i && k !== j);
      const s = evalFiveCard(hand);
      if (s > best) best = s;
    }
  }
  return { score: best, name: handCatName(best) };
}

function evalFiveCard(cards: number[]): number {
  const ranks = cards.map(cardRank).sort((a, b) => b - a);
  const suits = cards.map(cardSuit);
  const isFlush = suits.every(s => s === suits[0]);
  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  const isStraight = uniq.length === 5 && uniq[0]! - uniq[4]! === 4;
  const isLowStraight = ranks.join() === '12,3,2,1,0';
  const freq = new Map<number, number>();
  for (const r of ranks) freq.set(r, (freq.get(r) ?? 0) + 1);
  const fv = [...freq.values()].sort((a, b) => b - a);
  const enc = (rs: number[]) => rs.reduce((s, r) => s * 15 + r + 1, 0);
  const P = 759376; // 15^5
  if (isFlush && (isStraight || isLowStraight)) return 8 * P + enc(ranks);
  if (fv[0] === 4) {
    const q = [...freq.entries()].find(([, v]) => v === 4)![0];
    const k = [...freq.entries()].find(([, v]) => v === 1)![0];
    return 7 * P + enc([q, k]);
  }
  if (fv[0] === 3 && fv[1] === 2) {
    const t = [...freq.entries()].find(([, v]) => v === 3)![0];
    const p = [...freq.entries()].find(([, v]) => v === 2)![0];
    return 6 * P + enc([t, p]);
  }
  if (isFlush) return 5 * P + enc(ranks);
  if (isStraight || isLowStraight) return 4 * P + enc(ranks);
  if (fv[0] === 3) {
    const t = [...freq.entries()].find(([, v]) => v === 3)![0];
    return 3 * P + enc([t, ...ranks.filter(r => r !== t)]);
  }
  if (fv[0] === 2 && fv[1] === 2) {
    const ps = [...freq.entries()].filter(([, v]) => v === 2).map(([r]) => r).sort((a, b) => b - a);
    const k = ranks.find(r => freq.get(r) === 1)!;
    return 2 * P + enc([...ps, k]);
  }
  if (fv[0] === 2) {
    const p = [...freq.entries()].find(([, v]) => v === 2)![0];
    return 1 * P + enc([p, ...ranks.filter(r => r !== p)]);
  }
  return enc(ranks);
}

function handCatName(score: number): string {
  const cats = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
    'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];
  const cat = Math.floor(score / 759376);
  return cats[cat] ?? 'High Card';
}

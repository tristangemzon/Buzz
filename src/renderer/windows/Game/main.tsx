import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { GameProps } from './shared';
import { CheckersGame } from './checkers';
import { ReversiGame }  from './reversi';
import { GomokuGame }   from './gomoku';
import { ChessGame }    from './chess';
import { PokerGame }    from './poker';
import { SpadesGame }   from './spades';
import '../../theme/aim5.css';

function parseProps(): GameProps {
  const h = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  const [peerId, kind, init] = h.split(':');
  return { peerId: peerId ?? '', kind: kind ?? 'checkers', initiator: init === '1' };
}

function GameRouter() {
  const props = parseProps();
  switch (props.kind) {
    case 'checkers': return <CheckersGame {...props} />;
    case 'reversi':  return <ReversiGame  {...props} />;
    case 'gomoku':   return <GomokuGame   {...props} />;
    case 'chess':    return <ChessGame    {...props} />;
    case 'poker':    return <PokerGame    {...props} />;
    case 'spades':   return <SpadesGame   {...props} />;
    default:         return <div style={{ padding: 20 }}>Unknown game: {props.kind}</div>;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><GameRouter /></StrictMode>,
);

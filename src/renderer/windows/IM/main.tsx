import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyPlatformTheme, applyThemeAttributes } from '../../theme/applyPlatform';
import { WindowChrome } from '../../components/WindowChrome';
import { ProfileViewer } from '../../components/ProfilePanes';
import { RichEditor, RichEditorHandle, RichText } from '../../components/RichText';
import { useTalk, fmtCallTime } from '../../components/useTalk';
import { WaveformCanvas } from '../../components/WaveformCanvas';
import { playSound, setSoundsEnabled, setSoundScheme } from '../../sounds/synth';
import type { ImMessage, Theme, XferOfferEvent } from '@shared/schemas';

const DEFAULT_THEME: Theme = {
  chatTheme: 'classic',
  windowTheme: 'classic',
  myBubbleColor: '#d8f0ff',
  theirBubbleColor: '#eeeeee',
  showTimestamps: true,
  showAvatarsInChat: true,
};

function getPeerIdFromHash(): string {
  const h = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  return h.trim();
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Inline xfer card kinds shown in the chat log between text messages.
type XferCard = {
  kind: 'xfer';
  id: string;
  direction: 'in' | 'out';
  fileName: string;
  fileSize: number;
  state: 'offered' | 'active' | 'complete' | 'failed' | 'declined';
  bytes: number;
  error?: string;
  savedPath?: string;
};

// ── Game picker ──────────────────────────────────────────────────────────────
type GameEntry = { kind: string; label: string; icon: string; available: boolean };
const GAME_LIST: GameEntry[] = [
  { kind: 'checkers', label: 'Checkers',   icon: '🔴', available: true },
  { kind: 'chess',    label: 'Chess',      icon: '♟️', available: true },
  { kind: 'reversi',  label: 'Reversi',    icon: '⚫', available: true },
  { kind: 'gomoku',   label: 'Gomoku',     icon: '🟡', available: true },
  { kind: 'poker',    label: 'Poker',      icon: '🃏', available: true },
  { kind: 'spades',   label: 'Spades',     icon: '♠️', available: true },
];

function GamePicker({ onSelect, onClose }: { onSelect: (kind: string) => void; onClose: () => void }) {
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

function App(): JSX.Element {
  const peerId = getPeerIdFromHash();
  const [me, setMe] = useState<{ screenName: string } | null>(null);
  const [alias, setAlias] = useState<string>(peerId.slice(0, 12) + '…');
  const [messages, setMessages] = useState<ImMessage[]>([]);
  const [xfers, setXfers] = useState<XferCard[]>([]);
  const [draft, setDraft] = useState('');
  const editorRef = useRef<RichEditorHandle>(null);
  const [status, setStatus] = useState<'online' | 'offline' | 'away' | 'idle'>('offline');
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [awayMessage, setAwayMessage] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [warnLevel, setWarnLevel] = useState(0);
  const [showProfile, setShowProfile] = useState(false);
  const [showGamePicker, setShowGamePicker] = useState(false);
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  const [myAvatar, setMyAvatar] = useState<string>('');
  const [theirAvatar, setTheirAvatar] = useState<string>('');
  const logRef = useRef<HTMLDivElement>(null);
  const talk = useTalk(peerId, { kind: 'voice' });

  function upsertXfer(updater: (list: XferCard[]) => XferCard[]): void {
    setXfers(updater);
  }

  async function refreshBuddyMeta(): Promise<void> {
    const bs = await window.buzz.listBuddies();
    const b = bs.find((x) => x.peerId === peerId);
    if (b) {
      setAlias(b.alias);
      setBlocked(b.blocked);
      setWarnLevel(b.warnLevel);
    }
  }

  useEffect(() => {
    void applyPlatformTheme(window.buzz);
    void window.buzz.getMyId().then(setMe);
    void window.buzz
      .getPrefs()
      .then((p) => {
        setSoundsEnabled(p.soundsEnabled);
        setSoundScheme(p.soundScheme);
        setTheme(p.theme);
        applyThemeAttributes(p.theme);
        setMyAvatar(p.profile.avatarDataUrl || '');
      })
      .catch(() => undefined);
    void window.buzz.getPeerProfile(peerId).then((row) => {
      if (row) setTheirAvatar(row.avatarDataUrl || '');
    });
    void window.buzz
      .listBuddies()
      .then((bs) => {
        const b = bs.find((x) => x.peerId === peerId);
        const resolvedAlias = b?.alias ?? (peerId.slice(0, 12) + '\u2026');
        if (b) {
          setAlias(b.alias);
          setBlocked(b.blocked);
          setWarnLevel(b.warnLevel);
        }
        // Chain status lookup so we have the correct alias available.
        return window.buzz.getPeerStatus(peerId).then((s) => {
          const resolved = !s || s.status === 'invisible' ? 'offline' : (s.status as typeof status);
          setStatus(resolved);
          if (resolved === 'offline') setStatusNotice(`${resolvedAlias} is offline.`);
          else if (resolved === 'away') setStatusNotice(`${resolvedAlias} is away.`);
          if (s) setAwayMessage(s.awayMessage);
        });
      })
      .catch(() => undefined);
    void window.buzz.history({ peerId, limit: 100 }).then(setMessages);
    void window.buzz.markImRead(peerId).catch(() => undefined);

    // Door open when this conversation window comes alive; door close when
    // it is torn down.  We use beforeunload instead of the React cleanup
    // return because Electron destroys the renderer before React can unmount.
    playSound('door-open');
    function handleBeforeUnload(): void { playSound('door-close'); }
    window.addEventListener('beforeunload', handleBeforeUnload);

    const offRecv = window.buzz.onImReceived((m) => {
      if (m.peerId !== peerId) return;
      setMessages((prev) => [...prev, m]);
      playSound('im-receive');
      // Window is open — flush this message from the unread tally.
      void window.buzz.markImRead(peerId).catch(() => undefined);
    });
    const offAck = window.buzz.onImAck(({ id, status }) => {
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status } : m)));
    });
    const offStatus = window.buzz.onBuddyStatus((e) => {
      if (e.peerId === peerId) {
        const next = e.status === 'invisible' ? 'offline' : (e.status as 'online' | 'offline' | 'away' | 'idle');
        setStatus((prev) => {
          if (next === prev) return prev;
          if (next === 'offline') setStatusNotice(`${alias} has gone offline.`);
          else if (next === 'away') setStatusNotice(`${alias} has gone away.`);
          else if (next === 'online' || next === 'idle') setStatusNotice(null);
          return next;
        });
        setAwayMessage(e.awayMessage);
      }
    });
    const offOffered = window.buzz.onXferOffered((o: XferOfferEvent) => {
      if (o.peerId !== peerId) return;
      upsertXfer((prev) => [
        ...prev,
        {
          kind: 'xfer',
          id: o.id,
          direction: 'in',
          fileName: o.fileName,
          fileSize: o.fileSize,
          state: 'offered',
          bytes: 0,
        },
      ]);
      playSound('mail');
    });
    const offProgress = window.buzz.onXferProgress((p) => {
      if (p.peerId !== peerId) return;
      upsertXfer((prev) =>
        prev.map((c) =>
          c.id === p.id
            ? { ...c, state: c.state === 'complete' ? c.state : 'active', bytes: p.bytes }
            : c,
        ),
      );
    });
    const offDone = window.buzz.onXferDone((d) => {
      if (d.peerId !== peerId) return;
      upsertXfer((prev) =>
        prev.map((c) =>
          c.id === d.id
            ? {
                ...c,
                state: d.ok
                  ? 'complete'
                  : d.error === 'declined'
                  ? 'declined'
                  : 'failed',
                error: d.error,
                savedPath: d.savedPath,
                bytes: d.ok ? c.fileSize : c.bytes,
              }
            : c,
        ),
      );
    });
    const offPeerProfile = window.buzz.onPeerProfile((pp) => {
      if (pp.peerId === peerId) setTheirAvatar(pp.avatarDataUrl || '');
    });
    const offGameInvite = window.buzz.onGameInvite((ev) => {
      if (ev.fromPeerId !== peerId) return;
      // Open the game window as acceptor (no initiator flag)
      void window.buzzWindows.openGame(peerId, ev.kind ?? 'checkers');
    });
    return () => {
      offRecv();
      offAck();
      offStatus();
      offOffered();
      offProgress();
      offDone();
      offPeerProfile();
      offGameInvite();
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [peerId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, statusNotice]);

  async function send(): Promise<void> {
    setErr('');
    if (blocked) {
      setErr('You have blocked this user. Unblock to send messages.');
      return;
    }
    const body = (editorRef.current?.getMarkup() ?? '').trim();
    if (!body) return;
    setBusy(true);
    try {
      const m = await window.buzz.sendIm({ toPeerId: peerId, body });
      setMessages((prev) => [...prev, m]);
      editorRef.current?.clear();
      setDraft('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to send.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleBlock(): Promise<void> {
    const next = !blocked;
    if (next && !confirm(`Block ${alias}? They will no longer be able to message you.`)) return;
    await window.buzz.blockBuddy(peerId, next);
    await refreshBuddyMeta();
  }

  async function warn(): Promise<void> {
    if (!confirm(`Warn ${alias}? This raises their warning level by 10%.`)) return;
    const lvl = await window.buzz.warnBuddy(peerId, 10);
    setWarnLevel(lvl);
  }

  async function sendFile(): Promise<void> {
    if (blocked) {
      setErr('You have blocked this user. Unblock to send files.');
      return;
    }
    setErr('');
    try {
      const r = await window.buzz.xferOffer(peerId);
      if (r.cancelled) return;
      // Optimistically add an outgoing card; progress will replace state.
      upsertXfer((prev) => [
        ...prev,
        {
          kind: 'xfer',
          id: r.id,
          direction: 'out',
          fileName: r.fileName,
          fileSize: r.fileSize,
          state: 'active',
          bytes: 0,
        },
      ]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to send file.');
    }
  }

  async function respondXfer(id: string, accept: boolean): Promise<void> {
    setErr('');
    try {
      await window.buzz.xferRespond(id, accept);
      // Decline immediately reflects; accept will move through 'active' → 'complete'.
      if (!accept) {
        upsertXfer((prev) =>
          prev.map((c) => (c.id === id ? { ...c, state: 'declined' } : c)),
        );
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed.');
    }
  }

  async function handleInviteGame(kind: string): Promise<void> {
    setShowGamePicker(false);
    await window.buzzWindows.openGame(peerId, kind, true);
    await window.buzz.gameInvite({ toPeerId: peerId, kind });
  }

  const myName = me?.screenName ?? 'me';

  return (
    <div className="window">
      <WindowChrome
        title={
          <span title={status === 'away' && awayMessage ? `Away: ${awayMessage}` : ''}>
            IM with {alias}{' '}
            <span
              className="muted"
              style={status === 'idle' ? { fontStyle: 'italic' } : undefined}
            >
              ({status})
            </span>
            {warnLevel > 0 && (
              <span className="warn-badge" title={`Warned ${warnLevel}%`}>
                {warnLevel}%
              </span>
            )}
            {blocked && <span className="warn-badge" title="You blocked this user">BLOCKED</span>}
          </span>
        }
      />

      {/* Classic-mode AIM avatar sidebar: recipient top, self bottom.
           im-body uses a 2×2 CSS grid in sidebar mode so the divider
           between the two avatar cells is a grid row boundary that
           always aligns with the chat-log / compose area boundary. */}
      <div className={`im-body${theme.chatTheme !== 'balloons' ? ' im-body-sidebar' : ''}`}>
        {theme.chatTheme !== 'balloons' && (
          <>
            <div className="im-avatar-top">
              {theirAvatar
                ? <img src={theirAvatar} alt={alias} className="im-avatar-img" />
                : <div className="im-avatar-img im-avatar-placeholder" />}
            </div>
            <div className="im-avatar-bottom">
              {myAvatar
                ? <img src={myAvatar} alt={myName} className="im-avatar-img" />
                : <div className="im-avatar-img im-avatar-placeholder" />}
            </div>
          </>
        )}
      <div ref={logRef} className="bevel-in chat-log">
        {messages.map((m) =>
          theme.chatTheme === 'balloons' ? (
            <div key={m.id} className={`bubble-row ${m.direction}`}>
              {theme.showAvatarsInChat &&
                (() => {
                  const src = m.direction === 'out' ? myAvatar : theirAvatar;
                  return src ? (
                    <img className="bubble-avatar" src={src} alt="" />
                  ) : (
                    <div className="bubble-avatar" />
                  );
                })()}
              <div className="bubble-content">
                <div className="bubble-name" style={{ textAlign: m.direction === 'out' ? 'right' : 'left' }}>
                  {m.direction === 'out' ? myName : alias}
                </div>
                <div className="bubble">
                  <RichText body={m.body} />
                  {(theme.showTimestamps || (m.direction === 'out' && m.status !== 'sent' && m.status !== 'delivered')) && (
                    <div className="meta">
                      {theme.showTimestamps && new Date(m.ts).toLocaleTimeString()}
                      {m.direction === 'out' && m.status !== 'sent' && m.status !== 'delivered'
                        ? ` · ${m.status}`
                        : ''}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div key={m.id}>
              {theme.showTimestamps && (
                <span className="muted" style={{ fontSize: 10, marginRight: 4 }}>
                  [{new Date(m.ts).toLocaleTimeString()}]
                </span>
              )}
              <span className={m.direction === 'out' ? 'me' : 'them'}>
                {m.direction === 'out' ? myName : alias}:
              </span>{' '}
              <RichText body={m.body} />
              {m.direction === 'out' && m.status !== 'sent' && m.status !== 'delivered' ? (
                <span className="muted"> [{m.status}]</span>
              ) : null}
            </div>
          ),
        )}
        {xfers.map((c) => (
          <XferLine
            key={c.id}
            card={c}
            onAccept={() => void respondXfer(c.id, true)}
            onDecline={() => void respondXfer(c.id, false)}
          />
        ))}
        {statusNotice && (
          <div className="im-status-banner">{statusNotice}</div>
        )}
      </div>

      <div className="bevel-in im-compose-wrap">
        <RichEditor
          ref={editorRef}
          placeholder={blocked ? 'Unblock this user to send messages.' : 'Type a message and hit Enter…'}
          disabled={busy || blocked}
          onMarkupChange={setDraft}
          onEnter={() => void send()}
          style={{ width: '100%', minHeight: 100 }}
        />
      </div>
      </div>{/* im-body */}

      {err && <div className="error" style={{ padding: '0 8px 2px', fontSize: 11 }}>{err}</div>}

      {/* ── AIM-style action bar ─────────────────────────────────────── */}
      <div className="im-actionbar">
        {/* Left: moderation */}
        <button className="im-action-btn" onClick={() => void warn()} disabled={blocked} title="Raise warning level by 10%">
          <span className="im-action-btn-icon">⚡</span>
          <span className="im-action-btn-label">Warn</span>
        </button>
        <button className="im-action-btn" onClick={() => void toggleBlock()} title={blocked ? 'Unblock this user' : 'Block this user'}>
          <span className="im-action-btn-icon">🚫</span>
          <span className="im-action-btn-label">{blocked ? 'Unblock' : 'Block'}</span>
        </button>

        <span className="im-actionbar-sep" />

        {/* Center: actions */}
        <button className="im-action-btn" onClick={() => setShowProfile(true)} title="View profile">
          <span className="im-action-btn-icon">👤</span>
          <span className="im-action-btn-label">Profile</span>
        </button>
        <button className="im-action-btn" onClick={() => setShowGamePicker(true)} title="Play a game" disabled={blocked}>
          <span className="im-action-btn-icon">🎲</span>
          <span className="im-action-btn-label">Games</span>
        </button>
        <button
          className="im-action-btn"
          onClick={() => void talk.startCall('voice')}
          disabled={blocked || (talk.call !== null && talk.call.state !== 'ended')}
          title="Start a voice call"
        >
          <span className="im-action-btn-icon">🎙️</span>
          <span className="im-action-btn-label">Talk</span>
        </button>
        <button
          className="im-action-btn"
          onClick={async () => {
            await window.buzzWindows.openVideoCall(peerId);
            await window.buzz.talkInvite(peerId, 'video').catch(() => undefined);
          }}
          disabled={blocked}
          title="Start a video chat"
        >
          <span className="im-action-btn-icon">📹</span>
          <span className="im-action-btn-label">Video</span>
        </button>

        <span className="im-actionbar-spacer" />

        {/* Right: send */}
        <button
          className="im-action-btn send"
          onClick={() => void send()}
          disabled={busy || blocked || draft.trim().length === 0}
          title="Send message"
        >
          <span className="im-action-btn-icon">📨</span>
          <span className="im-action-btn-label">Send</span>
        </button>
      </div>

      {showProfile && (
        <ProfileViewer peerId={peerId} alias={alias} onClose={() => setShowProfile(false)} />
      )}

      {showGamePicker && (
        <GamePicker
          onSelect={(kind) => void handleInviteGame(kind)}
          onClose={() => setShowGamePicker(false)}
        />
      )}

      {talk.call && talk.call.state === 'ringing' && talk.call.role === 'callee' && (
        <div className="call-modal-backdrop">
          <div className="call-modal bevel-out">
            <div className="call-modal-title">Incoming call</div>
            <div className="call-modal-body">
              <b>{talk.call.screenName || alias}</b> wants to talk.
            </div>
            <div className="call-modal-actions">
              <button onClick={() => void talk.acceptIncoming()}>Accept</button>{' '}
              <button onClick={() => void talk.rejectIncoming()}>Decline</button>
            </div>
          </div>
        </div>
      )}

      {talk.call && talk.call.state !== 'ringing' && (
        <div className="call-bar">
          <div className="call-bar-row">
            <span className="call-dot" />
            {talk.call.state === 'inviting' ? (
              <span className="call-bar-title">Calling {alias}…</span>
            ) : (
              <span className="call-bar-title">{alias} · {fmtCallTime(talk.elapsedSec)}</span>
            )}
            <span className="spacer" />
            {talk.call.state === 'active' && (
              <button onClick={() => talk.toggleMute()} title={talk.muted ? 'Unmute' : 'Mute'}>
                {talk.muted ? 'Unmute' : 'Mute'}
              </button>
            )}
            <button onClick={() => void talk.endCall()}>End</button>
          </div>
          {talk.call.state === 'active' && (
            <div className="call-waves">
              <div className="call-wave-pair">
                <span className="call-wave-label">You</span>
                <WaveformCanvas
                  getAnalyser={talk.getMicAnalyser}
                  color={talk.muted ? '#5a5a5a' : '#33ff66'}
                  bg="#001a05"
                  active={!talk.muted}
                />
              </div>
              <div className="call-wave-pair">
                <span className="call-wave-label">Them</span>
                <WaveformCanvas
                  getAnalyser={talk.getRemoteAnalyser}
                  color="#ff3399"
                  bg="#1a0010"
                />
              </div>
            </div>
          )}
        </div>
      )}
      {talk.error && <div className="error" style={{ margin: '0 6px 6px' }}>{talk.error}</div>}
    </div>
  );
}

function XferLine(props: {
  card: XferCard;
  onAccept: () => void;
  onDecline: () => void;
}): JSX.Element {
  const { card } = props;
  const pct =
    card.fileSize > 0 ? Math.min(100, Math.round((card.bytes / card.fileSize) * 100)) : 0;
  const verb = card.direction === 'in' ? 'wants to send' : 'sending';
  return (
    <div
      style={{
        margin: '4px 0',
        padding: 6,
        border: '1px solid #888',
        background: '#f8f8f0',
        fontSize: 11,
      }}
    >
      <div>
        <b>File transfer</b> — {verb}{' '}
        <span style={{ fontStyle: 'italic' }}>{card.fileName}</span>{' '}
        <span className="muted">({fmtBytes(card.fileSize)})</span>
      </div>
      {card.state === 'offered' && card.direction === 'in' && (
        <div style={{ marginTop: 4 }}>
          <button onClick={props.onAccept}>Accept</button>{' '}
          <button onClick={props.onDecline}>Decline</button>
        </div>
      )}
      {card.state === 'active' && (
        <div style={{ marginTop: 4 }}>
          <div
            style={{
              width: '100%',
              height: 8,
              background: '#ddd',
              border: '1px solid #888',
            }}
          >
            <div style={{ width: `${pct}%`, height: '100%', background: '#316ac5' }} />
          </div>
          <div className="muted">
            {fmtBytes(card.bytes)} / {fmtBytes(card.fileSize)} ({pct}%)
          </div>
        </div>
      )}
      {card.state === 'complete' && (
        <div className="muted" style={{ marginTop: 2 }}>
          ✓ Complete{card.savedPath ? ` — saved to ${card.savedPath}` : ''}
        </div>
      )}
      {card.state === 'declined' && (
        <div className="muted" style={{ marginTop: 2 }}>Declined.</div>
      )}
      {card.state === 'failed' && (
        <div className="error" style={{ marginTop: 2 }}>
          Failed{card.error ? `: ${card.error}` : ''}.
        </div>
      )}
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

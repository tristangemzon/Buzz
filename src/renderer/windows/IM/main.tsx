import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyPlatformTheme, applyThemeAttributes } from '../../theme/applyPlatform';
import { WindowChrome } from '../../components/WindowChrome';
import { ProfileViewer } from '../../components/ProfilePanes';
import { FormatToolbar, RichText, handleFormatShortcut } from '../../components/RichText';
import { useTalk, fmtCallTime } from '../../components/useTalk';
import { WaveformCanvas } from '../../components/WaveformCanvas';
import { playSound, setSoundsEnabled } from '../../sounds/synth';
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

function App(): JSX.Element {
  const peerId = getPeerIdFromHash();
  const [me, setMe] = useState<{ screenName: string } | null>(null);
  const [alias, setAlias] = useState<string>(peerId.slice(0, 12) + '…');
  const [messages, setMessages] = useState<ImMessage[]>([]);
  const [xfers, setXfers] = useState<XferCard[]>([]);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<'online' | 'offline' | 'away' | 'idle'>('offline');
  const [awayMessage, setAwayMessage] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [warnLevel, setWarnLevel] = useState(0);
  const [showProfile, setShowProfile] = useState(false);
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  const [myAvatar, setMyAvatar] = useState<string>('');
  const [theirAvatar, setTheirAvatar] = useState<string>('');
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const talk = useTalk(peerId);

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
        if (b) {
          setAlias(b.alias);
          setBlocked(b.blocked);
          setWarnLevel(b.warnLevel);
        }
      });
    void window.buzz.history({ peerId, limit: 100 }).then(setMessages);
    // Mark all delivered messages from this peer as read since the IM
    // window is now open and visible.
    void window.buzz.markImRead(peerId).catch(() => undefined);
    // Seed the header status from the session's last-known snapshot in case
    // the buddy went online before this window was opened.
    void window.buzz
      .getPeerStatus(peerId)
      .then((s) => {
        if (!s) return;
        setStatus(s.status === 'invisible' ? 'offline' : (s.status as typeof status));
        setAwayMessage(s.awayMessage);
      })
      .catch(() => undefined);

    // Door open on conversation focus; close on unmount.
    playSound('door-open');

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
        setStatus(e.status === 'invisible' ? 'offline' : (e.status as typeof status));
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
    return () => {
      offRecv();
      offAck();
      offStatus();
      offOffered();
      offProgress();
      offDone();
      offPeerProfile();
      playSound('door-close');
    };
  }, [peerId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  async function send(): Promise<void> {
    setErr('');
    if (blocked) {
      setErr('You have blocked this user. Unblock to send messages.');
      return;
    }
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    try {
      const m = await window.buzz.sendIm({ toPeerId: peerId, body });
      setMessages((prev) => [...prev, m]);
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

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (handleFormatShortcut(e, inputRef, draft, setDraft)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
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
              <div>
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
      </div>

      <div className="bevel-in" style={{ margin: 6 }}>
        <FormatToolbar
          textareaRef={inputRef}
          value={draft}
          onChange={setDraft}
          disabled={busy || blocked}
        />
        <textarea
          ref={inputRef}
          className="chat-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder={blocked ? 'Unblock this user to send messages.' : 'Type a message and hit Enter…'}
          disabled={busy || blocked}
          style={{ width: '100%' }}
        />
      </div>

      <div className="toolbar">
        <button onClick={() => void sendFile()} disabled={blocked} title="Send a file">
          Send File
        </button>
        <button
          onClick={() => void talk.startCall()}
          disabled={blocked || (talk.call !== null && talk.call.state !== 'ended')}
          title="Start a voice call"
        >
          Talk
        </button>
        <button onClick={() => setShowProfile(true)} title="View profile">
          Profile
        </button>
        <button onClick={() => void warn()} disabled={blocked} title="Raise warning level by 10%">
          Warn
        </button>
        <button onClick={() => void toggleBlock()} title={blocked ? 'Unblock' : 'Block'}>
          {blocked ? 'Unblock' : 'Block'}
        </button>
        <span className="error">{err}</span>
        <span className="spacer" />
        <button onClick={send} disabled={busy || blocked || draft.trim().length === 0}>
          Send
        </button>
      </div>

      {showProfile && (
        <ProfileViewer peerId={peerId} alias={alias} onClose={() => setShowProfile(false)} />
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
          <span className="call-dot" />
          {talk.call.state === 'inviting' ? (
            <span>Calling {alias}…</span>
          ) : (
            <span>On a call with {alias} · {fmtCallTime(talk.elapsedSec)}</span>
          )}
          {talk.call.state === 'active' && (
            <div className="call-waves">
              <div className="call-wave-pair">
                <span className="call-wave-label">You</span>
                <WaveformCanvas
                  getAnalyser={talk.getMicAnalyser}
                  color={talk.muted ? '#888' : '#7cf'}
                  active={!talk.muted}
                />
              </div>
              <div className="call-wave-pair">
                <span className="call-wave-label">Them</span>
                <WaveformCanvas
                  getAnalyser={talk.getRemoteAnalyser}
                  color="#ff7eb6"
                />
              </div>
            </div>
          )}
          <span className="spacer" />
          {talk.call.state === 'active' && (
            <button onClick={() => talk.toggleMute()} title={talk.muted ? 'Unmute' : 'Mute'}>
              {talk.muted ? 'Unmute' : 'Mute'}
            </button>
          )}
          <button onClick={() => void talk.endCall()}>End</button>
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

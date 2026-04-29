import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyPlatformTheme, applyThemeAttributes } from '../../theme/applyPlatform';
import { WindowChrome } from '../../components/WindowChrome';
import { playSound, setSoundsEnabled } from '../../sounds/synth';
import type { Buddy, Room, RoomMessage, Theme } from '@shared/schemas';

const DEFAULT_THEME: Theme = {
  chatTheme: 'classic',
  windowTheme: 'classic',
  myBubbleColor: '#d8f0ff',
  theirBubbleColor: '#eeeeee',
  showTimestamps: true,
  showAvatarsInChat: true,
};

function getRoomIdFromHash(): string {
  return decodeURIComponent(window.location.hash.replace(/^#/, '')).trim();
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function App(): JSX.Element {
  const roomId = getRoomIdFromHash();
  const [me, setMe] = useState<{ peerId: string; screenName: string } | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  const [buddies, setBuddies] = useState<Buddy[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  // Resolve a friendly name for a member peer id (self / buddy alias / peerId).
  const nameFor = useMemo(
    () =>
      (peerId: string): string => {
        if (me && peerId === me.peerId) return me.screenName + ' (me)';
        const b = buddies.find((x) => x.peerId === peerId);
        if (b) return b.alias;
        return peerId.slice(0, 12) + '…';
      },
    [me, buddies],
  );

  async function refreshRoom(): Promise<void> {
    const rooms = await window.buzz.listRooms();
    const r = rooms.find((x) => x.id === roomId) ?? null;
    setRoom(r);
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
      })
      .catch(() => undefined);
    void window.buzz.listBuddies().then(setBuddies);
    void refreshRoom();
    void window.buzz.roomHistory({ roomId, limit: 200 }).then(setMessages);

    playSound('door-open');

    const offMsg = window.buzz.onRoomMessage((m) => {
      if (m.roomId !== roomId) return;
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      if (m.direction === 'in') playSound('im-receive');
    });
    const offMembers = window.buzz.onRoomMembers((e) => {
      if (e.roomId !== roomId) return;
      void refreshRoom();
    });
    const offInvited = window.buzz.onRoomInvited((e) => {
      if (e.roomId !== roomId) return;
      void refreshRoom();
    });

    return () => {
      offMsg();
      offMembers();
      offInvited();
      playSound('door-close');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  async function send(): Promise<void> {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setErr('');
    try {
      const stored = await window.buzz.sendRoomMessage({ roomId, body });
      setMessages((prev) => [...prev, stored]);
      setDraft('');
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function leave(): Promise<void> {
    if (!confirm('Leave this chat room? You will need a new invite to rejoin.')) return;
    try {
      await window.buzz.leaveRoom({ roomId });
      window.close();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }

  async function invite(peerId: string): Promise<void> {
    setBusy(true);
    setErr('');
    try {
      await window.buzz.inviteToRoom({ roomId, peerId });
      setShowInvite(false);
      await refreshRoom();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const members = room?.members ?? [];
  const inviteCandidates = buddies.filter((b) => !members.includes(b.peerId) && !b.blocked);
  const balloons = theme.chatTheme === 'balloons';
  const compact = theme.chatTheme === 'compact';

  return (
    <div className="im-window" data-window-theme={theme.windowTheme}>
      <WindowChrome title={room?.name ? `Chat: ${room.name}` : 'Chat Room'} />
      <div className="im-toolbar" style={{ display: 'flex', gap: 6, padding: '4px 8px' }}>
        <button onClick={() => setShowInvite(true)} disabled={inviteCandidates.length === 0}>
          + Invite
        </button>
        <button onClick={leave}>Leave</button>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, opacity: 0.7 }}>
          {members.length} {members.length === 1 ? 'member' : 'members'}
        </span>
      </div>

      <div className="im-members" style={{ padding: '0 8px 4px', fontSize: 11, opacity: 0.8 }}>
        {members.map((m) => (
          <span key={m} style={{ marginRight: 8 }}>
            • {nameFor(m)}
          </span>
        ))}
      </div>

      <div
        ref={logRef}
        className="im-log"
        data-chat-theme={theme.chatTheme}
        style={{ flex: 1, overflowY: 'auto', padding: 8 }}
      >
        {messages.map((m) => {
          const mine = me && m.fromPeerId === me.peerId;
          const bg = mine ? theme.myBubbleColor : theme.theirBubbleColor;
          return (
            <div
              key={m.id}
              className={`im-row ${mine ? 'mine' : 'theirs'}`}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: mine ? 'flex-end' : 'flex-start',
                marginBottom: compact ? 2 : 6,
              }}
            >
              {!compact && (
                <div style={{ fontSize: 10, opacity: 0.7 }}>
                  <strong>{m.fromName || nameFor(m.fromPeerId)}</strong>
                  {theme.showTimestamps && <span> · {fmtTime(m.ts)}</span>}
                </div>
              )}
              <div
                className="im-bubble"
                style={{
                  background: bg,
                  padding: compact ? '2px 6px' : '4px 8px',
                  borderRadius: balloons ? 14 : 4,
                  maxWidth: '85%',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {compact && <strong style={{ marginRight: 4 }}>{m.fromName || nameFor(m.fromPeerId)}:</strong>}
                {m.body}
              </div>
            </div>
          );
        })}
      </div>

      {err && <div style={{ color: '#a00', padding: '4px 8px', fontSize: 11 }}>{err}</div>}

      <div className="im-composer" style={{ display: 'flex', padding: 8, gap: 6 }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          style={{ flex: 1, resize: 'none' }}
          placeholder="Say something to the room…"
        />
        <button onClick={() => void send()} disabled={busy || !draft.trim()}>
          Send
        </button>
      </div>

      {showInvite && (
        <div
          className="modal-backdrop"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={() => setShowInvite(false)}
        >
          <div
            className="modal"
            style={{ background: '#fff', padding: 12, minWidth: 240, borderRadius: 4 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 8px' }}>Invite a buddy</h3>
            {inviteCandidates.length === 0 ? (
              <p style={{ fontSize: 12 }}>No buddies available to invite.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: 220, overflowY: 'auto' }}>
                {inviteCandidates.map((b) => (
                  <li key={b.peerId} style={{ padding: '4px 0' }}>
                    <button
                      style={{ width: '100%', textAlign: 'left' }}
                      onClick={() => void invite(b.peerId)}
                      disabled={busy}
                    >
                      {b.alias}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div style={{ marginTop: 8, textAlign: 'right' }}>
              <button onClick={() => setShowInvite(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

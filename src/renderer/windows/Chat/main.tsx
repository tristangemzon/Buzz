import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyPlatformTheme, applyThemeAttributes } from '../../theme/applyPlatform';
import { WindowChrome } from '../../components/WindowChrome';
import { playSound, setSoundsEnabled } from '../../sounds/synth';
import type { Buddy, Room, RoomChannel, RoomMessage, Theme } from '@shared/schemas';

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
  const [channels, setChannels] = useState<RoomChannel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string>('');
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  const [buddies, setBuddies] = useState<Buddy[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  // Mirror activeChannelId in a ref so the persistent room-message listener
  // (registered once on mount) always reads the latest value.
  const activeChannelIdRef = useRef<string>('');
  useEffect(() => {
    activeChannelIdRef.current = activeChannelId;
  }, [activeChannelId]);

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

  async function refreshChannels(): Promise<RoomChannel[]> {
    const list = await window.buzz.listRoomChannels({ roomId });
    setChannels(list);
    return list;
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
    void refreshChannels().then((list) => {
      const def = list.find((c) => c.isDefault) ?? list[0];
      if (def) setActiveChannelId(def.id);
    });

    playSound('door-open');
    // Mark room as read on open.
    void window.buzz.markRoomRead(roomId).catch(() => undefined);

    const offMsg = window.buzz.onRoomMessage((m) => {
      if (m.roomId !== roomId) return;
      if (m.direction === 'in') playSound('im-receive');
      // Only append to the visible log if it's for the active channel.
      if (m.channelId !== activeChannelIdRef.current) return;
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      // Window is open — flush this room from the unread tally.
      void window.buzz.markRoomRead(roomId).catch(() => undefined);
    });
    const offMembers = window.buzz.onRoomMembers((e) => {
      if (e.roomId !== roomId) return;
      void refreshRoom();
    });
    const offInvited = window.buzz.onRoomInvited((e) => {
      if (e.roomId !== roomId) return;
      void refreshRoom();
    });
    const offChannel = window.buzz.onRoomChannel((e) => {
      if (e.channel.roomId !== roomId) return;
      setChannels((prev) => {
        if (e.kind === 'added') {
          if (prev.some((c) => c.id === e.channel.id)) {
            return prev.map((c) => (c.id === e.channel.id ? e.channel : c));
          }
          return [...prev, e.channel];
        }
        return prev.filter((c) => c.id !== e.channel.id);
      });
      if (e.kind === 'removed' && e.channel.id === activeChannelIdRef.current) {
        // Active channel went away — fall back to default.
        void refreshChannels().then((list) => {
          const def = list.find((c) => c.isDefault) ?? list[0];
          if (def) setActiveChannelId(def.id);
        });
      }
    });

    return () => {
      offMsg();
      offMembers();
      offInvited();
      offChannel();
      playSound('door-close');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Reload history when the active channel changes.
  useEffect(() => {
    if (!activeChannelId) {
      setMessages([]);
      return;
    }
    void window.buzz
      .roomHistory({ roomId, channelId: activeChannelId, limit: 200 })
      .then(setMessages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannelId, roomId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  async function send(): Promise<void> {
    const body = draft.trim();
    if (!body || busy || !activeChannelId) return;
    setBusy(true);
    setErr('');
    try {
      const stored = await window.buzz.sendRoomMessage({
        roomId,
        channelId: activeChannelId,
        body,
      });
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
  const activeChannel = channels.find((c) => c.id === activeChannelId) ?? null;

  async function createChannel(): Promise<void> {
    const name = newChannelName.trim();
    if (!name) return;
    setBusy(true);
    setErr('');
    try {
      const ch = await window.buzz.createRoomChannel({ roomId, name });
      setChannels((prev) =>
        prev.some((c) => c.id === ch.id) ? prev : [...prev, ch],
      );
      setActiveChannelId(ch.id);
      setNewChannelName('');
      setShowNewChannel(false);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteChannel(channelId: string): Promise<void> {
    const ch = channels.find((c) => c.id === channelId);
    if (!ch || ch.isDefault) return;
    if (!confirm(`Delete channel #${ch.name}? Its messages will be lost for you.`)) return;
    setBusy(true);
    setErr('');
    try {
      await window.buzz.deleteRoomChannel({ roomId, channelId });
      setChannels((prev) => prev.filter((c) => c.id !== channelId));
      if (activeChannelId === channelId) {
        const def = channels.find((c) => c.isDefault) ?? channels.find((c) => c.id !== channelId);
        setActiveChannelId(def?.id ?? '');
      }
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="im-window" data-window-theme={theme.windowTheme}>
      <WindowChrome
        title={
          room?.name
            ? `Chat: ${room.name}${activeChannel ? ` · #${activeChannel.name}` : ''}`
            : 'Chat Room'
        }
      />
      <div className="chat-body">
        <aside className="chat-channels">
          <div className="chat-channels-header">
            <span>Channels</span>
            <button
              className="chat-channels-add"
              title="New channel"
              onClick={() => {
                setNewChannelName('');
                setShowNewChannel(true);
              }}
            >
              +
            </button>
          </div>
          <div className="chat-channels-list">
            {channels.map((c) => (
              <div
                key={c.id}
                className={`chat-channel-row${c.id === activeChannelId ? ' active' : ''}`}
                onClick={() => setActiveChannelId(c.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!c.isDefault) void deleteChannel(c.id);
                }}
                title={c.isDefault ? 'Default channel' : 'Right-click to delete'}
              >
                <span className="chat-channel-hash">#</span>
                {c.name}
              </div>
            ))}
          </div>
        </aside>

        <div className="chat-main">
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
              placeholder={
                activeChannel ? `Message #${activeChannel.name}\u2026` : 'Select a channel\u2026'
              }
              disabled={!activeChannelId}
            />
            <button onClick={() => void send()} disabled={busy || !draft.trim() || !activeChannelId}>
              Send
            </button>
          </div>
        </div>
      </div>

      {showNewChannel && (
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
          onClick={() => setShowNewChannel(false)}
        >
          <div
            className="modal"
            style={{ background: '#fff', padding: 12, minWidth: 260, borderRadius: 4 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 8px' }}>New channel</h3>
            <input
              type="text"
              autoFocus
              value={newChannelName}
              onChange={(e) => setNewChannelName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createChannel();
              }}
              placeholder="channel-name"
              style={{ width: '100%' }}
              maxLength={64}
            />
            <p style={{ fontSize: 11, opacity: 0.7, margin: '6px 0 0' }}>
              Letters, numbers, spaces, dashes, and underscores only.
            </p>
            <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
              <button onClick={() => setShowNewChannel(false)} disabled={busy}>
                Cancel
              </button>
              <button
                onClick={() => void createChannel()}
                disabled={busy || !newChannelName.trim()}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

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

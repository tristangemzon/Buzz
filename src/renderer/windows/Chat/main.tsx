import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyPlatformTheme, applyThemeAttributes } from '../../theme/applyPlatform';
import { WindowChrome } from '../../components/WindowChrome';
import { RichEditor, RichEditorHandle, RichText } from '../../components/RichText';
import { useRoomVoice } from '../../components/useRoomVoice';
import { useRoomScreen } from '../../components/useRoomScreen';
import { ScreenSourcePicker } from '../../components/ScreenSourcePicker';
import { playSound, setSoundsEnabled, setSoundScheme, setDnd } from '../../sounds/synth';
import type { Buddy, Room, RoomChannel, RoomMessage, Theme } from '@shared/schemas';
import { GamePicker } from '../../components/GamePicker';

const DEFAULT_THEME: Theme = {
  chatTheme: 'classic',
  windowTheme: 'classic',
  colorMode: 'light',
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
  const [newChannelKind, setNewChannelKind] = useState<'text' | 'voice'>('text');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [showGamePicker, setShowGamePicker] = useState(false);
  const [showMemberPicker, setShowMemberPicker] = useState(false);
  const [gameKindPending, setGameKindPending] = useState<string | null>(null);
  // v0.6.0 moderation state
  const [replyingTo, setReplyingTo] = useState<RoomMessage | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number; flipX: boolean; flipY: boolean; msgMine: boolean } | null>(null);
  const [showPins, setShowPins] = useState(false);
  const [pinnedMessages, setPinnedMessages] = useState<RoomMessage[]>([]);
  const [memberRoles, setMemberRoles] = useState<Record<string, 'owner' | 'mod' | 'member'>>({});
  const [memberCtxMenu, setMemberCtxMenu] = useState<{ peerId: string; x: number; y: number; flipX: boolean; flipY: boolean } | null>(null);
  const [showCategoryModal, setShowCategoryModal] = useState<{ channelId: string } | null>(null);
  const [categoryInput, setCategoryInput] = useState('');
  // v0.7.0 message action state
  const [reactions, setReactions] = useState<Map<string, { emoji: string; count: number; mine: boolean }[]>>(new Map());
  const [emojiPickerPos, setEmojiPickerPos] = useState<{ id: string; x: number; y: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const myPeerIdRef = useRef<string | null>(null);
  const mutedRef = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<RichEditorHandle>(null);
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
    mutedRef.current = !!r?.muted;
  }

  async function refreshChannels(): Promise<RoomChannel[]> {
    const list = await window.buzz.listRoomChannels({ roomId });
    setChannels(list);
    return list;
  }

  useEffect(() => {
    void applyPlatformTheme(window.buzz);
    void window.buzz.getMyId().then((id) => { setMe(id); myPeerIdRef.current = id.peerId; });
    void window.buzz.getSelfPresence().then((sp) => setDnd(sp.status === 'dnd')).catch(() => undefined);
    void window.buzz
      .getPrefs()
      .then((p) => {
        setSoundsEnabled(p.soundsEnabled);
        setSoundScheme(p.soundScheme);
        setTheme(p.theme);
        applyThemeAttributes(p.theme);
      })
      .catch(() => undefined);
    void window.buzz.listBuddies().then(setBuddies);
    void refreshRoom().then(async () => {
      // Build member role map: check room owner + mods from room state.
      const rooms = await window.buzz.listRooms();
      const r = rooms.find((x) => x.id === roomId);
      if (r) {
        const roleMap: Record<string, 'owner' | 'mod' | 'member'> = {};
        if (r.ownerPeerId) roleMap[r.ownerPeerId] = 'owner';
        for (const mod of r.mods ?? []) roleMap[mod] = 'mod';
        setMemberRoles(roleMap);
      }
    });
    void refreshChannels().then((list) => {
      const def = list.find((c) => c.isDefault) ?? list[0];
      if (def) setActiveChannelId(def.id);
    });

    playSound('door-open');
    function handleBeforeUnload(): void { playSound('door-close'); }
    window.addEventListener('beforeunload', handleBeforeUnload);
    // Mark room as read on open.
    void window.buzz.markRoomRead(roomId).catch(() => undefined);

    const offMsg = window.buzz.onRoomMessage((m) => {
      if (m.roomId !== roomId) return;
      if (m.direction === 'in' && !mutedRef.current) playSound('im-receive');
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

    const offTheme = window.buzz.onThemeChanged((t) => {
      setTheme(t);
      applyThemeAttributes(t);
    });

    // v0.6.0 moderation events
    const offPin = window.buzz.onRoomPin((e) => {
      if (e.roomId !== roomId) return;
      setMessages((prev) => prev.map((m) => (m.id === e.msgId ? { ...m, isPinned: e.isPinned } : m)));
      setPinnedMessages((prev) =>
        e.isPinned
          ? prev.some((m) => m.id === e.msgId)
            ? prev
            : prev // will refresh on next open
          : prev.filter((m) => m.id !== e.msgId),
      );
    });
    const offKick = window.buzz.onRoomKick((e) => {
      if (e.roomId !== roomId) return;
      if (me && e.peerId === me.peerId) {
        alert('You were removed from this room.');
        window.close();
        return;
      }
      void refreshRoom();
    });
    const offRole = window.buzz.onRoomRole((e) => {
      if (e.roomId !== roomId) return;
      setMemberRoles((prev) => ({ ...prev, [e.peerId]: e.role as 'owner' | 'mod' | 'member' }));
    });
    const offCategory = window.buzz.onRoomCategory((e) => {
      if (e.roomId !== roomId) return;
      setChannels((prev) => prev.map((c) => (c.id === e.channelId ? { ...c, category: e.category } : c)));
    });

    // v0.7.0 message action events
    const offReaction = window.buzz.onReaction(({ msgId, peerId: reactorId, emoji, added, roomId: rxnRoomId }) => {
      if (rxnRoomId !== roomId) return;
      setReactions((prev) => {
        const next = new Map(prev);
        const list = [...(next.get(msgId) ?? [])];
        const idx = list.findIndex((x) => x.emoji === emoji);
        if (added) {
          if (idx >= 0) {
            const entry = { ...list[idx]!, count: list[idx]!.count + 1 };
            if (reactorId === myPeerIdRef.current) entry.mine = true;
            list[idx] = entry;
          } else {
            list.push({ emoji, count: 1, mine: reactorId === myPeerIdRef.current });
          }
        } else {
          if (idx >= 0) {
            const entry = { ...list[idx]!, count: Math.max(0, list[idx]!.count - 1) };
            if (reactorId === myPeerIdRef.current) entry.mine = false;
            if (entry.count > 0) list[idx] = entry; else list.splice(idx, 1);
          }
        }
        next.set(msgId, list);
        return next;
      });
    });
    const offRoomEdited = window.buzz.onRoomEdited((e) => {
      if (e.roomId !== roomId) return;
      setMessages((prev) => prev.map((m) => m.id === e.msgId ? { ...m, body: e.body, editedAt: e.editedAt } : m));
    });
    const offRoomDeleted = window.buzz.onRoomDeleted((e) => {
      if (e.roomId !== roomId) return;
      setMessages((prev) => prev.map((m) => m.id === e.msgId ? { ...m, deletedAt: e.deletedAt } : m));
    });
    const offSelf = window.buzz.onSelfPresence((sp) => setDnd(sp.status === 'dnd'));

    return () => {
      offMsg();
      offMembers();
      offInvited();
      offChannel();
      offTheme();
      offPin();
      offKick();
      offRole();
      offCategory();
      offReaction();
      offRoomEdited();
      offRoomDeleted();
      offSelf();
      window.removeEventListener('beforeunload', handleBeforeUnload);
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
      .then((msgs) => {
        setMessages(msgs);
        // Load reactions for all loaded messages.
        void window.buzz.imListReactions(msgs.map((m) => m.id)).then((rows) => {
          const map = new Map<string, { emoji: string; count: number; mine: boolean }[]>();
          for (const r of rows) {
            const list = map.get(r.msgId) ?? [];
            const existing = list.find((x) => x.emoji === r.emoji);
            if (existing) {
              existing.count++;
              if (r.peerId === myPeerIdRef.current) existing.mine = true;
            } else {
              list.push({ emoji: r.emoji, count: 1, mine: r.peerId === myPeerIdRef.current });
            }
            map.set(r.msgId, list);
          }
          setReactions(map);
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannelId, roomId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  async function send(): Promise<void> {
    const body = (editorRef.current?.getMarkup() ?? '').trim();
    if (!body || busy || !activeChannelId) return;
    setBusy(true);
    setErr('');
    try {
      const stored = await window.buzz.sendRoomMessage({
        roomId,
        channelId: activeChannelId,
        body,
        replyToId: replyingTo?.id,
        mentions: replyingTo?.fromPeerId ? [replyingTo.fromPeerId] : undefined,
      });
      setMessages((prev) => [...prev, stored]);
      editorRef.current?.clear();
      setDraft('');
      setReplyingTo(null);
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
  // v0.6.0 derived
  const isOwner = !!me && room?.ownerPeerId === me.peerId;
  const isMod = !!me && memberRoles[me.peerId] === 'mod';
  const isPrivileged = isOwner || isMod;

  async function createChannel(): Promise<void> {
    const name = newChannelName.trim();
    if (!name) return;
    setBusy(true);
    setErr('');
    try {
      const ch = await window.buzz.createRoomChannel({ roomId, name, kind: newChannelKind });
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

  async function pinMsg(msgId: string, isPinned: boolean): Promise<void> {
    try {
      await window.buzz.roomsPin({ roomId, msgId, isPinned });
      setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, isPinned } : m)));
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }

  async function toggleReaction(msgId: string, emoji: string): Promise<void> {
    const myId = myPeerIdRef.current;
    if (!myId) return;
    const list = reactions.get(msgId) ?? [];
    const existing = list.find((x) => x.emoji === emoji);
    if (existing?.mine) {
      await window.buzz.roomsUnreact({ roomId, msgId, emoji }).catch(() => undefined);
    } else {
      await window.buzz.roomsReact({ roomId, msgId, emoji }).catch(() => undefined);
    }
  }

  async function commitEdit(msgId: string): Promise<void> {
    if (!editDraft.trim()) return;
    await window.buzz.roomsEditMsg({ roomId, msgId, body: editDraft.trim() }).catch(() => undefined);
    setEditingId(null);
    setEditDraft('');
  }

  async function deleteMsg(msgId: string): Promise<void> {
    if (!confirm('Delete this message?')) return;
    await window.buzz.roomsDeleteMsg({ roomId, msgId }).catch(() => undefined);
  }

  async function kickMember(peerId: string): Promise<void> {
    if (!confirm(`Remove ${nameFor(peerId)} from the room?`)) return;
    try {
      await window.buzz.roomsKick({ roomId, peerId });
      void refreshRoom();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }

  async function setRole(peerId: string, role: 'mod' | 'member'): Promise<void> {
    try {
      await window.buzz.roomsSetRole({ roomId, peerId, role });
      setMemberRoles((prev) => ({ ...prev, [peerId]: role }));
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }

  async function openPins(): Promise<void> {
    try {
      const pins = await window.buzz.roomsListPinned({ roomId, channelId: activeChannelId || undefined });
      setPinnedMessages(pins);
      setShowPins(true);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }

  async function saveCategory(): Promise<void> {
    if (!showCategoryModal) return;
    const category = categoryInput.trim();
    try {
      await window.buzz.roomsSetCategory({ roomId, channelId: showCategoryModal.channelId, category });
      setChannels((prev) => prev.map((c) => (c.id === showCategoryModal!.channelId ? { ...c, category } : c)));
      setShowCategoryModal(null);
      setCategoryInput('');
    } catch (e) {
      setErr(String((e as Error).message ?? e));
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

  // Group channels by category for sidebar rendering.
  const channelGroups = useMemo(() => {
    const groups = new Map<string, RoomChannel[]>();
    for (const c of channels) {
      const cat = c.category || '';
      const arr = groups.get(cat) ?? [];
      arr.push(c);
      groups.set(cat, arr);
    }
    return groups;
  }, [channels]);

  return (
    <div
      className="im-window"
      data-window-theme={theme.windowTheme}
      onClick={() => { setCtxMenu(null); setMemberCtxMenu(null); }}
    >
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
            {Array.from(channelGroups.entries()).map(([cat, chans]) => (
              <div key={cat}>
                {cat && <div style={{ fontSize: 10, opacity: 0.5, padding: '4px 8px 2px', textTransform: 'uppercase', letterSpacing: 1 }}>{cat}</div>}
                {chans.map((c) => (
                  <div
                    key={c.id}
                    className={`chat-channel-row${c.id === activeChannelId ? ' active' : ''}`}
                    onClick={() => setActiveChannelId(c.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (isPrivileged) {
                        setShowCategoryModal({ channelId: c.id });
                        setCategoryInput(c.category ?? '');
                      } else if (!c.isDefault) {
                        void deleteChannel(c.id);
                      }
                    }}
                    title={c.isDefault ? 'Default channel' : isPrivileged ? 'Right-click to set category' : 'Right-click to delete'}
                  >
                    <span className="chat-channel-hash">{c.kind === 'voice' ? '🔊' : '#'}</span>
                    {c.name}
                  </div>
                ))}
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
            <button onClick={() => void openPins()} title="Pinned messages">★ Pins</button>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11, opacity: 0.7 }}>
              {members.length} {members.length === 1 ? 'member' : 'members'}
            </span>
          </div>

          <div className="im-members" style={{ padding: '0 8px 4px', fontSize: 11, opacity: 0.8 }}>
            {members.map((m) => {
              const role = m === room?.ownerPeerId ? 'owner' : (memberRoles[m] ?? 'member');
              const badge = role === 'owner' ? ' 👑' : role === 'mod' ? ' ★' : '';
              return (
                <span
                  key={m}
                  style={{ marginRight: 8, cursor: isPrivileged && m !== me?.peerId ? 'context-menu' : 'default' }}
                  onContextMenu={(e) => {
                    if (!isPrivileged || m === me?.peerId) return;
                    e.preventDefault();
                    setMemberCtxMenu({ peerId: m, x: e.clientX, y: e.clientY, flipX: e.clientX + 170 > window.innerWidth, flipY: e.clientY + 80 > window.innerHeight });
                  }}
                >
                  • {nameFor(m)}{badge}
                </span>
              );
            })}
          </div>

          {activeChannel?.kind === 'voice' ? (
            <VoiceChannelPane
              roomId={roomId}
              channelId={activeChannelId}
              channelName={activeChannel.name}
              nameFor={nameFor}
              myPeerId={me?.peerId ?? null}
            />
          ) : (
            <>
          <div
            ref={logRef}
            className="im-log"
            data-chat-theme={theme.chatTheme}
            style={{ flex: 1, overflowY: 'auto', padding: 8 }}
          >
            {messages.map((m) => {
              const mine = me && m.fromPeerId === me.peerId;
              const isDark = theme.colorMode === 'dark';
              const bg = mine
                ? (isDark ? '#1e3a5f' : theme.myBubbleColor)
                : (isDark ? '#2a2a3e' : theme.theirBubbleColor);
              const replied = m.replyToId ? messages.find((x) => x.id === m.replyToId) : null;
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
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtxMenu({ id: m.id, x: e.clientX, y: e.clientY, flipX: e.clientX + 150 > window.innerWidth, flipY: e.clientY + 80 > window.innerHeight, msgMine: !!mine });
                  }}
                >
                  {!compact && (
                    <div style={{ fontSize: 10, opacity: 0.7 }}>
                      <strong>{m.fromName || nameFor(m.fromPeerId)}</strong>
                      {theme.showTimestamps && <span> · {fmtTime(m.ts)}</span>}
                      {m.isPinned && <span style={{ marginLeft: 4 }}>★</span>}
                    </div>
                  )}
                  {replied && (
                    <div style={{ fontSize: 10, opacity: 0.6, padding: '2px 6px', borderLeft: '2px solid #888', marginBottom: 2, maxWidth: '70%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      ↳ {replied.fromName || nameFor(replied.fromPeerId)}: {replied.body.slice(0, 80)}
                    </div>
                  )}
                  {m.replyToId && !replied && (
                    <div style={{ fontSize: 10, opacity: 0.5, padding: '2px 6px', borderLeft: '2px solid #ccc', marginBottom: 2 }}>
                      ↳ [message not loaded]
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
                    {editingId === m.id ? (
                      <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <input
                          autoFocus
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void commitEdit(m.id);
                            if (e.key === 'Escape') { setEditingId(null); setEditDraft(''); }
                          }}
                          style={{ flex: 1, fontSize: 'inherit' }}
                        />
                        <button style={{ fontSize: 10 }} onClick={() => void commitEdit(m.id)}>Save</button>
                        <button style={{ fontSize: 10 }} onClick={() => { setEditingId(null); setEditDraft(''); }}>✕</button>
                      </span>
                    ) : m.deletedAt ? (
                      <span style={{ opacity: 0.5, fontStyle: 'italic' }}>[deleted]</span>
                    ) : (
                      <>
                        <RichText body={m.body} />
                        {m.editedAt && <span style={{ opacity: 0.5, fontSize: 10 }}> (edited)</span>}
                      </>
                    )}
                  </div>
                  {!m.deletedAt && (
                    <RoomReactionPills
                      pills={reactions.get(m.id) ?? []}
                      onToggle={(emoji) => void toggleReaction(m.id, emoji)}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {err && <div style={{ color: '#a00', padding: '4px 8px', fontSize: 11 }}>{err}</div>}

          {replyingTo && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderTop: '1px solid #ddd', fontSize: 11, background: 'rgba(0,0,0,0.04)' }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                ↳ Replying to <strong>{replyingTo.fromName || nameFor(replyingTo.fromPeerId)}</strong>: {replyingTo.body.slice(0, 80)}
              </span>
              <button style={{ padding: '1px 5px', fontSize: 11 }} onClick={() => setReplyingTo(null)}>×</button>
            </div>
          )}

          <div className="im-composer" style={{ display: 'flex', flexDirection: 'column', padding: '8px 8px 0' }}>
            <RichEditor
              ref={editorRef}
              placeholder={activeChannel ? `Message #${activeChannel.name}…` : 'Select a channel…'}
              disabled={!activeChannelId}
              onMarkupChange={setDraft}
              onEnter={() => void send()}
            />
          </div>

          {/* AIM-style action bar */}
          <div className="im-actionbar">
            <button
              className="im-action-btn"
              title="Games"
              onClick={() => setShowGamePicker(true)}
            >
              <span className="im-action-btn-icon">🎲</span>
              <span className="im-action-btn-label">Games</span>
            </button>
            <span className="im-actionbar-spacer" />
            <button
              className="im-action-btn send"
              onClick={() => void send()}
              disabled={busy || !draft.trim() || !activeChannelId}
              title="Send message"
            >
              <span className="im-action-btn-icon">📨</span>
              <span className="im-action-btn-label">Send</span>
            </button>
          </div>
            </>
          )}
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
            <div style={{ display: 'flex', gap: 6, marginBottom: 8, fontSize: 11 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="radio"
                  name="channel-kind"
                  checked={newChannelKind === 'text'}
                  onChange={() => setNewChannelKind('text')}
                />
                Text
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="radio"
                  name="channel-kind"
                  checked={newChannelKind === 'voice'}
                  onChange={() => setNewChannelKind('voice')}
                />
                Voice
              </label>
            </div>
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

      {showGamePicker && (
        <GamePicker
          onSelect={(kind) => {
            setShowGamePicker(false);
            setGameKindPending(kind);
            setShowMemberPicker(true);
          }}
          onClose={() => setShowGamePicker(false)}
        />
      )}

      {/* Message context menu */}
      {ctxMenu && (
        <div
          className="ctx-menu"
          style={{
            position: 'fixed',
            top: ctxMenu.flipY ? 'auto' : ctxMenu.y,
            bottom: ctxMenu.flipY ? window.innerHeight - ctxMenu.y : 'auto',
            left: ctxMenu.flipX ? 'auto' : ctxMenu.x,
            right: ctxMenu.flipX ? window.innerWidth - ctxMenu.x : 'auto',
            borderRadius: 4,
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            zIndex: 1000,
            minWidth: 140,
            fontSize: 12,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            style={{ padding: '6px 12px', cursor: 'pointer' }}
            onClick={() => {
              const msg = messages.find((m) => m.id === ctxMenu.id);
              if (msg) setReplyingTo(msg);
              setCtxMenu(null);
              editorRef.current?.focus?.();
            }}
          >
            ↩ Reply
          </div>
          {isPrivileged && (
            <div
              style={{ padding: '6px 12px', cursor: 'pointer' }}
              onClick={() => {
                const msg = messages.find((m) => m.id === ctxMenu.id);
                void pinMsg(ctxMenu.id, !msg?.isPinned);
                setCtxMenu(null);
              }}
            >
              {messages.find((m) => m.id === ctxMenu.id)?.isPinned ? '★ Unpin' : '☆ Pin'}
            </div>
          )}
          {ctxMenu.msgMine && (
            <div
              style={{ padding: '6px 12px', cursor: 'pointer' }}
              onClick={() => {
                const msg = messages.find((m) => m.id === ctxMenu.id);
                if (msg) { setEditingId(msg.id); setEditDraft(msg.body); }
                setCtxMenu(null);
              }}
            >
              ✏️ Edit
            </div>
          )}
          {(ctxMenu.msgMine || isPrivileged) && (
            <div
              style={{ padding: '6px 12px', cursor: 'pointer', color: '#c00' }}
              onClick={() => {
                void deleteMsg(ctxMenu.id);
                setCtxMenu(null);
              }}
            >
              🗑️ Delete
            </div>
          )}
          <div
            style={{ padding: '6px 12px', cursor: 'pointer' }}
            onClick={() => {
              setEmojiPickerPos({ id: ctxMenu.id, x: ctxMenu.x, y: ctxMenu.y });
              setCtxMenu(null);
            }}
          >
            😀 React
          </div>
        </div>
      )}

      {/* Member context menu */}
      {memberCtxMenu && (
        <div
          className="ctx-menu"
          style={{
            position: 'fixed',
            top: memberCtxMenu.flipY ? 'auto' : memberCtxMenu.y,
            bottom: memberCtxMenu.flipY ? window.innerHeight - memberCtxMenu.y : 'auto',
            left: memberCtxMenu.flipX ? 'auto' : memberCtxMenu.x,
            right: memberCtxMenu.flipX ? window.innerWidth - memberCtxMenu.x : 'auto',
            borderRadius: 4,
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            zIndex: 1000,
            minWidth: 160,
            fontSize: 12,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {isOwner && (
            <>
              <div
                style={{ padding: '6px 12px', cursor: 'pointer' }}
                onClick={() => {
                  const cur = memberRoles[memberCtxMenu.peerId] ?? 'member';
                  void setRole(memberCtxMenu.peerId, cur === 'mod' ? 'member' : 'mod');
                  setMemberCtxMenu(null);
                }}
              >
                {(memberRoles[memberCtxMenu.peerId] ?? 'member') === 'mod' ? '★ Remove Mod' : '★ Make Mod'}
              </div>
            </>
          )}
          <div
            style={{ padding: '6px 12px', cursor: 'pointer', color: '#c00' }}
            onClick={() => {
              void kickMember(memberCtxMenu.peerId);
              setMemberCtxMenu(null);
            }}
          >
            ✕ Kick
          </div>
        </div>
      )}

      {/* Emoji picker for room reactions */}
      {emojiPickerPos && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 999 }} onClick={() => setEmojiPickerPos(null)} onContextMenu={(e) => { e.preventDefault(); setEmojiPickerPos(null); }} />
          <RoomEmojiPickerPopover
            x={emojiPickerPos.x}
            y={emojiPickerPos.y}
            onPick={(emoji) => { void toggleReaction(emojiPickerPos.id, emoji); setEmojiPickerPos(null); }}
            onClose={() => setEmojiPickerPos(null)}
          />
        </>
      )}

      {/* Pins modal */}
      {showPins && (
        <div
          className="modal-backdrop"
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setShowPins(false)}
        >
          <div
            className="modal"
            style={{ background: '#fff', padding: 12, minWidth: 300, maxWidth: 480, maxHeight: 400, borderRadius: 4, display: 'flex', flexDirection: 'column', gap: 8 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: 0 }}>★ Pinned Messages</h3>
            {pinnedMessages.length === 0 ? (
              <p style={{ fontSize: 12, opacity: 0.7 }}>No pinned messages.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, overflowY: 'auto', flex: 1 }}>
                {pinnedMessages.map((m) => (
                  <li key={m.id} style={{ padding: '6px 0', borderBottom: '1px solid #eee', fontSize: 12 }}>
                    <strong>{m.fromName || nameFor(m.fromPeerId)}</strong>
                    <span style={{ opacity: 0.6, marginLeft: 6 }}>{fmtTime(m.ts)}</span>
                    <div style={{ marginTop: 2 }}>{m.body.slice(0, 200)}</div>
                  </li>
                ))}
              </ul>
            )}
            <div style={{ textAlign: 'right' }}>
              <button onClick={() => setShowPins(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Set Category modal */}
      {showCategoryModal && (
        <div
          className="modal-backdrop"
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => { setShowCategoryModal(null); setCategoryInput(''); }}
        >
          <div
            className="modal"
            style={{ background: '#fff', padding: 12, minWidth: 260, borderRadius: 4 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 8px' }}>Set Channel Category</h3>
            <input
              type="text"
              autoFocus
              value={categoryInput}
              onChange={(e) => setCategoryInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveCategory(); }}
              placeholder="Category name (blank to remove)"
              style={{ width: '100%' }}
              maxLength={64}
            />
            <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
              <button onClick={() => { setShowCategoryModal(null); setCategoryInput(''); }}>Cancel</button>
              <button onClick={() => void saveCategory()}>Save</button>
            </div>
          </div>
        </div>
      )}

      {showMemberPicker && gameKindPending && room && (
        <div
          className="modal-backdrop"
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => { setShowMemberPicker(false); setGameKindPending(null); }}
        >
          <div
            className="modal"
            style={{ background: '#fff', padding: 12, minWidth: 220, borderRadius: 4 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 8px' }}>Challenge a member</h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: 200, overflowY: 'auto' }}>
              {room.members
                .filter((pid) => pid !== me?.peerId)
                .map((pid) => (
                  <li key={pid} style={{ padding: '4px 0' }}>
                    <button
                      style={{ width: '100%', textAlign: 'left' }}
                      onClick={async () => {
                        setShowMemberPicker(false);
                        const kind = gameKindPending!;
                        setGameKindPending(null);
                        await window.buzzWindows.openGame(pid, kind, true);
                        await window.buzz.gameInvite({ toPeerId: pid, kind });
                        if (activeChannelId) {
                          const label = kind.charAt(0).toUpperCase() + kind.slice(1);
                          const body = `🎲 challenged ${nameFor(pid)} to ${label}`;
                          try {
                            const stored = await window.buzz.sendRoomMessage({
                              roomId,
                              channelId: activeChannelId,
                              body,
                            });
                            setMessages((prev) => [...prev, stored]);
                          } catch { /* announcement is best-effort */ }
                        }
                      }}
                    >
                      {nameFor(pid)}
                    </button>
                  </li>
                ))}
            </ul>
            <div style={{ marginTop: 8, textAlign: 'right' }}>
              <button onClick={() => { setShowMemberPicker(false); setGameKindPending(null); }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

const ROOM_EMOJI_LIST = ['👍','👎','❤️','😂','😮','😢','🔥','🎉','👀','💯','✅','❌','🤔','💀','🙏','🫡','💪','🤝','😎','🚀'];

function RoomEmojiPickerPopover({ x, y, onPick, onClose: _onClose }: { x: number; y: number; onPick: (e: string) => void; onClose: () => void }) {
  return (
    <div
      style={{
        position: 'fixed', left: x, top: y, zIndex: 1000, background: '#fff', border: '1px solid #aaa',
        borderRadius: 4, padding: 4, display: 'flex', flexWrap: 'wrap', width: 160, gap: 2,
        boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {ROOM_EMOJI_LIST.map((e) => (
        <span
          key={e}
          style={{ cursor: 'pointer', fontSize: 16, padding: '1px 2px', borderRadius: 2 }}
          title={e}
          onClick={() => onPick(e)}
        >{e}</span>
      ))}
    </div>
  );
}

function RoomReactionPills({
  pills, onToggle,
}: {
  pills: { emoji: string; count: number; mine: boolean }[];
  onToggle: (emoji: string) => void;
}) {
  if (pills.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 2 }}>
      {pills.map((p) => (
        <button
          key={p.emoji}
          style={{
            fontSize: 12, padding: '0 5px', border: p.mine ? '1px solid #316ac5' : '1px solid #bbb',
            background: p.mine ? '#dce8f8' : '#f0f0f0', borderRadius: 10, cursor: 'pointer',
          }}
          title={p.mine ? 'Remove reaction' : 'Add reaction'}
          onClick={() => onToggle(p.emoji)}
        >
          {p.emoji} {p.count}
        </button>
      ))}
    </div>
  );
}

function VoiceChannelPane(props: {
  roomId: string;
  channelId: string;
  channelName: string;
  nameFor: (peerId: string) => string;
  myPeerId: string | null;
}): JSX.Element {
  const { roomId, channelId, channelName, nameFor, myPeerId } = props;
  const voice = useRoomVoice(roomId, channelId);
  const screen = useRoomScreen(roomId, channelId, voice.joined, myPeerId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const screenContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = screenContainerRef.current;
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    if (screen.videoEl) {
      screen.videoEl.style.width = '100%';
      screen.videoEl.style.height = '100%';
      screen.videoEl.style.objectFit = 'contain';
      screen.videoEl.style.background = '#000';
      host.appendChild(screen.videoEl);
    }
    return () => {
      if (screen.videoEl && host.contains(screen.videoEl)) host.removeChild(screen.videoEl);
    };
  }, [screen.videoEl]);

  const someoneElsePresenting = !!screen.presenter && screen.presenter.peerId !== myPeerId;
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-start',
        padding: 16,
        gap: 12,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600 }}>🔊 {channelName}</div>
      <div style={{ fontSize: 11, opacity: 0.75 }}>
        {voice.joined
          ? voice.participants.length === 0
            ? 'You\u2019re the only one here.'
            : `Talking with ${voice.participants.length} ${voice.participants.length === 1 ? 'person' : 'people'}.`
          : 'Voice channel — press Join to talk.'}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        {!voice.joined ? (
          <button onClick={() => void voice.join()}>Join</button>
        ) : (
          <>
            <button onClick={() => voice.toggleMute()}>{voice.muted ? 'Unmute' : 'Mute'}</button>
            <button onClick={() => void voice.leave()}>Leave</button>
            {screen.iAmPresenting ? (
              <button onClick={() => void screen.stopShare()}>Stop Sharing</button>
            ) : (
              <button
                onClick={() => setPickerOpen(true)}
                disabled={someoneElsePresenting}
                title={someoneElsePresenting ? `${screen.presenter?.screenName || 'Someone'} is presenting` : 'Share your screen with the channel'}
              >
                Share Screen
              </button>
            )}
          </>
        )}
      </div>

      {someoneElsePresenting && (
        <div style={{ width: '100%', maxWidth: 480, marginTop: 8, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <div style={{ fontSize: 11, opacity: 0.75 }}>
            🖥 {screen.presenter?.screenName || nameFor(screen.presenter?.peerId ?? '')} is presenting{screen.presenter?.sourceName ? ` (${screen.presenter.sourceName})` : ''}
          </div>
          <div
            ref={screenContainerRef}
            style={{
              width: '100%',
              aspectRatio: '16 / 9',
              background: '#000',
              borderRadius: 4,
              overflow: 'hidden',
            }}
          />
        </div>
      )}

      {screen.iAmPresenting && (
        <div style={{ fontSize: 11, opacity: 0.75 }}>You are sharing your screen.</div>
      )}
      {screen.error && (
        <div style={{ color: '#a00', fontSize: 11 }}>{screen.error}</div>
      )}

      <ScreenSourcePicker
        open={pickerOpen}
        onCancel={() => setPickerOpen(false)}
        onShare={(source, resolution) => {
          setPickerOpen(false);
          void screen.startShare(source, resolution);
        }}
      />

      <div
        style={{
          marginTop: 12,
          width: '100%',
          maxWidth: 360,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          fontSize: 12,
        }}
      >
        {voice.joined && (
          <div
            style={{
              padding: '4px 8px',
              borderRadius: 4,
              background: 'rgba(0,128,255,0.08)',
            }}
          >
            • You {voice.muted ? '(muted)' : ''}
          </div>
        )}
        {voice.participants.map((p) => (
          <div
            key={p.peerId}
            style={{
              padding: '4px 8px',
              borderRadius: 4,
              background: 'rgba(0,0,0,0.04)',
            }}
          >
            • {p.screenName || nameFor(p.peerId)}
          </div>
        ))}
      </div>

      {voice.error && (
        <div style={{ color: '#a00', fontSize: 11 }}>{voice.error}</div>
      )}
    </div>
  );
}

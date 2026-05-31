import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyPlatformTheme, applyThemeAttributes } from '../../theme/applyPlatform';
import { WindowChrome } from '../../components/WindowChrome';
import { ProfileViewer } from '../../components/ProfilePanes';
import { RichEditor, RichEditorHandle, RichText } from '../../components/RichText';
import { useTalk, fmtCallTime } from '../../components/useTalk';
import { VoiceMemo } from '../../components/VoiceMemo';
import { WaveformCanvas } from '../../components/WaveformCanvas';
import { GamePicker } from '../../components/GamePicker';
import { playSound, setSoundsEnabled, setSoundScheme, setDnd } from '../../sounds/synth';
import type { ImMessage, Theme, XferOfferEvent } from '@shared/schemas';

const DEFAULT_THEME: Theme = {
  chatTheme: 'classic',
  windowTheme: 'classic',
  colorMode: 'light',
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
  const [me, setMe] = useState<{ screenName: string; peerId?: string } | null>(null);
  const [alias, setAlias] = useState<string>(peerId.slice(0, 12) + '…');
  const [messages, setMessages] = useState<ImMessage[]>([]);
  const [xfers, setXfers] = useState<XferCard[]>([]);
  const [draft, setDraft] = useState('');
  const editorRef = useRef<RichEditorHandle>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSendingTypingRef = useRef(false);
  const [status, setStatus] = useState<'online' | 'offline' | 'away' | 'idle' | 'dnd'>('offline');
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [peerTyping, setPeerTyping] = useState(false);
  const peerTypingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [awayMessage, setAwayMessage] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [warnLevel, setWarnLevel] = useState(0);
  const [showProfile, setShowProfile] = useState(false);
  const [showGamePicker, setShowGamePicker] = useState(false);
  const [dragHover, setDragHover] = useState(false);
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  const [myAvatar, setMyAvatar] = useState<string>('');
  const [theirAvatar, setTheirAvatar] = useState<string>('');
  const logRef = useRef<HTMLDivElement>(null);
  const talk = useTalk(peerId, { kind: 'voice' });
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number; canEdit: boolean } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  // reactions: msgId → { emoji: string; count: number; mine: boolean }[]
  const [reactions, setReactions] = useState<Map<string, { emoji: string; count: number; mine: boolean }[]>>(new Map());
  const [emojiPickerPos, setEmojiPickerPos] = useState<{ id: string; x: number; y: number } | null>(null);
  const myPeerIdRef = useRef<string | null>(null);
  const mutedRef = useRef(false);
  // Search
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ImMessage[] | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

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
    void window.buzz.getMyId().then((info) => { setMe(info); myPeerIdRef.current = info.peerId; });
    void window.buzz.getSelfPresence().then((sp) => setDnd(sp.status === 'dnd')).catch(() => undefined);
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
          mutedRef.current = !!b.muted;
        }
        // Chain status lookup so we have the correct alias available.
        return window.buzz.getPeerStatus(peerId).then((s) => {
          const resolved = !s || s.status === 'invisible' ? 'offline' : (s.status as typeof status);
          setStatus(resolved);
          if (resolved === 'offline') setStatusNotice(`${resolvedAlias} is offline.`);
          else if (resolved === 'away') setStatusNotice(`${resolvedAlias} is away.`);
          else if (resolved === 'dnd') setStatusNotice(`${resolvedAlias} has Do Not Disturb on.`);
          if (s) setAwayMessage(s.awayMessage);
        });
      })
      .catch(() => undefined);
    void window.buzz.history({ peerId, limit: 100 }).then((msgs) => {
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
      if (!mutedRef.current) playSound('im-receive');
      // Window is open — flush this message from the unread tally.
      void window.buzz.markImRead(peerId).catch(() => undefined);
      // Refresh cached mute flag in case it changed.
      void window.buzz
        .listBuddies()
        .then((bs) => { mutedRef.current = !!bs.find((b) => b.peerId === peerId)?.muted; })
        .catch(() => undefined);
    });
    const offAck = window.buzz.onImAck(({ id, status }) => {
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status } : m)));
    });
    const offStatus = window.buzz.onBuddyStatus((e) => {
      if (e.peerId === peerId) {
        const next = e.status === 'invisible' ? 'offline' : (e.status as 'online' | 'offline' | 'away' | 'idle' | 'dnd');
        setStatus((prev) => {
          if (next === prev) return prev;
          if (next === 'offline') setStatusNotice(`${alias} has gone offline.`);
          else if (next === 'away') setStatusNotice(`${alias} has gone away.`);
          else if (next === 'dnd') setStatusNotice(`${alias} turned on Do Not Disturb.`);
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
    const offImEdited = window.buzz.onImEdited(({ id, body, editedAt }) => {
      setMessages((prev) => prev.map((m) => m.id === id ? { ...m, body, editedAt } : m));
    });
    const offImDeleted = window.buzz.onImDeleted(({ id, deletedAt }) => {
      setMessages((prev) => prev.map((m) => m.id === id ? { ...m, deletedAt } : m));
    });
    const offReaction = window.buzz.onReaction(({ msgId, peerId: reactorId, emoji, added, roomId }) => {
      if (roomId) return; // room reactions handled by chat window
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
    const offTheme = window.buzz.onThemeChanged((theme) => {
      setTheme(theme);
      applyThemeAttributes(theme);
    });
    const offTyping = window.buzz.onTyping((e) => {
      if (e.peerId !== peerId) return;
      if (peerTypingTimerRef.current) clearTimeout(peerTypingTimerRef.current);
      setPeerTyping(e.typing);
      if (e.typing) {
        peerTypingTimerRef.current = setTimeout(() => setPeerTyping(false), 6000);
      }
    });
    const offSelf = window.buzz.onSelfPresence((sp) => setDnd(sp.status === 'dnd'));
    return () => {
      offRecv();
      offAck();
      offStatus();
      offOffered();
      offProgress();
      offDone();
      offPeerProfile();
      offGameInvite();
      offImEdited();
      offImDeleted();
      offReaction();
      offTheme();
      offTyping();
      offSelf();
      if (peerTypingTimerRef.current) clearTimeout(peerTypingTimerRef.current);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [peerId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  // Cmd+F / Ctrl+F opens message search.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
      if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false);
        setSearchQuery('');
        setSearchResults(null);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [searchOpen]);

  async function runSearch(q: string): Promise<void> {
    if (!q.trim()) { setSearchResults(null); return; }
    const results = await window.buzz.imSearch({ query: q, peerId, limit: 50 }).catch(() => []);
    setSearchResults(results);
  }

  async function send(): Promise<void> {
    setErr('');
    if (blocked) {
      setErr('You have blocked this user. Unblock to send messages.');
      return;
    }
    const body = (editorRef.current?.getMarkup() ?? '').trim();
    if (!body) return;
    // Stop typing indicator immediately on send.
    if (typingTimerRef.current) { clearTimeout(typingTimerRef.current); typingTimerRef.current = null; }
    if (isSendingTypingRef.current) {
      isSendingTypingRef.current = false;
      void window.buzz.imSendTyping({ toPeerId: peerId, typing: false });
    }
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

  async function sendFile(filePath?: string): Promise<void> {
    if (blocked) {
      setErr('You have blocked this user. Unblock to send files.');
      return;
    }
    setErr('');
    try {
      const r = await window.buzz.xferOffer(peerId, filePath);
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

  async function commitEdit(id: string): Promise<void> {
    if (!editDraft.trim()) return;
    await window.buzz.imEdit({ id, body: editDraft.trim() }).catch(() => undefined);
    setEditingId(null);
    setEditDraft('');
  }

  async function deleteMsg(id: string): Promise<void> {
    await window.buzz.imDelete({ id }).catch(() => undefined);
  }

  async function toggleReaction(msgId: string, emoji: string): Promise<void> {
    const myId = myPeerIdRef.current;
    if (!myId) return;
    const list = reactions.get(msgId) ?? [];
    const existing = list.find((x) => x.emoji === emoji);
    if (existing?.mine) {
      await window.buzz.imUnreact({ msgId, peerId: myId, emoji }).catch(() => undefined);
    } else {
      await window.buzz.imReact({ msgId, peerId: myId, emoji }).catch(() => undefined);
    }
  }

  const myName = me?.screenName ?? 'me';

  return (
    <div
      className={`window${dragHover ? ' im-dragover' : ''}`}
      onDragEnter={(e) => {
        if (e.dataTransfer?.types?.includes('Files')) {
          e.preventDefault();
          setDragHover(true);
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDragLeave={(e) => {
        if (e.target === e.currentTarget) setDragHover(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragHover(false);
        const files = Array.from(e.dataTransfer?.files ?? []);
        for (const f of files) {
          const fp = (f as unknown as { path?: string }).path;
          if (fp) void sendFile(fp);
        }
      }}
    >
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
      <div ref={logRef} className="bevel-in chat-log" style={{ position: 'relative' }}>
        {/* ── Search bar overlay ── */}
        {searchOpen && (
          <div style={{
            position: 'sticky', top: 0, zIndex: 10, background: '#f0f0f0',
            borderBottom: '1px solid #bbb', padding: '4px 6px', display: 'flex', gap: 4, alignItems: 'center',
          }}>
            <input
              ref={searchInputRef}
              style={{ flex: 1, fontSize: 11 }}
              placeholder="Search messages…"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); void runSearch(e.target.value); }}
            />
            <button style={{ fontSize: 10 }} onClick={() => { setSearchOpen(false); setSearchQuery(''); setSearchResults(null); }}>✕</button>
          </div>
        )}
        {/* Search results replace normal log when active */}
        {searchResults !== null ? (
          searchResults.length === 0 ? (
            <div className="muted" style={{ padding: 8, fontSize: 11 }}>No results.</div>
          ) : (
            <>
              {searchResults.map((m) => (
                <div key={m.id} style={{ padding: '2px 0', borderBottom: '1px solid #eee', fontSize: 11 }}>
                  <span className="muted">{new Date(m.ts).toLocaleString()}</span>{' '}
                  <span className={m.direction === 'out' ? 'me' : 'them'}>{m.direction === 'out' ? (me?.screenName ?? 'me') : alias}:</span>{' '}
                  <span>{m.body}</span>
                </div>
              ))}
            </>
          )
        ) : (
          <>
            {messages.map((m) => {
              const isDeleted = !!m.deletedAt;
              const canEdit = m.direction === 'out' && !isDeleted;
              const isEditing = editingId === m.id;
              const msgContent = isDeleted ? (
                <span className="muted" style={{ fontStyle: 'italic' }}>Message deleted.</span>
              ) : isEditing ? (
                <span>
                  <textarea
                    style={{ fontSize: 12, width: '100%', minHeight: 40, boxSizing: 'border-box' }}
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void commitEdit(m.id); }
                      if (e.key === 'Escape') { setEditingId(null); setEditDraft(''); }
                    }}
                    autoFocus
                  />
                  <button style={{ fontSize: 10 }} onClick={() => void commitEdit(m.id)}>Save</button>{' '}
                  <button style={{ fontSize: 10 }} onClick={() => { setEditingId(null); setEditDraft(''); }}>Cancel</button>
                </span>
              ) : (
                <>
                  <RichText body={m.body} />
                  {m.editedAt && <span className="muted" style={{ fontSize: 10 }}> (edited)</span>}
                </>
              );
              const msgPills = reactions.get(m.id) ?? [];
              const reactionRow = !isDeleted ? (
                <div>
                  <ReactionPills
                    pills={msgPills}
                    onToggle={(emoji) => void toggleReaction(m.id, emoji)}
                  />
                </div>
              ) : null;

              if (theme.chatTheme === 'balloons') {
                return (
                  <div
                    key={m.id}
                    className={`bubble-row ${m.direction}`}
                    onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ id: m.id, x: e.clientX, y: e.clientY, canEdit: canEdit && !isEditing }); }}
                  >
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
                        {msgContent}
                        {(theme.showTimestamps || (m.direction === 'out' && m.status !== 'sent' && m.status !== 'delivered')) && (
                          <div className="meta">
                            {theme.showTimestamps && new Date(m.ts).toLocaleTimeString()}
                            {m.direction === 'out' && m.status !== 'sent' && m.status !== 'delivered'
                              ? ` · ${m.status}`
                              : ''}
                          </div>
                        )}
                      </div>
                      {reactionRow}
                    </div>
                  </div>
                );
              }
              return (
                <div
                  key={m.id}
                  onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ id: m.id, x: e.clientX, y: e.clientY, canEdit: canEdit && !isEditing }); }}
                >
                  {theme.showTimestamps && (
                    <span className="muted" style={{ fontSize: 10, marginRight: 4 }}>
                      [{new Date(m.ts).toLocaleTimeString()}]
                    </span>
                  )}
                  <span className={m.direction === 'out' ? 'me' : 'them'}>
                    {m.direction === 'out' ? myName : alias}:
                  </span>{' '}
                  {msgContent}
                  {m.direction === 'out' && m.status !== 'sent' && m.status !== 'delivered' ? (
                    <span className="muted"> [{m.status}]</span>
                  ) : null}
                  {reactionRow}
                </div>
              );
            })}
            {xfers.map((c) => (
              <XferLine
                key={c.id}
                card={c}
                onAccept={() => void respondXfer(c.id, true)}
                onDecline={() => void respondXfer(c.id, false)}
              />
            ))}
          </>
        )}
      </div>

      <div className="im-compose-col">
        {(peerTyping || statusNotice) && (
          <div className="im-status-banner">
            {peerTyping ? `${alias} is typing…` : statusNotice}
          </div>
        )}
        <div className="bevel-in im-compose-wrap">
          <RichEditor
            ref={editorRef}
            placeholder={blocked ? 'Unblock this user to send messages.' : 'Type a message and hit Enter…'}
            disabled={busy || blocked}
            onMarkupChange={(markup) => {
              setDraft(markup);
              if (markup.trim() && !isSendingTypingRef.current) {
                isSendingTypingRef.current = true;
                void window.buzz.imSendTyping({ toPeerId: peerId, typing: true });
              }
              if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
              typingTimerRef.current = setTimeout(() => {
                isSendingTypingRef.current = false;
                void window.buzz.imSendTyping({ toPeerId: peerId, typing: false });
              }, 4000);
            }}
            onEnter={() => void send()}
            style={{ width: '100%', minHeight: 100 }}
          />
        </div>
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
        <button
          className="im-action-btn"
          onClick={() => void sendFile()}
          disabled={blocked}
          title="Send a file (or drag and drop)"
        >
          <span className="im-action-btn-icon">📎</span>
          <span className="im-action-btn-label">File</span>
        </button>
        <VoiceMemo
          peerId={peerId}
          disabled={blocked}
          onError={(m) => setErr(m)}
          onSent={(info) => upsertXfer((prev) => [
            ...prev,
            { kind: 'xfer', id: info.id, direction: 'out', fileName: info.fileName, fileSize: info.fileSize, state: 'active', bytes: 0 },
          ])}
        />

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

      {ctxMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 999 }} onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }} />
          <MessageContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            canEdit={ctxMenu.canEdit}
            onEdit={() => {
              const msg = messages.find((m) => m.id === ctxMenu.id);
              if (msg) { setEditingId(ctxMenu.id); setEditDraft(msg.body); }
              setCtxMenu(null);
            }}
            onDelete={() => { void deleteMsg(ctxMenu.id); setCtxMenu(null); }}
            onReact={() => { setEmojiPickerPos({ id: ctxMenu.id, x: ctxMenu.x, y: ctxMenu.y }); setCtxMenu(null); }}
            onClose={() => setCtxMenu(null)}
          />
        </>
      )}

      {emojiPickerPos && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 999 }} onClick={() => setEmojiPickerPos(null)} onContextMenu={(e) => { e.preventDefault(); setEmojiPickerPos(null); }} />
          <EmojiPickerPopover
            x={emojiPickerPos.x}
            y={emojiPickerPos.y}
            onPick={(emoji) => { void toggleReaction(emojiPickerPos.id, emoji); setEmojiPickerPos(null); }}
            onClose={() => setEmojiPickerPos(null)}
          />
        </>
      )}
    </div>
  );
}

const EMOJI_LIST = ['👍','👎','❤️','😂','😮','😢','🔥','🎉','👀','💯','✅','❌','🤔','💀','🙏','🫡','💪','🤝','😎','🚀'];

function EmojiPickerPopover({ x, y, onPick, onClose: _onClose }: { x: number; y: number; onPick: (e: string) => void; onClose: () => void }) {
  return (
    <div
      style={{
        position: 'fixed', left: x, top: y, zIndex: 1000, background: '#fff', border: '1px solid #aaa',
        borderRadius: 4, padding: 4, display: 'flex', flexWrap: 'wrap', width: 160, gap: 2,
        boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {EMOJI_LIST.map((e) => (
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

function ReactionPills({
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

function MessageContextMenu({ x, y, canEdit, onEdit, onDelete, onReact, onClose: _onClose }: {
  x: number; y: number; canEdit: boolean;
  onEdit: () => void; onDelete: () => void; onReact: () => void; onClose: () => void;
}) {
  const itemStyle: React.CSSProperties = {
    padding: '5px 12px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
    userSelect: 'none',
  };
  return (
    <div
      style={{
        position: 'fixed', left: x, top: y, zIndex: 1000,
        background: '#fff', border: '1px solid #aaa', borderRadius: 3,
        boxShadow: '0 2px 8px rgba(0,0,0,0.18)', minWidth: 140,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {canEdit && (
        <>
          <div style={itemStyle} onClick={onEdit}>✏️ Edit</div>
          <div style={itemStyle} onClick={onDelete}>🗑️ Delete</div>
          <div style={{ borderTop: '1px solid #eee' }} />
        </>
      )}
      <div style={itemStyle} onClick={onReact}>😀 Add Reaction</div>
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
        <div style={{ marginTop: 4 }}>
          <div className="muted">
            ✓ Complete{card.savedPath ? ` — saved to ${card.savedPath}` : ''}
          </div>
          {/\.(png|jpe?g|gif|webp|svg)$/i.test(card.fileName) && (
            <img
              src={`buzz-file://${card.id}`}
              alt={card.fileName}
              style={{ maxWidth: '100%', maxHeight: 240, marginTop: 4, display: 'block', borderRadius: 2 }}
            />
          )}
          {/\.(webm|ogg|mp3|wav|m4a)$/i.test(card.fileName) && (
            <audio
              src={`buzz-file://${card.id}`}
              controls
              style={{ marginTop: 4, display: 'block', maxWidth: '100%' }}
            />
          )}
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

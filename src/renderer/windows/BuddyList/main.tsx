import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyPlatformTheme, applyThemeAttributes } from '../../theme/applyPlatform';
import { WindowChrome } from '../../components/WindowChrome';
import { ProfileEditor, ProfileViewer } from '../../components/ProfilePanes';
import { Modal } from '../../components/Modal';
import { playSound, setSoundsEnabled, setSoundScheme, getSoundScheme } from '../../sounds/synth';
import type { SoundScheme } from '../../sounds/synth';
import type {
  Buddy,
  BuddyRequest,
  BuddyRequestEvent,
  BuddyRequestResolvedEvent,
  Room,
  Status,
  BuddyStatusEvent,
  DiscoveredEvent,
  DiscoveredPeer,
  MailboxStats,
  SelectableStatus,
  SelfPresence,
  UnreadCounts,
} from '@shared/schemas';

function App(): JSX.Element {
  const [me, setMe] = useState<{ peerId: string; buddyCode: string; screenName: string } | null>(
    null,
  );
  const [buddies, setBuddies] = useState<Buddy[]>([]);
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [awayMessages, setAwayMessages] = useState<Record<string, string | undefined>>({});
  const [self, setSelf] = useState<SelfPresence | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showAway, setShowAway] = useState(false);
  const [awayDraft, setAwayDraft] = useState('');
  const [code, setCode] = useState('');
  const [alias, setAlias] = useState('');
  const [group, setGroup] = useState('Buddies');
  const [err, setErr] = useState('');
  const [soundsOn, setSoundsOn] = useState(true);
  const [soundScheme, setSoundSchemeState] = useState<SoundScheme>(getSoundScheme());
  const logoutSoundPlayedRef = useRef(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showRoom, setShowRoom] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [roomMembers, setRoomMembers] = useState<Set<string>>(new Set());
  const [rooms, setRooms] = useState<Room[]>([]);
  const [showMailbox, setShowMailbox] = useState(false);
  const [mailbox, setMailbox] = useState<MailboxStats | null>(null);
  const [relayInput, setRelayInput] = useState('');
  const [viewProfile, setViewProfile] = useState<{ peerId: string; alias: string } | null>(null);
  const [ctx, setCtx] = useState<{ peerId: string; x: number; y: number } | null>(null);
  const [roomCtx, setRoomCtx] = useState<{ roomId: string; x: number; y: number } | null>(null);
  // Invite-to-room sub-flow: which room we're inviting into.
  const [roomCtxInvite, setRoomCtxInvite] = useState<{ roomId: string; roomName: string } | null>(null);
  const [roomInvitePeerId, setRoomInvitePeerId] = useState('');
  // Auto-discovered LAN peers that aren't in the buddy list yet.
  const [nearby, setNearby] = useState<DiscoveredPeer[]>([]);
  // Pending buddy add requests (both directions).
  const [requests, setRequests] = useState<BuddyRequest[]>([]);
  // Unread message counters per peer / per room.
  const [unread, setUnread] = useState<UnreadCounts>({ peers: {}, rooms: {} });
  const [signingOff, setSigningOff] = useState(false);
  const [isMesh, setIsMesh] = useState(false);
  // Track last seen status per peer so we can play buddy-in / buddy-out
  // only on actual transitions (not on every duplicate broadcast).
  const prevStatusRef = useRef<Record<string, Status>>({});

  useEffect(() => {
    void applyPlatformTheme(window.buzz);
    void window.buzz.getNetworkConfig().then((cfg) => setIsMesh(cfg.mode === 'exp-p2p'));
    void window.buzz.getMyId().then(setMe);
    void window.buzz.listBuddies().then((list) => {
      setBuddies(list);
      // Pre-populate prevStatusRef with the current buddy statuses so that
      // the initial burst of onBuddyStatus events on login doesn't trigger
      // buddy-in sounds for buddies who were already online.
      for (const b of list) {
        prevStatusRef.current[b.peerId] = b.status ?? 'offline';
      }
    });
    void window.buzz.getSelfPresence().then(setSelf).catch(() => undefined);
    void window.buzz
      .getPrefs()
      .then((p) => {
        setSoundsOn(p.soundsEnabled);
        setSoundsEnabled(p.soundsEnabled);
        setSoundSchemeState(p.soundScheme);
        setSoundScheme(p.soundScheme);
        playSound('login');
      })
      .catch(() => undefined);
    const off = window.buzz.onBuddyStatus((e: BuddyStatusEvent) => {
      setStatuses((s) => ({ ...s, [e.peerId]: e.status }));
      setAwayMessages((m) => ({ ...m, [e.peerId]: e.awayMessage }));
      const prev = prevStatusRef.current[e.peerId];
      const wasOnline = prev !== undefined && prev !== 'offline' && prev !== 'invisible';
      const isOnline = e.status !== 'offline' && e.status !== 'invisible';
      if (!wasOnline && isOnline) playSound('buddy-in');
      else if (wasOnline && !isOnline) playSound('buddy-out');
      prevStatusRef.current[e.peerId] = e.status;
    });
    void window.buzz.listRooms().then(setRooms);
    void window.buzz.listDiscovered().then(setNearby).catch(() => undefined);
    void window.buzz.listBuddyRequests().then(setRequests).catch(() => undefined);
    void window.buzz.getUnread().then(setUnread).catch(() => undefined);
    const offBuddyReq = window.buzz.onBuddyRequest((e: BuddyRequestEvent) => {
      setRequests((prev) => {
        const others = prev.filter((r) => r.peerId !== e.request.peerId);
        return e.kind === 'incoming' ? [e.request, ...others] : others;
      });
      if (e.kind === 'incoming') playSound('im-receive');
    });
    const offBuddyResolved = window.buzz.onBuddyRequestResolved(
      (e: BuddyRequestResolvedEvent) => {
        setRequests((prev) => prev.filter((r) => r.peerId !== e.peerId));
        // Refresh buddies if the remote accepted us.
        if (e.accepted) void window.buzz.listBuddies().then(setBuddies);
      },
    );
    const offUnread = window.buzz.onUnread((c: UnreadCounts) => setUnread(c));
    const offDiscovered = window.buzz.onDiscovered((e: DiscoveredEvent) => {
      setNearby((prev) => {
        if (e.kind === 'removed') return prev.filter((p) => p.peerId !== e.peer.peerId);
        const others = prev.filter((p) => p.peerId !== e.peer.peerId);
        return [e.peer, ...others];
      });
    });
    const offInvited = window.buzz.onRoomInvited((e) => {
      void window.buzz.listRooms().then(setRooms);
      // Auto-open the new chat window so the user sees the invite immediately.
      void window.buzzWindows.openChat(e.roomId);
      playSound('im-receive');
    });
    const offRoomMembers = window.buzz.onRoomMembers(() => {
      void window.buzz.listRooms().then(setRooms);
    });
    // Open (or focus) the right window on incoming call invite so the
    // recipient sees the ring/accept UI even if they had no chat open.
    const offTalkInvite = window.buzz.onTalkInvite((e) => {
      if ((e.kind ?? 'voice') === 'video') {
        void window.buzzWindows.openVideoCall(e.peerId);
      } else {
        void window.buzzWindows.openIm(e.peerId);
      }
    });
    const offGameInvite = window.buzz.onGameInvite((e) => {
      // Open game window as acceptor (initiator=false) so recipient sees invite dialog
      void window.buzzWindows.openGame(e.fromPeerId, e.kind ?? 'checkers', false);
    });

    // Play goodbye when the buddy list window is closed directly (X button).
    // signOff() plays it before lock(), so we guard against a double-play.
    function handleBeforeUnload() {
      if (!logoutSoundPlayedRef.current) { logoutSoundPlayedRef.current = true; playSound('logout'); }
    }
    window.addEventListener('beforeunload', handleBeforeUnload);

    const offTheme = window.buzz.onThemeChanged((theme) => applyThemeAttributes(theme));

    return () => {
      off();
      offInvited();
      offRoomMembers();
      offDiscovered();
      offBuddyReq();
      offBuddyResolved();
      offUnread();
      offTalkInvite();
      offGameInvite();
      offTheme();
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  const grouped = useMemo(() => {
    const out: Record<string, Buddy[]> = {};
    for (const b of buddies) {
      const g = b.group || 'Buddies';
      (out[g] ||= []).push({ ...b, status: statuses[b.peerId] ?? 'offline' });
    }
    return out;
  }, [buddies, statuses]);

  async function addBuddy(): Promise<void> {
    setErr('');
    if (!code.trim() || !alias.trim()) return setErr('Code and alias are required.');
    try {
      await window.buzz.sendBuddyRequest({
        buddyCode: code.trim(),
        alias: alias.trim(),
        group: group.trim() || 'Buddies',
      });
      // Reflect the outbound pending request locally for visual feedback.
      const reqs = await window.buzz.listBuddyRequests();
      setRequests(reqs);
      setShowAdd(false);
      setCode('');
      setAlias('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed.');
    }
  }

  // Quick-add a discovered LAN peer using their advertised screen name (or a
  // truncated peer id if none was announced yet).
  async function addNearby(peer: DiscoveredPeer): Promise<void> {
    const fallbackAlias = peer.screenName || `${peer.peerId.slice(0, 8)}…`;
    try {
      await window.buzz.sendBuddyRequest({
        buddyCode: peer.peerId,
        alias: fallbackAlias,
        group: 'Buddies',
      });
      const reqs = await window.buzz.listBuddyRequests();
      setRequests(reqs);
    } catch {
      /* ignore — error surfaces via the Add Buddy modal flow if user retries */
    }
  }

  async function approveRequest(peerId: string): Promise<void> {
    await window.buzz.approveBuddyRequest(peerId);
    setRequests((prev) => prev.filter((r) => r.peerId !== peerId));
    await refreshBuddies();
  }

  async function denyRequest(peerId: string): Promise<void> {
    await window.buzz.denyBuddyRequest(peerId);
    setRequests((prev) => prev.filter((r) => r.peerId !== peerId));
  }

  async function cancelRequest(peerId: string): Promise<void> {
    await window.buzz.cancelBuddyRequest(peerId);
    setRequests((prev) => prev.filter((r) => r.peerId !== peerId));
  }

  async function openIm(peerId: string): Promise<void> {
    await window.buzzWindows.openIm(peerId);
  }

  async function signOff(): Promise<void> {
    if (signingOff) return;
    setSigningOff(true);
    logoutSoundPlayedRef.current = true;
    playSound('logout');
    try {
      await window.buzz.lock();
    } catch {
      setSigningOff(false);
      return;
    }
    window.close();
  }

  async function applyStatus(
    next: SelectableStatus,
    awayMessage?: string,
  ): Promise<void> {
    try {
      const sp = await window.buzz.setStatus({ status: next, awayMessage });
      setSelf(sp);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed.');
    }
  }

  async function openAwayModal(): Promise<void> {
    // Pre-fill with the saved away message from prefs.
    try {
      const prefs = await window.buzz.getPrefs();
      setAwayDraft(prefs.awayMessage || '');
    } catch {
      setAwayDraft('');
    }
    setShowAway(true);
  }

  async function commitAway(): Promise<void> {
    const msg = awayDraft.trim() || 'I am away from my computer right now.';
    setShowAway(false);
    await applyStatus('away', msg);
  }

  async function toggleSounds(): Promise<void> {
    const next = !soundsOn;
    setSoundsOn(next);
    setSoundsEnabled(next);
    try {
      await window.buzz.setPrefs({ soundsEnabled: next });
    } catch {
      /* best-effort */
    }
  }

  async function refreshBuddies(): Promise<void> {
    const fresh = await window.buzz.listBuddies();
    setBuddies(fresh);
  }

  function openCtx(e: React.MouseEvent, peerId: string): void {
    e.preventDefault();
    const menuW = 170; const menuH = 220;
    const x = Math.min(e.clientX, window.innerWidth - menuW);
    const y = Math.min(e.clientY, window.innerHeight - menuH);
    setCtx({ peerId, x, y });
  }

  async function ctxBlock(peerId: string, blocked: boolean): Promise<void> {
    setCtx(null);
    await window.buzz.blockBuddy(peerId, blocked);
    await refreshBuddies();
  }

  async function ctxWarn(peerId: string, delta: number): Promise<void> {
    setCtx(null);
    await window.buzz.warnBuddy(peerId, delta);
    await refreshBuddies();
  }

  async function ctxRemove(peerId: string): Promise<void> {
    setCtx(null);
    if (!confirm('Remove this buddy from your list?')) return;
    await window.buzz.removeBuddy(peerId);
    await refreshBuddies();
  }

  function openRoomCtx(e: React.MouseEvent, roomId: string): void {
    e.preventDefault();
    const menuW = 160; const menuH = 120;
    const x = Math.min(e.clientX, window.innerWidth - menuW);
    const y = Math.min(e.clientY, window.innerHeight - menuH);
    setRoomCtx({ roomId, x, y });
  }

  async function ctxLeaveRoom(roomId: string): Promise<void> {
    setRoomCtx(null);
    if (!confirm('Leave this chat room? It will be removed from your list.')) return;
    await window.buzz.leaveRoom({ roomId });
    setRooms((prev) => prev.filter((r) => r.id !== roomId));
  }

  function ctxOpenInviteRoom(roomId: string): void {
    setRoomCtx(null);
    const room = rooms.find((r) => r.id === roomId);
    if (!room) return;
    setRoomInvitePeerId('');
    setRoomCtxInvite({ roomId, roomName: room.name });
  }

  async function commitRoomInvite(): Promise<void> {
    if (!roomCtxInvite || !roomInvitePeerId) return;
    try {
      await window.buzz.inviteToRoom({ roomId: roomCtxInvite.roomId, peerId: roomInvitePeerId });
      setRoomCtxInvite(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to invite.');
    }
  }

  return (
    <div className="window">
      <WindowChrome
        title="Buzz — Buddy List"
      />

      {/* ── Self / status bar ─────────────────────────────────────────── */}
      <div className="bl-selfbar">
        <span className={`status ${self?.status ?? 'offline'}`} style={{ flexShrink: 0 }} />
        <span className="bl-screenname">{me?.screenName ?? '…'}</span>
        <select
          className="bl-status-select"
          value={self?.baseStatus ?? 'online'}
          onChange={(e) => {
            const v = e.target.value as SelectableStatus;
            if (v === 'away') void openAwayModal();
            else void applyStatus(v);
          }}
          title="Set status"
        >
          <option value="online">Available</option>
          <option value="away">Away…</option>
          <option value="invisible">Invisible</option>
        </select>
      </div>

      <div className="buddylist-split">
        <div className="bevel-in list buddylist-buddies">
          {requests.filter((r) => r.direction === 'in').length > 0 && (
            <div>
              <div className="group">
                Buddy Requests ({requests.filter((r) => r.direction === 'in').length})
              </div>
              {requests
                .filter((r) => r.direction === 'in')
                .map((r) => (
                  <div className="row request-row" key={`in-${r.peerId}`} title={r.peerId}>
                    <span className="status online" />
                    <span className="nearby-label">
                      {r.screenName || `${r.peerId.slice(0, 12)}…`}
                    </span>
                    <button
                      className="nearby-add request-approve"
                      title="Approve"
                      onClick={() => void approveRequest(r.peerId)}
                    >
                      ✓ Approve
                    </button>
                    <button
                      className="nearby-add request-deny"
                      title="Deny"
                      onClick={() => void denyRequest(r.peerId)}
                    >
                      ✕ Deny
                    </button>
                  </div>
                ))}
            </div>
          )}
          {nearby.filter((p) => !requests.some((r) => r.peerId === p.peerId)).length > 0 && (
            <div>
              <div className="group">
                Nearby (
                {nearby.filter((p) => !requests.some((r) => r.peerId === p.peerId)).length})
              </div>
              {nearby
                .filter((p) => !requests.some((r) => r.peerId === p.peerId))
                .map((p) => (
                  <div className="row nearby-row" key={p.peerId} title={p.peerId}>
                    <span className="status online" />
                    <span className="nearby-label">
                      {p.screenName || `${p.peerId.slice(0, 12)}…`}
                    </span>
                    <button
                      className="nearby-add"
                      title="Send buddy request"
                      onClick={() => void addNearby(p)}
                    >
                      + Add
                    </button>
                  </div>
                ))}
            </div>
          )}
          {requests.filter((r) => r.direction === 'out').length > 0 && (
            <div>
              <div className="group">
                Pending ({requests.filter((r) => r.direction === 'out').length})
              </div>
              {requests
                .filter((r) => r.direction === 'out')
                .map((r) => (
                  <div className="row pending-row" key={`out-${r.peerId}`} title={r.peerId}>
                    <span className="status offline" />
                    <span className="nearby-label">
                      {r.screenName || `${r.peerId.slice(0, 12)}…`}
                    </span>
                    <button
                      className="nearby-add request-deny"
                      title="Cancel request"
                      onClick={() => void cancelRequest(r.peerId)}
                    >
                      Cancel
                    </button>
                  </div>
                ))}
            </div>
          )}
          {Object.keys(grouped).length === 0 ? (
            <div className="row muted" style={{ padding: 10 }}>
              No buddies yet. Use the 👤+ button below to add one.
            </div>
          ) : (
            Object.entries(grouped).map(([g, arr]) => (
              <div key={g}>
                <div className="group">
                  {g} ({arr.filter((b) => b.status !== 'offline').length}/{arr.length})
                </div>
                {arr.map((b) => (
                  <div
                    className={`row${b.blocked ? ' blocked' : ''}`}
                    key={b.peerId}
                    onDoubleClick={() => openIm(b.peerId)}
                    onContextMenu={(e) => openCtx(e, b.peerId)}
                    title={
                      awayMessages[b.peerId]
                        ? `${b.peerId}\nAway: ${awayMessages[b.peerId]}`
                        : b.peerId
                    }
                  >
                    <span className={`status ${b.status}`} />
                    {b.alias}
                    {unread.peers[b.peerId] ? (
                      <span className="unread-badge" title="Unread messages">
                        {unread.peers[b.peerId]}
                      </span>
                    ) : null}
                    {b.warnLevel > 0 && (
                      <span className="warn-badge" title={`Warned ${b.warnLevel}%`}>
                        {b.warnLevel}%
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="buddylist-rooms">
          <div className="buddylist-rooms-header">
            <span>Chat Rooms</span>
            <button
              className="buddylist-rooms-new"
              title="New chat room"
              onClick={() => {
                setRoomName('');
                setRoomMembers(new Set());
                setShowRoom(true);
              }}
            >
              +
            </button>
          </div>
          <div className="bevel-in list buddylist-rooms-list">
            {rooms.length === 0 ? (
              <div className="row muted" style={{ padding: 8 }}>
                No chat rooms. Click <b>+</b> to create one.
              </div>
            ) : (
              rooms.map((r) => (
                <div
                  className="row"
                  key={r.id}
                  onDoubleClick={() => void window.buzzWindows.openChat(r.id)}
                  onContextMenu={(e) => openRoomCtx(e, r.id)}
                  title={`${r.members.length} member(s) — right-click for options`}
                >
                  <span className="room-glyph">#</span>
                  {r.name}
                  <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>
                    ({r.members.length})
                  </span>
                  {unread.rooms[r.id] ? (
                    <span className="unread-badge" title="Unread messages">
                      {unread.rooms[r.id]}
                    </span>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* ── Bottom action bar ─────────────────────────────────────────── */}
      <div className="bl-actionbar">
        <button className="bl-action-btn" title="Add Buddy" onClick={() => setShowAdd(true)}>
          👤+
        </button>
        <button className="bl-action-btn" title="My Info" onClick={() => setShowInfo(true)}>
          🪪
        </button>
        <button className="bl-action-btn" title="My Profile" onClick={() => setShowProfile(true)}>
          ✏️
        </button>
        <button
          className="bl-action-btn"
          title="Offline Mailbox"
          onClick={async () => {
            try {
              const s = await window.buzz.mailboxStats();
              setMailbox(s);
            } catch {
              setMailbox(null);
            }
            setRelayInput('');
            setShowMailbox(true);
          }}
        >
          📬
        </button>
        <button className="bl-action-btn" title="Toggle sounds" onClick={toggleSounds}>
          {soundsOn ? '🔊' : '🔇'}
        </button>
        <button
          className="bl-action-btn"
          title="Settings"
          onClick={() => void window.buzzWindows.openSettings()}
        >
          ⚙️
        </button>
        {isMesh && (
          <button
            className="bl-action-btn"
            title="Mesh Debug"
            onClick={() => void window.buzzWindows.openMeshDebug()}
          >
            📡
          </button>
        )}
        <span className="bl-actionbar-spacer" />
        <button className="bl-action-btn bl-signoff" title="Sign Off" onClick={signOff} disabled={signingOff}>
          Sign Off
        </button>
      </div>

      {showAdd && (
        <Modal title="Add Buddy" onClose={() => setShowAdd(false)}>
          <div className="row">
            <label className="label">Buddy Code</label>
            <input
              className="bevel-in"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="paste base58 PeerId"
            />
          </div>
          <div className="row">
            <label className="label">Display Name</label>
            <input
              className="bevel-in"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
            />
          </div>
          <div className="row">
            <label className="label">Group</label>
            <input
              className="bevel-in"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
            />
          </div>
          <div className="error">{err}</div>
          <div className="actions">
            <button onClick={addBuddy}>Add</button>
            <button onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </Modal>
      )}

      {showInfo && me && (
        <Modal title="My Info" onClose={() => setShowInfo(false)}>
          <div className="label">Screen Name</div>
          <div>{me.screenName}</div>
          <div className="label" style={{ marginTop: 8 }}>
            Buddy Code (share this so others can add you)
          </div>
          <div className="code">{me.buddyCode}</div>
          <div className="actions">
            <button onClick={() => navigator.clipboard.writeText(me.buddyCode)}>
              Copy Code
            </button>
            <button onClick={() => setShowInfo(false)}>Close</button>
          </div>
        </Modal>
      )}

      {showAway && (
        <Modal title="Away Message" onClose={() => setShowAway(false)}>
          <div className="label">Tell your buddies why you're away</div>
          <textarea
            className="bevel-in"
            rows={4}
            value={awayDraft}
            onChange={(e) => setAwayDraft(e.target.value)}
            placeholder="I am away from my computer right now."
          />
          <div className="actions">
            <button onClick={commitAway}>Set Away</button>
            <button onClick={() => setShowAway(false)}>Cancel</button>
          </div>
        </Modal>
      )}

      {showProfile && <ProfileEditor onClose={() => setShowProfile(false)} />}
      {viewProfile && (
        <ProfileViewer
          peerId={viewProfile.peerId}
          alias={viewProfile.alias}
          onClose={() => setViewProfile(null)}
        />
      )}

      {showRoom && (
        <Modal title="Create Chat Room" onClose={() => setShowRoom(false)}>
          <input
            placeholder="Room name"
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            maxLength={80}
          />
          <div style={{ fontSize: 11, opacity: 0.7 }}>Invite buddies:</div>
          <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid #ccc', padding: 4 }}>
            {buddies.length === 0 && <div style={{ fontSize: 11 }}>No buddies to invite.</div>}
            {buddies.map((b) => (
              <label key={b.peerId} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={roomMembers.has(b.peerId)}
                  onChange={(e) => {
                    setRoomMembers((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(b.peerId);
                      else next.delete(b.peerId);
                      return next;
                    });
                  }}
                />
                <span>{b.alias}</span>
              </label>
            ))}
          </div>
          {rooms.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 11, opacity: 0.7 }}>
              Tip: existing rooms are listed in the bottom panel — double-click to open.
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              disabled={!roomName.trim() || roomMembers.size === 0}
              onClick={async () => {
                try {
                  const r = await window.buzz.createRoom({
                    name: roomName.trim(),
                    members: Array.from(roomMembers),
                  });
                  setShowRoom(false);
                  setRooms((prev) => [...prev.filter((x) => x.id !== r.id), r]);
                  void window.buzzWindows.openChat(r.id);
                } catch (e) {
                  alert(String((e as Error).message ?? e));
                }
              }}
            >
              Create
            </button>
            <button onClick={() => setShowRoom(false)}>Cancel</button>
          </div>
        </Modal>
      )}

      {showMailbox && (
        <Modal title="Offline Mailbox" onClose={() => setShowMailbox(false)}>
          <p style={{ marginTop: 0 }}>
            Mailbox relays queue messages when buddies are offline. Add a peer
            (any other Buzz user, or a dedicated relay) you trust to hold
            sealed envelopes for you. Envelopes are anonymous and end-to-end
            encrypted to the recipient — relays cannot read them.
          </p>
          <div style={{ marginBottom: 8 }}>
            <strong>Configured relays</strong>
            {(!mailbox || mailbox.relays.length === 0) && (
              <div className="muted" style={{ marginTop: 4 }}>None.</div>
            )}
            {mailbox && mailbox.relays.length > 0 && (
              <ul style={{ margin: '4px 0', paddingLeft: 16 }}>
                {mailbox.relays.map((p) => (
                  <li key={p} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <code style={{ flex: 1, overflowWrap: 'anywhere' }}>{p}</code>
                    <span className="muted" style={{ fontSize: 11 }}>
                      {mailbox.lastPolledAt[p]
                        ? `polled ${new Date(mailbox.lastPolledAt[p]).toLocaleTimeString()}`
                        : 'never polled'}
                    </span>
                    <button
                      onClick={async () => {
                        try {
                          const s = await window.buzz.mailboxRemoveRelay({ peerId: p });
                          setMailbox(s);
                        } catch (e) {
                          alert(String((e as Error).message ?? e));
                        }
                      }}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <input
              type="text"
              value={relayInput}
              placeholder="Relay peer id (12D3Koo…)"
              onChange={(e) => setRelayInput(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              disabled={!relayInput.trim()}
              onClick={async () => {
                try {
                  const s = await window.buzz.mailboxAddRelay({ peerId: relayInput.trim() });
                  setMailbox(s);
                  setRelayInput('');
                } catch (e) {
                  alert(String((e as Error).message ?? e));
                }
              }}
            >
              Add
            </button>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="muted">
              {mailbox ? `${mailbox.relayHeldCount} envelope(s) we are holding for others` : ''}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={async () => {
                  try {
                    await window.buzz.mailboxPoll();
                    const s = await window.buzz.mailboxStats();
                    setMailbox(s);
                  } catch (e) {
                    alert(String((e as Error).message ?? e));
                  }
                }}
              >
                Poll Now
              </button>
              <button onClick={() => setShowMailbox(false)}>Close</button>
            </div>
          </div>
        </Modal>
      )}

      {/* showSettings modal removed — now a dedicated window */}

      {/* ── Room context menu ────────────────────────────────────────── */}
      {roomCtx && (() => {
        const room = rooms.find((r) => r.id === roomCtx.roomId);
        if (!room) return null;
        return (
          <>
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 999 }}
              onClick={() => setRoomCtx(null)}
              onContextMenu={(e) => { e.preventDefault(); setRoomCtx(null); }}
            />
            <div className="ctx-menu" style={{ left: roomCtx.x, top: roomCtx.y }}>
              <button onClick={() => { setRoomCtx(null); void window.buzzWindows.openChat(room.id); }}>Open</button>
              <button onClick={() => ctxOpenInviteRoom(room.id)}>Invite Buddy…</button>
              <div className="sep" />
              <button onClick={() => void ctxLeaveRoom(room.id)}>Leave Room</button>
            </div>
          </>
        );
      })()}

      {/* ── Invite-to-room picker ─────────────────────────────────────── */}
      {roomCtxInvite && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 999 }}
            onClick={() => setRoomCtxInvite(null)}
            onContextMenu={(e) => { e.preventDefault(); setRoomCtxInvite(null); }}
          />
          <div className="ctx-menu" style={{ minWidth: 200, padding: 8, zIndex: 1000 }}>
            <div style={{ fontWeight: 'bold', marginBottom: 6, fontSize: 11 }}>
              Invite to #{roomCtxInvite.roomName}
            </div>
            <select
              style={{ width: '100%', marginBottom: 6 }}
              value={roomInvitePeerId}
              onChange={(e) => setRoomInvitePeerId(e.target.value)}
              size={Math.min(buddies.length + 1, 8)}
            >
              <option value="">— select a buddy —</option>
              {buddies
                .filter((b) => !rooms.find((r) => r.id === roomCtxInvite.roomId)?.members.includes(b.peerId))
                .map((b) => (
                  <option key={b.peerId} value={b.peerId}>{b.alias}</option>
                ))}
            </select>
            <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
              <button onClick={() => setRoomCtxInvite(null)}>Cancel</button>
              <button disabled={!roomInvitePeerId} onClick={() => void commitRoomInvite()}>Invite</button>
            </div>
          </div>
        </>
      )}

      {ctx && (() => {
        const b = buddies.find((x) => x.peerId === ctx.peerId);
        if (!b) return null;
        return (
          <>
            {/* Click-away catcher. */}
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 999 }}
              onClick={() => setCtx(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtx(null);
              }}
            />
            <div className="ctx-menu" style={{ left: ctx.x, top: ctx.y }}>
              <button onClick={() => { setCtx(null); void openIm(b.peerId); }}>Send IM</button>
              <button onClick={() => { setCtx(null); setViewProfile({ peerId: b.peerId, alias: b.alias }); }}>Get Profile</button>
              <div className="sep" />
              <button onClick={() => void ctxWarn(b.peerId, 10)}>Warn (+10%)</button>
              {b.warnLevel > 0 && (
                <button onClick={() => void ctxWarn(b.peerId, -b.warnLevel)}>
                  Forgive ({b.warnLevel}% → 0%)
                </button>
              )}
              <div className="sep" />
              <button onClick={() => void ctxBlock(b.peerId, !b.blocked)}>
                {b.blocked ? 'Unblock' : 'Block'}
              </button>
              <button onClick={() => void ctxRemove(b.peerId)}>Remove…</button>
            </div>
          </>
        );
      })()}
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

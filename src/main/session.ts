// Session: holds the unlocked DB, libp2p node, and IM service. Locked by
// default; unlock() / create() bring it online.

import path from 'node:path';
import * as fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow } from 'electron';
import type { Libp2p } from 'libp2p';

import { Keystore, type IdentityMaterial } from './crypto/keystore.js';
import { openDb, type Db } from './db/open.js';
import * as repos from './db/repos.js';
import * as profiles from './profiles.js';
import { ImService, IM_PROTOCOL } from './p2p/im.js';
import { MailboxService } from './p2p/mailbox.js';
import { PresenceManager } from './p2p/presence.js';
import { RoomService } from './p2p/rooms.js';
import { XferService } from './p2p/xfer.js';
import { TalkService } from './p2p/talk.js';
import { buddyCodeFor, createNode } from './p2p/node.js';
import { loadNetworkConfig, peerIdFromMultiaddr } from './network.js';
import { IPC } from '@shared/ipc.js';
import type {
  ImAckEvent,
  ImReceivedEvent,
  BuddyStatusEvent,
  BuddyRequest,
  BuddyRequestEvent,
  BuddyRequestResolvedEvent,
  DiscoveredEvent,
  DiscoveredPeer,
  PeerProfile,
  RoomChannel,
  RoomChannelEvent,
  RoomInvitedEvent,
  RoomMembersEvent,
  RoomMessage,
  UnreadCounts,
  XferDoneEvent,
  XferOfferEvent,
  XferProgressEvent,
  TalkCallState,
  TalkEndedEvent,
  TalkAudioEvent,
} from '@shared/schemas.js';
import { sodium } from './crypto/keystore.js';

export type SessionState = 'locked' | 'unlocked';

export class Session {
  state: SessionState = 'locked';
  identity: IdentityMaterial | null = null;
  db: Db | null = null;
  node: Libp2p | null = null;
  im: ImService | null = null;
  presence: PresenceManager | null = null;
  xfer: XferService | null = null;
  rooms: RoomService | null = null;
  mailbox: MailboxService | null = null;
  talk: TalkService | null = null;
  // Single active voice call. MVP: at most one call at a time across the app.
  private currentCall: TalkCallState | null = null;
  // Decoded room keys keyed by roomId. Populated on bringUp from DB and on
  // accepted invites.
  private roomKeys = new Map<string, Uint8Array>();
  // In-memory cache of members per known room (mirror of room_members table).
  private roomMembers = new Map<string, string[]>();
  // Auto-discovered peers (LAN via mDNS) that speak the Buzz IM protocol and
  // aren't already in our buddy list. Cleared on lock.
  private discovered = new Map<string, DiscoveredPeer>();
  // Last broadcast status per peer so windows that open after the event can
  // catch up. Cleared on lock.
  private peerStatuses = new Map<string, BuddyStatusEvent>();
  private onPeerIdentify: ((evt: Event) => void) | null = null;
  screenName = '';
  // Active profile id (set on create/unlock, cleared on lock).
  profileId: string | null = null;

  constructor() {
    /* no-op; keystore is opened per-profile in create()/unlock() */
  }

  listProfiles(): profiles.ProfileSummary[] {
    return profiles.listProfiles();
  }

  // Wipe ALL local data — every profile (keystore + encrypted DB), the
  // plaintext profile index, and the network-mode config. Forces a lock
  // first so the open DB is closed cleanly. Used by the SignOn settings
  // "Reset all data" flow.
  async factoryReset(): Promise<void> {
    if (this.state === 'unlocked') {
      await this.lock();
    }
    profiles.wipeAll();
  }

  async create(
    screenName: string,
    passphrase: string,
  ): Promise<{ profileId: string; buddyCode: string }> {
    const profile = profiles.addProfile(screenName);
    try {
      const ks = new Keystore(path.join(profiles.profileDir(profile.id), 'keystore.bin'));
      const id = await ks.create(passphrase);
      await this.bringUp(id, profile.id, screenName);
      return { profileId: profile.id, buddyCode: this.buddyCode() };
    } catch (err) {
      // Roll back the half-created profile so the user can retry.
      profiles.removeProfile(profile.id);
      throw err;
    }
  }

  async unlock(
    profileId: string,
    passphrase: string,
  ): Promise<{ profileId: string; buddyCode: string }> {
    if (this.state === 'unlocked' && this.profileId === profileId) {
      return { profileId, buddyCode: this.buddyCode() };
    }
    if (this.state === 'unlocked') {
      // Switching profiles: tear down current session first.
      await this.lock();
    }
    const profile = profiles.getProfile(profileId);
    if (!profile) throw new Error('Profile not found');
    const ks = new Keystore(path.join(profiles.profileDir(profileId), 'keystore.bin'));
    const id = await ks.unlock(passphrase);
    await this.bringUp(id, profileId, '');
    // Sync the profile-index display name with the unlocked DB's identity
    // (handles migrated legacy installs where the index started as a placeholder).
    if (this.screenName && this.screenName !== profile.screenName) {
      profiles.updateProfile(profileId, { screenName: this.screenName });
    }
    return { profileId, buddyCode: this.buddyCode() };
  }

  async lock(): Promise<void> {
    if (this.presence) {
      try {
        await this.presence.stop();
      } catch {
        /* ignore */
      }
    }
    if (this.xfer) {
      try {
        await this.xfer.stop();
      } catch {
        /* ignore */
      }
    }
    if (this.talk) {
      try {
        // Best-effort bye to peer for any active call.
        if (this.currentCall) {
          await this.talk
            .send(this.currentCall.peerId, { type: 'bye', callId: this.currentCall.callId })
            .catch(() => undefined);
        }
        await this.talk.stop();
      } catch {
        /* ignore */
      }
    }
    if (this.im) {
      try {
        await this.im.stop();
      } catch {
        /* ignore */
      }
    }
    if (this.node) {
      try {
        if (this.onPeerIdentify) {
          this.node.removeEventListener('peer:identify', this.onPeerIdentify);
          this.onPeerIdentify = null;
        }
        await this.node.stop();
      } catch {
        /* ignore */
      }
    }
    if (this.db) this.db.close();
    this.identity = null;
    this.db = null;
    this.node = null;
    this.im = null;
    this.presence = null;
    this.xfer = null;
    this.rooms = null;
    if (this.mailbox) await this.mailbox.stop().catch(() => undefined);
    this.mailbox = null;
    this.talk = null;
    this.currentCall = null;
    this.roomKeys.clear();
    this.roomMembers.clear();
    this.discovered.clear();
    this.peerStatuses.clear();
    this.profileId = null;
    this.state = 'locked';
  }

  buddyCode(): string {
    if (!this.node) throw new Error('Locked');
    return buddyCodeFor(this.node.peerId);
  }

  peerIdStr(): string {
    if (!this.node) throw new Error('Locked');
    return this.node.peerId.toString();
  }

  private async bringUp(
    id: IdentityMaterial,
    profileId: string,
    screenNameIfNew: string,
  ): Promise<void> {
    this.identity = id;
    this.profileId = profileId;
    const dbFile = path.join(profiles.profileDir(profileId), 'buzz.sqlite');
    this.db = openDb(dbFile, id.dbKey);

    // Establish identity row in DB.
    const network = loadNetworkConfig();
    const node = await createNode({ identity: id, network });
    this.node = node;
    const peerIdStr = node.peerId.toString();
    const existing = repos.getIdentity(this.db);
    if (existing) {
      this.screenName = existing.screenName;
    } else {
      const sn = screenNameIfNew || 'Buddy';
      this.screenName = sn;
      repos.setIdentity(this.db, peerIdStr, sn);
    }
    if (screenNameIfNew && existing) {
      // honour rename via create flow when keystore was fresh
      this.screenName = screenNameIfNew;
      repos.setIdentity(this.db, peerIdStr, screenNameIfNew);
    }

    // In server mode, ensure the configured server's PeerId is registered as
    // a mailbox relay so offline-message push/poll uses it transparently. The
    // user can still add/remove other relays from prefs.
    if (network.mode === 'server' && network.serverAddr) {
      const relayPid = peerIdFromMultiaddr(network.serverAddr);
      if (relayPid) {
        const prefs = repos.getPrefs(this.db);
        if (!prefs.mailboxRelays.includes(relayPid)) {
          const next = [...prefs.mailboxRelays, relayPid].slice(0, 8);
          repos.setPrefs(this.db, { mailboxRelays: next });
        }
      }
    }

    this.im = new ImService(
      node,
      {
        onMessage: (peer, m) => this.handleIncoming(peer, m),
        onAck: (peer, msgId, status) => this.handleAck(peer, msgId, status),
        onTyping: (peer, typing) => this.broadcast(IPC.EvtTyping, { peerId: peer, typing }),
        onProfile: (peer, p) => {
          const ev: BuddyStatusEvent = {
            peerId: peer,
            status: (p.status as BuddyStatusEvent['status']) ?? 'online',
            awayMessage: p.awayMessage,
          };
          this.peerStatuses.set(peer, ev);
          this.broadcast(IPC.EvtBuddyStatus, ev);
          // Cache the custom profile fields when present so the IM window
          // can show a 'View Profile' pane styled to the buddy's choices.
          const hasCustom =
            !!p.aboutText ||
            !!p.textColor ||
            !!p.bgColor ||
            !!p.fontFamily ||
            !!p.avatar ||
            !!p.bgImage;
          if (this.db) {
            const cached: PeerProfile = {
              peerId: peer,
              screenName: p.screenName ?? '',
              aboutText: p.aboutText ?? '',
              textColor: p.textColor ?? '',
              bgColor: p.bgColor ?? '',
              fontFamily: p.fontFamily ?? '',
              avatarDataUrl: p.avatar ?? '',
              bgImageDataUrl: p.bgImage ?? '',
              lastSeen: Date.now(),
            };
            // Only write if any field is meaningful — avoids stomping a richer
            // cached profile when the peer sends a bare presence-only update.
            if (hasCustom || p.screenName) {
              repos.upsertPeerProfile(this.db, cached);
              this.broadcast(IPC.EvtPeerProfile, cached);
            }
          }
          // If this peer is currently in our auto-discovered list, enrich it
          // with the screen name they just announced.
          if (p.screenName) {
            const d = this.discovered.get(peer);
            if (d && d.screenName !== p.screenName) {
              const updated: DiscoveredPeer = { ...d, screenName: p.screenName, lastSeen: Date.now() };
              this.discovered.set(peer, updated);
              this.broadcast(IPC.EvtDiscovered, {
                kind: 'added',
                peer: updated,
              } satisfies DiscoveredEvent);
            }
          }
        },
        onRoomInvite: (peer, p) => this.rooms?.handleInvite(peer, p),
        onRoomMsg: (peer, p) => this.rooms?.handleMsg(peer, p),
        onRoomLeave: (peer, roomId) => this.rooms?.handleLeave(peer, roomId),
        onRoomMeta: (peer, p) => this.rooms?.handleMeta(peer, p),
        onRoomChannelAdd: (peer, p) => this.rooms?.handleChannelAdd(peer, p),
        onRoomChannelDel: (peer, p) => this.rooms?.handleChannelDel(peer, p),
        onBuddyReq: (peer, p) => this.handleBuddyReq(peer, p),
        onBuddyResp: (peer, p) => this.handleBuddyResp(peer, p),
      },
      (peerId) => (this.db ? repos.isBlocked(this.db, peerId) : false),
    );
    await this.im.start();

    // File transfer service (separate libp2p protocol).
    this.xfer = new XferService(
      node,
      {
        onOffer: (o) => {
          if (!this.db) return;
          // Persist a pending row so it shows in history even if declined.
          repos.insertTransfer(this.db, {
            id: o.id,
            peerId: o.peerId,
            direction: 'in',
            fileName: o.fileName,
            fileSize: o.fileSize,
            fileHash: o.hash,
            status: 'pending',
            savedPath: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          const ev: XferOfferEvent = {
            id: o.id,
            peerId: o.peerId,
            fileName: o.fileName,
            fileSize: o.fileSize,
            hash: o.hash,
          };
          this.broadcast(IPC.EvtXferOffered, ev);
        },
        onProgress: (id, peerId, direction, bytes, total) => {
          const ev: XferProgressEvent = { id, peerId, direction, bytes, total };
          this.broadcast(IPC.EvtXferProgress, ev);
        },
        onDone: (id, peerId, direction, fileName, ok, error, savedPath) => {
          if (this.db) {
            const status = ok ? 'complete' : error === 'declined' ? 'declined' : 'failed';
            repos.updateTransferStatus(this.db, id, status, savedPath ?? null);
          }
          const ev: XferDoneEvent = { id, peerId, direction, fileName, ok, error, savedPath };
          this.broadcast(IPC.EvtXferDone, ev);
        },
      },
      (peerId) => (this.db ? repos.isBlocked(this.db, peerId) : false),
      fsp,
    );
    await this.xfer.start();

    // Voice talk service. Frames flow through dedicated /buzz/talk/1.0.0
    // streams; we keep call state on the session so window-mount queries
    // (`getActiveCall`) can return current call info.
    this.talk = new TalkService(
      node,
      {
        onInvite: (peerId, callId, screenName, ts) => this.handleTalkInvite(peerId, callId, screenName, ts),
        onAccept: (peerId, callId) => this.handleTalkAccept(peerId, callId),
        onReject: (peerId, callId, reason) => this.handleTalkReject(peerId, callId, reason),
        onBye: (peerId, callId) => this.handleTalkBye(peerId, callId),
        onAudio: (peerId, callId, seq, data) => this.handleTalkAudio(peerId, callId, seq, data),
      },
      (peerId) => (this.db ? repos.isBlocked(this.db, peerId) : false),
    );
    await this.talk.start();

    await node.start();

    // Auto-discovery: when a peer identifies and advertises our IM protocol,
    // surface them in the BuddyList "Nearby" section (provided they aren't
    // already a buddy and aren't us). LAN peers come in via mDNS; bootstrap
    // peers won't speak our protocol so they're filtered out automatically.
    this.onPeerIdentify = (evt: Event) => {
      const detail = (evt as CustomEvent<{ peerId: { toString(): string }; protocols: string[] }>)
        .detail;
      try {
        if (!detail || !Array.isArray(detail.protocols)) return;
        if (!detail.protocols.includes(IM_PROTOCOL)) return;
        const pid = detail.peerId.toString();
        if (pid === node.peerId.toString()) return;
        if (!this.db) return;
        const isBuddy = !!this.db
          .prepare('SELECT 1 FROM buddies WHERE peer_id=?')
          .get(pid);
        if (isBuddy) return;
        const prev = this.discovered.get(pid);
        const peer: DiscoveredPeer = {
          peerId: pid,
          screenName: prev?.screenName,
          source: 'mdns',
          lastSeen: Date.now(),
        };
        this.discovered.set(pid, peer);
        if (!prev) {
          this.broadcast(IPC.EvtDiscovered, {
            kind: 'added',
            peer,
          } satisfies DiscoveredEvent);
        }
      } catch {
        /* ignore */
      }
    };
    node.addEventListener('peer:identify', this.onPeerIdentify);

    // Presence after node is up so peer:connect events flow.
    const db = this.db;
    this.presence = new PresenceManager(
      node,
      this.im,
      () => this.screenName,
      {
        getIdleMinutes: () => repos.getPrefs(db).idleMinutes,
        getAwayMessage: () => repos.getPrefs(db).awayMessage,
        getLastStatus: () => repos.getPrefs(db).lastStatus,
        setLastStatus: (s) => {
          repos.setPrefs(db, { lastStatus: s });
        },
        getProfile: () => repos.getPrefs(db).profile,
      },
      (peerId, status, awayMessage) => {
        const ev: BuddyStatusEvent = { peerId, status, awayMessage };
        this.peerStatuses.set(peerId, ev);
        this.broadcast(IPC.EvtBuddyStatus, ev);
      },
    );
    this.presence.start();

    // Multi-party chat rooms. Decode all known room keys into RAM so the
    // RoomBridge can return them synchronously when encrypting/decrypting.
    const s = await sodium();
    for (const r of repos.listRooms(this.db)) {
      try {
        this.roomKeys.set(r.id, s.from_base64(r.keyB64, s.base64_variants.ORIGINAL));
        this.roomMembers.set(r.id, r.members);
      } catch {
        // Corrupt key — skip.
      }
    }
    this.rooms = new RoomService(
      this.im,
      {
        onInvite: (fromPeerId, p) => {
          if (!this.db) return;
          // Persist room + key + roster, cache the key, and notify renderers.
          repos.upsertRoom(this.db, {
            id: p.roomId,
            name: p.name,
            keyB64: p.keyB64,
            createdAt: p.ts,
          });
          repos.setRoomMembers(this.db, p.roomId, p.members);
          try {
            this.roomKeys.set(p.roomId, s.from_base64(p.keyB64, s.base64_variants.ORIGINAL));
          } catch {
            return;
          }
          this.roomMembers.set(p.roomId, [...p.members]);
          // Apply the channel snapshot from the inviter so we share the same
          // channel ids (avoids divergent default-channel UUIDs that would
          // produce ghost "channel" placeholders on first message).
          if (p.channels && p.channels.length > 0) {
            for (const ch of p.channels) {
              repos.upsertRoomChannel(this.db, {
                id: ch.id,
                roomId: p.roomId,
                name: ch.name,
                isDefault: ch.isDefault,
                createdAt: ch.createdAt,
              });
            }
            // Clean up any pre-existing placeholder default that was created
            // before this fix landed (different id, same room).
            const desiredDefault = p.channels.find((c) => c.isDefault);
            if (desiredDefault) {
              const all = repos.listRoomChannels(this.db, p.roomId);
              for (const c of all) {
                if (c.id !== desiredDefault.id && (c.isDefault || c.name === 'channel')) {
                  // Reattribute its messages to the real default and drop it.
                  this.db
                    .prepare(
                      'UPDATE room_messages SET channel_id=? WHERE channel_id=?',
                    )
                    .run(desiredDefault.id, c.id);
                  repos.deleteRoomChannel(this.db, c.id);
                  this.broadcast(IPC.EvtRoomChannel, {
                    kind: 'removed',
                    channel: c,
                  } satisfies RoomChannelEvent);
                }
              }
            }
          } else if (!repos.getDefaultChannelId(this.db, p.roomId)) {
            // Legacy peer (pre-channels) — fall back to a local default.
            const ch: RoomChannel = {
              id: randomUUID(),
              roomId: p.roomId,
              name: 'general',
              isDefault: true,
              createdAt: p.ts,
            };
            repos.upsertRoomChannel(this.db, ch);
          }
          const ev: RoomInvitedEvent = {
            roomId: p.roomId,
            name: p.name,
            fromPeerId,
            members: p.members,
          };
          this.broadcast(IPC.EvtRoomInvited, ev);
        },
        onMessage: (fromPeerId, m) => {
          if (!this.db) return;
          // If the peer references a channel we don't know about (or sends
          // legacy frames without channelId), route it to our local default
          // channel rather than creating a ghost placeholder — the channel
          // will materialize properly when its `room-channel-add` arrives.
          let channelId = m.channelId;
          if (!channelId || !repos.getRoomChannel(this.db, channelId)) {
            channelId = repos.getDefaultChannelId(this.db, m.roomId) ?? '';
          }
          const stored: RoomMessage = {
            id: m.id,
            roomId: m.roomId,
            channelId,
            fromPeerId,
            fromName: m.fromName,
            direction: 'in',
            ts: m.ts,
            body: m.body,
          };
          repos.insertRoomMessage(this.db, stored);
          this.broadcast(IPC.EvtRoomMessage, stored);
          this.broadcastUnread();
        },
        onMembers: (roomId, members, name) => {
          if (!this.db) return;
          repos.setRoomMembers(this.db, roomId, members);
          this.roomMembers.set(roomId, [...members]);
          if (name) {
            const cur = repos.getRoom(this.db, roomId);
            if (cur && cur.name !== name) {
              repos.upsertRoom(this.db, {
                id: cur.id,
                name,
                keyB64: cur.keyB64,
                createdAt: cur.createdAt,
              });
            }
          }
          const ev: RoomMembersEvent = { roomId, members };
          this.broadcast(IPC.EvtRoomMembers, ev);
        },
        onLeave: (fromPeerId, roomId) => {
          if (!this.db) return;
          repos.removeRoomMember(this.db, roomId, fromPeerId);
          const members = repos.getRoomMembers(this.db, roomId);
          this.roomMembers.set(roomId, members);
          const ev: RoomMembersEvent = { roomId, members };
          this.broadcast(IPC.EvtRoomMembers, ev);
        },
        onChannelAdd: (_fromPeerId, p) => {
          if (!this.db) return;
          // Only honor channel ops for rooms we know about.
          if (!repos.getRoom(this.db, p.roomId)) return;
          const existing = repos.getRoomChannel(this.db, p.channelId);
          const ch: RoomChannel = {
            id: p.channelId,
            roomId: p.roomId,
            name: p.name,
            isDefault: existing?.isDefault ?? false,
            createdAt: existing?.createdAt ?? p.ts,
          };
          repos.upsertRoomChannel(this.db, ch);
          this.broadcast(IPC.EvtRoomChannel, {
            kind: 'added',
            channel: ch,
          } satisfies RoomChannelEvent);
        },
        onChannelDel: (_fromPeerId, p) => {
          if (!this.db) return;
          const existing = repos.getRoomChannel(this.db, p.channelId);
          if (!existing) return;
          // Refuse to delete the default channel.
          if (existing.isDefault) return;
          repos.deleteRoomChannel(this.db, p.channelId);
          this.broadcast(IPC.EvtRoomChannel, {
            kind: 'removed',
            channel: existing,
          } satisfies RoomChannelEvent);
        },
      },
      {
        getRoomKey: (id) => this.roomKeys.get(id) ?? null,
        getRoomMembers: (id) => this.roomMembers.get(id) ?? (this.db ? repos.getRoomMembers(this.db, id) : []),
        myPeerId: () => this.peerIdStr(),
        myScreenName: () => this.screenName,
      },
    );

    // Offline mailbox relay. Acts as both a server (queues envelopes addressed
    // to other peers and serves them on fetch) and a client (pushes our
    // outgoing messages to relays when direct delivery fails, and polls
    // relays for envelopes addressed to us).
    this.mailbox = new MailboxService(
      node,
      this.db,
      {
        identity: id,
        deliver: (m) => this.deliverMailboxMessage(m),
      },
      () => (this.db ? repos.getPrefs(this.db).mailboxRelays : []),
    );
    await this.mailbox.start();
    // Best-effort initial poll. Don't block bringUp on it — relays may be
    // unreachable; the periodic timer will retry.
    void this.mailbox.pollAll().catch(() => undefined);

    this.state = 'unlocked';
  }

  // Deliver a sealed-and-verified mailbox envelope as if it had arrived live.
  // Returns true if accepted (caller acks the relay); false if dropped.
  private async deliverMailboxMessage(m: {
    id: string;
    ts: number;
    body: string;
    fromPeerId: string;
  }): Promise<boolean> {
    if (!this.db || !this.im) return false;
    if (repos.isBlocked(this.db, m.fromPeerId)) return true; // drop silently but ack
    // De-dupe against existing local history (mailbox + retried sends).
    const existing = this.db
      .prepare('SELECT 1 FROM messages WHERE id=?')
      .get(m.id) as { '1'?: number } | undefined;
    if (existing) return true;
    const msg: ImReceivedEvent = {
      id: m.id,
      peerId: m.fromPeerId,
      direction: 'in',
      ts: m.ts,
      body: m.body,
      status: 'delivered',
    };
    repos.insertMessage(this.db, msg);
    this.broadcast(IPC.EvtImReceived, msg);
    this.broadcast(IPC.EvtMailboxDelivered, { peerId: m.fromPeerId, count: 1 });
    this.broadcastUnread();
    return true;
  }

  // Helpers used by IPC handlers to manipulate the in-memory key/member caches
  // when a local user creates or destroys a room.
  cacheRoomKey(roomId: string, key: Uint8Array): void {
    this.roomKeys.set(roomId, key);
  }
  cacheRoomMembers(roomId: string, members: string[]): void {
    this.roomMembers.set(roomId, [...members]);
  }
  forgetRoom(roomId: string): void {
    this.roomKeys.delete(roomId);
    this.roomMembers.delete(roomId);
  }

  // Auto-discovered peers (LAN). Filtered for non-buddy on insert; we also
  // filter again here in case a buddy was added between events.
  listDiscovered(): DiscoveredPeer[] {
    if (!this.db) return [];
    const out: DiscoveredPeer[] = [];
    for (const peer of this.discovered.values()) {
      const isBuddy = !!this.db
        .prepare('SELECT 1 FROM buddies WHERE peer_id=?')
        .get(peer.peerId);
      if (!isBuddy) out.push(peer);
    }
    return out.sort((a, b) => b.lastSeen - a.lastSeen);
  }

  forgetDiscovered(peerId: string): void {
    const peer = this.discovered.get(peerId);
    if (!peer) return;
    this.discovered.delete(peerId);
    this.broadcast(IPC.EvtDiscovered, {
      kind: 'removed',
      peer,
    } satisfies DiscoveredEvent);
  }

  getPeerStatus(peerId: string): BuddyStatusEvent | null {
    return this.peerStatuses.get(peerId) ?? null;
  }

  // Buddy add request operations (initiator side) ──────────────────────────
  async sendBuddyRequest(
    peerId: string,
    alias: string,
    _group: string,
  ): Promise<void> {
    if (!this.db || !this.im) throw new Error('Locked');
    if (this.db.prepare('SELECT 1 FROM buddies WHERE peer_id=?').get(peerId)) {
      return; // already a buddy
    }
    const ts = Date.now();
    repos.upsertBuddyRequest(this.db, {
      peerId,
      direction: 'out',
      screenName: alias,
      ts,
    });
    // Best-effort send; if the peer is offline we'll retry next time the
    // user clicks "Add" (the local pending row is the source of truth).
    try {
      await this.im.send(peerId, {
        type: 'buddy-req',
        screenName: this.screenName,
        ts,
      });
    } catch {
      // swallow — peer may be offline
    }
  }

  approveBuddyRequest(peerId: string): void {
    if (!this.db) throw new Error('Locked');
    const req = repos.getBuddyRequest(this.db, peerId);
    if (!req || req.direction !== 'in') return;
    const alias = req.screenName?.trim() || `${peerId.slice(0, 8)}…`;
    repos.addBuddy(this.db, peerId, alias, 'Buddies');
    repos.deleteBuddyRequest(this.db, peerId);
    this.forgetDiscovered(peerId);
    void this.im
      ?.send(peerId, { type: 'buddy-resp', accepted: true, screenName: this.screenName })
      .catch(() => {});
    this.broadcast(IPC.EvtBuddyRequestResolved, {
      peerId,
      accepted: true,
    } satisfies BuddyRequestResolvedEvent);
  }

  denyBuddyRequest(peerId: string): void {
    if (!this.db) throw new Error('Locked');
    const req = repos.getBuddyRequest(this.db, peerId);
    if (!req || req.direction !== 'in') return;
    repos.deleteBuddyRequest(this.db, peerId);
    void this.im
      ?.send(peerId, { type: 'buddy-resp', accepted: false })
      .catch(() => {});
    this.broadcast(IPC.EvtBuddyRequestResolved, {
      peerId,
      accepted: false,
    } satisfies BuddyRequestResolvedEvent);
  }

  private handleIncoming(peerId: string, m: { id: string; ts: number; body: string }): void {
    if (!this.db || !this.im) return;
    if (repos.isBlocked(this.db, peerId)) return;

    const msg: ImReceivedEvent = {
      id: m.id,
      peerId,
      direction: 'in',
      ts: m.ts,
      body: m.body,
      status: 'delivered',
    };
    repos.insertMessage(this.db, msg);
    this.broadcast(IPC.EvtImReceived, msg);
    this.broadcastUnread();

    void this.im.send(peerId, { type: 'ack', id: m.id, status: 'delivered' }).catch(() => {});
  }

  private handleAck(peerId: string, id: string, status: 'delivered' | 'read' | 'failed'): void {
    if (!this.db) return;
    repos.setMessageStatus(this.db, id, status);
    const ev: ImAckEvent = { id, status };
    this.broadcast(IPC.EvtImAck, ev);
  }

  // Buddy add request flow ─────────────────────────────────────────────────
  private handleBuddyReq(
    peerId: string,
    p: { screenName: string; ts: number },
  ): void {
    if (!this.db) return;
    if (repos.isBlocked(this.db, peerId)) return;
    // If we're already buddies, treat the request as an instant approval so
    // the remote side flips out of pending.
    const alreadyBuddy = !!this.db
      .prepare('SELECT 1 FROM buddies WHERE peer_id=?')
      .get(peerId);
    if (alreadyBuddy) {
      void this.im
        ?.send(peerId, { type: 'buddy-resp', accepted: true, screenName: this.screenName })
        .catch(() => {});
      return;
    }
    const req: BuddyRequest = {
      peerId,
      direction: 'in',
      screenName: p.screenName ?? '',
      ts: p.ts ?? Date.now(),
    };
    repos.upsertBuddyRequest(this.db, req);
    this.broadcast(IPC.EvtBuddyRequest, {
      kind: 'incoming',
      request: req,
    } satisfies BuddyRequestEvent);
  }

  private handleBuddyResp(
    peerId: string,
    p: { accepted: boolean; screenName?: string },
  ): void {
    if (!this.db) return;
    const req = repos.getBuddyRequest(this.db, peerId);
    // Only outbound (we sent) requests should ever resolve via a response.
    if (req && req.direction !== 'out') return;
    repos.deleteBuddyRequest(this.db, peerId);
    if (p.accepted) {
      // Prefer the alias we picked locally when sending the request; fall
      // back to the screen name the remote announced; finally a short id.
      const alias =
        req?.screenName?.trim() ||
        p.screenName?.trim() ||
        `${peerId.slice(0, 8)}…`;
      repos.addBuddy(this.db, peerId, alias, 'Buddies');
      // Drop them out of the "Nearby" list now that they're a buddy.
      this.forgetDiscovered(peerId);
    }
    const ev: BuddyRequestResolvedEvent = { peerId, accepted: p.accepted };
    this.broadcast(IPC.EvtBuddyRequestResolved, ev);
  }

  // Unread broadcast ───────────────────────────────────────────────────────
  unreadSnapshot(): UnreadCounts {
    if (!this.db) return { peers: {}, rooms: {} };
    return {
      peers: repos.unreadImCounts(this.db),
      rooms: repos.unreadRoomCounts(this.db, this.peerIdStr()),
    };
  }

  broadcastUnread(): void {
    this.broadcast(IPC.EvtUnread, this.unreadSnapshot());
  }

  // ── Voice talk ────────────────────────────────────────────────────────────

  getActiveCall(peerId: string): TalkCallState | null {
    if (!this.currentCall) return null;
    if (this.currentCall.peerId !== peerId) return null;
    if (this.currentCall.state === 'ended') return null;
    return this.currentCall;
  }

  async startCall(peerId: string): Promise<TalkCallState> {
    if (!this.talk) throw new Error('Locked');
    if (this.currentCall && this.currentCall.state !== 'ended') {
      throw new Error('Another call is already active');
    }
    const callId = randomUUID();
    const ts = Date.now();
    const state: TalkCallState = {
      callId,
      peerId,
      role: 'caller',
      state: 'inviting',
      screenName: this.screenName,
      startedAt: ts,
    };
    this.currentCall = state;
    this.broadcast(IPC.EvtTalkState, state);
    try {
      await this.talk.send(peerId, { type: 'invite', callId, screenName: this.screenName, ts });
    } catch (err) {
      this.endCallLocal(callId, 'unreachable');
      throw err;
    }
    return state;
  }

  async acceptCall(callId: string): Promise<void> {
    if (!this.talk || !this.currentCall) return;
    if (this.currentCall.callId !== callId) return;
    if (this.currentCall.role !== 'callee') return;
    const peerId = this.currentCall.peerId;
    await this.talk.send(peerId, { type: 'accept', callId }).catch(() => undefined);
    this.currentCall = { ...this.currentCall, state: 'active', startedAt: Date.now() };
    this.broadcast(IPC.EvtTalkState, this.currentCall);
  }

  async rejectCall(callId: string, reason?: string): Promise<void> {
    if (!this.talk || !this.currentCall) return;
    if (this.currentCall.callId !== callId) return;
    const peerId = this.currentCall.peerId;
    await this.talk.send(peerId, { type: 'reject', callId, reason }).catch(() => undefined);
    this.endCallLocal(callId, reason ?? 'rejected');
  }

  async endCall(callId: string): Promise<void> {
    if (!this.talk || !this.currentCall) return;
    if (this.currentCall.callId !== callId) return;
    const peerId = this.currentCall.peerId;
    await this.talk.send(peerId, { type: 'bye', callId }).catch(() => undefined);
    this.endCallLocal(callId, 'ended');
  }

  async sendCallAudio(callId: string, data: Uint8Array): Promise<void> {
    if (!this.talk || !this.currentCall) return;
    if (this.currentCall.callId !== callId) return;
    if (this.currentCall.state !== 'active') return;
    const peerId = this.currentCall.peerId;
    // eslint-disable-next-line no-console
    console.debug('[talk] tx->peer', peerId.slice(0, 8), data.byteLength);
    // We don't bother numbering on the main side; renderer-side seq is fine.
    await this.talk.send(peerId, { type: 'audio', callId, seq: 0, data }).catch((err) => {
      console.warn('[talk] tx send failed', err);
    });
  }

  private endCallLocal(callId: string, reason?: string): void {
    if (!this.currentCall || this.currentCall.callId !== callId) return;
    const peerId = this.currentCall.peerId;
    this.currentCall = { ...this.currentCall, state: 'ended' };
    this.broadcast(IPC.EvtTalkState, this.currentCall);
    const ev: TalkEndedEvent = { callId, peerId, reason };
    this.broadcast(IPC.EvtTalkEnded, ev);
    // Clear cached call after a tick so renderers can settle.
    setTimeout(() => {
      if (this.currentCall && this.currentCall.callId === callId) this.currentCall = null;
    }, 50);
  }

  private handleTalkInvite(peerId: string, callId: string, screenName: string, _ts: number): void {
    if (!this.talk) return;
    // Reject if already in another call.
    if (this.currentCall && this.currentCall.state !== 'ended') {
      void this.talk.send(peerId, { type: 'reject', callId, reason: 'busy' }).catch(() => undefined);
      return;
    }
    const state: TalkCallState = {
      callId,
      peerId,
      role: 'callee',
      state: 'ringing',
      screenName,
      startedAt: Date.now(),
    };
    this.currentCall = state;
    this.broadcast(IPC.EvtTalkInvite, state);
    this.broadcast(IPC.EvtTalkState, state);
  }

  private handleTalkAccept(peerId: string, callId: string): void {
    if (!this.currentCall || this.currentCall.callId !== callId) return;
    if (this.currentCall.peerId !== peerId) return;
    this.currentCall = { ...this.currentCall, state: 'active', startedAt: Date.now() };
    this.broadcast(IPC.EvtTalkState, this.currentCall);
  }

  private handleTalkReject(peerId: string, callId: string, reason?: string): void {
    if (!this.currentCall || this.currentCall.callId !== callId) return;
    if (this.currentCall.peerId !== peerId) return;
    this.endCallLocal(callId, reason ?? 'rejected');
  }

  private handleTalkBye(peerId: string, callId: string): void {
    if (!this.currentCall || this.currentCall.callId !== callId) return;
    if (this.currentCall.peerId !== peerId) return;
    this.endCallLocal(callId, 'remote-ended');
  }

  private handleTalkAudio(peerId: string, callId: string, seq: number, data: Uint8Array): void {
    if (!this.currentCall || this.currentCall.callId !== callId) return;
    if (this.currentCall.peerId !== peerId) return;
    if (this.currentCall.state !== 'active') return;
    // eslint-disable-next-line no-console
    console.debug('[talk] rx<-peer', peerId.slice(0, 8), data.byteLength);
    // Copy into a fresh ArrayBuffer-backed Uint8Array so it satisfies the
    // TalkAudioEvent schema (and to detach from the libp2p stream buffer).
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const ev: TalkAudioEvent = { callId, peerId, seq, data: copy };
    this.broadcast(IPC.EvtTalkAudio, ev);
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  }
}

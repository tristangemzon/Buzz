// Session: holds the unlocked DB, libp2p node, and IM service. Locked by
// default; unlock() / create() bring it online.

import path from 'node:path';
import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { BrowserWindow, app } from 'electron';
import type { Libp2p } from 'libp2p';

import { Keystore, type IdentityMaterial } from './crypto/keystore.js';
import { openDb, openDbLegacy, type Db } from './db/open.js';
import * as repos from './db/repos.js';
import * as profiles from './profiles.js';
import { ImService, IM_PROTOCOL } from './p2p/im.js';
import { MailboxService } from './p2p/mailbox.js';
import { PresenceManager } from './p2p/presence.js';
import { RoomService } from './p2p/rooms.js';
import { XferService } from './p2p/xfer.js';
import { TalkService } from './p2p/talk.js';
import { buddyCodeFor, createNode, MESH_LIBP2P_PORT } from './p2p/node.js';
import { MeshNode } from './p2p/mesh.js';
import { loadNetworkConfig, peerIdFromMultiaddr } from './network.js';
import { HiveClient, type HiveCallbacks } from './p2p/hive-client.js';
import { notifyIm, setNotificationsEnabled } from './notify.js';
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
  RoomCategoryEvent,
  RoomChannelEvent,
  RoomInvitedEvent,
  RoomKickEvent,
  RoomMembersEvent,
  RoomMessage,
  RoomPinEvent,
  RoomRoleEvent,
  RoomVoicePresenceEvent,
  RoomVoiceAudioEvent,
  UnreadCounts,
  XferDoneEvent,
  XferOfferEvent,
  XferProgressEvent,
  TalkCallState,
  TalkEndedEvent,
  TalkAudioEvent,
  TalkVideoEvent,
  TalkVideoStateEvent,
  TalkScreenEvent,
  TalkScreenStateEvent,
  ScreenShareResolution,
  ConnectionHealth,
  HealthState,
  TransportHealth,
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
  hiveClient: HiveClient | null = null;
  // Single active voice call. MVP: at most one call at a time across the app.
  private currentCall: TalkCallState | null = null;
  // Decoded room keys keyed by roomId. Populated on bringUp from DB and on
  // accepted invites.
  private roomKeys = new Map<string, Uint8Array>();
  // In-memory cache of members per known room (mirror of room_members table).
  private roomMembers = new Map<string, string[]>();
  // Per-voice-channel set of remote peers known to be joined right now.
  // Key is `${roomId}|${channelId}`.
  private roomVoiceMembers = new Map<string, Set<string>>();
  // Voice channels we are currently joined to (same key shape as above).
  private localVoiceJoined = new Set<string>();
  // Active remote presenter per voice channel (for the one-at-a-time rule).
  private roomScreenPresenters = new Map<string, {
    peerId: string;
    screenName: string;
    sourceName?: string;
    resolution?: '480p' | '720p' | '1080p';
  }>();
  // Voice channels where we are the active local screen presenter.
  private localScreenPresenting = new Set<string>();
  // Auto-discovered peers (LAN via mDNS) that speak the Buzz IM protocol and
  // aren't already in our buddy list. Cleared on lock.
  private discovered = new Map<string, DiscoveredPeer>();
  // Last broadcast status per peer so windows that open after the event can
  // catch up. Cleared on lock.
  private peerStatuses = new Map<string, BuddyStatusEvent>();
  private onPeerIdentify: ((evt: Event) => void) | null = null;
  // Interval timer that polls the buzz-mesh sidecar for new tailnet peers (exp-p2p mode).
  private _meshPollTimer: ReturnType<typeof setInterval> | null = null;
  // Burst timeouts fired shortly after login in mesh mode (analogous to loginBurst for presence).
  private _meshBurstTimers: ReturnType<typeof setTimeout>[] = [];
  // Rolling buffer of the last 20 dial error messages — surfaced in Mesh Debug window.
  _meshDialErrors: string[] = [];

  get meshDialErrors(): string[] {
    return this._meshDialErrors;
  }
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
    const isMesh = loadNetworkConfig().mode === 'exp-p2p';
    const profile = profiles.addProfile(screenName, isMesh);
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

  /**
   * Migrate a legacy database (created with bsmc v11 / SQLite3MultipleCiphers
   * < 2.2.5) to the current format. Opens the old DB using the broken KDF
   * passphrase derivation, copies all data to a fresh DB with the correct
   * raw key, then atomically replaces the old file.
   */
  async migrateDb(profileId: string, passphrase: string): Promise<void> {
    const profile = profiles.getProfile(profileId);
    if (!profile) throw new Error('Profile not found');
    const ks = new Keystore(path.join(profiles.profileDir(profileId), 'keystore.bin'));
    const id = await ks.unlock(passphrase);
    const dbFile = path.join(profiles.profileDir(profileId), 'buzz.sqlite');
    const tmpFile = dbFile + '.migrating';

    let oldDb: Db;
    try {
      oldDb = openDbLegacy(dbFile, id.dbKey);
    } catch (e) {
      throw new Error(
        `Could not open legacy database (wrong passphrase or not a v11 database): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    fs.rmSync(tmpFile, { force: true });
    const newDb = openDb(tmpFile, id.dbKey);

    try {
      const tables = [
        'identity', 'buddies', 'messages', 'prefs', 'profile_cache',
        'transfers', 'rooms', 'room_members', 'room_messages',
        'room_channels', 'mailbox', 'buddy_requests', 'room_reads',
      ];
      const tx = newDb.transaction(() => {
        for (const table of tables) {
          const exists = oldDb
            .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
            .get(table) as unknown;
          if (!exists) continue;
          const rows = oldDb.prepare(`SELECT * FROM ${table}`).all();
          if (rows.length === 0) continue;
          const cols = Object.keys(rows[0] as Record<string, unknown>);
          const placeholders = cols.map(() => '?').join(', ');
          const ins = newDb.prepare(
            `INSERT OR REPLACE INTO ${table}(${cols.join(', ')}) VALUES (${placeholders})`,
          );
          for (const row of rows) {
            ins.run(...cols.map((c) => (row as Record<string, unknown>)[c]));
          }
        }
      });
      tx();
    } finally {
      oldDb.close();
      newDb.close();
    }

    fs.renameSync(tmpFile, dbFile);
    // Remove any WAL/SHM files left from the old encryption so that the
    // freshly-migrated database is not tainted by stale pages.
    fs.rmSync(dbFile + '-wal', { force: true });
    fs.rmSync(dbFile + '-shm', { force: true });
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
    if (this.hiveClient) {
      this.hiveClient.disconnect();
      this.hiveClient = null;
    }
    // Stop the Buzz Mesh sidecar if it was running in exp-p2p mode.
    for (const t of this._meshBurstTimers) clearTimeout(t);
    this._meshBurstTimers = [];
    if (this._meshPollTimer != null) {
      clearInterval(this._meshPollTimer);
      this._meshPollTimer = null;
    }
    this._meshDialErrors = [];
    await MeshNode.instance.stop().catch(() => undefined);
    this.currentCall = null;
    this.roomKeys.clear();
    this.roomMembers.clear();
    this.discovered.clear();
    this.peerStatuses.clear();
    this.profileId = null;
    this.state = 'locked';
    this.broadcastHealth();
  }

  buddyCode(): string {
    if (this.hiveClient) return this.hiveClient.getPeerId();
    if (!this.node) throw new Error('Locked');
    return buddyCodeFor(this.node.peerId);
  }

  peerIdStr(): string {
    if (this.hiveClient) return this.hiveClient.getPeerId();
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
    try {
      this.db = openDb(dbFile, id.dbKey);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'SQLITE_NOTADB' || code === 'SQLITE_ERROR') {
        // Legacy database (bsmc v11 / SQLite3MultipleCiphers < 2.2.5 bug #218).
        // Surface as a typed error so the renderer can offer a migration flow.
        throw Object.assign(new Error('LEGACY_DB'), { code: 'LEGACY_DB' });
      }
      throw err;
    }

    // Establish identity row in DB.
    const network = loadNetworkConfig();

    // ── Server mode: use HiveClient instead of libp2p ──────────────────────
    if (network.mode === 'server' && network.serverUrl) {
      await this.bringUpHive(id, network.serverUrl, screenNameIfNew);
      return;
    }

    // ── Experimental P2P: join the Buzz Mesh (Tailscale tsnet sidecar) ──────
    let meshIp: string | undefined;
    let socksPort: number | undefined;
    if (network.mode === 'exp-p2p') {
      meshIp = await MeshNode.instance.start();
      socksPort = MeshNode.instance.socksPort ?? undefined;
    }

    const node = await createNode({ identity: id, network, listenIp: meshIp, socksPort });
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
        onRoomVoiceState: (peer, p) => this.rooms?.handleVoiceState(peer, p),
        onRoomVoiceAudio: (peer, p) => this.rooms?.handleVoiceAudio(peer, p),
        onRoomScreenState: (peer, p) => this.rooms?.handleScreenState(peer, p),
        onRoomScreenVideo: (peer, p) => this.rooms?.handleScreenVideo(peer, p),
        onRoomPin: (peer, p) => this.rooms?.handlePin(peer, p),
        onRoomKick: (peer, p) => this.rooms?.handleKick(peer, p),
        onRoomRole: (peer, p) => this.rooms?.handleRole(peer, p),
        onRoomCategory: (peer, p) => this.rooms?.handleCategory(peer, p),
        onRoomReaction: (peer, p) => this.rooms?.handleReaction(peer, p),
        onRoomEditMsg: (peer, p) => this.rooms?.handleEditMsg(peer, p),
        onRoomDeleteMsg: (peer, p) => this.rooms?.handleDeleteMsg(peer, p),
        onBuddyReq: (peer, p) => this.handleBuddyReq(peer, p),
        onBuddyResp: (peer, p) => this.handleBuddyResp(peer, p),
        onGameFrame: (peer, p) => this.handleGameFrame(peer, p),
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
        onInvite: (peerId, callId, screenName, ts, kind) =>
          this.handleTalkInvite(peerId, callId, screenName, ts, kind),
        onAccept: (peerId, callId) => this.handleTalkAccept(peerId, callId),
        onReject: (peerId, callId, reason) => this.handleTalkReject(peerId, callId, reason),
        onBye: (peerId, callId) => this.handleTalkBye(peerId, callId),
        onAudio: (peerId, callId, seq, data) => this.handleTalkAudio(peerId, callId, seq, data),
        onVideo: (peerId, callId, seq, data) => this.handleTalkVideo(peerId, callId, seq, data),
        onVideoState: (peerId, callId, on) => this.handleTalkVideoState(peerId, callId, on),
        onScreen: (peerId, callId, seq, data) => this.handleTalkScreen(peerId, callId, seq, data),
        onScreenState: (peerId, callId, on, sourceName, resolution) =>
          this.handleTalkScreenState(peerId, callId, on, sourceName, resolution),
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
      // Suppress (or extend debounce for) offline signals while a video/voice
      // call is in progress with this peer.
      (peerId) => (this.talk?.getActivePeerIds().has(peerId) ?? false),
      (self) => this.handleSelfPresenceChange(self),
    );
    this.presence.start();
    this.presence.loginBurst();

    // In Buzz Mesh mode, periodically fetch tailnet peer IPs from the Go
    // sidecar and dial any we haven't connected to yet. mDNS handles same-
    // network peers automatically; this covers cross-network Tailscale peers.
    if (network.mode === 'exp-p2p') {
      const dialMeshPeers = async () => {
        const ips = await MeshNode.instance.fetchTailnetPeers();
        for (const ip of ips) {
          const ma = `/ip4/${ip}/tcp/${MESH_LIBP2P_PORT}`;
          try {
            const { multiaddr } = await import('@multiformats/multiaddr');
            const conn = await node.dial(multiaddr(ma));
            const connectedPeerId = conn.remotePeer.toString();

            // Proactively surface this peer in the Nearby section right away
            // rather than waiting for peer:identify (which may lag in mesh mode).
            if (this.db && connectedPeerId !== node.peerId.toString()) {
              const isBuddy = !!this.db
                .prepare('SELECT 1 FROM buddies WHERE peer_id=?')
                .get(connectedPeerId);
              if (!isBuddy) {
                const prev = this.discovered.get(connectedPeerId);
                const dp: DiscoveredPeer = {
                  peerId: connectedPeerId,
                  screenName: prev?.screenName,
                  source: 'mdns', // 'tailscale' conceptually
                  lastSeen: Date.now(),
                };
                this.discovered.set(connectedPeerId, dp);
                if (!prev) {
                  this.broadcast(IPC.EvtDiscovered, { kind: 'added', peer: dp } satisfies DiscoveredEvent);
                }
              }
            }

            // Retry any pending outgoing buddy request to this newly-connected
            // peer — the first send may have fired before the connection existed.
            if (this.db && this.im) {
              const pending = this.db
                .prepare(
                  "SELECT screen_name as screenName, ts FROM buddy_requests WHERE peer_id=? AND direction='out'",
                )
                .get(connectedPeerId) as { screenName: string; ts: number } | undefined;
              if (pending) {
                void this.im
                  .send(connectedPeerId, {
                    type: 'buddy-req',
                    screenName: this.screenName,
                    ts: pending.ts,
                  })
                  .catch(() => {});
              }
            }
          } catch (err) {
            const msg = `[mesh] dial ${ip}:${MESH_LIBP2P_PORT} failed: ${err instanceof Error ? err.message : String(err)}`;
            console.error(msg);
            this._meshDialErrors = [msg, ...this._meshDialErrors].slice(0, 20);
          }
        }
      };

      // Initial burst of dial attempts (catches the case where both peers sign
      // on at roughly the same time and one side's Go forwarder isn't up yet).
      const MESH_DIAL_BURST_MS = [2_000, 5_000, 10_000, 20_000, 40_000];
      this._meshBurstTimers = MESH_DIAL_BURST_MS.map((delay) =>
        setTimeout(() => { void dialMeshPeers(); }, delay),
      );
      this._meshPollTimer = setInterval(() => { void dialMeshPeers(); }, 60_000);
    }

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
            ownerPeerId: p.ownerPeerId ?? '',
          });
          repos.setRoomMembers(this.db, p.roomId, p.members);
          if (p.ownerPeerId) {
            repos.setMemberRole(this.db, p.roomId, p.ownerPeerId, 'owner');
          }
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
                kind: ch.kind === 'voice' ? 'voice' : 'text',
                isDefault: ch.isDefault,
                createdAt: ch.createdAt,
                category: '',
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
              kind: 'text',
              isDefault: true,
              createdAt: p.ts,
              category: '',
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
            replyToId: m.replyToId,
            mentions: m.mentions,
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
                ownerPeerId: cur.ownerPeerId,
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
            kind: existing?.kind ?? (p.kind === 'voice' ? 'voice' : 'text'),
            isDefault: existing?.isDefault ?? false,
            createdAt: existing?.createdAt ?? p.ts,
            category: existing?.category ?? '',
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
        onVoiceState: (fromPeerId, p) => {
          // Track the remote presence so newly-joining clients see the room.
          const key = `${p.roomId}|${p.channelId}`;
          const set = this.roomVoiceMembers.get(key) ?? new Set<string>();
          if (p.joined) set.add(fromPeerId);
          else set.delete(fromPeerId);
          this.roomVoiceMembers.set(key, set);
          this.broadcast(IPC.EvtRoomVoicePresence, {
            roomId: p.roomId,
            channelId: p.channelId,
            peerId: fromPeerId,
            screenName: p.fromName ?? '',
            joined: p.joined,
          } satisfies RoomVoicePresenceEvent);
          this.broadcastHealth();
          // If we're locally joined to this voice channel, re-announce so the
          // peer learns we're here too. Cheap: a single small frame.
          if (p.joined && this.localVoiceJoined.has(key)) {
            this.rooms?.broadcastVoiceState(p.roomId, p.channelId, true).catch(() => undefined);
            // Also let late joiners know we're presenting, if we are.
            if (this.localScreenPresenting.has(key)) {
              this.rooms?.broadcastScreenState(p.roomId, p.channelId, true).catch(() => undefined);
            }
          }
        },
        onVoiceAudio: (fromPeerId, p) => {
          // Only deliver decrypted audio to renderers if WE are joined to this
          // voice channel — otherwise we'd be wasting cycles decoding audio
          // we won't play.
          const key = `${p.roomId}|${p.channelId}`;
          if (!this.localVoiceJoined.has(key)) return;
          void (async () => {
            const plain = await this.rooms?.decryptVoiceAudio(p.roomId, p.ctB64, p.nonceB64);
            if (!plain) return;
            const copy = new Uint8Array(plain.byteLength);
            copy.set(plain);
            const ev: RoomVoiceAudioEvent = {
              roomId: p.roomId,
              channelId: p.channelId,
              peerId: fromPeerId,
              screenName: p.fromName ?? '',
              data: copy,
            };
            this.broadcast(IPC.EvtRoomVoiceAudio, ev);
          })();
        },
        onScreenState: (fromPeerId, p) => {
          const key = `${p.roomId}|${p.channelId}`;
          if (p.presenting) {
            this.roomScreenPresenters.set(key, {
              peerId: fromPeerId,
              screenName: p.fromName ?? '',
              sourceName: p.sourceName,
              resolution: p.resolution,
            });
          } else {
            const cur = this.roomScreenPresenters.get(key);
            if (cur && cur.peerId === fromPeerId) this.roomScreenPresenters.delete(key);
          }
          this.broadcast(IPC.EvtRoomScreenState, {
            roomId: p.roomId,
            channelId: p.channelId,
            peerId: fromPeerId,
            screenName: p.fromName ?? '',
            presenting: p.presenting,
            sourceName: p.sourceName,
            resolution: p.resolution,
          });
          // If we just joined the voice channel and someone else starts
          // presenting, the late-join echo is handled automatically because
          // they re-broadcast on every roomVoiceState join below.
        },
        onScreenVideo: (fromPeerId, p) => {
          const key = `${p.roomId}|${p.channelId}`;
          if (!this.localVoiceJoined.has(key)) return;
          void (async () => {
            const plain = await this.rooms?.decryptScreenVideo(p.roomId, p.ctB64, p.nonceB64);
            if (!plain) return;
            const copy = new Uint8Array(plain.byteLength);
            copy.set(plain);
            this.broadcast(IPC.EvtRoomScreenVideo, {
              roomId: p.roomId,
              channelId: p.channelId,
              peerId: fromPeerId,
              screenName: p.fromName ?? '',
              data: copy,
            });
          })();
        },
        onPin: (_fromPeerId, p) => {
          if (!this.db) return;
          repos.pinRoomMessage(this.db, p.msgId, p.isPinned);
          this.broadcast(IPC.EvtRoomPin, { roomId: p.roomId, msgId: p.msgId, isPinned: p.isPinned } satisfies RoomPinEvent);
        },
        onKick: (_fromPeerId, p) => {
          if (!this.db) return;
          repos.kickRoomMember(this.db, p.roomId, p.peerId);
          const members = repos.getRoomMembers(this.db, p.roomId);
          this.roomMembers.set(p.roomId, members);
          this.broadcast(IPC.EvtRoomKick, { roomId: p.roomId, peerId: p.peerId } satisfies RoomKickEvent);
        },
        onRole: (_fromPeerId, p) => {
          if (!this.db) return;
          const role = (p.role === 'owner' || p.role === 'mod' || p.role === 'member' ? p.role : 'member') as 'owner' | 'mod' | 'member';
          repos.setMemberRole(this.db, p.roomId, p.peerId, role);
          this.broadcast(IPC.EvtRoomRole, { roomId: p.roomId, peerId: p.peerId, role } satisfies RoomRoleEvent);
        },
        onCategory: (_fromPeerId, p) => {
          if (!this.db) return;
          repos.setChannelCategory(this.db, p.channelId, p.category);
          this.broadcast(IPC.EvtRoomCategory, { roomId: p.roomId, channelId: p.channelId, category: p.category } satisfies RoomCategoryEvent);
        },
        onReaction: (_fromPeerId, p) => {
          if (!this.db) return;
          if (p.added) repos.upsertReaction(this.db, p.msgId, _fromPeerId, p.emoji);
          else repos.deleteReaction(this.db, p.msgId, _fromPeerId, p.emoji);
          this.broadcast(IPC.EvtReaction, { roomId: p.roomId, msgId: p.msgId, peerId: _fromPeerId, emoji: p.emoji, added: p.added });
        },
        onEditMsg: (_fromPeerId, p) => {
          if (!this.db) return;
          if (repos.editRoomMessage(this.db, p.msgId, p.body, p.ts)) {
            this.broadcast(IPC.EvtRoomEdited, { roomId: p.roomId, msgId: p.msgId, body: p.body, editedAt: p.ts });
          }
        },
        onDeleteMsg: (_fromPeerId, p) => {
          if (!this.db) return;
          repos.deleteRoomMessage(this.db, p.msgId, p.ts);
          this.broadcast(IPC.EvtRoomDeleted, { roomId: p.roomId, msgId: p.msgId, deletedAt: p.ts });
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
    this.broadcastHealth();
  }

  /**
   * Server-mode bringUp: use HiveClient instead of the entire libp2p stack.
   * libp2p node, ImService, PresenceManager, XferService, TalkService,
   * MailboxService are all NOT started.
   */
  private async bringUpHive(
    id: IdentityMaterial,
    serverUrl: string,
    screenNameIfNew: string,
  ): Promise<void> {
    const db = this.db!;

    // Resolve identity from DB (no node.peerId yet — client sets it after auth).
    const existing = repos.getIdentity(db);
    if (existing) {
      this.screenName = existing.screenName;
    } else {
      this.screenName = screenNameIfNew || 'Buddy';
    }
    if (screenNameIfNew && existing) {
      this.screenName = screenNameIfNew;
    }

    const prefs = repos.getPrefs(db);
    const cbs: HiveCallbacks = {
      onAuthed: (peerId, buddies, pendingRequests, _pubKeys) => {
        // Now we know our peerId — store identity row in DB.
        if (!repos.getIdentity(db)) {
          repos.setIdentity(db, peerId, this.screenName);
        } else if (screenNameIfNew) {
          repos.setIdentity(db, peerId, this.screenName);
        }
        // Emit buddy list to renderers.
        for (const b of buddies) {
          const ev: BuddyStatusEvent = { peerId: b.peerId, status: b.status, awayMessage: b.awayMessage };
          this.peerStatuses.set(b.peerId, ev);
          this.broadcast(IPC.EvtBuddyStatus, ev);
        }
        // Emit any pending buddy requests as BuddyRequestEvent so the buddy-list
        // renderer can show them.
        for (const req of pendingRequests) {
          if (req.direction === 'in') {
            this.broadcast(IPC.EvtBuddyRequest, {
              kind: 'incoming',
              request: { peerId: req.peerId, screenName: req.screenName, direction: 'in', ts: req.createdAt },
            } satisfies BuddyRequestEvent);
          }
        }
      },
      onConnected: () => {
        // Send our current status to the server.
        this.hiveClient?.setStatus(
          prefs.lastStatus === 'invisible' ? 'invisible'
            : prefs.lastStatus === 'dnd' ? 'dnd'
            : 'online',
          prefs.awayMessage || undefined,
        );
        this.broadcastHealth();
      },
      onDisconnected: () => {
        // Notify renderers that the server connection dropped.
        this.broadcast(IPC.EvtError, { message: 'Disconnected from Hive server. Reconnecting…' });
        this.broadcastHealth();
      },
      onError: (err) => {
        console.error('[hive-client]', err.message);
        this.broadcastHealth();
      },
      onBuddyStatus: (peerId, status, awayMessage) => {
        const ev: BuddyStatusEvent = { peerId, status, awayMessage };
        this.peerStatuses.set(peerId, ev);
        this.broadcast(IPC.EvtBuddyStatus, ev);
      },
      onBuddyList: (buddies, _pubKeys) => {
        for (const b of buddies) {
          const ev: BuddyStatusEvent = { peerId: b.peerId, status: b.status, awayMessage: b.awayMessage };
          this.peerStatuses.set(b.peerId, ev);
          this.broadcast(IPC.EvtBuddyStatus, ev);
        }
      },
      onBuddyRequest: (peerId, screenName) => {
        this.broadcast(IPC.EvtBuddyRequest, {
          kind: 'incoming',
          request: { peerId, screenName, direction: 'in', ts: Date.now() },
        } satisfies BuddyRequestEvent);
      },
      onBuddyResponse: (peerId, accepted, _screenName) => {
        this.broadcast(IPC.EvtBuddyRequestResolved, { peerId, accepted } satisfies BuddyRequestResolvedEvent);
      },
      onMessage: (fromPeerId, msgId, ts, cipherB64) => {
        if (!this.hiveClient) return;
        if (repos.isBlocked(db, fromPeerId)) {
          this.hiveClient.sendAck(msgId);
          return;
        }
        // Decrypt sealed_box.
        const body = this.hiveClient.openMessage(cipherB64);
        if (!body) return;
        const networkCfg = loadNetworkConfig();
        const shouldCache = networkCfg.serverCacheEnabled;
        const msg: ImReceivedEvent = {
          id: msgId,
          peerId: fromPeerId,
          direction: 'in',
          ts,
          body,
          status: 'delivered',
        };
        if (shouldCache) {
          repos.insertMessage(db, msg);
        }
        this.hiveClient.sendAck(msgId);
        this.broadcast(IPC.EvtImReceived, msg);
        this.broadcastUnread();
        // Desktop notification if no IM window for this peer is focused.
        const allFocused = BrowserWindow.getAllWindows().some((w) => w.isFocused());
        if (!allFocused && !repos.isBuddyMuted(db, fromPeerId)) {
          const alias = repos.listBuddies(db).find((b) => b.peerId === fromPeerId)?.alias ?? fromPeerId.slice(0, 12);
          notifyIm(alias, body);
        }
      },
      onAck: (msgId) => {
        repos.setMessageStatus(db, msgId, 'delivered');
        this.broadcast(IPC.EvtImAck, { id: msgId, status: 'delivered' } satisfies ImAckEvent);
      },
      onRoomInvite: (invite) => {
        repos.upsertRoom(db, {
          id: invite.id,
          name: invite.name,
          keyB64: invite.keyEnvelopeB64,
          createdAt: Date.now(),
          ownerPeerId: invite.ownerPeerId ?? '',
        });
        repos.setRoomMembers(db, invite.id, invite.members);
        if (invite.ownerPeerId) {
          repos.setMemberRole(db, invite.id, invite.ownerPeerId, 'owner');
        }
        for (const ch of invite.channels) {
          repos.upsertRoomChannel(db, {
            id: ch.id,
            roomId: invite.id,
            name: ch.name,
            kind: ch.kind ?? 'text',
            isDefault: ch.name === 'general',
            createdAt: Date.now(),
            category: '',
          });
        }
        this.roomMembers.set(invite.id, [...invite.members]);
        this.broadcast(IPC.EvtRoomInvited, {
          roomId: invite.id,
          name: invite.name,
          fromPeerId: invite.from,
          members: invite.members,
        } satisfies RoomInvitedEvent);
      },
      onRoomMsg: (roomId, channelId, fromPeerId, msgId, ts, cipherB64, opts) => {
        // Room messages are secretbox-encrypted; the body IS the ciphertext from our perspective.
        // For Hive server mode, store cipher and surface as-is — renderers decrypt using room key.
        const networkCfg = loadNetworkConfig();
        if (networkCfg.serverCacheEnabled) {
          const stored: RoomMessage = {
            id: msgId,
            roomId,
            channelId,
            fromPeerId,
            fromName: opts?.fromName ?? '',
            direction: fromPeerId === (this.hiveClient?.getPeerId() ?? '') ? 'out' : 'in',
            ts,
            body: cipherB64,
            replyToId: opts?.replyToId,
            mentions: opts?.mentions,
          };
          repos.insertRoomMessage(db, stored);
          this.broadcast(IPC.EvtRoomMessage, stored);
        } else {
          this.broadcast(IPC.EvtRoomMessage, {
            id: msgId, roomId, channelId, fromPeerId, fromName: opts?.fromName ?? '',
            direction: 'in', ts, body: cipherB64,
            replyToId: opts?.replyToId, mentions: opts?.mentions,
          } satisfies RoomMessage);
        }
        this.broadcastUnread();
      },
      onRoomMemberJoin: (roomId, peerId, screenName) => {
        const members = [...(this.roomMembers.get(roomId) ?? [])];
        if (!members.includes(peerId)) members.push(peerId);
        this.roomMembers.set(roomId, members);
        repos.setRoomMembers(db, roomId, members);
        this.broadcast(IPC.EvtRoomMembers, { roomId, members } satisfies RoomMembersEvent);
        // Also synthesize a presence event so they show as online in buddy list.
        this.broadcast(IPC.EvtBuddyStatus, { peerId, status: 'online' } satisfies BuddyStatusEvent);
        void screenName; // suppress unused-var warning
      },
      onRoomMemberLeave: (roomId, peerId) => {
        const members = (this.roomMembers.get(roomId) ?? []).filter((id) => id !== peerId);
        this.roomMembers.set(roomId, members);
        repos.setRoomMembers(db, roomId, members);
        this.broadcast(IPC.EvtRoomMembers, { roomId, members } satisfies RoomMembersEvent);
      },
      onTalkSignal: (from, callId, signal, payload) => {
        this.handleHiveTalkSignal(from, callId, signal, payload);
      },
      onTalkAudio: (from, callId, buf) => {
        this.handleTalkAudio(from, callId, 0, buf);
      },
      onTalkVideo: (from, callId, buf) => {
        this.handleTalkVideo(from, callId, 0, buf);
      },
      onTalkScreen: (from, callId, buf) => {
        this.handleTalkScreen(from, callId, 0, buf);
      },
      onGameSignal: (from, action, kind, path) => {
        this.handleGameFrame(from, { action, kind, path });
      },
      onTyping: (from, typing) => {
        this.broadcast(IPC.EvtTyping, { peerId: from, typing });
      },
      onReadReceipt: (from, msgId) => {
        this.broadcast(IPC.EvtReadReceipt, { from, msgId });
        // Mark the matching outbound message as read in DB.
        if (this.db) {
          this.db.prepare("UPDATE messages SET status='read' WHERE id=? AND direction='out'").run(msgId);
        }
      },
      onReaction: (from, msgId, emoji, added) => {
        // Persist locally.
        if (this.db) {
          if (added) repos.upsertReaction(this.db, msgId, from, emoji);
          else repos.deleteReaction(this.db, msgId, from, emoji);
        }
        this.broadcast(IPC.EvtReaction, { msgId, peerId: from, emoji, added });
      },
      onRoomReaction: (roomId, from, msgId, emoji, added) => {
        this.broadcast(IPC.EvtReaction, { roomId, msgId, peerId: from, emoji, added });
      },
      onRoomEditMsg: (roomId, _from, msgId, ts, cipherB64) => {
        if (!this.db) return;
        void this.decryptHiveRoomBody(roomId, cipherB64).then((body) => {
          if (!body || !this.db) return;
          if (repos.editRoomMessage(this.db, msgId, body, ts)) {
            this.broadcast(IPC.EvtRoomEdited, { roomId, msgId, body, editedAt: ts });
          }
        });
      },
      onRoomDeleteMsg: (roomId, _from, msgId, ts) => {
        if (!this.db) return;
        repos.deleteRoomMessage(this.db, msgId, ts);
        this.broadcast(IPC.EvtRoomDeleted, { roomId, msgId, deletedAt: ts });
      },
      onEditMsg: (_from, msgId, ts, cipherB64) => {
        if (!this.db || !this.hiveClient) return;
        const body = this.hiveClient.openMessage(cipherB64);
        if (body == null) return;
        repos.editMessage(this.db, msgId, body, ts);
        this.broadcast(IPC.EvtImEdited, { id: msgId, body, editedAt: ts });
      },
      onDeleteMsg: (_from, msgId, ts) => {
        if (!this.db) return;
        repos.deleteMessage(this.db, msgId, ts);
        this.broadcast(IPC.EvtImDeleted, { id: msgId, deletedAt: ts });
      },
      onRoomPin: (roomId, _from, msgId, isPinned) => {
        if (!this.db) return;
        repos.pinRoomMessage(this.db, msgId, isPinned);
        this.broadcast(IPC.EvtRoomPin, { roomId, msgId, isPinned } satisfies RoomPinEvent);
      },
      onRoomKick: (roomId, _from, peerId) => {
        if (!this.db) return;
        repos.kickRoomMember(this.db, roomId, peerId);
        const members = repos.getRoomMembers(this.db, roomId);
        this.cacheRoomMembers(roomId, members);
        this.broadcast(IPC.EvtRoomKick, { roomId, peerId } satisfies RoomKickEvent);
      },
      onRoomRole: (roomId, _from, peerId, role) => {
        if (!this.db) return;
        const r = (role === 'owner' || role === 'mod' || role === 'member' ? role : 'member') as 'owner' | 'mod' | 'member';
        repos.setMemberRole(this.db, roomId, peerId, r);
        this.broadcast(IPC.EvtRoomRole, { roomId, peerId, role: r } satisfies RoomRoleEvent);
      },
      onRoomCategory: (roomId, channelId, category) => {
        if (!this.db) return;
        repos.setChannelCategory(this.db, channelId, category);
        this.broadcast(IPC.EvtRoomCategory, { roomId, channelId, category } satisfies RoomCategoryEvent);
      },
      onRoomChannelAdd: (roomId, channelId, name, kind) => {
        if (!this.db) return;
        if (!repos.getRoom(this.db, roomId)) return;
        const existing = repos.getRoomChannel(this.db, channelId);
        const ch: RoomChannel = {
          id: channelId,
          roomId,
          name,
          kind: kind === 'voice' ? 'voice' : 'text',
          isDefault: existing?.isDefault ?? false,
          createdAt: existing?.createdAt ?? Date.now(),
          category: existing?.category ?? '',
        };
        repos.upsertRoomChannel(this.db, ch);
        this.broadcast(IPC.EvtRoomChannel, { kind: 'added', channel: ch } satisfies RoomChannelEvent);
      },
    };

    this.hiveClient = new HiveClient(id, serverUrl, this.screenName, cbs);
    await this.hiveClient.connect();

    this.state = 'unlocked';
    this.broadcastHealth();
  }

  // Deliver a sealed-and-verified mailbox envelope as if it had arrived live.
  // Returns true if accepted (caller acks the relay); false if dropped.
  private async deliverMailboxMessage(m: {
    id: string;
    ts: number;
    body: string;
    fromPeerId: string;
    media?: { mime: string; name: string; data: Uint8Array };
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
    if (m.media) {
      try {
        const dir = path.join(app.getPath('userData'), 'mailbox-media');
        await fsp.mkdir(dir, { recursive: true });
        const safeName = m.media.name.replace(/[^\w.-]+/g, '_').slice(0, 120) || 'attachment';
        const filePath = path.join(dir, `${m.id}-${safeName}`);
        await fsp.writeFile(filePath, Buffer.from(m.media.data), { mode: 0o600 });
        const xferId = `${m.id}:media`;
        repos.insertTransfer(this.db, {
          id: xferId,
          peerId: m.fromPeerId,
          direction: 'in',
          fileName: safeName,
          fileSize: m.media.data.byteLength,
          fileHash: '',
          status: 'complete',
          savedPath: filePath,
          createdAt: m.ts,
          updatedAt: Date.now(),
        });
        const offer: XferOfferEvent = {
          id: xferId,
          peerId: m.fromPeerId,
          fileName: safeName,
          fileSize: m.media.data.byteLength,
          hash: '',
        };
        this.broadcast(IPC.EvtXferOffered, offer);
        const done: XferDoneEvent = {
          id: xferId,
          peerId: m.fromPeerId,
          direction: 'in',
          fileName: safeName,
          ok: true,
          savedPath: filePath,
        };
        this.broadcast(IPC.EvtXferDone, done);
      } catch {
        /* media write failure: still ack so relay frees row */
      }
    }
    this.broadcast(IPC.EvtMailboxDelivered, { peerId: m.fromPeerId, count: 1 });
    this.broadcastUnread();
    return true;
  }

  // Helpers used by IPC handlers to manipulate the in-memory key/member caches
  // when a local user creates or destroys a room.
  cacheRoomKey(roomId: string, key: Uint8Array): void {
    this.roomKeys.set(roomId, key);
  }

  async encryptHiveRoomBody(roomId: string, body: string): Promise<string> {
    const key = this.roomKeys.get(roomId);
    if (!key) throw new Error('Unknown room');
    const s = await sodium();
    const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
    const plain = s.from_string(body);
    const ct = s.crypto_secretbox_easy(plain, nonce, key);
    const framed = new Uint8Array(nonce.length + ct.length);
    framed.set(nonce, 0);
    framed.set(ct, nonce.length);
    return s.to_base64(framed, s.base64_variants.ORIGINAL);
  }

  private async decryptHiveRoomBody(roomId: string, cipherB64: string): Promise<string | null> {
    const key = this.roomKeys.get(roomId);
    if (!key) return null;
    try {
      const s = await sodium();
      const framed = s.from_base64(cipherB64, s.base64_variants.ORIGINAL);
      const nonceBytes = s.crypto_secretbox_NONCEBYTES;
      if (framed.length <= nonceBytes) return null;
      const nonce = framed.slice(0, nonceBytes);
      const ct = framed.slice(nonceBytes);
      const plain = s.crypto_secretbox_open_easy(ct, nonce, key);
      return s.to_string(plain);
    } catch {
      return null;
    }
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

  // ── Peer-to-peer games ────────────────────────────────────────────────────
  private handleGameFrame(
    peerId: string,
    p: { action: string; kind: string; path?: number[] },
  ): void {
    const fromName = this.db
      ? (repos.listBuddies(this.db).find((b) => b.peerId === peerId)?.alias ?? peerId.slice(0, 8))
      : peerId.slice(0, 8);
    switch (p.action) {
      case 'invite':
        this.broadcast(IPC.EvtGameInvite, { fromPeerId: peerId, fromName, kind: p.kind });
        break;
      case 'accept':
        this.broadcast(IPC.EvtGameAccepted, { fromPeerId: peerId, kind: p.kind });
        break;
      case 'decline':
        this.broadcast(IPC.EvtGameDeclined, { fromPeerId: peerId, kind: p.kind });
        break;
      case 'move':
        this.broadcast(IPC.EvtGameMove, { fromPeerId: peerId, kind: p.kind, path: p.path ?? [] });
        break;
      case 'resign':
        this.broadcast(IPC.EvtGameResigned, { fromPeerId: peerId, kind: p.kind });
        break;
    }
  }

  async sendGameFrame(
    toPeerId: string,
    action: 'invite' | 'accept' | 'decline' | 'move' | 'resign',
    kind: string,
    path?: number[],
  ): Promise<void> {
    if (this.hiveClient) {
      this.hiveClient.sendGame(toPeerId, action, kind, path);
    } else {
      if (!this.im) throw new Error('Locked');
      await this.im.send(toPeerId, { type: 'game' as const, action, kind, ...(path ? { path } : {}) });
    }
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

  private async sendTalkControl(peerId: string, callId: string, signal: 'invite' | 'accept' | 'reject' | 'bye' | 'videoState' | 'screenState', payload?: unknown): Promise<void> {
    if (this.hiveClient) {
      this.hiveClient.sendTalkSignal(peerId, callId, signal, payload ?? null);
      return;
    }
    if (!this.talk) throw new Error('Locked');
    switch (signal) {
      case 'invite': {
        const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
        await this.talk.send(peerId, {
          type: 'invite',
          callId,
          screenName: typeof p['screenName'] === 'string' ? p['screenName'] : this.screenName,
          ts: typeof p['ts'] === 'number' ? p['ts'] : Date.now(),
          kind: p['kind'] === 'video' ? 'video' : 'voice',
        });
        return;
      }
      case 'accept':
        await this.talk.send(peerId, { type: 'accept', callId });
        return;
      case 'reject': {
        const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
        await this.talk.send(peerId, { type: 'reject', callId, reason: typeof p['reason'] === 'string' ? p['reason'] : undefined });
        return;
      }
      case 'bye':
        await this.talk.send(peerId, { type: 'bye', callId });
        return;
      case 'videoState': {
        const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
        await this.talk.send(peerId, { type: 'videoState', callId, on: p['on'] === true });
        return;
      }
      case 'screenState': {
        const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
        const resolution = p['resolution'] === '480p' || p['resolution'] === '720p' || p['resolution'] === '1080p'
          ? p['resolution']
          : undefined;
        await this.talk.send(peerId, {
          type: 'screenState',
          callId,
          on: p['on'] === true,
          sourceName: typeof p['sourceName'] === 'string' ? p['sourceName'] : undefined,
          resolution,
        });
        return;
      }
    }
  }

  private handleHiveTalkSignal(peerId: string, callId: string, signal: string, payload: unknown): void {
    const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    switch (signal) {
      case 'invite': {
        const screenName = typeof p['screenName'] === 'string' ? p['screenName'] : peerId;
        const ts = typeof p['ts'] === 'number' ? p['ts'] : Date.now();
        const kind = p['kind'] === 'video' ? 'video' : 'voice';
        this.handleTalkInvite(peerId, callId, screenName, ts, kind);
        return;
      }
      case 'accept':
        this.handleTalkAccept(peerId, callId);
        return;
      case 'reject':
        this.handleTalkReject(peerId, callId, typeof p['reason'] === 'string' ? p['reason'] : undefined);
        return;
      case 'bye':
        this.handleTalkBye(peerId, callId);
        return;
      case 'videoState':
        this.handleTalkVideoState(peerId, callId, p['on'] === true);
        return;
      case 'screenState': {
        const resolution = p['resolution'] === '480p' || p['resolution'] === '720p' || p['resolution'] === '1080p'
          ? p['resolution']
          : undefined;
        this.handleTalkScreenState(
          peerId,
          callId,
          p['on'] === true,
          typeof p['sourceName'] === 'string' ? p['sourceName'] : undefined,
          resolution,
        );
        return;
      }
      default:
        return;
    }
  }

  async startCall(peerId: string, kind: 'voice' | 'video' = 'voice'): Promise<TalkCallState> {
    if (!this.talk && !this.hiveClient) throw new Error('Locked');
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
      kind,
      screenName: this.screenName,
      startedAt: ts,
    };
    this.currentCall = state;
    this.broadcast(IPC.EvtTalkState, state);
    this.broadcastHealth();
    try {
      await this.sendTalkControl(peerId, callId, 'invite', { screenName: this.screenName, ts, kind });
    } catch (err) {
      this.endCallLocal(callId, 'unreachable');
      throw err;
    }
    return state;
  }

  async acceptCall(callId: string): Promise<void> {
    if ((!this.talk && !this.hiveClient) || !this.currentCall) return;
    if (this.currentCall.callId !== callId) return;
    if (this.currentCall.role !== 'callee') return;
    const peerId = this.currentCall.peerId;
    await this.sendTalkControl(peerId, callId, 'accept').catch(() => undefined);
    this.currentCall = { ...this.currentCall, state: 'active', startedAt: Date.now() };
    this.broadcast(IPC.EvtTalkState, this.currentCall);
    this.broadcastHealth();
  }

  async rejectCall(callId: string, reason?: string): Promise<void> {
    if ((!this.talk && !this.hiveClient) || !this.currentCall) return;
    if (this.currentCall.callId !== callId) return;
    const peerId = this.currentCall.peerId;
    await this.sendTalkControl(peerId, callId, 'reject', { reason }).catch(() => undefined);
    this.endCallLocal(callId, reason ?? 'rejected');
  }

  async endCall(callId: string): Promise<void> {
    if ((!this.talk && !this.hiveClient) || !this.currentCall) return;
    if (this.currentCall.callId !== callId) return;
    const peerId = this.currentCall.peerId;
    await this.sendTalkControl(peerId, callId, 'bye').catch(() => undefined);
    this.endCallLocal(callId, 'ended');
  }

  async sendCallAudio(callId: string, data: Uint8Array): Promise<void> {
    if ((!this.talk && !this.hiveClient) || !this.currentCall) return;
    if (this.currentCall.callId !== callId) return;
    if (this.currentCall.state !== 'active') return;
    const peerId = this.currentCall.peerId;
    if (this.hiveClient) {
      this.hiveClient.sendTalkAudio(peerId, callId, Buffer.from(data));
      return;
    }
    // Fire-and-forget: TalkService enforces a bounded outbound queue with a
    // drop-oldest policy on backpressure, so awaiting here would only block
    // the IPC handler without changing what the peer actually sees.
    void this.talk?.send(peerId, { type: 'audio', callId, seq: 0, data }).catch(() => undefined);
  }

  async sendCallVideo(callId: string, data: Uint8Array): Promise<void> {
    if ((!this.talk && !this.hiveClient) || !this.currentCall) return;
    if (this.currentCall.callId !== callId) return;
    if (this.currentCall.state !== 'active') return;
    const peerId = this.currentCall.peerId;
    if (this.hiveClient) {
      this.hiveClient.sendTalkVideo(peerId, callId, Buffer.from(data));
      return;
    }
    void this.talk?.send(peerId, { type: 'video', callId, seq: 0, data }).catch(() => undefined);
  }

  async setCallVideo(callId: string, on: boolean): Promise<void> {
    if ((!this.talk && !this.hiveClient) || !this.currentCall) return;
    if (this.currentCall.callId !== callId) return;
    if (this.currentCall.state !== 'active') return;
    const peerId = this.currentCall.peerId;
    await this.sendTalkControl(peerId, callId, 'videoState', { on }).catch((err) => {
      console.warn('[talk] videoState send failed', err);
    });
  }

  async sendCallScreen(callId: string, data: Uint8Array): Promise<void> {
    if ((!this.talk && !this.hiveClient) || !this.currentCall) return;
    if (this.currentCall.callId !== callId) return;
    if (this.currentCall.state !== 'active') return;
    const peerId = this.currentCall.peerId;
    if (this.hiveClient) {
      this.hiveClient.sendTalkScreen(peerId, callId, Buffer.from(data));
      return;
    }
    void this.talk?.send(peerId, { type: 'screen', callId, seq: 0, data }).catch(() => undefined);
  }

  async setCallScreen(callId: string, on: boolean, sourceName?: string, resolution?: ScreenShareResolution): Promise<void> {
    if ((!this.talk && !this.hiveClient) || !this.currentCall) return;
    if (this.currentCall.callId !== callId) return;
    if (this.currentCall.state !== 'active') return;
    const peerId = this.currentCall.peerId;
    await this.sendTalkControl(peerId, callId, 'screenState', { on, sourceName, resolution }).catch((err) => {
      console.warn('[talk] screenState send failed', err);
    });
  }

  private endCallLocal(callId: string, reason?: string): void {
    if (!this.currentCall || this.currentCall.callId !== callId) return;
    const peerId = this.currentCall.peerId;
    this.currentCall = { ...this.currentCall, state: 'ended' };
    this.broadcast(IPC.EvtTalkState, this.currentCall);
    this.broadcastHealth();
    const ev: TalkEndedEvent = { callId, peerId, reason };
    this.broadcast(IPC.EvtTalkEnded, ev);
    // Clear cached call after a tick so renderers can settle.
    setTimeout(() => {
      if (this.currentCall && this.currentCall.callId === callId) this.currentCall = null;
      this.broadcastHealth();
    }, 50);
  }

  private handleTalkInvite(
    peerId: string,
    callId: string,
    screenName: string,
    _ts: number,
    kind: 'voice' | 'video',
  ): void {
    // Reject if already in another call.
    if (this.currentCall && this.currentCall.state !== 'ended') {
      void this.sendTalkControl(peerId, callId, 'reject', { reason: 'busy' }).catch(() => undefined);
      return;
    }
    const state: TalkCallState = {
      callId,
      peerId,
      role: 'callee',
      state: 'ringing',
      kind,
      screenName,
      startedAt: Date.now(),
    };
    this.currentCall = state;
    this.broadcast(IPC.EvtTalkInvite, state);
    this.broadcast(IPC.EvtTalkState, state);
    this.broadcastHealth();
  }

  private handleTalkAccept(peerId: string, callId: string): void {
    if (!this.currentCall || this.currentCall.callId !== callId) return;
    if (this.currentCall.peerId !== peerId) return;
    this.currentCall = { ...this.currentCall, state: 'active', startedAt: Date.now() };
    this.broadcast(IPC.EvtTalkState, this.currentCall);
    this.broadcastHealth();
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
    // Copy into a fresh ArrayBuffer-backed Uint8Array so it satisfies the
    // TalkAudioEvent schema (and to detach from the libp2p stream buffer).
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const ev: TalkAudioEvent = { callId, peerId, seq, data: copy };
    this.broadcast(IPC.EvtTalkAudio, ev);
  }

  private handleTalkVideo(peerId: string, callId: string, seq: number, data: Uint8Array): void {
    if (!this.currentCall || this.currentCall.callId !== callId) return;
    if (this.currentCall.peerId !== peerId) return;
    if (this.currentCall.state !== 'active') return;
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const ev: TalkVideoEvent = { callId, peerId, seq, data: copy };
    this.broadcast(IPC.EvtTalkVideo, ev);
  }

  private handleTalkVideoState(peerId: string, callId: string, on: boolean): void {
    if (!this.currentCall || this.currentCall.callId !== callId) return;
    if (this.currentCall.peerId !== peerId) return;
    if (this.currentCall.state !== 'active') return;
    const ev: TalkVideoStateEvent = { callId, peerId, on };
    this.broadcast(IPC.EvtTalkVideoState, ev);
  }

  private handleTalkScreen(peerId: string, callId: string, seq: number, data: Uint8Array): void {
    if (!this.currentCall || this.currentCall.callId !== callId) return;
    if (this.currentCall.peerId !== peerId) return;
    if (this.currentCall.state !== 'active') return;
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const ev: TalkScreenEvent = { callId, peerId, seq, data: copy };
    this.broadcast(IPC.EvtTalkScreen, ev);
  }

  private handleTalkScreenState(peerId: string, callId: string, on: boolean, sourceName?: string, resolution?: ScreenShareResolution): void {
    if (!this.currentCall || this.currentCall.callId !== callId) return;
    if (this.currentCall.peerId !== peerId) return;
    if (this.currentCall.state !== 'active') return;
    const ev: TalkScreenStateEvent = { callId, peerId, on, sourceName, resolution };
    this.broadcast(IPC.EvtTalkScreenState, ev);
    this.broadcastHealth();
  }

  // ── voice channels ────────────────────────────────────────────────────
  async roomVoiceJoin(roomId: string, channelId: string): Promise<void> {
    if (!this.rooms) throw new Error('locked');
    const key = `${roomId}|${channelId}`;
    if (this.localVoiceJoined.has(key)) return;
    this.localVoiceJoined.add(key);
    await this.rooms.broadcastVoiceState(roomId, channelId, true);
    this.broadcastHealth();
  }

  async roomVoiceLeave(roomId: string, channelId: string): Promise<void> {
    if (!this.rooms) return;
    const key = `${roomId}|${channelId}`;
    if (!this.localVoiceJoined.has(key)) return;
    this.localVoiceJoined.delete(key);
    if (this.localScreenPresenting.has(key)) {
      this.localScreenPresenting.delete(key);
      await this.rooms.broadcastScreenState(roomId, channelId, false).catch(() => undefined);
    }
    await this.rooms.broadcastVoiceState(roomId, channelId, false);
    this.broadcastHealth();
  }

  async roomVoiceSendAudio(roomId: string, channelId: string, data: Uint8Array): Promise<void> {
    if (!this.rooms) return;
    const key = `${roomId}|${channelId}`;
    if (!this.localVoiceJoined.has(key)) return;
    await this.rooms.broadcastVoiceAudio(roomId, channelId, data);
  }

  // ── screen share within a voice channel ───────────────────────────────
  async roomScreenStart(
    roomId: string,
    channelId: string,
    opts?: { sourceName?: string; resolution?: '480p' | '720p' | '1080p' },
  ): Promise<void> {
    if (!this.rooms) throw new Error('locked');
    const key = `${roomId}|${channelId}`;
    if (!this.localVoiceJoined.has(key)) throw new Error('Join the voice channel first');
    const remote = this.roomScreenPresenters.get(key);
    if (remote && remote.peerId !== this.peerIdStr()) {
      throw new Error(`${remote.screenName || 'Someone'} is already presenting`);
    }
    this.localScreenPresenting.add(key);
    await this.rooms.broadcastScreenState(roomId, channelId, true, opts);
  }

  async roomScreenStop(roomId: string, channelId: string): Promise<void> {
    if (!this.rooms) return;
    const key = `${roomId}|${channelId}`;
    if (!this.localScreenPresenting.has(key)) return;
    this.localScreenPresenting.delete(key);
    await this.rooms.broadcastScreenState(roomId, channelId, false);
  }

  async roomScreenSendVideo(roomId: string, channelId: string, data: Uint8Array): Promise<void> {
    if (!this.rooms) return;
    const key = `${roomId}|${channelId}`;
    if (!this.localScreenPresenting.has(key)) return;
    await this.rooms.broadcastScreenVideo(roomId, channelId, data);
  }

  // List remote peers currently joined to a voice channel (excludes us).
  roomVoicePresence(roomId: string, channelId: string): string[] {
    const key = `${roomId}|${channelId}`;
    return Array.from(this.roomVoiceMembers.get(key) ?? new Set<string>());
  }

  connectionHealth(): ConnectionHealth {
    const network = loadNetworkConfig();
    const updatedAt = Date.now();
    const locked = this.state !== 'unlocked';
    const p2pPeers = this.node?.getConnections().length ?? 0;
    const hiveInfo = this.hiveClient?.getConnectionInfo();
    const meshStatus = MeshNode.instance.status;
    const mailboxRelays = this.db ? repos.getPrefs(this.db).mailboxRelays.length : 0;
    const lastMailboxPoll = Object.values(this.mailbox?.lastPolledAt() ?? {}).sort((a, b) => b - a)[0];
    const activeVoiceChannels = this.localVoiceJoined.size;
    const remoteVoicePeers = Array.from(this.roomVoiceMembers.values()).reduce((sum, peers) => sum + peers.size, 0);

    const p2p: TransportHealth = locked || network.mode === 'server'
      ? { state: 'offline', label: 'P2P offline', detail: network.mode === 'server' ? 'Hive server mode is active.' : 'Sign on to start P2P.' }
      : { state: 'online', label: 'P2P online', detail: `${p2pPeers} peer connection${p2pPeers === 1 ? '' : 's'}`, count: p2pPeers };

    const hive: TransportHealth = network.mode !== 'server'
      ? { state: 'offline', label: 'Hive off', detail: 'Server mode is not active.' }
      : hiveInfo
        ? {
            state: hiveInfo.state === 'online' ? 'online' : hiveInfo.state === 'error' ? 'error' : hiveInfo.state,
            label: hiveInfo.state === 'online' ? 'Hive connected' : hiveInfo.state === 'error' ? 'Hive error' : 'Hive connecting',
            detail: hiveInfo.lastError ?? hiveInfo.serverUrl,
            lastOkAt: hiveInfo.lastConnectedAt,
          }
        : { state: locked ? 'offline' : 'connecting', label: locked ? 'Hive offline' : 'Hive starting', detail: network.serverUrl || undefined };

    const mesh: TransportHealth = network.mode !== 'exp-p2p'
      ? { state: 'offline', label: 'Mesh off', detail: 'Experimental mesh mode is not active.' }
      : meshStatus.state === 'connected'
        ? { state: 'online', label: 'Mesh connected', detail: (meshStatus as { ip: string }).ip }
        : meshStatus.state === 'error'
          ? { state: 'error', label: 'Mesh error', detail: (meshStatus as { message: string }).message }
          : { state: meshStatus.state === 'connecting' ? 'connecting' : 'offline', label: meshStatus.state === 'connecting' ? 'Mesh connecting' : 'Mesh stopped' };

    const mailbox: TransportHealth = this.mailbox
      ? { state: mailboxRelays > 0 ? 'online' : 'degraded', label: mailboxRelays > 0 ? 'Mailbox ready' : 'No mailbox relays', count: mailboxRelays, lastOkAt: lastMailboxPoll }
      : { state: locked || network.mode === 'server' ? 'offline' : 'degraded', label: locked ? 'Mailbox offline' : network.mode === 'server' ? 'Hive handles offline delivery' : 'Mailbox not started' };

    const call: TransportHealth = this.currentCall
      ? { state: 'online', label: `${this.currentCall.kind === 'video' ? 'Video' : 'Voice'} call active`, detail: this.currentCall.state, count: 1 }
      : { state: 'offline', label: 'No active call' };

    const roomVoice: TransportHealth = activeVoiceChannels > 0 || remoteVoicePeers > 0
      ? { state: 'online', label: 'Room voice active', detail: `${activeVoiceChannels} joined, ${remoteVoicePeers} remote`, count: activeVoiceChannels + remoteVoicePeers }
      : { state: 'offline', label: 'No room voice' };

    const primary = network.mode === 'server' ? hive.state : network.mode === 'exp-p2p' ? mesh.state : p2p.state;
    const summary: HealthState = locked
      ? 'offline'
      : primary === 'online'
        ? mailbox.state === 'degraded' ? 'degraded' : 'online'
        : primary;

    return { mode: network.mode, locked, summary, updatedAt, p2p, hive, mesh, mailbox, call, roomVoice };
  }

  private broadcastHealth(): void {
    this.broadcast(IPC.EvtHealth, this.connectionHealth());
  }

  private handleSelfPresenceChange(self: { status: string; baseStatus: string; awayMessage?: string }): void {
    // Mirror to Hive (server mode) so peers see the new status.
    if (this.hiveClient) {
      const wire = self.status === 'invisible' ? 'invisible'
        : self.status === 'dnd' ? 'dnd'
        : self.status === 'away' ? 'away'
        : self.status === 'idle' ? 'idle'
        : 'online';
      this.hiveClient.setStatus(wire as 'online' | 'away' | 'idle' | 'dnd' | 'invisible' | 'offline', self.awayMessage);
    }
    // Gate notifications: respect user pref AND suppress while DND.
    const prefs = this.db ? repos.getPrefs(this.db) : null;
    const notifPref = prefs?.notificationsEnabled ?? true;
    setNotificationsEnabled(notifPref && self.status !== 'dnd');
    // Tell renderers (so sound subsystem can mute, status pill updates, etc.).
    this.broadcast(IPC.EvtSelfPresence, self);
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  }
}

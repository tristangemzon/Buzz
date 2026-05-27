/**
 * HiveClient — Buzz client-side connector for Hive server mode.
 *
 * Replaces the libp2p stack when network.mode === 'server'.
 * Connects to a Hive server over WSS, authenticates with Ed25519 challenge-
 * response, then routes all chat/presence/rooms/talk through the server.
 *
 * Mirrors the callback shapes expected by session.ts so bringUp() can wire
 * up identically to the P2P path.
 */
import WebSocket from 'ws';
import type { IdentityMaterial } from '../crypto/keystore.js';

// ── Hive wire-protocol types (subset needed by the client) ──────────────────
// These mirror the types in the Hive server project's src/shared/types.ts.

export type UserStatus = 'online' | 'away' | 'idle' | 'invisible' | 'offline';

export type BuddyEntry = {
  peerId: string;
  screenName: string;
  status: UserStatus;
  awayMessage?: string;
};

export type BuddyRequest = {
  peerId: string;
  screenName: string;
  direction: 'in' | 'out';
  createdAt: number;
};

export type ChannelEntry = {
  id: string;
  name: string;
  kind: 'text' | 'voice';
};

export type RoomEntry = {
  id: string;
  name: string;
  members: string[];
  channels: ChannelEntry[];
};

// Subset of server→client messages that the client actually handles.
type SrvChallenge = { type: 'challenge'; nonce: string };
type SrvAuthed = { type: 'authed'; peerId: string; buddyList: BuddyEntry[]; pendingRequests: BuddyRequest[]; pubKeys: Record<string, string> };
type SrvPresenceUpdate = { type: 'presenceUpdate'; peerId: string; status: UserStatus; awayMessage?: string };
type SrvIm = { type: 'im'; from: string; msgId: string; ts: number; cipherB64: string };
type SrvBuddyRequest = { type: 'buddyRequest'; from: string; screenName: string };
type SrvBuddyResponse = { type: 'buddyResponse'; peerId: string; accepted: boolean; screenName: string; pubKeys?: Record<string, string> };
type SrvBuddyList = { type: 'buddyList'; buddies: BuddyEntry[]; pubKeys: Record<string, string> };
type SrvRoomInvite = { type: 'roomInvite'; roomId: string; name: string; from: string; keyEnvelopeB64: string; channels: ChannelEntry[]; members: string[]; ownerPeerId?: string };
type SrvRoomMsg = { type: 'roomMsg'; roomId: string; channelId: string; from: string; msgId: string; ts: number; cipherB64: string; fromName?: string; replyToId?: string; mentions?: string[] };
type SrvRoomMemberJoin = { type: 'roomMemberJoin'; roomId: string; peerId: string; screenName: string };
type SrvRoomMemberLeave = { type: 'roomMemberLeave'; roomId: string; peerId: string };
type SrvTalkSignal = { type: 'talkSignal'; from: string; callId: string; signal: string; payload: unknown };
type SrvGameSignal = { type: 'gameSignal'; from: string; action: string; kind: string; path?: number[] };
type SrvError = { type: 'error'; code: string; message: string };
type SrvReaction = { type: 'reaction'; from: string; msgId: string; emoji: string; added: boolean };
type SrvRoomReaction = { type: 'roomReaction'; roomId: string; from: string; msgId: string; emoji: string; added: boolean };
type SrvRoomEditMsg = { type: 'roomEditMsg'; roomId: string; from: string; msgId: string; ts: number; cipherB64: string };
type SrvRoomDeleteMsg = { type: 'roomDeleteMsg'; roomId: string; from: string; msgId: string; ts: number };
type SrvTyping = { type: 'typing'; from: string; typing: boolean };
type SrvReadReceipt = { type: 'readReceipt'; from: string; msgId: string };
type SrvRoomPin = { type: 'roomPin'; roomId: string; from: string; msgId: string; isPinned: boolean };
type SrvRoomKick = { type: 'roomKick'; roomId: string; from: string; peerId: string };
type SrvRoomRole = { type: 'roomRole'; roomId: string; from: string; peerId: string; role: string };
type SrvRoomCategory = { type: 'roomCategory'; roomId: string; channelId: string; category: string };
type SrvRoomChannelAdd = { type: 'roomChannelAdd'; roomId: string; channelId: string; name: string; kind: 'text' | 'voice' };
type ServerMessage = SrvChallenge | SrvAuthed | SrvPresenceUpdate | SrvIm | SrvBuddyRequest | SrvBuddyResponse | SrvBuddyList | SrvRoomInvite | SrvRoomMsg | SrvRoomMemberJoin | SrvRoomMemberLeave | SrvTalkSignal | SrvGameSignal | SrvError | SrvReaction | SrvRoomReaction | SrvRoomEditMsg | SrvRoomDeleteMsg | SrvTyping | SrvReadReceipt | SrvRoomPin | SrvRoomKick | SrvRoomRole | SrvRoomCategory | SrvRoomChannelAdd;

// Subset of client→server messages that the client sends.
type CliAuth = { type: 'auth'; peerId: string; screenName: string; pubKeyB64: string; sigB64: string };
type CliSetStatus = { type: 'setStatus'; status: UserStatus; awayMessage?: string };
type CliIm = { type: 'im'; to: string; msgId: string; ts: number; cipherB64: string };
type CliAck = { type: 'ack'; msgId: string };
type CliBuddyAdd = { type: 'buddyAdd'; targetPeerId: string };
type CliBuddyRemove = { type: 'buddyRemove'; targetPeerId: string };
type CliBuddyApprove = { type: 'buddyApprove'; targetPeerId: string };
type CliBuddyDeny = { type: 'buddyDeny'; targetPeerId: string };
type CliRoomCreate = { type: 'roomCreate'; roomId: string; name: string; keyEnvelopes: Array<{ peerId: string; cipherB64: string }>; memberPeerIds: string[] };
type CliRoomInvite = { type: 'roomInvite'; roomId: string; targetPeerId: string; keyEnvelopeB64: string };
type CliRoomMsg = { type: 'roomMsg'; roomId: string; channelId: string; msgId: string; ts: number; cipherB64: string; fromName?: string; replyToId?: string; mentions?: string[] };
type CliRoomChannelAdd = { type: 'roomChannelAdd'; roomId: string; channelId: string; name: string; kind: 'text' | 'voice' };
type CliGetHistory = { type: 'getHistory'; peerId: string; before?: number; limit?: number };
type CliGetRoomHistory = { type: 'getRoomHistory'; roomId: string; channelId: string; before?: number; limit?: number };
type CliTalkSignal = { type: 'talkSignal'; to: string; callId: string; signal: string; payload: unknown };
type CliGameSignal = { type: 'gameSignal'; to: string; action: string; kind: string; path?: number[] };
type CliReaction = { type: 'reaction'; to: string; msgId: string; emoji: string };
type CliUnreaction = { type: 'unreaction'; to: string; msgId: string; emoji: string };
type CliRoomReaction = { type: 'roomReaction'; roomId: string; msgId: string; emoji: string };
type CliRoomUnreaction = { type: 'roomUnreaction'; roomId: string; msgId: string; emoji: string };
type CliRoomEditMsg = { type: 'roomEditMsg'; roomId: string; msgId: string; ts: number; cipherB64: string };
type CliRoomDeleteMsg = { type: 'roomDeleteMsg'; roomId: string; msgId: string; ts: number };
type CliTyping = { type: 'typing'; to: string; typing: boolean };
type CliReadReceipt = { type: 'readReceipt'; to: string; msgId: string };
type CliRoomPin = { type: 'roomPin'; roomId: string; msgId: string; isPinned: boolean };
type CliRoomKick = { type: 'roomKick'; roomId: string; peerId: string };
type CliRoomRole = { type: 'roomRole'; roomId: string; peerId: string; role: string };
type CliRoomCategory = { type: 'roomCategory'; roomId: string; channelId: string; category: string };
type ClientMessage = CliAuth | CliSetStatus | CliIm | CliAck | CliBuddyAdd | CliBuddyRemove | CliBuddyApprove | CliBuddyDeny | CliRoomCreate | CliRoomInvite | CliRoomMsg | CliRoomChannelAdd | CliGetHistory | CliGetRoomHistory | CliTalkSignal | CliGameSignal | CliReaction | CliUnreaction | CliRoomReaction | CliRoomUnreaction | CliRoomEditMsg | CliRoomDeleteMsg | CliTyping | CliReadReceipt | CliRoomPin | CliRoomKick | CliRoomRole | CliRoomCategory;

// Sodium import — same pattern as keystore.ts uses.
import sodiumPkg from 'libsodium-wrappers-sumo';
const sodium = sodiumPkg;

// Maximum reconnect backoff in ms.
const MAX_BACKOFF_MS = 30_000;
// How long to wait for a pong before treating the connection as dead.
const PING_TIMEOUT_MS = 20_000;
// Binary frame type bytes (must match Hive server/handlers.ts).
const BINARY_AUDIO = 0xa1;
const BINARY_VIDEO = 0xa2;
const BINARY_SCREEN = 0xa3;

export type HiveCallbacks = {
  onMessage: (peerId: string, msgId: string, ts: number, cipherB64: string) => void;
  onAck: (msgId: string) => void;
  onBuddyStatus: (peerId: string, status: UserStatus, awayMessage?: string) => void;
  onBuddyList: (buddies: BuddyEntry[], pubKeys: Record<string, string>) => void;
  onBuddyRequest: (peerId: string, screenName: string) => void;
  onBuddyResponse: (peerId: string, accepted: boolean, screenName: string) => void;
  onRoomInvite: (invite: RoomEntry & { keyEnvelopeB64: string; from: string; ownerPeerId?: string }) => void;
  onRoomMsg: (roomId: string, channelId: string, from: string, msgId: string, ts: number, cipherB64: string, opts?: { fromName?: string; replyToId?: string; mentions?: string[] }) => void;
  onRoomMemberJoin: (roomId: string, peerId: string, screenName: string) => void;
  onRoomMemberLeave: (roomId: string, peerId: string) => void;
  onTalkSignal: (from: string, callId: string, signal: string, payload: unknown) => void;
  onTalkAudio: (from: string, callId: string, buf: Buffer) => void;
  onTalkVideo: (from: string, callId: string, buf: Buffer) => void;
  onTalkScreen: (from: string, callId: string, buf: Buffer) => void;
  onGameSignal?: (from: string, action: string, kind: string, path?: number[]) => void;
  onAuthed: (peerId: string, buddies: BuddyEntry[], pendingRequests: BuddyRequest[], pubKeys: Record<string, string>) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  onError: (err: Error) => void;
  // Reactions
  onReaction?: (from: string, msgId: string, emoji: string, added: boolean) => void;
  onRoomReaction?: (roomId: string, from: string, msgId: string, emoji: string, added: boolean) => void;
  onRoomEditMsg?: (roomId: string, from: string, msgId: string, ts: number, cipherB64: string) => void;
  onRoomDeleteMsg?: (roomId: string, from: string, msgId: string, ts: number) => void;
  // Typing indicator
  onTyping?: (from: string, typing: boolean) => void;
  // Read receipts
  onReadReceipt?: (from: string, msgId: string) => void;
  // v0.6.0 room moderation
  onRoomPin?: (roomId: string, from: string, msgId: string, isPinned: boolean) => void;
  onRoomKick?: (roomId: string, from: string, peerId: string) => void;
  onRoomRole?: (roomId: string, from: string, peerId: string, role: string) => void;
  onRoomCategory?: (roomId: string, channelId: string, category: string) => void;
  onRoomChannelAdd?: (roomId: string, channelId: string, name: string, kind: 'text' | 'voice') => void;
};

export type HiveConnectionInfo = {
  state: 'offline' | 'connecting' | 'online' | 'error';
  serverUrl: string;
  lastConnectedAt?: number;
  lastError?: string;
  nextReconnectAt?: number;
};

export class HiveClient {
  private ws: WebSocket | null = null;
  private identity: IdentityMaterial;
  private serverUrl: string;
  private callbacks: HiveCallbacks;

  // peerId derived from identity (set once sodium is ready).
  private peerId = '';
  // Ed25519 pubkey base64.
  private pubKeyB64 = '';
  // X25519 pubkey base64 (for sealing messages to self).
  private x25519PubKeyB64 = '';
  // Peer pubkeys received from server (ed25519, base64).
  private peerPubKeys = new Map<string, string>();
  // X25519 pubkeys derived from peer ed25519 keys (lazy cache).
  private peerX25519Keys = new Map<string, Uint8Array>();

  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private backoff = 2_000;
  private stopped = false;
  private authed = false;
  private screenName: string;
  // Accept invalid TLS certs for self-signed Hive servers.
  private rejectUnauthorized: boolean;
  private connectionState: HiveConnectionInfo['state'] = 'offline';
  private lastConnectedAt: number | undefined;
  private lastError: string | undefined;
  private nextReconnectAt: number | undefined;

  constructor(
    identity: IdentityMaterial,
    serverUrl: string,
    screenName: string,
    callbacks: HiveCallbacks,
    opts: { rejectUnauthorized?: boolean } = {},
  ) {
    this.identity = identity;
    this.serverUrl = serverUrl;
    this.screenName = screenName;
    this.callbacks = callbacks;
    this.rejectUnauthorized = opts.rejectUnauthorized ?? false;
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.connectionState = 'connecting';
    await sodium.ready;

    // Derive peerId from the Ed25519 seed stored in identity.
    // identity.seed is a 32-byte Uint8Array → derive Ed25519 keypair.
    const kp = sodium.crypto_sign_seed_keypair(this.identity.seed);
    // Encode peerId as multibase base58btc of the public key bytes for compat with Buzz P2P.
    // For Hive mode we just use base64url of the pubkey as the peer identifier.
    this.pubKeyB64 = Buffer.from(kp.publicKey).toString('base64');
    // Derive X25519 pubkey for sealing messages to self.
    const x25519Pub = sodium.crypto_sign_ed25519_pk_to_curve25519(kp.publicKey);
    this.x25519PubKeyB64 = Buffer.from(x25519Pub).toString('base64');
    // peerId: sha256 of pubkey, hex — simple deterministic identifier.
    const { createHash } = await import('node:crypto');
    this.peerId = createHash('sha256').update(kp.publicKey).digest('hex');

    this._connect();
  }

  private _connect(): void {
    if (this.stopped) return;
    this.connectionState = 'connecting';
    this.nextReconnectAt = undefined;

    this.ws = new WebSocket(this.serverUrl, {
      rejectUnauthorized: this.rejectUnauthorized,
    });
    this.ws.binaryType = 'nodebuffer';

    this.ws.on('open', () => {
      this.backoff = 2_000;
      this._startPing();
    });

    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this._handleBinary(data as Buffer);
      } else {
        this._handleText(data.toString('utf8'));
      }
    });

    this.ws.on('close', () => {
      this._stopPing();
      this.authed = false;
      this.callbacks.onDisconnected();
      if (!this.stopped) {
        this.connectionState = 'connecting';
        this.nextReconnectAt = Date.now() + this.backoff;
        this.reconnectTimer = setTimeout(() => this._connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      } else {
        this.connectionState = 'offline';
        this.nextReconnectAt = undefined;
      }
    });

    this.ws.on('error', (err) => {
      this.connectionState = 'error';
      this.lastError = err.message;
      this.callbacks.onError(err);
    });
  }

  disconnect(): void {
    this.stopped = true;
    this.connectionState = 'offline';
    this.nextReconnectAt = undefined;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this._stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  getConnectionInfo(): HiveConnectionInfo {
    return {
      state: this.connectionState,
      serverUrl: this.serverUrl,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
      nextReconnectAt: this.nextReconnectAt,
    };
  }

  // ── Ping keepalive ─────────────────────────────────────────────────────────

  private _startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
        // If we don't get a pong within timeout, close.
        const t = setTimeout(() => { this.ws?.close(); }, PING_TIMEOUT_MS);
        this.ws.once('pong', () => clearTimeout(t));
      }
    }, 15_000);
  }

  private _stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  // ── Message handling ───────────────────────────────────────────────────────

  private _handleText(text: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'challenge':
        this._respondToChallenge(msg.nonce);
        break;
      case 'authed':
        this.authed = true;
        this.connectionState = 'online';
        this.lastConnectedAt = Date.now();
        this.lastError = undefined;
        this.nextReconnectAt = undefined;
        for (const [pid, pk] of Object.entries(msg.pubKeys)) {
          this.peerPubKeys.set(pid, pk);
        }
        this.callbacks.onAuthed(msg.peerId, msg.buddyList, msg.pendingRequests, msg.pubKeys);
        this.callbacks.onConnected();
        break;
      case 'presenceUpdate':
        this.callbacks.onBuddyStatus(msg.peerId, msg.status, msg.awayMessage);
        break;
      case 'im':
        this.callbacks.onMessage(msg.from, msg.msgId, msg.ts, msg.cipherB64);
        break;
      case 'buddyRequest':
        this.callbacks.onBuddyRequest(msg.from, msg.screenName);
        break;
      case 'buddyResponse':
        if (msg.pubKeys) {
          for (const [pid, pk] of Object.entries(msg.pubKeys as Record<string, string>)) {
            this.peerPubKeys.set(pid, pk);
          }
        }
        this.callbacks.onBuddyResponse(msg.peerId, msg.accepted, msg.screenName);
        break;
      case 'buddyList':
        for (const [pid, pk] of Object.entries(msg.pubKeys)) {
          this.peerPubKeys.set(pid, pk);
        }
        this.callbacks.onBuddyList(msg.buddies, msg.pubKeys);
        break;
      case 'roomInvite':
        this.callbacks.onRoomInvite({
          id: msg.roomId,
          name: msg.name,
          members: msg.members,
          channels: msg.channels,
          keyEnvelopeB64: msg.keyEnvelopeB64,
          from: msg.from,
          ownerPeerId: msg.ownerPeerId,
        });
        break;
      case 'roomMsg':
        this.callbacks.onRoomMsg(
          msg.roomId, msg.channelId, msg.from, msg.msgId, msg.ts, msg.cipherB64,
          (msg.fromName !== undefined || msg.replyToId !== undefined || msg.mentions !== undefined)
            ? { fromName: msg.fromName, replyToId: msg.replyToId, mentions: msg.mentions }
            : undefined,
        );
        break;
      case 'roomMemberJoin':
        this.callbacks.onRoomMemberJoin(msg.roomId, msg.peerId, msg.screenName);
        break;
      case 'roomMemberLeave':
        this.callbacks.onRoomMemberLeave(msg.roomId, msg.peerId);
        break;
      case 'talkSignal':
        this.callbacks.onTalkSignal(msg.from, msg.callId, msg.signal, msg.payload);
        break;
      case 'gameSignal':
        if (this.callbacks.onGameSignal && typeof msg.from === 'string' && typeof msg.action === 'string' && typeof msg.kind === 'string') {
          this.callbacks.onGameSignal(msg.from, msg.action, msg.kind, Array.isArray(msg.path) ? msg.path : undefined);
        }
        break;
      case 'reaction':
        this.callbacks.onReaction?.(msg.from, msg.msgId, msg.emoji, msg.added);
        break;
      case 'roomReaction':
        this.callbacks.onRoomReaction?.(msg.roomId, msg.from, msg.msgId, msg.emoji, msg.added);
        break;
      case 'roomEditMsg':
        this.callbacks.onRoomEditMsg?.(msg.roomId, msg.from, msg.msgId, msg.ts, msg.cipherB64);
        break;
      case 'roomDeleteMsg':
        this.callbacks.onRoomDeleteMsg?.(msg.roomId, msg.from, msg.msgId, msg.ts);
        break;
      case 'typing':
        this.callbacks.onTyping?.(msg.from, msg.typing);
        break;
      case 'readReceipt':
        this.callbacks.onReadReceipt?.(msg.from, msg.msgId);
        break;
      case 'roomPin':
        this.callbacks.onRoomPin?.(msg.roomId, msg.from, msg.msgId, msg.isPinned);
        break;
      case 'roomKick':
        this.callbacks.onRoomKick?.(msg.roomId, msg.from, msg.peerId);
        break;
      case 'roomRole':
        this.callbacks.onRoomRole?.(msg.roomId, msg.from, msg.peerId, msg.role);
        break;
      case 'roomCategory':
        this.callbacks.onRoomCategory?.(msg.roomId, msg.channelId, msg.category);
        break;
      case 'roomChannelAdd':
        this.callbacks.onRoomChannelAdd?.(msg.roomId, msg.channelId, msg.name, msg.kind);
        break;
      case 'error':
        this.callbacks.onError(new Error(`[hive] ${msg.code}: ${msg.message}`));
        break;
      default:
        break;
    }
  }

  private _handleBinary(buf: Buffer): void {
    if (buf.length < 3) return;
    const type = buf[0];
    if (type !== BINARY_AUDIO && type !== BINARY_VIDEO && type !== BINARY_SCREEN) return;

    // Parse: [1 type][2 fromPeerIdLen][fromPeerId][2 callIdLen][callId][...payload]
    let offset = 1;
    if (buf.length < offset + 2) return;
    const fromLen = buf.readUInt16LE(offset); offset += 2;
    if (buf.length < offset + fromLen) return;
    const from = buf.subarray(offset, offset + fromLen).toString('utf8'); offset += fromLen;
    if (buf.length < offset + 2) return;
    const callIdLen = buf.readUInt16LE(offset); offset += 2;
    if (buf.length < offset + callIdLen) return;
    const callId = buf.subarray(offset, offset + callIdLen).toString('utf8'); offset += callIdLen;
    const payload = buf.subarray(offset);

    if (type === BINARY_AUDIO) {
      this.callbacks.onTalkAudio(from, callId, payload);
    } else if (type === BINARY_VIDEO) {
      this.callbacks.onTalkVideo(from, callId, payload);
    } else {
      this.callbacks.onTalkScreen(from, callId, payload);
    }
  }

  private _respondToChallenge(nonce: string): void {
    const nonceBytes = Buffer.from(nonce, 'base64');
    const peerIdBytes = Buffer.from(this.peerId, 'utf8');
    const message = Buffer.concat([nonceBytes, peerIdBytes]);
    const kp = sodium.crypto_sign_seed_keypair(this.identity.seed);
    const sig = sodium.crypto_sign_detached(message, kp.privateKey);
    const sigB64 = Buffer.from(sig).toString('base64');

    this._send({
      type: 'auth',
      peerId: this.peerId,
      screenName: this.screenName,
      pubKeyB64: this.pubKeyB64,
      sigB64,
    });
  }

  // ── Send helpers ───────────────────────────────────────────────────────────

  private _send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private _sendBinary(buf: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(buf);
    }
  }

  // ── Crypto helpers ─────────────────────────────────────────────────────────

  /** Get or derive the X25519 pubkey for a peer (from their Ed25519 pubkey). */
  private _getX25519PubKey(peerId: string): Uint8Array | null {
    const cached = this.peerX25519Keys.get(peerId);
    if (cached) return cached;
    const edPubB64 = this.peerPubKeys.get(peerId);
    if (!edPubB64) return null;
    try {
      const edPub = Uint8Array.from(Buffer.from(edPubB64, 'base64'));
      const x25519 = sodium.crypto_sign_ed25519_pk_to_curve25519(edPub);
      this.peerX25519Keys.set(peerId, x25519);
      return x25519;
    } catch {
      return null;
    }
  }

  /** Register a peer's pubkey (used when buddy is added after initial auth). */
  registerPeerPubKey(peerId: string, pubKeyB64: string): void {
    this.peerPubKeys.set(peerId, pubKeyB64);
    // Evict X25519 cache if stale.
    this.peerX25519Keys.delete(peerId);
  }

  /** Seal a plaintext message to a peer using their X25519 pubkey (sealed_box). */
  sealMessage(toPeerId: string, plaintext: string): string | null {
    const x25519Pub = this._getX25519PubKey(toPeerId);
    if (!x25519Pub) return null;
    try {
      const ptBytes = Buffer.from(plaintext, 'utf8');
      const cipher = sodium.crypto_box_seal(ptBytes, x25519Pub);
      return Buffer.from(cipher).toString('base64');
    } catch {
      return null;
    }
  }

  /**
   * Open a sealed_box message that was encrypted to our X25519 pubkey.
   * Returns null if decryption fails.
   */
  openMessage(cipherB64: string): string | null {
    try {
      const kp = sodium.crypto_sign_seed_keypair(this.identity.seed);
      const myX25519Priv = sodium.crypto_sign_ed25519_sk_to_curve25519(kp.privateKey);
      const myX25519Pub = sodium.crypto_sign_ed25519_pk_to_curve25519(kp.publicKey);
      const cipher = Uint8Array.from(Buffer.from(cipherB64, 'base64'));
      const plain = sodium.crypto_box_seal_open(cipher, myX25519Pub, myX25519Priv);
      return Buffer.from(plain).toString('utf8');
    } catch {
      return null;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getPeerId(): string { return this.peerId; }
  isAuthed(): boolean { return this.authed; }
  getX25519PubKeyB64(): string { return this.x25519PubKeyB64; }

  setStatus(status: UserStatus, awayMessage?: string): void {
    this._send({ type: 'setStatus', status, awayMessage });
  }

  sendIm(toPeerId: string, msgId: string, ts: number, cipherB64: string): void {
    this._send({ type: 'im', to: toPeerId, msgId, ts, cipherB64 });
  }

  sendAck(msgId: string): void {
    this._send({ type: 'ack', msgId });
  }

  addBuddy(targetPeerId: string): void {
    this._send({ type: 'buddyAdd', targetPeerId });
  }

  removeBuddy(targetPeerId: string): void {
    this._send({ type: 'buddyRemove', targetPeerId });
  }

  approveBuddy(targetPeerId: string): void {
    this._send({ type: 'buddyApprove', targetPeerId });
  }

  denyBuddy(targetPeerId: string): void {
    this._send({ type: 'buddyDeny', targetPeerId });
  }

  createRoom(
    roomId: string,
    name: string,
    keyEnvelopes: Array<{ peerId: string; cipherB64: string }>,
    memberPeerIds: string[],
  ): void {
    this._send({ type: 'roomCreate', roomId, name, keyEnvelopes, memberPeerIds });
  }

  inviteToRoom(roomId: string, targetPeerId: string, keyEnvelopeB64: string): void {
    this._send({ type: 'roomInvite', roomId, targetPeerId, keyEnvelopeB64 });
  }

  sendRoomMsg(roomId: string, channelId: string, msgId: string, ts: number, cipherB64: string, opts?: { fromName?: string; replyToId?: string; mentions?: string[] }): void {
    this._send({ type: 'roomMsg', roomId, channelId, msgId, ts, cipherB64, ...opts });
  }

  addRoomChannel(roomId: string, channelId: string, name: string, kind: 'text' | 'voice'): void {
    this._send({ type: 'roomChannelAdd', roomId, channelId, name, kind });
  }

  getHistory(peerId: string, before?: number, limit?: number): void {
    this._send({ type: 'getHistory', peerId, before, limit });
  }

  getRoomHistory(roomId: string, channelId: string, before?: number, limit?: number): void {
    this._send({ type: 'getRoomHistory', roomId, channelId, before, limit });
  }

  sendTalkSignal(to: string, callId: string, signal: string, payload: unknown): void {
    this._send({ type: 'talkSignal', to, callId, signal, payload });
  }

  sendGame(to: string, action: string, kind: string, path?: number[]): void {
    this._send({ type: 'gameSignal', to, action, kind, ...(path ? { path } : {}) });
  }

  /**
   * Send an encrypted audio/video binary frame to a peer via the server.
   *
   * Frame: [1 byte type][2 LE toPeerIdLen][toPeerId][2 LE callIdLen][callId][payload]
   */
  private _sendMediaFrame(type: typeof BINARY_AUDIO | typeof BINARY_VIDEO | typeof BINARY_SCREEN, to: string, callId: string, payload: Buffer): void {
    const toBytes = Buffer.from(to, 'utf8');
    const callIdBytes = Buffer.from(callId, 'utf8');
    const buf = Buffer.allocUnsafe(1 + 2 + toBytes.length + 2 + callIdBytes.length + payload.length);
    let off = 0;
    buf[off++] = type;
    buf.writeUInt16LE(toBytes.length, off); off += 2;
    toBytes.copy(buf, off); off += toBytes.length;
    buf.writeUInt16LE(callIdBytes.length, off); off += 2;
    callIdBytes.copy(buf, off); off += callIdBytes.length;
    payload.copy(buf, off);
    this._sendBinary(buf);
  }

  sendTalkAudio(to: string, callId: string, payload: Buffer): void {
    this._sendMediaFrame(BINARY_AUDIO, to, callId, payload);
  }

  sendTalkVideo(to: string, callId: string, payload: Buffer): void {
    this._sendMediaFrame(BINARY_VIDEO, to, callId, payload);
  }

  sendTalkScreen(to: string, callId: string, payload: Buffer): void {
    this._sendMediaFrame(BINARY_SCREEN, to, callId, payload);
  }

  sendTyping(to: string, typing: boolean): void {
    this._send({ type: 'typing', to, typing });
  }

  sendReadReceipt(to: string, msgId: string): void {
    this._send({ type: 'readReceipt', to, msgId });
  }

  sendReaction(to: string, msgId: string, emoji: string): void {
    this._send({ type: 'reaction', to, msgId, emoji });
  }

  sendUnreaction(to: string, msgId: string, emoji: string): void {
    this._send({ type: 'unreaction', to, msgId, emoji });
  }

  sendRoomReaction(roomId: string, msgId: string, emoji: string): void {
    this._send({ type: 'roomReaction', roomId, msgId, emoji });
  }

  sendRoomUnreaction(roomId: string, msgId: string, emoji: string): void {
    this._send({ type: 'roomUnreaction', roomId, msgId, emoji });
  }

  sendRoomEditMsg(roomId: string, msgId: string, ts: number, cipherB64: string): void {
    this._send({ type: 'roomEditMsg', roomId, msgId, ts, cipherB64 });
  }

  sendRoomDeleteMsg(roomId: string, msgId: string, ts: number): void {
    this._send({ type: 'roomDeleteMsg', roomId, msgId, ts });
  }

  sendRoomPin(roomId: string, msgId: string, isPinned: boolean): void {
    this._send({ type: 'roomPin', roomId, msgId, isPinned });
  }

  sendRoomKick(roomId: string, peerId: string): void {
    this._send({ type: 'roomKick', roomId, peerId });
  }

  sendRoomRole(roomId: string, peerId: string, role: string): void {
    this._send({ type: 'roomRole', roomId, peerId, role });
  }

  sendRoomCategory(roomId: string, channelId: string, category: string): void {
    this._send({ type: 'roomCategory', roomId, channelId, category });
  }
}

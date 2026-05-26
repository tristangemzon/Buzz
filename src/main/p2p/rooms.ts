// Multi-party chat rooms.
//
// Design (sealed-key model):
//
//   • Each room has a unique 32-byte symmetric key (XSalsa20-Poly1305 secretbox).
//     The creator generates it; invitees receive it inside a `room-invite`
//     frame on the existing /buzz/im/1.0.0 channel — that channel is already
//     Noise-XX encrypted to the invitee, so the key is end-to-end confidential
//     (and authenticated) without an extra sealed_box layer.
//
//   • Every room message is encrypted with that key (random 24-byte nonce) and
//     fanned out to each member via the same 1:1 IM transport. Non-members
//     never see frames; even if they did, ciphertext is unreadable without
//     the room key. This is conceptually equivalent to gossipsub + a sealed
//     room key, with the gossip topology replaced by a small full-mesh
//     broadcast (perfectly fine for AIM-style rooms of a handful of buddies).
//
//   • Membership changes (`room-meta`, `room-leave`) propagate the same way.

import { randomUUID } from 'node:crypto';
import { sodium } from '../crypto/keystore.js';
import type {
  ImService,
  RoomCategoryPayload,
  RoomChannelAddPayload,
  RoomChannelDelPayload,
  RoomInvitePayload,
  RoomKickPayload,
  RoomMsgPayload,
  RoomMetaPayload,
  RoomPinPayload,
  RoomRolePayload,
  RoomVoiceStatePayload,
  RoomVoiceAudioPayload,
  RoomReactionPayload,
  RoomEditMsgPayload,
  RoomDeleteMsgPayload,
} from './im.js';

export type RoomServiceEvents = {
  onInvite(fromPeerId: string, p: RoomInvitePayload): void;
  onMessage(
    fromPeerId: string,
    msg: { roomId: string; channelId: string; id: string; ts: number; body: string; fromName: string; replyToId?: string; mentions?: string[] },
  ): void;
  onMembers(roomId: string, members: string[], name?: string): void;
  onLeave(fromPeerId: string, roomId: string): void;
  onChannelAdd(fromPeerId: string, p: RoomChannelAddPayload): void;
  onChannelDel(fromPeerId: string, p: RoomChannelDelPayload): void;
  onVoiceState(fromPeerId: string, p: RoomVoiceStatePayload): void;
  onVoiceAudio(fromPeerId: string, p: RoomVoiceAudioPayload): void;
  // v0.6.0 moderation
  onPin(fromPeerId: string, p: RoomPinPayload): void;
  onKick(fromPeerId: string, p: RoomKickPayload): void;
  onRole(fromPeerId: string, p: RoomRolePayload): void;
  onCategory(fromPeerId: string, p: RoomCategoryPayload): void;
  // v0.7.0 message actions
  onReaction(fromPeerId: string, p: RoomReactionPayload): void;
  onEditMsg(fromPeerId: string, p: RoomEditMsgPayload): void;
  onDeleteMsg(fromPeerId: string, p: RoomDeleteMsgPayload): void;
};

export type RoomBridge = {
  // Key bytes (32 B) for a room we're a member of, or null.
  getRoomKey(roomId: string): Uint8Array | null;
  // Current member peer ids for a room we know about.
  getRoomMembers(roomId: string): string[];
  // Our own identity for filling out from-fields.
  myPeerId(): string;
  myScreenName(): string;
};

export class RoomService {
  constructor(
    private readonly im: ImService,
    private readonly events: RoomServiceEvents,
    private readonly bridge: RoomBridge,
  ) {}

  // ── inbound (wire these into ImEvents) ─────────────────────────────────
  readonly handleInvite = (fromPeerId: string, p: RoomInvitePayload): void => {
    this.events.onInvite(fromPeerId, p);
  };
  readonly handleMsg = (fromPeerId: string, p: RoomMsgPayload): void => {
    void this.decryptAndDispatch(fromPeerId, p);
  };
  readonly handleLeave = (fromPeerId: string, roomId: string): void => {
    this.events.onLeave(fromPeerId, roomId);
  };
  readonly handleMeta = (_fromPeerId: string, p: RoomMetaPayload): void => {
    this.events.onMembers(
      p.roomId,
      p.members ?? this.bridge.getRoomMembers(p.roomId),
      p.name,
    );
  };
  readonly handleChannelAdd = (fromPeerId: string, p: RoomChannelAddPayload): void => {
    this.events.onChannelAdd(fromPeerId, p);
  };
  readonly handleChannelDel = (fromPeerId: string, p: RoomChannelDelPayload): void => {
    this.events.onChannelDel(fromPeerId, p);
  };
  readonly handleVoiceState = (fromPeerId: string, p: RoomVoiceStatePayload): void => {
    this.events.onVoiceState(fromPeerId, p);
  };
  readonly handleVoiceAudio = (fromPeerId: string, p: RoomVoiceAudioPayload): void => {
    this.events.onVoiceAudio(fromPeerId, p);
  };
  readonly handlePin = (fromPeerId: string, p: RoomPinPayload): void => {
    this.events.onPin(fromPeerId, p);
  };
  readonly handleKick = (fromPeerId: string, p: RoomKickPayload): void => {
    this.events.onKick(fromPeerId, p);
  };
  readonly handleRole = (fromPeerId: string, p: RoomRolePayload): void => {
    this.events.onRole(fromPeerId, p);
  };
  readonly handleCategory = (fromPeerId: string, p: RoomCategoryPayload): void => {
    this.events.onCategory(fromPeerId, p);
  };
  readonly handleReaction = (fromPeerId: string, p: RoomReactionPayload): void => {
    this.events.onReaction(fromPeerId, p);
  };
  readonly handleEditMsg = (fromPeerId: string, p: RoomEditMsgPayload): void => {
    this.events.onEditMsg(fromPeerId, p);
  };
  readonly handleDeleteMsg = (fromPeerId: string, p: RoomDeleteMsgPayload): void => {
    this.events.onDeleteMsg(fromPeerId, p);
  };

  private async decryptAndDispatch(fromPeerId: string, p: RoomMsgPayload): Promise<void> {
    const key = this.bridge.getRoomKey(p.roomId);
    if (!key) return; // Not a member; drop silently.
    try {
      const s = await sodium();
      const ct = s.from_base64(p.ctB64, s.base64_variants.ORIGINAL);
      const nonce = s.from_base64(p.nonceB64, s.base64_variants.ORIGINAL);
      const plain = s.crypto_secretbox_open_easy(ct, nonce, key);
      const body = s.to_string(plain);
      this.events.onMessage(fromPeerId, {
        roomId: p.roomId,
        channelId: p.channelId,
        id: p.id,
        ts: p.ts,
        body,
        fromName: p.fromName ?? '',
        replyToId: p.replyToId,
        mentions: p.mentions,
      });
    } catch {
      // Auth failure or stale key — drop.
    }
  }

  // ── outbound ───────────────────────────────────────────────────────────
  async newKey(): Promise<Uint8Array> {
    const s = await sodium();
    return s.randombytes_buf(32);
  }

  async createRoom(opts: {
    name: string;
    members: string[];
    ownerPeerId?: string;
    channels?: Array<{ id: string; name: string; isDefault: boolean; createdAt: number; kind?: 'text' | 'voice' }>;
  }): Promise<{ roomId: string; keyB64: string; createdAt: number; members: string[] }> {
    const s = await sodium();
    const roomId = randomUUID();
    const key = await this.newKey();
    const keyB64 = s.to_base64(key, s.base64_variants.ORIGINAL);
    const createdAt = Date.now();
    const me = this.bridge.myPeerId();
    const fullMembers = uniq([me, ...opts.members]);
    await Promise.all(
      fullMembers
        .filter((m) => m !== me)
        .map((peer) =>
          this.im
            .send(peer, {
              type: 'room-invite',
              roomId,
              name: opts.name,
              members: fullMembers,
              keyB64,
              ts: createdAt,
              ownerPeerId: opts.ownerPeerId ?? me,
              channels: opts.channels,
            })
            .catch(() => undefined),
        ),
    );
    return { roomId, keyB64, createdAt, members: fullMembers };
  }

  async invite(
    roomId: string,
    peerId: string,
    name: string,
    channels?: Array<{ id: string; name: string; isDefault: boolean; createdAt: number; kind?: 'text' | 'voice' }>,
    ownerPeerId?: string,
  ): Promise<string[]> {
    const key = this.bridge.getRoomKey(roomId);
    if (!key) throw new Error('Unknown or non-member room');
    const s = await sodium();
    const keyB64 = s.to_base64(key, s.base64_variants.ORIGINAL);
    const members = uniq([...this.bridge.getRoomMembers(roomId), peerId]);
    await this.im
      .send(peerId, {
        type: 'room-invite',
        roomId,
        name,
        members,
        keyB64,
        ts: Date.now(),
        ownerPeerId,
        channels,
      })
      .catch(() => undefined);
    await this.broadcastMeta(roomId, { roomId, members, name });
    return members;
  }

  async sendMessage(
    roomId: string,
    channelId: string,
    body: string,
    opts?: { replyToId?: string; mentions?: string[] },
  ): Promise<{ id: string; ts: number }> {
    const key = this.bridge.getRoomKey(roomId);
    if (!key) throw new Error('Unknown room');
    const s = await sodium();
    const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
    const plain = s.from_string(body);
    const ct = s.crypto_secretbox_easy(plain, nonce, key);
    const id = randomUUID();
    const ts = Date.now();
    const frame = {
      type: 'room-msg' as const,
      roomId,
      channelId,
      id,
      ts,
      ctB64: s.to_base64(ct, s.base64_variants.ORIGINAL),
      nonceB64: s.to_base64(nonce, s.base64_variants.ORIGINAL),
      fromName: this.bridge.myScreenName(),
      replyToId: opts?.replyToId,
      mentions: opts?.mentions,
    };
    const me = this.bridge.myPeerId();
    const recipients = this.bridge.getRoomMembers(roomId).filter((m) => m !== me);
    await Promise.all(
      recipients.map((peer) => this.im.send(peer, frame).catch(() => undefined)),
    );
    return { id, ts };
  }

  async broadcastChannelAdd(roomId: string, channelId: string, name: string, kind: 'text' | 'voice' = 'text'): Promise<void> {
    const me = this.bridge.myPeerId();
    const recipients = this.bridge.getRoomMembers(roomId).filter((m) => m !== me);
    const ts = Date.now();
    await Promise.all(
      recipients.map((peer) =>
        this.im
          .send(peer, { type: 'room-channel-add', roomId, channelId, name, ts, kind })
          .catch(() => undefined),
      ),
    );
  }

  async broadcastVoiceState(roomId: string, channelId: string, joined: boolean): Promise<void> {
    const me = this.bridge.myPeerId();
    const recipients = this.bridge.getRoomMembers(roomId).filter((m) => m !== me);
    const ts = Date.now();
    const fromName = this.bridge.myScreenName();
    await Promise.all(
      recipients.map((peer) =>
        this.im
          .send(peer, { type: 'room-voice-state', roomId, channelId, joined, fromName, ts })
          .catch(() => undefined),
      ),
    );
  }

  async broadcastVoiceAudio(
    roomId: string,
    channelId: string,
    data: Uint8Array,
  ): Promise<void> {
    const key = this.bridge.getRoomKey(roomId);
    if (!key) return;
    const s = await sodium();
    const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
    const ct = s.crypto_secretbox_easy(data, nonce, key);
    const me = this.bridge.myPeerId();
    const recipients = this.bridge.getRoomMembers(roomId).filter((m) => m !== me);
    const frame = {
      type: 'room-voice-audio' as const,
      roomId,
      channelId,
      ctB64: s.to_base64(ct, s.base64_variants.ORIGINAL),
      nonceB64: s.to_base64(nonce, s.base64_variants.ORIGINAL),
      fromName: this.bridge.myScreenName(),
      ts: Date.now(),
    };
    await Promise.all(
      recipients.map((peer) => this.im.send(peer, frame).catch(() => undefined)),
    );
  }

  async decryptVoiceAudio(roomId: string, ctB64: string, nonceB64: string): Promise<Uint8Array | null> {
    const key = this.bridge.getRoomKey(roomId);
    if (!key) return null;
    try {
      const s = await sodium();
      const ct = s.from_base64(ctB64, s.base64_variants.ORIGINAL);
      const nonce = s.from_base64(nonceB64, s.base64_variants.ORIGINAL);
      return s.crypto_secretbox_open_easy(ct, nonce, key);
    } catch {
      return null;
    }
  }

  async broadcastChannelDel(roomId: string, channelId: string): Promise<void> {
    const me = this.bridge.myPeerId();
    const recipients = this.bridge.getRoomMembers(roomId).filter((m) => m !== me);
    await Promise.all(
      recipients.map((peer) =>
        this.im
          .send(peer, { type: 'room-channel-del', roomId, channelId })
          .catch(() => undefined),
      ),
    );
  }

  async leave(roomId: string): Promise<void> {
    const me = this.bridge.myPeerId();
    const recipients = this.bridge.getRoomMembers(roomId).filter((m) => m !== me);
    await Promise.all(
      recipients.map((peer) =>
        this.im.send(peer, { type: 'room-leave', roomId }).catch(() => undefined),
      ),
    );
  }

  async broadcastMeta(roomId: string, meta: RoomMetaPayload): Promise<void> {
    const me = this.bridge.myPeerId();
    const targets = (meta.members ?? this.bridge.getRoomMembers(roomId)).filter(
      (m) => m !== me,
    );
    await Promise.all(
      targets.map((peer) =>
        this.im.send(peer, { type: 'room-meta', ...meta }).catch(() => undefined),
      ),
    );
  }

  async broadcastPin(roomId: string, msgId: string, isPinned: boolean): Promise<void> {
    const me = this.bridge.myPeerId();
    const recipients = this.bridge.getRoomMembers(roomId).filter((m) => m !== me);
    const ts = Date.now();
    await Promise.all(
      recipients.map((peer) =>
        this.im.send(peer, { type: 'room-pin', roomId, msgId, isPinned, ts }).catch(() => undefined),
      ),
    );
  }

  async broadcastKick(roomId: string, peerId: string): Promise<void> {
    const me = this.bridge.myPeerId();
    const recipients = this.bridge.getRoomMembers(roomId).filter((m) => m !== me);
    const ts = Date.now();
    await Promise.all(
      recipients.map((peer) =>
        this.im.send(peer, { type: 'room-kick', roomId, peerId, ts }).catch(() => undefined),
      ),
    );
  }

  async broadcastRole(roomId: string, peerId: string, role: string): Promise<void> {
    const me = this.bridge.myPeerId();
    const recipients = this.bridge.getRoomMembers(roomId).filter((m) => m !== me);
    const ts = Date.now();
    await Promise.all(
      recipients.map((peer) =>
        this.im.send(peer, { type: 'room-role', roomId, peerId, role, ts }).catch(() => undefined),
      ),
    );
  }

  async broadcastCategory(roomId: string, channelId: string, category: string): Promise<void> {
    const me = this.bridge.myPeerId();
    const recipients = this.bridge.getRoomMembers(roomId).filter((m) => m !== me);
    const ts = Date.now();
    await Promise.all(
      recipients.map((peer) =>
        this.im.send(peer, { type: 'room-category', roomId, channelId, category, ts }).catch(() => undefined),
      ),
    );
  }

  async broadcastReaction(roomId: string, msgId: string, emoji: string, added: boolean): Promise<void> {
    const me = this.bridge.myPeerId();
    const recipients = this.bridge.getRoomMembers(roomId).filter((m) => m !== me);
    const type = added ? 'room-reaction' : 'room-unreaction';
    const ts = Date.now();
    await Promise.all(
      recipients.map((peer) =>
        this.im.send(peer, { type, roomId, msgId, emoji, ts }).catch(() => undefined),
      ),
    );
  }

  async broadcastEditMsg(roomId: string, msgId: string, body: string): Promise<void> {
    const me = this.bridge.myPeerId();
    const recipients = this.bridge.getRoomMembers(roomId).filter((m) => m !== me);
    const ts = Date.now();
    await Promise.all(
      recipients.map((peer) =>
        this.im.send(peer, { type: 'room-edit-msg', roomId, msgId, body, ts }).catch(() => undefined),
      ),
    );
  }

  async broadcastDeleteMsg(roomId: string, msgId: string): Promise<void> {
    const me = this.bridge.myPeerId();
    const recipients = this.bridge.getRoomMembers(roomId).filter((m) => m !== me);
    const ts = Date.now();
    await Promise.all(
      recipients.map((peer) =>
        this.im.send(peer, { type: 'room-delete-msg', roomId, msgId, ts }).catch(() => undefined),
      ),
    );
  }
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

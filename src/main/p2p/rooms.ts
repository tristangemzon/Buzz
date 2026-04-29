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
  RoomChannelAddPayload,
  RoomChannelDelPayload,
  RoomInvitePayload,
  RoomMsgPayload,
  RoomMetaPayload,
} from './im.js';

export type RoomServiceEvents = {
  onInvite(fromPeerId: string, p: RoomInvitePayload): void;
  onMessage(
    fromPeerId: string,
    msg: { roomId: string; channelId: string; id: string; ts: number; body: string; fromName: string },
  ): void;
  onMembers(roomId: string, members: string[], name?: string): void;
  onLeave(fromPeerId: string, roomId: string): void;
  onChannelAdd(fromPeerId: string, p: RoomChannelAddPayload): void;
  onChannelDel(fromPeerId: string, p: RoomChannelDelPayload): void;
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
            })
            .catch(() => undefined),
        ),
    );
    return { roomId, keyB64, createdAt, members: fullMembers };
  }

  async invite(roomId: string, peerId: string, name: string): Promise<string[]> {
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
      })
      .catch(() => undefined);
    await this.broadcastMeta(roomId, { roomId, members, name });
    return members;
  }

  async sendMessage(roomId: string, channelId: string, body: string): Promise<{ id: string; ts: number }> {
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
    };
    const me = this.bridge.myPeerId();
    const recipients = this.bridge.getRoomMembers(roomId).filter((m) => m !== me);
    await Promise.all(
      recipients.map((peer) => this.im.send(peer, frame).catch(() => undefined)),
    );
    return { id, ts };
  }

  async broadcastChannelAdd(roomId: string, channelId: string, name: string): Promise<void> {
    const me = this.bridge.myPeerId();
    const recipients = this.bridge.getRoomMembers(roomId).filter((m) => m !== me);
    const ts = Date.now();
    await Promise.all(
      recipients.map((peer) =>
        this.im
          .send(peer, { type: 'room-channel-add', roomId, channelId, name, ts })
          .catch(() => undefined),
      ),
    );
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
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

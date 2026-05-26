// /buzz/im/1.0.0 — length-prefixed CBOR frames over a libp2p stream.
//
// Frame: 4-byte big-endian length + CBOR payload. Max payload = 256 KiB.
//
// Frame types:
//   { type: 'msg',   id, ts, body }      - chat message
//   { type: 'ack',   id, status }        - delivery / read receipt
//   { type: 'typing', typing }           - ephemeral typing indicator
//   { type: 'profile', screenName, status, awayMessage } - presence/profile
//
// Every frame from a peer is also implicitly authenticated by the Noise XX
// channel (peer is who they say they are). A future revision can add an
// Ed25519 signature inside the frame for store-and-forward.

import { encode, decode } from 'cbor-x';
import type { Libp2p, Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { pipe } from 'it-pipe';
import type { Source } from 'it-stream-types';

export const IM_PROTOCOL = '/buzz/im/1.0.0';
export const MAX_FRAME = 256 * 1024;

export type ProfilePayload = {
  screenName: string;
  status: string;
  awayMessage?: string;
  aboutText?: string;
  textColor?: string;
  bgColor?: string;
  fontFamily?: string;
  avatar?: string;
  bgImage?: string;
};

export type Frame =
  | { type: 'msg'; id: string; ts: number; body: string }
  | { type: 'ack'; id: string; status: 'delivered' | 'read' | 'failed' }
  | { type: 'typing'; typing: boolean }
  | ({ type: 'profile' } & ProfilePayload)
  // Multi-party chat rooms (sealed-key model). The room key is delivered
  // inside `room-invite` while the IM channel is already Noise-encrypted to
  // the recipient; subsequent room-msg frames are *additionally* encrypted
  // with the room key so non-members in transit can never read them.
  | {
      type: 'room-invite';
      roomId: string;
      name: string;
      members: string[];
      keyB64: string; // 32-byte secretbox key, base64
      ts: number;
      ownerPeerId?: string;
      // Channel list at the time of invite, so the invitee creates the same
      // channel ids the inviter is using (avoids divergent default-channel
      // UUIDs that would otherwise produce ghost "channel" placeholders).
      channels?: Array<{ id: string; name: string; isDefault: boolean; createdAt: number; kind?: 'text' | 'voice' }>;
    }
  | {
      type: 'room-msg';
      roomId: string;
      channelId: string;
      id: string;
      ts: number;
      ctB64: string; // secretbox ciphertext
      nonceB64: string; // 24-byte nonce
      fromName?: string;
      replyToId?: string;
      mentions?: string[];
    }
  | { type: 'room-leave'; roomId: string }
  | { type: 'room-meta'; roomId: string; name?: string; members?: string[] }
  | {
      type: 'room-channel-add';
      roomId: string;
      channelId: string;
      name: string;
      ts: number;
      kind?: 'text' | 'voice';
    }
  | { type: 'room-channel-del'; roomId: string; channelId: string }
  // v0.6.0 moderation frames — broadcast plaintext over Noise-encrypted IM.
  | { type: 'room-pin'; roomId: string; msgId: string; isPinned: boolean; ts: number }
  | { type: 'room-kick'; roomId: string; peerId: string; ts: number }
  | { type: 'room-role'; roomId: string; peerId: string; role: string; ts: number }
  | { type: 'room-category'; roomId: string; channelId: string; category: string; ts: number }
  // v0.7.0 message actions
  | { type: 'room-reaction'; roomId: string; msgId: string; emoji: string; ts: number }
  | { type: 'room-unreaction'; roomId: string; msgId: string; emoji: string; ts: number }
  | { type: 'room-edit-msg'; roomId: string; msgId: string; body: string; ts: number }
  | { type: 'room-delete-msg'; roomId: string; msgId: string; ts: number }
  // Voice channels: presence beacons + opus/webm audio chunks fanned out to
  // every room member. Audio is *additionally* secret-boxed with the room key
  // (analogous to room-msg) so non-members never see plaintext.
  | {
      type: 'room-voice-state';
      roomId: string;
      channelId: string;
      joined: boolean;
      fromName?: string;
      ts: number;
    }
  | {
      type: 'room-voice-audio';
      roomId: string;
      channelId: string;
      ctB64: string;
      nonceB64: string;
      fromName?: string;
      ts: number;
    }
  // Buddy add request flow.
  | { type: 'buddy-req'; screenName: string; ts: number }
  | { type: 'buddy-resp'; accepted: boolean; screenName?: string }
  // In-IM peer-to-peer games.
  | { type: 'game'; action: 'invite' | 'accept' | 'decline' | 'move' | 'resign'; kind: string; path?: number[] };

export type RoomInvitePayload = {
  roomId: string;
  name: string;
  members: string[];
  keyB64: string;
  ts: number;
  ownerPeerId?: string;
  channels?: Array<{ id: string; name: string; isDefault: boolean; createdAt: number; kind?: 'text' | 'voice' }>;
};
export type RoomMsgPayload = {
  roomId: string;
  channelId: string;
  id: string;
  ts: number;
  ctB64: string;
  nonceB64: string;
  fromName?: string;
  replyToId?: string;
  mentions?: string[];
};
export type RoomMetaPayload = { roomId: string; name?: string; members?: string[] };
export type RoomChannelAddPayload = {
  roomId: string;
  channelId: string;
  name: string;
  ts: number;
  kind?: 'text' | 'voice';
};
export type RoomChannelDelPayload = { roomId: string; channelId: string };
export type RoomVoiceStatePayload = {
  roomId: string;
  channelId: string;
  joined: boolean;
  fromName?: string;
  ts: number;
};
export type RoomVoiceAudioPayload = {
  roomId: string;
  channelId: string;
  ctB64: string;
  nonceB64: string;
  fromName?: string;
  ts: number;
};
export type RoomPinPayload = { roomId: string; msgId: string; isPinned: boolean; ts: number };
export type RoomKickPayload = { roomId: string; peerId: string; ts: number };
export type RoomRolePayload = { roomId: string; peerId: string; role: string; ts: number };
export type RoomCategoryPayload = { roomId: string; channelId: string; category: string; ts: number };
export type RoomReactionPayload = { roomId: string; msgId: string; emoji: string; added: boolean; ts: number };
export type RoomEditMsgPayload = { roomId: string; msgId: string; body: string; ts: number };
export type RoomDeleteMsgPayload = { roomId: string; msgId: string; ts: number };

export type ImEvents = {
  onMessage(peerId: string, msg: { id: string; ts: number; body: string }): void;
  onAck(peerId: string, id: string, status: 'delivered' | 'read' | 'failed'): void;
  onTyping(peerId: string, typing: boolean): void;
  onProfile(peerId: string, p: ProfilePayload): void;
  onRoomInvite?(peerId: string, p: RoomInvitePayload): void;
  onRoomMsg?(peerId: string, p: RoomMsgPayload): void;
  onRoomLeave?(peerId: string, roomId: string): void;
  onRoomMeta?(peerId: string, p: RoomMetaPayload): void;
  onRoomChannelAdd?(peerId: string, p: RoomChannelAddPayload): void;
  onRoomChannelDel?(peerId: string, p: RoomChannelDelPayload): void;
  onRoomVoiceState?(peerId: string, p: RoomVoiceStatePayload): void;
  onRoomVoiceAudio?(peerId: string, p: RoomVoiceAudioPayload): void;
  // v0.6.0 moderation
  onRoomPin?(peerId: string, p: RoomPinPayload): void;
  onRoomKick?(peerId: string, p: RoomKickPayload): void;
  onRoomRole?(peerId: string, p: RoomRolePayload): void;
  onRoomCategory?(peerId: string, p: RoomCategoryPayload): void;
  // v0.7.0 message actions
  onRoomReaction?(peerId: string, p: RoomReactionPayload): void;
  onRoomEditMsg?(peerId: string, p: RoomEditMsgPayload): void;
  onRoomDeleteMsg?(peerId: string, p: RoomDeleteMsgPayload): void;
  onBuddyReq?(peerId: string, p: { screenName: string; ts: number }): void;
  onBuddyResp?(peerId: string, p: { accepted: boolean; screenName?: string }): void;
  onGameFrame?(peerId: string, p: { action: string; kind: string; path?: number[] }): void;
};

type ConnState = {
  send: (f: Frame) => Promise<void>;
  close: () => Promise<void>;
};

export class ImService {
  private readonly conns = new Map<string, ConnState>();

  constructor(
    private readonly node: Libp2p,
    private readonly events: ImEvents,
    private readonly isBlocked: (peerId: string) => boolean,
  ) {}

  async start(): Promise<void> {
    await this.node.handle(
      IM_PROTOCOL,
      ({ stream, connection }) => {
        const peer = connection.remotePeer.toString();
        if (this.isBlocked(peer)) {
          void stream.close();
          return;
        }
        this.attach(peer, stream);
      },
      // Allow inbound IM streams over relayed (transient) connections so that
      // peers behind NAT can still reach us before/without DCUtR hole-punching.
      { runOnTransientConnection: true },
    );
  }

  async stop(): Promise<void> {
    await this.node.unhandle(IM_PROTOCOL);
    for (const c of this.conns.values()) await c.close().catch(() => {});
    this.conns.clear();
  }

  async send(peerIdStr: string, frame: Frame): Promise<void> {
    // Attempt once; if the cached stream has died, evict it and retry once.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const c = await this.connect(peerIdStr);
        await c.send(frame);
        return;
      } catch (err) {
        // Evict the dead connection so the next connect() opens a fresh one.
        const stale = this.conns.get(peerIdStr);
        if (stale) {
          this.conns.delete(peerIdStr);
          void stale.close().catch(() => undefined);
        }
        if (attempt === 1) throw err;
      }
    }
  }

  private async connect(peerIdStr: string): Promise<ConnState> {
    const existing = this.conns.get(peerIdStr);
    if (existing) return existing;
    const peerId = peerIdFromString(peerIdStr);
    const stream = await this.node.dialProtocol(peerId, IM_PROTOCOL, {
      // Allow opening the stream when the only available connection is a
      // circuit-relay (transient) one. The IM protocol is low-bandwidth so
      // running over a relay is acceptable as a fallback.
      runOnTransientConnection: true,
    });
    return this.attachOutbound(peerIdStr, stream);
  }

  private attach(peerIdStr: string, stream: Stream): ConnState {
    return this.attachOutbound(peerIdStr, stream);
  }

  private attachOutbound(peerIdStr: string, stream: Stream): ConnState {
    // Outgoing queue → length-prefixed bytes.
    const outQueue: Uint8Array[] = [];
    let resolveWaiter: (() => void) | null = null;
    let closed = false;

    const source: Source<Uint8Array> = (async function* () {
      while (!closed) {
        if (outQueue.length === 0) {
          await new Promise<void>((r) => (resolveWaiter = r));
        }
        const next = outQueue.shift();
        if (next) yield next;
      }
    })();

    const send = async (f: Frame) => {
      if (closed) throw new Error('stream closed');
      const payload = encode(f);
      if (payload.length > MAX_FRAME) throw new Error('frame too large');
      const out = new Uint8Array(4 + payload.length);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, payload.length, false);
      out.set(payload, 4);
      outQueue.push(out);
      if (resolveWaiter) {
        const r = resolveWaiter;
        resolveWaiter = null;
        r();
      }
    };

    const close = async () => {
      closed = true;
      if (resolveWaiter) {
        const r = resolveWaiter;
        resolveWaiter = null;
        r();
      }
      try {
        await stream.close();
      } catch {
        /* ignore */
      }
      this.conns.delete(peerIdStr);
    };

    // Sink: consume our outQueue and write to the stream.
    void pipe(source, stream.sink).catch(() => void close());

    // Source: read from the peer, parse frames.
    void this.readLoop(peerIdStr, stream).catch(() => void close());

    const state: ConnState = { send, close };
    this.conns.set(peerIdStr, state);
    return state;
  }

  private async readLoop(peerIdStr: string, stream: Stream): Promise<void> {
    let buf = new Uint8Array(0);

    const append = (chunk: Uint8Array) => {
      const next = new Uint8Array(buf.length + chunk.length);
      next.set(buf, 0);
      next.set(chunk, buf.length);
      buf = next;
    };

    for await (const chunk of stream.source) {
      // chunk is a Uint8ArrayList in some libp2p versions
      const u8 =
        chunk instanceof Uint8Array
          ? chunk
          : (chunk as { subarray(): Uint8Array }).subarray();
      append(u8);

      while (buf.length >= 4) {
        const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, false);
        if (len > MAX_FRAME) {
          await stream.close();
          return;
        }
        if (buf.length < 4 + len) break;
        const payload = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        let frame: Frame;
        try {
          frame = decode(payload) as Frame;
        } catch {
          continue;
        }
        this.dispatch(peerIdStr, frame);
      }
    }
  }

  private dispatch(peerIdStr: string, f: Frame): void {
    if (this.isBlocked(peerIdStr)) return;
    switch (f.type) {
      case 'msg':
        if (typeof f.id === 'string' && typeof f.body === 'string' && typeof f.ts === 'number') {
          this.events.onMessage(peerIdStr, { id: f.id, ts: f.ts, body: f.body });
        }
        break;
      case 'ack':
        this.events.onAck(peerIdStr, f.id, f.status);
        break;
      case 'typing':
        this.events.onTyping(peerIdStr, !!f.typing);
        break;
      case 'profile':
        this.events.onProfile(peerIdStr, {
          screenName: f.screenName,
          status: f.status,
          awayMessage: f.awayMessage,
          aboutText: f.aboutText,
          textColor: f.textColor,
          bgColor: f.bgColor,
          fontFamily: f.fontFamily,
          avatar: f.avatar,
          bgImage: f.bgImage,
        });
        break;
      case 'room-invite':
        if (
          this.events.onRoomInvite &&
          typeof f.roomId === 'string' &&
          typeof f.name === 'string' &&
          Array.isArray(f.members) &&
          typeof f.keyB64 === 'string'
        ) {
          this.events.onRoomInvite(peerIdStr, {
            roomId: f.roomId,
            name: f.name,
            members: f.members,
            keyB64: f.keyB64,
            ts: f.ts,
            ownerPeerId: typeof f.ownerPeerId === 'string' ? f.ownerPeerId : undefined,
            channels: Array.isArray(f.channels) ? f.channels : undefined,
          });
        }
        break;
      case 'room-msg':
        if (
          this.events.onRoomMsg &&
          typeof f.roomId === 'string' &&
          typeof f.channelId === 'string' &&
          typeof f.id === 'string' &&
          typeof f.ctB64 === 'string' &&
          typeof f.nonceB64 === 'string'
        ) {
          this.events.onRoomMsg(peerIdStr, {
            roomId: f.roomId,
            channelId: f.channelId,
            id: f.id,
            ts: f.ts,
            ctB64: f.ctB64,
            nonceB64: f.nonceB64,
            fromName: f.fromName,
            replyToId: typeof f.replyToId === 'string' ? f.replyToId : undefined,
            mentions: Array.isArray(f.mentions) ? (f.mentions as string[]) : undefined,
          });
        }
        break;
      case 'room-leave':
        if (this.events.onRoomLeave && typeof f.roomId === 'string') {
          this.events.onRoomLeave(peerIdStr, f.roomId);
        }
        break;
      case 'room-meta':
        if (this.events.onRoomMeta && typeof f.roomId === 'string') {
          this.events.onRoomMeta(peerIdStr, {
            roomId: f.roomId,
            name: f.name,
            members: f.members,
          });
        }
        break;
      case 'room-channel-add':
        if (
          this.events.onRoomChannelAdd &&
          typeof f.roomId === 'string' &&
          typeof f.channelId === 'string' &&
          typeof f.name === 'string'
        ) {
          this.events.onRoomChannelAdd(peerIdStr, {
            roomId: f.roomId,
            channelId: f.channelId,
            name: f.name,
            ts: f.ts,
            kind: f.kind === 'voice' ? 'voice' : f.kind === 'text' ? 'text' : undefined,
          });
        }
        break;
      case 'room-channel-del':
        if (
          this.events.onRoomChannelDel &&
          typeof f.roomId === 'string' &&
          typeof f.channelId === 'string'
        ) {
          this.events.onRoomChannelDel(peerIdStr, {
            roomId: f.roomId,
            channelId: f.channelId,
          });
        }
        break;
      case 'room-voice-state':
        if (
          this.events.onRoomVoiceState &&
          typeof f.roomId === 'string' &&
          typeof f.channelId === 'string' &&
          typeof f.joined === 'boolean'
        ) {
          this.events.onRoomVoiceState(peerIdStr, {
            roomId: f.roomId,
            channelId: f.channelId,
            joined: f.joined,
            fromName: f.fromName,
            ts: typeof f.ts === 'number' ? f.ts : Date.now(),
          });
        }
        break;
      case 'room-voice-audio':
        if (
          this.events.onRoomVoiceAudio &&
          typeof f.roomId === 'string' &&
          typeof f.channelId === 'string' &&
          typeof f.ctB64 === 'string' &&
          typeof f.nonceB64 === 'string'
        ) {
          this.events.onRoomVoiceAudio(peerIdStr, {
            roomId: f.roomId,
            channelId: f.channelId,
            ctB64: f.ctB64,
            nonceB64: f.nonceB64,
            fromName: f.fromName,
            ts: typeof f.ts === 'number' ? f.ts : Date.now(),
          });
        }
        break;
      case 'buddy-req':
        if (this.events.onBuddyReq && typeof f.screenName === 'string') {
          this.events.onBuddyReq(peerIdStr, {
            screenName: f.screenName,
            ts: typeof f.ts === 'number' ? f.ts : Date.now(),
          });
        }
        break;
      case 'room-pin':
        if (this.events.onRoomPin && typeof f.roomId === 'string' && typeof f.msgId === 'string') {
          this.events.onRoomPin(peerIdStr, {
            roomId: f.roomId,
            msgId: f.msgId,
            isPinned: !!f.isPinned,
            ts: typeof f.ts === 'number' ? f.ts : Date.now(),
          });
        }
        break;
      case 'room-kick':
        if (this.events.onRoomKick && typeof f.roomId === 'string' && typeof f.peerId === 'string') {
          this.events.onRoomKick(peerIdStr, {
            roomId: f.roomId,
            peerId: f.peerId,
            ts: typeof f.ts === 'number' ? f.ts : Date.now(),
          });
        }
        break;
      case 'room-role':
        if (
          this.events.onRoomRole &&
          typeof f.roomId === 'string' &&
          typeof f.peerId === 'string' &&
          typeof f.role === 'string'
        ) {
          this.events.onRoomRole(peerIdStr, {
            roomId: f.roomId,
            peerId: f.peerId,
            role: f.role,
            ts: typeof f.ts === 'number' ? f.ts : Date.now(),
          });
        }
        break;
      case 'room-category':
        if (
          this.events.onRoomCategory &&
          typeof f.roomId === 'string' &&
          typeof f.channelId === 'string' &&
          typeof f.category === 'string'
        ) {
          this.events.onRoomCategory(peerIdStr, {
            roomId: f.roomId,
            channelId: f.channelId,
            category: f.category,
            ts: typeof f.ts === 'number' ? f.ts : Date.now(),
          });
        }
        break;
      case 'room-reaction':
        if (
          this.events.onRoomReaction &&
          typeof f.roomId === 'string' &&
          typeof f.msgId === 'string' &&
          typeof f.emoji === 'string'
        ) {
          this.events.onRoomReaction(peerIdStr, {
            roomId: f.roomId,
            msgId: f.msgId,
            emoji: f.emoji,
            added: true,
            ts: typeof f.ts === 'number' ? f.ts : Date.now(),
          });
        }
        break;
      case 'room-unreaction':
        if (
          this.events.onRoomReaction &&
          typeof f.roomId === 'string' &&
          typeof f.msgId === 'string' &&
          typeof f.emoji === 'string'
        ) {
          this.events.onRoomReaction(peerIdStr, {
            roomId: f.roomId,
            msgId: f.msgId,
            emoji: f.emoji,
            added: false,
            ts: typeof f.ts === 'number' ? f.ts : Date.now(),
          });
        }
        break;
      case 'room-edit-msg':
        if (
          this.events.onRoomEditMsg &&
          typeof f.roomId === 'string' &&
          typeof f.msgId === 'string' &&
          typeof f.body === 'string'
        ) {
          this.events.onRoomEditMsg(peerIdStr, {
            roomId: f.roomId,
            msgId: f.msgId,
            body: f.body,
            ts: typeof f.ts === 'number' ? f.ts : Date.now(),
          });
        }
        break;
      case 'room-delete-msg':
        if (
          this.events.onRoomDeleteMsg &&
          typeof f.roomId === 'string' &&
          typeof f.msgId === 'string'
        ) {
          this.events.onRoomDeleteMsg(peerIdStr, {
            roomId: f.roomId,
            msgId: f.msgId,
            ts: typeof f.ts === 'number' ? f.ts : Date.now(),
          });
        }
        break;
      case 'buddy-resp':
        if (this.events.onBuddyResp && typeof f.accepted === 'boolean') {
          this.events.onBuddyResp(peerIdStr, {
            accepted: f.accepted,
            screenName: typeof f.screenName === 'string' ? f.screenName : undefined,
          });
        }
        break;
      case 'game':
        if (this.events.onGameFrame && typeof f.action === 'string' && typeof f.kind === 'string') {
          this.events.onGameFrame(peerIdStr, {
            action: f.action,
            kind: f.kind,
            path: Array.isArray(f.path) ? (f.path as number[]) : undefined,
          });
        }
        break;
    }
  }
}

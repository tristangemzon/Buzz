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
      // Channel list at the time of invite, so the invitee creates the same
      // channel ids the inviter is using (avoids divergent default-channel
      // UUIDs that would otherwise produce ghost "channel" placeholders).
      channels?: Array<{ id: string; name: string; isDefault: boolean; createdAt: number }>;
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
    }
  | { type: 'room-leave'; roomId: string }
  | { type: 'room-meta'; roomId: string; name?: string; members?: string[] }
  | {
      type: 'room-channel-add';
      roomId: string;
      channelId: string;
      name: string;
      ts: number;
    }
  | { type: 'room-channel-del'; roomId: string; channelId: string };

export type RoomInvitePayload = {
  roomId: string;
  name: string;
  members: string[];
  keyB64: string;
  ts: number;
  channels?: Array<{ id: string; name: string; isDefault: boolean; createdAt: number }>;
};
export type RoomMsgPayload = {
  roomId: string;
  channelId: string;
  id: string;
  ts: number;
  ctB64: string;
  nonceB64: string;
  fromName?: string;
};
export type RoomMetaPayload = { roomId: string; name?: string; members?: string[] };
export type RoomChannelAddPayload = {
  roomId: string;
  channelId: string;
  name: string;
  ts: number;
};
export type RoomChannelDelPayload = { roomId: string; channelId: string };

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
    const c = await this.connect(peerIdStr);
    await c.send(frame);
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
    return this.attach(peerIdStr, stream);
  }

  private attach(peerIdStr: string, stream: Stream): ConnState {
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
    }
  }
}

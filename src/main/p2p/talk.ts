// /buzz/talk/1.0.0 — voice call signalling + audio streaming over a single
// length-prefixed CBOR libp2p stream per peer.
//
// Frame: 4-byte big-endian length + CBOR payload. Max payload = 256 KiB
// (audio chunks are typically a few KB at 60ms timeslices of Opus).
//
// Frame types (all carry a callId so future versions can multiplex):
//   { type: 'invite', callId, screenName, ts }
//   { type: 'accept', callId }
//   { type: 'reject', callId, reason? }
//   { type: 'bye',    callId }
//   { type: 'audio',  callId, seq, data }   - opus-in-webm chunk
//
// Codec is hardcoded to audio/webm;codecs=opus. Both sides agree on this in
// MVP; a future revision can negotiate via 'invite'/'accept' fields.

import { encode, decode } from 'cbor-x';
import type { Libp2p, Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { pipe } from 'it-pipe';
import type { Source } from 'it-stream-types';

export const TALK_PROTOCOL = '/buzz/talk/1.0.0';
export const TALK_MAX_FRAME = 256 * 1024;
export const TALK_MIME = 'audio/webm;codecs=opus';
export const TALK_VIDEO_MIME = 'video/webm;codecs=vp8';

export type TalkFrame =
  | { type: 'invite'; callId: string; screenName: string; ts: number }
  | { type: 'accept'; callId: string }
  | { type: 'reject'; callId: string; reason?: string }
  | { type: 'bye'; callId: string }
  | { type: 'audio'; callId: string; seq: number; data: Uint8Array }
  | { type: 'video'; callId: string; seq: number; data: Uint8Array }
  | { type: 'videoState'; callId: string; on: boolean };

export type TalkEvents = {
  onInvite(peerId: string, callId: string, screenName: string, ts: number): void;
  onAccept(peerId: string, callId: string): void;
  onReject(peerId: string, callId: string, reason?: string): void;
  onBye(peerId: string, callId: string): void;
  onAudio(peerId: string, callId: string, seq: number, data: Uint8Array): void;
  onVideo(peerId: string, callId: string, seq: number, data: Uint8Array): void;
  onVideoState(peerId: string, callId: string, on: boolean): void;
};

type ConnState = {
  send: (f: TalkFrame) => Promise<void>;
  close: () => Promise<void>;
};

export class TalkService {
  private readonly conns = new Map<string, ConnState>();

  constructor(
    private readonly node: Libp2p,
    private readonly events: TalkEvents,
    private readonly isBlocked: (peerId: string) => boolean,
  ) {}

  async start(): Promise<void> {
    await this.node.handle(
      TALK_PROTOCOL,
      ({ stream, connection }) => {
        const peer = connection.remotePeer.toString();
        if (this.isBlocked(peer)) {
          void stream.close();
          return;
        }
        this.attach(peer, stream);
      },
      { runOnTransientConnection: true },
    );
  }

  async stop(): Promise<void> {
    try {
      await this.node.unhandle(TALK_PROTOCOL);
    } catch {
      /* ignore */
    }
    for (const c of this.conns.values()) await c.close().catch(() => undefined);
    this.conns.clear();
  }

  async send(peerIdStr: string, frame: TalkFrame): Promise<void> {
    const c = await this.connect(peerIdStr);
    await c.send(frame);
  }

  private async connect(peerIdStr: string): Promise<ConnState> {
    const existing = this.conns.get(peerIdStr);
    if (existing) return existing;
    const peerId = peerIdFromString(peerIdStr);
    const stream = await this.node.dialProtocol(peerId, TALK_PROTOCOL, {
      runOnTransientConnection: true,
    });
    return this.attach(peerIdStr, stream);
  }

  private attach(peerIdStr: string, stream: Stream): ConnState {
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

    const send = async (f: TalkFrame): Promise<void> => {
      if (closed) throw new Error('talk stream closed');
      const payload = encode(f);
      if (payload.length > TALK_MAX_FRAME) throw new Error('talk frame too large');
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

    const close = async (): Promise<void> => {
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

    void pipe(source, stream.sink).catch(() => void close());
    void this.readLoop(peerIdStr, stream).catch(() => void close());

    const state: ConnState = { send, close };
    this.conns.set(peerIdStr, state);
    return state;
  }

  private async readLoop(peerIdStr: string, stream: Stream): Promise<void> {
    let buf = new Uint8Array(0);
    const append = (chunk: Uint8Array): void => {
      const next = new Uint8Array(buf.length + chunk.length);
      next.set(buf, 0);
      next.set(chunk, buf.length);
      buf = next;
    };

    for await (const chunk of stream.source) {
      const u8 =
        chunk instanceof Uint8Array
          ? chunk
          : (chunk as { subarray(): Uint8Array }).subarray();
      append(u8);
      while (buf.length >= 4) {
        const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, false);
        if (len > TALK_MAX_FRAME) {
          await stream.close();
          return;
        }
        if (buf.length < 4 + len) break;
        const payload = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        let frame: TalkFrame;
        try {
          frame = decode(payload) as TalkFrame;
        } catch {
          continue;
        }
        this.dispatch(peerIdStr, frame);
      }
    }
  }

  private dispatch(peerIdStr: string, f: TalkFrame): void {
    if (this.isBlocked(peerIdStr)) return;
    switch (f.type) {
      case 'invite':
        if (typeof f.callId === 'string' && typeof f.screenName === 'string') {
          this.events.onInvite(peerIdStr, f.callId, f.screenName, f.ts ?? Date.now());
        }
        break;
      case 'accept':
        if (typeof f.callId === 'string') this.events.onAccept(peerIdStr, f.callId);
        break;
      case 'reject':
        if (typeof f.callId === 'string') this.events.onReject(peerIdStr, f.callId, f.reason);
        break;
      case 'bye':
        if (typeof f.callId === 'string') this.events.onBye(peerIdStr, f.callId);
        break;
      case 'audio':
        if (
          typeof f.callId === 'string' &&
          typeof f.seq === 'number' &&
          f.data instanceof Uint8Array
        ) {
          this.events.onAudio(peerIdStr, f.callId, f.seq, f.data);
        }
        break;
      case 'video':
        if (
          typeof f.callId === 'string' &&
          typeof f.seq === 'number' &&
          f.data instanceof Uint8Array
        ) {
          this.events.onVideo(peerIdStr, f.callId, f.seq, f.data);
        }
        break;
      case 'videoState':
        if (typeof f.callId === 'string' && typeof f.on === 'boolean') {
          this.events.onVideoState(peerIdStr, f.callId, f.on);
        }
        break;
    }
  }
}

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
//   { type: 'screen', callId, seq, data }   - VP8/WebM screen chunk
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

// Bounded outbound buffer per peer. Audio is the smallest/most latency-
// sensitive stream; capping the byte budget per peer means a slow peer
// can never inflate our memory or stall the local UI. When the budget is
// exceeded we drop the oldest media frames first (audio/video/screen) and
// always preserve control frames (invite/accept/reject/bye/*State).
const TALK_OUT_BUDGET_BYTES = 2 * 1024 * 1024;

export type TalkFrame =
  | { type: 'invite'; callId: string; screenName: string; ts: number; kind?: 'voice' | 'video' }
  | { type: 'accept'; callId: string }
  | { type: 'reject'; callId: string; reason?: string }
  | { type: 'bye'; callId: string }
  | { type: 'audio'; callId: string; seq: number; data: Uint8Array }
  | { type: 'video'; callId: string; seq: number; data: Uint8Array }
  | { type: 'videoState'; callId: string; on: boolean }
  | { type: 'screen'; callId: string; seq: number; data: Uint8Array }
  | { type: 'screenState'; callId: string; on: boolean; sourceName?: string; resolution?: '480p' | '720p' | '1080p' };

export type TalkEvents = {
  onInvite(peerId: string, callId: string, screenName: string, ts: number, kind: 'voice' | 'video'): void;
  onAccept(peerId: string, callId: string): void;
  onReject(peerId: string, callId: string, reason?: string): void;
  onBye(peerId: string, callId: string): void;
  onAudio(peerId: string, callId: string, seq: number, data: Uint8Array): void;
  onVideo(peerId: string, callId: string, seq: number, data: Uint8Array): void;
  onVideoState(peerId: string, callId: string, on: boolean): void;
  onScreen(peerId: string, callId: string, seq: number, data: Uint8Array): void;
  onScreenState(peerId: string, callId: string, on: boolean, sourceName?: string, resolution?: '480p' | '720p' | '1080p'): void;
};

type ConnState = {
  send: (f: TalkFrame) => Promise<void>;
  close: () => Promise<void>;
};

export class TalkService {
  private readonly conns = new Map<string, ConnState>();
  // Peers with whom we currently have an active TALK connection (ringing,
  // active, etc.). PresenceManager queries this to avoid marking a peer offline
  // while a call is in progress.
  private readonly activePeers = new Set<string>();

  getActivePeerIds(): ReadonlySet<string> {
    return this.activePeers;
  }

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
    this.activePeers.add(peerIdStr);
    type Item = { bytes: Uint8Array; media: boolean };
    const outQueue: Item[] = [];
    let outBytes = 0;
    let resolveWaiter: (() => void) | null = null;
    let closed = false;

    const source: Source<Uint8Array> = (async function* () {
      while (!closed) {
        if (outQueue.length === 0) {
          await new Promise<void>((r) => (resolveWaiter = r));
        }
        const next = outQueue.shift();
        if (next) {
          outBytes -= next.bytes.length;
          yield next.bytes;
        }
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
      const isMedia = f.type === 'audio' || f.type === 'video' || f.type === 'screen';
      // Backpressure: if we're over the per-peer byte budget, drop the
      // oldest media frames (keep control frames). This bounds memory under
      // a slow peer and prevents the queue from growing without limit, which
      // would otherwise show up to the user as ever-increasing call latency.
      if (isMedia) {
        while (outBytes + out.length > TALK_OUT_BUDGET_BYTES && outQueue.length > 0) {
          let dropped = false;
          for (let i = 0; i < outQueue.length; i++) {
            const entry = outQueue[i];
            if (entry && entry.media) {
              outQueue.splice(i, 1);
              outBytes -= entry.bytes.length;
              dropped = true;
              break;
            }
          }
          if (!dropped) break;
        }
        if (outBytes + out.length > TALK_OUT_BUDGET_BYTES) {
          // Still over budget after dropping all media \u2014 drop this one too.
          return;
        }
      }
      outQueue.push({ bytes: out, media: isMedia });
      outBytes += out.length;
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
      this.activePeers.delete(peerIdStr);
      this.conns.delete(peerIdStr);
    };

    void pipe(source, stream.sink).catch(() => void close());
    void this.readLoop(peerIdStr, stream).catch(() => void close());

    const state: ConnState = { send, close };
    this.conns.set(peerIdStr, state);
    return state;
  }

  private async readLoop(peerIdStr: string, stream: Stream): Promise<void> {
    // Chunk-list accumulator: avoids reallocating a single growing buffer on
    // every inbound chunk (which is O(n\u00b2) under the high-throughput case of
    // audio + video + screen interleaved at ~25\u201350 chunks/sec).
    const chunks: Uint8Array[] = [];
    let total = 0;

    const peek4 = (): number | null => {
      if (total < 4) return null;
      const out = new Uint8Array(4);
      let need = 4;
      let off = 0;
      for (const c of chunks) {
        const take = Math.min(need, c.length);
        out.set(c.subarray(0, take), off);
        off += take;
        need -= take;
        if (need === 0) break;
      }
      return new DataView(out.buffer).getUint32(0, false);
    };

    const consume = (n: number): Uint8Array => {
      const out = new Uint8Array(n);
      let off = 0;
      while (off < n) {
        const head = chunks[0];
        if (!head) break;
        const take = Math.min(n - off, head.length);
        out.set(head.subarray(0, take), off);
        off += take;
        if (take === head.length) chunks.shift();
        else chunks[0] = head.subarray(take);
      }
      total -= n;
      return out;
    };

    for await (const chunk of stream.source) {
      const u8 =
        chunk instanceof Uint8Array
          ? chunk
          : (chunk as { subarray(): Uint8Array }).subarray();
      chunks.push(u8);
      total += u8.length;
      while (total >= 4) {
        const len = peek4();
        if (len === null) break;
        if (len > TALK_MAX_FRAME) {
          await stream.close();
          return;
        }
        if (total < 4 + len) break;
        consume(4); // length prefix
        const payload = consume(len);
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
          const kind = f.kind === 'video' ? 'video' : 'voice';
          this.events.onInvite(peerIdStr, f.callId, f.screenName, f.ts ?? Date.now(), kind);
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
      case 'screen':
        if (
          typeof f.callId === 'string' &&
          typeof f.seq === 'number' &&
          f.data instanceof Uint8Array
        ) {
          this.events.onScreen(peerIdStr, f.callId, f.seq, f.data);
        }
        break;
      case 'screenState':
        if (typeof f.callId === 'string' && typeof f.on === 'boolean') {
          const resolution = f.resolution === '480p' || f.resolution === '720p' || f.resolution === '1080p'
            ? f.resolution
            : undefined;
          this.events.onScreenState(peerIdStr, f.callId, f.on, f.sourceName, resolution);
        }
        break;
    }
  }
}

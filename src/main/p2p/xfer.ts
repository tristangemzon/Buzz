// /buzz/xfer/1.0.0 — file transfer over a dedicated libp2p stream.
//
// Wire format: 4-byte big-endian length + CBOR payload, same as IM frames.
// Each transfer uses its own bidirectional stream — sender opens it, sends
// 'offer', waits for 'accept' or 'decline', then streams 16 KiB chunks
// followed by a final 'done' frame. Receiver verifies the BLAKE3 hash of
// the assembled payload before reporting success.
//
// Frames:
//   { type: 'offer',   id, fileName, fileSize, hash }
//   { type: 'accept',  id }
//   { type: 'decline', id, reason? }
//   { type: 'chunk',   id, seq, data }
//   { type: 'done',    id }
//   { type: 'error',   id, msg }

import { encode, decode } from 'cbor-x';
import { blake3 } from '@noble/hashes/blake3';
import type { Libp2p, Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { pipe } from 'it-pipe';
import type { Source } from 'it-stream-types';
import { randomUUID } from 'node:crypto';

export const XFER_PROTOCOL = '/buzz/xfer/1.0.0';
export const XFER_CHUNK = 16 * 1024;
export const XFER_MAX_FRAME = 64 * 1024; // chunk + cbor overhead
export const XFER_MAX_SIZE = 2 * 1024 * 1024 * 1024; // 2 GiB hard cap

type XferFrame =
  | { type: 'offer'; id: string; fileName: string; fileSize: number; hash: string }
  | { type: 'accept'; id: string }
  | { type: 'decline'; id: string; reason?: string }
  | { type: 'chunk'; id: string; seq: number; data: Uint8Array }
  | { type: 'done'; id: string }
  | { type: 'error'; id: string; msg: string };

export type IncomingOffer = {
  id: string;
  peerId: string;
  fileName: string;
  fileSize: number;
  hash: string;
};

export type XferEvents = {
  onOffer(o: IncomingOffer): void;
  onProgress(id: string, peerId: string, direction: 'in' | 'out', bytes: number, total: number): void;
  onDone(
    id: string,
    peerId: string,
    direction: 'in' | 'out',
    fileName: string,
    ok: boolean,
    error?: string,
    savedPath?: string,
  ): void;
};

type IncomingPending = {
  offer: IncomingOffer;
  // Resolves with the user's choice. The receiver side awaits this before
  // sending an accept/decline frame back to the sender.
  decide: (accept: boolean, savePath?: string) => void;
  decision: Promise<{ accept: boolean; savePath?: string }>;
};

function encodeFrame(f: XferFrame): Uint8Array {
  const payload = encode(f);
  if (payload.length > XFER_MAX_FRAME) throw new Error('xfer frame too large');
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

export class XferService {
  // Pending incoming offers keyed by transfer id; the IPC layer accepts or
  // declines them after prompting the user with a save dialog.
  private readonly pending = new Map<string, IncomingPending>();

  constructor(
    private readonly node: Libp2p,
    private readonly events: XferEvents,
    private readonly isBlocked: (peerId: string) => boolean,
    private readonly fs: typeof import('node:fs/promises'),
  ) {}

  async start(): Promise<void> {
    await this.node.handle(XFER_PROTOCOL, ({ stream, connection }) => {
      const peer = connection.remotePeer.toString();
      if (this.isBlocked(peer)) {
        void stream.close();
        return;
      }
      void this.handleIncoming(peer, stream).catch(() => {
        void stream.close().catch(() => undefined);
      });
    });
  }

  async stop(): Promise<void> {
    try {
      await this.node.unhandle(XFER_PROTOCOL);
    } catch {
      /* ignore */
    }
    this.pending.clear();
  }

  // Called by the IPC layer once the user has chosen to accept (with a save
  // path) or decline an incoming offer surfaced via events.onOffer.
  respond(id: string, accept: boolean, savePath?: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    p.decide(accept, savePath);
  }

  // Sender side. Reads the file, opens a stream, sends offer, waits for the
  // peer's accept/decline, streams chunks, finalises with 'done'.
  async sendFile(peerIdStr: string, filePath: string): Promise<{ id: string }> {
    const stat = await this.fs.stat(filePath);
    if (!stat.isFile()) throw new Error('Not a file');
    if (stat.size > XFER_MAX_SIZE) throw new Error('File too large');
    const data = await this.fs.readFile(filePath);
    const fileName = filePath.split(/[/\\]/).pop() || 'file';
    const hash = bytesToHex(blake3(data));
    const id = randomUUID();
    const total = data.byteLength;

    const peerId = peerIdFromString(peerIdStr);
    const stream = await this.node.dialProtocol(peerId, XFER_PROTOCOL);

    const out = createOutbound(stream);
    void pipe(out.source, stream.sink).catch(() => undefined);

    // Push the offer.
    out.send(encodeFrame({ type: 'offer', id, fileName, fileSize: total, hash }));

    // Wait for accept/decline frame from the peer.
    const reply = await readNextFrame(stream);
    if (!reply || reply.id !== id) {
      out.close();
      this.events.onDone(id, peerIdStr, 'out', fileName, false, 'No reply');
      throw new Error('No reply from peer');
    }
    if (reply.type === 'decline') {
      out.close();
      this.events.onDone(id, peerIdStr, 'out', fileName, false, reply.reason || 'Declined');
      return { id };
    }
    if (reply.type !== 'accept') {
      out.close();
      this.events.onDone(id, peerIdStr, 'out', fileName, false, 'Unexpected reply');
      throw new Error('Unexpected reply');
    }

    // Stream chunks.
    let sent = 0;
    let seq = 0;
    while (sent < total) {
      const end = Math.min(sent + XFER_CHUNK, total);
      const slice = data.subarray(sent, end);
      out.send(encodeFrame({ type: 'chunk', id, seq, data: slice }));
      sent = end;
      seq += 1;
      this.events.onProgress(id, peerIdStr, 'out', sent, total);
    }
    out.send(encodeFrame({ type: 'done', id }));
    // Drain a moment so the sink flushes before we close.
    await new Promise((r) => setTimeout(r, 50));
    out.close();
    this.events.onDone(id, peerIdStr, 'out', fileName, true);
    return { id };
  }

  // Receiver side.
  private async handleIncoming(peerIdStr: string, stream: Stream): Promise<void> {
    // Persistent outbound queue so we can send 'accept' / 'decline' / final
    // 'done' on the same stream.sink lifecycle.
    const out = createOutbound(stream);
    void pipe(out.source, stream.sink).catch(() => undefined);

    const reader = frameReader(stream);
    const first = await reader.next();
    if (first.done || !first.value || first.value.type !== 'offer') {
      out.close();
      return;
    }
    const offer = first.value;
    if (offer.fileSize > XFER_MAX_SIZE) {
      out.send(encodeFrame({ type: 'decline', id: offer.id, reason: 'too large' }));
      await delay(50);
      out.close();
      return;
    }

    let decideResolver: (v: { accept: boolean; savePath?: string }) => void = () => undefined;
    const decision = new Promise<{ accept: boolean; savePath?: string }>(
      (r) => (decideResolver = r),
    );
    const incoming: IncomingPending = {
      offer: {
        id: offer.id,
        peerId: peerIdStr,
        fileName: offer.fileName,
        fileSize: offer.fileSize,
        hash: offer.hash,
      },
      decide: (accept, savePath) => decideResolver({ accept, savePath }),
      decision,
    };
    this.pending.set(offer.id, incoming);
    this.events.onOffer(incoming.offer);

    const choice = await decision;
    this.pending.delete(offer.id);

    if (!choice.accept || !choice.savePath) {
      out.send(encodeFrame({ type: 'decline', id: offer.id }));
      await delay(50);
      out.close();
      this.events.onDone(offer.id, peerIdStr, 'in', offer.fileName, false, 'declined');
      return;
    }

    out.send(encodeFrame({ type: 'accept', id: offer.id }));

    // Collect chunks; verify hash; write to disk atomically (tmp + rename).
    const buf: Uint8Array[] = [];
    let received = 0;
    const tmpPath = choice.savePath + '.part';
    const fh = await this.fs.open(tmpPath, 'w');
    let aborted = false;
    try {
      for await (const f of reader) {
        if (f.id !== offer.id) continue;
        if (f.type === 'chunk') {
          await fh.write(f.data);
          buf.push(f.data);
          received += f.data.byteLength;
          this.events.onProgress(offer.id, peerIdStr, 'in', received, offer.fileSize);
        } else if (f.type === 'done') {
          break;
        } else if (f.type === 'error') {
          aborted = true;
          break;
        }
      }
    } finally {
      await fh.close().catch(() => undefined);
    }

    if (aborted) {
      await this.fs.unlink(tmpPath).catch(() => undefined);
      out.close();
      this.events.onDone(offer.id, peerIdStr, 'in', offer.fileName, false, 'aborted');
      return;
    }

    // Verify hash before promoting to final path.
    const all = Buffer.concat(buf.map((u) => Buffer.from(u)));
    const got = bytesToHex(blake3(all));
    if (got !== offer.hash || all.byteLength !== offer.fileSize) {
      await this.fs.unlink(tmpPath).catch(() => undefined);
      out.close();
      this.events.onDone(offer.id, peerIdStr, 'in', offer.fileName, false, 'hash mismatch');
      return;
    }
    await this.fs.rename(tmpPath, choice.savePath);
    this.events.onDone(
      offer.id,
      peerIdStr,
      'in',
      offer.fileName,
      true,
      undefined,
      choice.savePath,
    );
    await delay(50);
    out.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── small stream helpers ─────────────────────────────────────────────────────

function createOutbound(_stream: Stream): {
  source: Source<Uint8Array>;
  send: (b: Uint8Array) => void;
  close: () => void;
} {
  const queue: Uint8Array[] = [];
  let resolveWaiter: (() => void) | null = null;
  let closed = false;

  const source: Source<Uint8Array> = (async function* () {
    while (!closed || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((r) => (resolveWaiter = r));
        continue;
      }
      const next = queue.shift();
      if (next) yield next;
    }
  })();

  return {
    source,
    send(b) {
      if (closed) return;
      queue.push(b);
      const r = resolveWaiter;
      if (r) {
        resolveWaiter = null;
        r();
      }
    },
    close() {
      closed = true;
      const r = resolveWaiter;
      if (r) {
        resolveWaiter = null;
        r();
      }
    },
  };
}

async function* frameReader(stream: Stream): AsyncGenerator<XferFrame> {
  let buf = new Uint8Array(0);
  for await (const chunk of stream.source) {
    const u8 =
      chunk instanceof Uint8Array
        ? chunk
        : (chunk as { subarray(): Uint8Array }).subarray();
    const next = new Uint8Array(buf.length + u8.length);
    next.set(buf, 0);
    next.set(u8, buf.length);
    buf = next;
    while (buf.length >= 4) {
      const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, false);
      if (len > XFER_MAX_FRAME) return;
      if (buf.length < 4 + len) break;
      const payload = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      try {
        yield decode(payload) as XferFrame;
      } catch {
        /* skip malformed */
      }
    }
  }
}

async function readNextFrame(stream: Stream): Promise<XferFrame | null> {
  const reader = frameReader(stream);
  const r = await reader.next();
  if (r.done) return null;
  return r.value;
}

function bytesToHex(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += (b[i] ?? 0).toString(16).padStart(2, '0');
  return out;
}

// /buzz/mailbox/1.0.0 — offline mailbox relay.
//
// Anyone running an Buzz client can act as a mailbox relay for their peers.
// Senders push **sealed envelopes** addressed to a recipient PeerId; the relay
// queues them in its encrypted local DB; the recipient pulls them whenever
// they come online and acks ids so the relay can free the rows.
//
// Confidentiality + authenticity:
//   • The wire ciphertext is a libsodium **anonymous sealed-box**, encrypted
//     to the recipient's X25519 key (derived from their Ed25519 PeerId). The
//     relay cannot read it; only the recipient can.
//   • Inside the cleartext we include an Ed25519 signature by the sender over
//     a domain-separated hash of the body fields, so a malicious relay (or
//     anyone storing for them) cannot forge envelopes claiming to be from
//     someone else. The signing key is the sender's identity PeerId — no
//     extra PKI required.
//
// Frame format: 4-byte big-endian length + CBOR payload (same as IM).

import { encode, decode } from 'cbor-x';
import type { Libp2p, Stream, Connection } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { unmarshalPublicKey } from '@libp2p/crypto/keys';
import { pipe } from 'it-pipe';
import type { Source } from 'it-stream-types';

import { sodium, type IdentityMaterial } from '../crypto/keystore.js';
import * as repos from '../db/repos.js';
import type { Db } from '../db/open.js';

export const MBX_PROTOCOL = '/buzz/mailbox/1.0.0';
export const MAX_FRAME = 256 * 1024;
export const MAX_BODY_BYTES = 64 * 1024;

type Frame =
  | { type: 'store'; id: string; recipient: string; sender: string; ctB64: string; ts: number }
  | { type: 'storeOk'; id: string }
  | { type: 'storeErr'; id: string; reason: string }
  | { type: 'fetch' }
  | { type: 'envelope'; id: string; sender: string; ctB64: string; ts: number }
  | { type: 'fetchEnd' }
  | { type: 'ack'; ids: string[] }
  | { type: 'ackOk'; count: number };

// What the sender CBOR-encodes inside the sealed-box.
type InnerEnvelope = {
  v: 1;
  msgId: string;
  ts: number;
  body: string;
  fromPeerId: string;
  toPeerId: string;
  sig: Uint8Array; // 64-byte Ed25519 sig over signingPayload(...)
};

const DOMAIN_TAG = 'buzz:mbox:v1';

export type DeliveredMessage = {
  id: string;
  ts: number;
  body: string;
  fromPeerId: string;
};

export type MailboxBridge = {
  // Identity bytes for sealing/signing. The seed is needed to derive the
  // X25519 secret key for opening sealed boxes.
  identity: IdentityMaterial;
  // Called once per validated incoming envelope. Should persist + notify UI.
  // Returns true if accepted (so we can ack to the relay).
  deliver(msg: DeliveredMessage): Promise<boolean> | boolean;
};

async function signingPayload(
  msgId: string,
  ts: number,
  body: string,
  fromPeerId: string,
  toPeerId: string,
): Promise<Uint8Array> {
  const s = await sodium();
  return s.crypto_generichash(
    32,
    s.from_string(`${DOMAIN_TAG}|${msgId}|${ts}|${body}|${fromPeerId}|${toPeerId}`),
    null,
  );
}

async function recipientCurveKeys(seed: Uint8Array): Promise<{
  pk: Uint8Array;
  sk: Uint8Array;
}> {
  const s = await sodium();
  const kp = s.crypto_sign_seed_keypair(seed);
  const pk = s.crypto_sign_ed25519_pk_to_curve25519(kp.publicKey);
  const sk = s.crypto_sign_ed25519_sk_to_curve25519(kp.privateKey);
  return { pk, sk };
}

// Resolve the X25519 public key for a peer (Ed25519 PeerId).
async function peerCurvePk(peerIdStr: string): Promise<Uint8Array> {
  const pid = peerIdFromString(peerIdStr);
  if (!pid.publicKey) throw new Error(`peer ${peerIdStr} has no embedded public key`);
  const pk = unmarshalPublicKey(pid.publicKey);
  // For Ed25519, marshal() returns the raw 32-byte key.
  const ed = pk.marshal();
  if (ed.length !== 32) throw new Error('expected 32-byte Ed25519 key');
  const s = await sodium();
  return s.crypto_sign_ed25519_pk_to_curve25519(ed);
}

async function peerEdPk(peerIdStr: string): Promise<Uint8Array> {
  const pid = peerIdFromString(peerIdStr);
  if (!pid.publicKey) throw new Error(`peer ${peerIdStr} has no embedded public key`);
  const ed = unmarshalPublicKey(pid.publicKey).marshal();
  if (ed.length !== 32) throw new Error('expected 32-byte Ed25519 key');
  return ed;
}

// ── Wire helpers ─────────────────────────────────────────────────────────────

function encodeFrame(f: Frame): Uint8Array {
  const payload = encode(f);
  if (payload.length > MAX_FRAME) throw new Error('mailbox frame too large');
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

async function* frameReader(stream: Stream): AsyncGenerator<Frame> {
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
      if (len > MAX_FRAME) throw new Error('mailbox frame too large');
      if (buf.length < 4 + len) break;
      const payload = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      yield decode(payload) as Frame;
    }
  }
}

// Drain a list of frames into the stream's sink and close.
async function writeFramesAndClose(stream: Stream, frames: Frame[]): Promise<void> {
  const queue = frames.slice();
  const source: Source<Uint8Array> = (async function* () {
    for (const f of queue) yield encodeFrame(f);
  })();
  await pipe(source, stream.sink);
}

// ── Service ──────────────────────────────────────────────────────────────────

export class MailboxService {
  // Known relays and last successful poll time (unix ms).
  private readonly lastPoll = new Map<string, number>();
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly node: Libp2p,
    private readonly db: Db,
    private readonly bridge: MailboxBridge,
    private readonly getRelays: () => string[],
  ) {}

  async start(): Promise<void> {
    await this.node.handle(MBX_PROTOCOL, ({ stream, connection }) => {
      void this.onIncoming(stream, connection).catch(() => stream.close().catch(() => {}));
    });
    // Periodic poll every 2 minutes.
    this.pollTimer = setInterval(() => void this.pollAll().catch(() => {}), 2 * 60 * 1000);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    await this.node.unhandle(MBX_PROTOCOL).catch(() => {});
  }

  // ── Relay-side handler: serve store/fetch/ack from any authenticated peer ─
  private async onIncoming(stream: Stream, connection: Connection): Promise<void> {
    const peer = connection.remotePeer.toString();
    const out: Frame[] = [];
    const reader = frameReader(stream);
    const first = await reader.next();
    if (first.done) {
      await stream.close().catch(() => {});
      return;
    }
    const req = first.value;
    if (req.type === 'store') {
      // Anyone may store; we just persist what they give us. A future pass
      // can rate-limit by `peer` and reject obviously-malformed envelopes.
      try {
        const r = repos.mailboxStore(this.db, {
          id: req.id,
          recipient: req.recipient,
          sender: req.sender,
          ctB64: req.ctB64,
          ts: req.ts,
        });
        out.push(
          r.stored ? { type: 'storeOk', id: req.id } : { type: 'storeErr', id: req.id, reason: r.reason ?? 'rejected' },
        );
      } catch (e) {
        out.push({ type: 'storeErr', id: req.id, reason: (e as Error).message ?? 'error' });
      }
    } else if (req.type === 'fetch') {
      // Only deliver envelopes addressed to the connecting peer. The Noise XX
      // handshake authenticates that peer cryptographically.
      const rows = repos.mailboxListFor(this.db, peer, 200);
      for (const r of rows) {
        out.push({
          type: 'envelope',
          id: r.id,
          sender: r.sender,
          ctB64: r.ctB64,
          ts: r.ts,
        });
      }
      out.push({ type: 'fetchEnd' });
    } else if (req.type === 'ack') {
      // Same scoping rule: only let `peer` delete envelopes addressed to it.
      const ids = Array.isArray(req.ids) ? req.ids.filter((x) => typeof x === 'string') : [];
      const n = repos.mailboxDelete(this.db, peer, ids);
      out.push({ type: 'ackOk', count: n });
    } else {
      // Unknown verb — just close.
      await stream.close().catch(() => {});
      return;
    }
    await writeFramesAndClose(stream, out);
  }

  // ── Sender side: seal + push to every configured relay ───────────────────
  async pushToRelays(toPeerId: string, msg: { id: string; ts: number; body: string }): Promise<boolean> {
    const relays = this.getRelays();
    if (relays.length === 0) return false;
    const ctB64 = await this.sealEnvelope(toPeerId, msg);
    const fromPeerId = this.node.peerId.toString();
    let any = false;
    await Promise.all(
      relays.map(async (relay) => {
        try {
          const stream = await this.node.dialProtocol(peerIdFromString(relay), MBX_PROTOCOL);
          const reader = frameReader(stream);
          const writer = (async () => {
            await writeFramesAndClose(stream, [
              {
                type: 'store',
                id: msg.id,
                recipient: toPeerId,
                sender: fromPeerId,
                ctB64,
                ts: msg.ts,
              },
            ]);
          })();
          const reply = await reader.next();
          await writer;
          if (!reply.done && reply.value.type === 'storeOk') any = true;
        } catch {
          // Relay unreachable — try the next.
        }
      }),
    );
    return any;
  }

  private async sealEnvelope(
    toPeerId: string,
    msg: { id: string; ts: number; body: string },
  ): Promise<string> {
    if (msg.body.length > MAX_BODY_BYTES) throw new Error('body too large for mailbox');
    const s = await sodium();
    const fromPeerId = this.node.peerId.toString();
    const sig = s.crypto_sign_detached(
      await signingPayload(msg.id, msg.ts, msg.body, fromPeerId, toPeerId),
      this.bridge.identity.secretKey,
    );
    const inner: InnerEnvelope = {
      v: 1,
      msgId: msg.id,
      ts: msg.ts,
      body: msg.body,
      fromPeerId,
      toPeerId,
      sig,
    };
    const plaintext = encode(inner);
    const recipientX = await peerCurvePk(toPeerId);
    const ct = s.crypto_box_seal(plaintext, recipientX);
    return s.to_base64(ct, s.base64_variants.ORIGINAL);
  }

  // ── Recipient side: poll relays + deliver ────────────────────────────────
  async pollAll(): Promise<{ relay: string; delivered: number }[]> {
    const relays = this.getRelays();
    const out: { relay: string; delivered: number }[] = [];
    for (const relay of relays) {
      try {
        const n = await this.pollOne(relay);
        out.push({ relay, delivered: n });
      } catch {
        // Skip unreachable relays silently; the next interval will retry.
      }
    }
    return out;
  }

  async pollOne(relay: string): Promise<number> {
    const stream = await this.node.dialProtocol(peerIdFromString(relay), MBX_PROTOCOL);
    const reader = frameReader(stream);
    const writer = (async () => {
      // We chain two requests: fetch, then ack the ids that opened cleanly.
      // Easiest: we send `fetch` first, drain, then open a second stream for ack.
      await writeFramesAndClose(stream, [{ type: 'fetch' }]);
    })();
    const envelopes: { id: string; sender: string; ctB64: string; ts: number }[] = [];
    for await (const frame of reader) {
      if (frame.type === 'envelope') envelopes.push(frame);
      if (frame.type === 'fetchEnd') break;
    }
    await writer;

    const acceptedIds: string[] = [];
    let delivered = 0;
    for (const env of envelopes) {
      const accepted = await this.openAndDeliver(env);
      if (accepted) {
        acceptedIds.push(env.id);
        delivered += 1;
      } else {
        // Even on bad-sig / corrupt envelopes we ack so the relay frees space.
        acceptedIds.push(env.id);
      }
    }

    if (acceptedIds.length > 0) {
      try {
        const ackStream = await this.node.dialProtocol(peerIdFromString(relay), MBX_PROTOCOL);
        const ackReader = frameReader(ackStream);
        await writeFramesAndClose(ackStream, [{ type: 'ack', ids: acceptedIds }]);
        await ackReader.next().catch(() => undefined);
      } catch {
        // Best effort; envelopes will still be deliverable on next poll if
        // ack failed (we de-dupe by msg id at the application layer).
      }
    }

    this.lastPoll.set(relay, Date.now());
    return delivered;
  }

  private async openAndDeliver(env: {
    id: string;
    sender: string;
    ctB64: string;
    ts: number;
  }): Promise<boolean> {
    try {
      const s = await sodium();
      const ct = s.from_base64(env.ctB64, s.base64_variants.ORIGINAL);
      const { pk, sk } = await recipientCurveKeys(this.bridge.identity.seed);
      const plaintext = s.crypto_box_seal_open(ct, pk, sk);
      const inner = decode(plaintext) as InnerEnvelope;
      if (!inner || inner.v !== 1) return false;
      if (inner.toPeerId !== this.node.peerId.toString()) return false;
      // Verify sender signature against the embedded fromPeerId.
      const senderEd = await peerEdPk(inner.fromPeerId);
      const ok = s.crypto_sign_verify_detached(
        inner.sig,
        await signingPayload(inner.msgId, inner.ts, inner.body, inner.fromPeerId, inner.toPeerId),
        senderEd,
      );
      if (!ok) return false;
      return await this.bridge.deliver({
        id: inner.msgId,
        ts: inner.ts,
        body: inner.body,
        fromPeerId: inner.fromPeerId,
      });
    } catch {
      return false;
    }
  }

  lastPolledAt(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.lastPoll) out[k] = v;
    return out;
  }
}

// Encrypted profile backup bundle (.buzzbackup).
//
// A profile's two on-disk artifacts are already cryptographically protected:
//   - keystore.bin → passphrase-encrypted (Argon2id + secretbox)
//   - buzz.sqlite  → SQLCipher-encrypted with a key derived from the seed
// So the backup container itself does not add encryption — it just bundles
// these files together with a tiny JSON header so they round-trip cleanly.
//
// Binary format (big-endian):
//   magic         "BUZZBACK" (8 bytes)
//   version       uint16   (currently 1)
//   numEntries    uint16
//   for each entry:
//     nameLen     uint16
//     name        utf8 bytes
//     dataLen     uint32
//     data        raw bytes
//
// History export is separate (JSON / CSV strings).

import path from 'node:path';
import * as fs from 'node:fs';
import * as profiles from './profiles.js';
import type { Db } from './db/open.js';

const MAGIC = Buffer.from('BUZZBACK', 'utf8');
const VERSION = 1;

type Entry = { name: string; data: Buffer };

function encodeBundle(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  parts.push(MAGIC);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(VERSION, 0);
  header.writeUInt16BE(entries.length, 2);
  parts.push(header);
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const nameLen = Buffer.alloc(2);
    nameLen.writeUInt16BE(nameBuf.length, 0);
    const dataLen = Buffer.alloc(4);
    dataLen.writeUInt32BE(data.length, 0);
    parts.push(nameLen, nameBuf, dataLen, data);
  }
  return Buffer.concat(parts);
}

function decodeBundle(buf: Buffer): { version: number; entries: Entry[] } {
  if (buf.length < MAGIC.length + 4) throw new Error('Bundle truncated');
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a Buzz backup');
  const version = buf.readUInt16BE(MAGIC.length);
  const numEntries = buf.readUInt16BE(MAGIC.length + 2);
  let off = MAGIC.length + 4;
  const entries: Entry[] = [];
  for (let i = 0; i < numEntries; i++) {
    if (off + 2 > buf.length) throw new Error('Bundle truncated');
    const nameLen = buf.readUInt16BE(off); off += 2;
    if (off + nameLen + 4 > buf.length) throw new Error('Bundle truncated');
    const name = buf.subarray(off, off + nameLen).toString('utf8'); off += nameLen;
    const dataLen = buf.readUInt32BE(off); off += 4;
    if (off + dataLen > buf.length) throw new Error('Bundle truncated');
    const data = Buffer.from(buf.subarray(off, off + dataLen)); off += dataLen;
    entries.push({ name, data });
  }
  return { version, entries };
}

export function exportProfileBundle(profileId: string): Buffer {
  const profile = profiles.getProfile(profileId);
  if (!profile) throw new Error('Unknown profile');
  const dir = profiles.profileDir(profileId);
  const ks = path.join(dir, 'keystore.bin');
  const db = path.join(dir, 'buzz.sqlite');
  if (!fs.existsSync(ks)) throw new Error('Keystore missing');
  const meta = {
    bundleVersion: VERSION,
    exportedAt: Date.now(),
    screenName: profile.screenName,
    createdAt: profile.createdAt,
    mesh: profile.mesh,
  };
  const entries: Entry[] = [
    { name: 'meta.json', data: Buffer.from(JSON.stringify(meta), 'utf8') },
    { name: 'keystore.bin', data: fs.readFileSync(ks) },
  ];
  if (fs.existsSync(db)) {
    entries.push({ name: 'buzz.sqlite', data: fs.readFileSync(db) });
  }
  return encodeBundle(entries);
}

export function importProfileBundle(bundle: Buffer): { profileId: string; screenName: string } {
  const { version, entries } = decodeBundle(bundle);
  if (version !== VERSION) throw new Error(`Unsupported bundle version ${version}`);
  const byName = new Map(entries.map((e) => [e.name, e.data] as const));
  const metaBuf = byName.get('meta.json');
  const ksBuf = byName.get('keystore.bin');
  if (!metaBuf || !ksBuf) throw new Error('Bundle missing required entries');
  let meta: { screenName?: string; mesh?: boolean };
  try {
    meta = JSON.parse(metaBuf.toString('utf8'));
  } catch {
    throw new Error('Bundle meta.json is not valid JSON');
  }
  const screenName = (meta.screenName ?? 'Imported Account').slice(0, 64);
  const profile = profiles.addProfile(screenName, !!meta.mesh);
  const dir = profiles.profileDir(profile.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'keystore.bin'), ksBuf, { mode: 0o600 });
  const dbBuf = byName.get('buzz.sqlite');
  if (dbBuf) fs.writeFileSync(path.join(dir, 'buzz.sqlite'), dbBuf, { mode: 0o600 });
  return { profileId: profile.id, screenName };
}

// ── History export ──────────────────────────────────────────────────────────

type ExportRow = {
  id: string;
  peerId: string;
  alias: string;
  direction: 'in' | 'out';
  ts: number;
  body: string;
  status: string;
  editedAt?: number | null;
  deletedAt?: number | null;
};

function readAllMessages(db: Db): ExportRow[] {
  const aliases = new Map<string, string>();
  for (const r of db.prepare('SELECT peer_id as peerId, alias FROM buddies').all() as Array<{
    peerId: string; alias: string;
  }>) {
    aliases.set(r.peerId, r.alias);
  }
  const rows = db
    .prepare(
      `SELECT id, peer_id as peerId, direction, ts, body, status,
              edited_at as editedAt, deleted_at as deletedAt
       FROM messages ORDER BY ts ASC`,
    )
    .all() as Array<Omit<ExportRow, 'alias'>>;
  return rows.map((r) => ({ ...r, alias: aliases.get(r.peerId) ?? '' }));
}

export function exportHistoryJson(db: Db): string {
  return JSON.stringify(
    { exportedAt: Date.now(), schema: 'buzz.history.v1', messages: readAllMessages(db) },
    null,
    2,
  );
}

function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function exportHistoryCsv(db: Db): string {
  const rows = readAllMessages(db);
  const header = ['id', 'peerId', 'alias', 'direction', 'ts', 'iso', 'status', 'editedAt', 'deletedAt', 'body'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.peerId,
        csvEscape(r.alias),
        r.direction,
        String(r.ts),
        new Date(r.ts).toISOString(),
        r.status,
        r.editedAt ? String(r.editedAt) : '',
        r.deletedAt ? String(r.deletedAt) : '',
        csvEscape(r.body),
      ].join(','),
    );
  }
  return lines.join('\n');
}

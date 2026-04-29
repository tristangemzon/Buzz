import type { Db } from './open.js';
import type { Buddy, ImMessage, PeerProfile, Prefs, Room, RoomMessage } from '@shared/schemas.js';
import { Prefs as PrefsSchema } from '@shared/schemas.js';

// ── identity ─────────────────────────────────────────────────────────────────

export function setIdentity(db: Db, peerId: string, screenName: string): void {
  db.prepare(
    `INSERT INTO identity(id, peer_id, screen_name, created_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET peer_id=excluded.peer_id, screen_name=excluded.screen_name`,
  ).run(peerId, screenName, Date.now());
}

export function getIdentity(db: Db): { peerId: string; screenName: string } | null {
  const row = db
    .prepare('SELECT peer_id as peerId, screen_name as screenName FROM identity WHERE id=1')
    .get() as { peerId: string; screenName: string } | undefined;
  return row ?? null;
}

// ── buddies ──────────────────────────────────────────────────────────────────

export function listBuddies(db: Db): Buddy[] {
  const rows = db
    .prepare(
      `SELECT peer_id as peerId, alias, grp as "group", blocked, warn_level as warnLevel
       FROM buddies ORDER BY grp, alias COLLATE NOCASE`,
    )
    .all() as Array<{
      peerId: string;
      alias: string;
      group: string;
      blocked: number;
      warnLevel: number;
    }>;
  return rows.map((r) => ({
    peerId: r.peerId,
    alias: r.alias,
    group: r.group,
    blocked: !!r.blocked,
    warnLevel: r.warnLevel ?? 0,
    status: 'offline' as const,
  }));
}

export function addBuddy(db: Db, peerId: string, alias: string, group: string): void {
  db.prepare(
    `INSERT INTO buddies(peer_id, alias, grp, blocked, added_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(peer_id) DO UPDATE SET alias=excluded.alias, grp=excluded.grp`,
  ).run(peerId, alias, group, Date.now());
}

export function removeBuddy(db: Db, peerId: string): void {
  db.prepare('DELETE FROM buddies WHERE peer_id = ?').run(peerId);
}

export function renameBuddy(db: Db, peerId: string, alias: string): void {
  db.prepare('UPDATE buddies SET alias=? WHERE peer_id=?').run(alias, peerId);
}

export function blockBuddy(db: Db, peerId: string, blocked: boolean): void {
  db.prepare('UPDATE buddies SET blocked=? WHERE peer_id=?').run(blocked ? 1 : 0, peerId);
}

export function isBlocked(db: Db, peerId: string): boolean {
  const row = db.prepare('SELECT blocked FROM buddies WHERE peer_id=?').get(peerId) as
    | { blocked: number }
    | undefined;
  return !!row?.blocked;
}

// Warn level is clamped 0..100. Each call bumps by `delta` (default +10) and
// returns the new level. A negative delta lets the UI offer a forgive button.
export function warnBuddy(db: Db, peerId: string, delta = 10): number {
  const row = db
    .prepare('SELECT warn_level as warnLevel FROM buddies WHERE peer_id=?')
    .get(peerId) as { warnLevel: number } | undefined;
  const current = row?.warnLevel ?? 0;
  const next = Math.max(0, Math.min(100, current + delta));
  db.prepare('UPDATE buddies SET warn_level=? WHERE peer_id=?').run(next, peerId);
  return next;
}

// ── messages ─────────────────────────────────────────────────────────────────

export function insertMessage(db: Db, m: ImMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages(id, peer_id, direction, ts, body, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(m.id, m.peerId, m.direction, m.ts, m.body, m.status);
}

export function setMessageStatus(db: Db, id: string, status: ImMessage['status']): void {
  db.prepare('UPDATE messages SET status=? WHERE id=?').run(status, id);
}

export function history(db: Db, peerId: string, limit: number, before?: number): ImMessage[] {
  const rows = before
    ? (db
        .prepare(
          `SELECT id, peer_id as peerId, direction, ts, body, status
           FROM messages WHERE peer_id=? AND ts<? ORDER BY ts DESC LIMIT ?`,
        )
        .all(peerId, before, limit) as ImMessage[])
    : (db
        .prepare(
          `SELECT id, peer_id as peerId, direction, ts, body, status
           FROM messages WHERE peer_id=? ORDER BY ts DESC LIMIT ?`,
        )
        .all(peerId, limit) as ImMessage[]);
  return rows.reverse();
}

// ── prefs ────────────────────────────────────────────────────────────────────

export function getPrefs(db: Db): Prefs {
  const rows = db.prepare('SELECT k, v FROM prefs').all() as Array<{ k: string; v: string }>;
  const obj: Record<string, unknown> = {};
  for (const { k, v } of rows) {
    try {
      obj[k] = JSON.parse(v);
    } catch {
      obj[k] = v;
    }
  }
  return PrefsSchema.parse({ ...PrefsSchema.parse({}), ...obj });
}

export function setPrefs(db: Db, patch: Partial<Prefs>): Prefs {
  const stmt = db.prepare(
    `INSERT INTO prefs(k, v) VALUES (?, ?)
     ON CONFLICT(k) DO UPDATE SET v=excluded.v`,
  );
  const tx = db.transaction((entries: Array<[string, unknown]>) => {
    for (const [k, v] of entries) stmt.run(k, JSON.stringify(v));
  });
  tx(Object.entries(patch));
  return getPrefs(db);
}

// ── peer profile cache ───────────────────────────────────────────────────────

export function upsertPeerProfile(db: Db, p: PeerProfile): void {
  db.prepare(
    `INSERT INTO profile_cache(peer_id, screen_name, about_text, text_color,
       bg_color, font_family, avatar, bg_image, last_seen)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(peer_id) DO UPDATE SET
       screen_name=excluded.screen_name,
       about_text=excluded.about_text,
       text_color=excluded.text_color,
       bg_color=excluded.bg_color,
       font_family=excluded.font_family,
       avatar=excluded.avatar,
       bg_image=excluded.bg_image,
       last_seen=excluded.last_seen`,
  ).run(
    p.peerId,
    p.screenName,
    p.aboutText,
    p.textColor,
    p.bgColor,
    p.fontFamily,
    p.avatarDataUrl,
    p.bgImageDataUrl,
    p.lastSeen,
  );
}

export function getPeerProfile(db: Db, peerId: string): PeerProfile | null {
  const row = db
    .prepare(
      `SELECT peer_id as peerId, screen_name as screenName, about_text as aboutText,
              text_color as textColor, bg_color as bgColor, font_family as fontFamily,
              avatar as avatarDataUrl, bg_image as bgImageDataUrl, last_seen as lastSeen
         FROM profile_cache WHERE peer_id=?`,
    )
    .get(peerId) as PeerProfile | undefined;
  return row ?? null;
}

// ── transfers ────────────────────────────────────────────────────────────────

export type TransferRow = {
  id: string;
  peerId: string;
  direction: 'in' | 'out';
  fileName: string;
  fileSize: number;
  fileHash: string;
  status: 'pending' | 'active' | 'complete' | 'failed' | 'declined';
  savedPath: string | null;
  createdAt: number;
  updatedAt: number;
};

export function insertTransfer(db: Db, t: TransferRow): void {
  db.prepare(
    `INSERT INTO transfers(id, peer_id, direction, file_name, file_size, file_hash,
       status, saved_path, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    t.id,
    t.peerId,
    t.direction,
    t.fileName,
    t.fileSize,
    t.fileHash,
    t.status,
    t.savedPath,
    t.createdAt,
    t.updatedAt,
  );
}

export function updateTransferStatus(
  db: Db,
  id: string,
  status: TransferRow['status'],
  savedPath?: string | null,
): void {
  if (savedPath !== undefined) {
    db.prepare(
      'UPDATE transfers SET status=?, saved_path=?, updated_at=? WHERE id=?',
    ).run(status, savedPath, Date.now(), id);
  } else {
    db.prepare('UPDATE transfers SET status=?, updated_at=? WHERE id=?').run(
      status,
      Date.now(),
      id,
    );
  }
}

// ── chat rooms ───────────────────────────────────────────────────────────────

export type RoomRow = { id: string; name: string; keyB64: string; createdAt: number };

export function listRooms(db: Db): Array<Room & { keyB64: string }> {
  const rows = db
    .prepare(
      `SELECT id, name, key_b64 as keyB64, created_at as createdAt FROM rooms ORDER BY created_at DESC`,
    )
    .all() as RoomRow[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    keyB64: r.keyB64,
    createdAt: r.createdAt,
    members: getRoomMembers(db, r.id),
  }));
}

export function getRoom(db: Db, id: string): (Room & { keyB64: string }) | null {
  const r = db
    .prepare(
      `SELECT id, name, key_b64 as keyB64, created_at as createdAt FROM rooms WHERE id=?`,
    )
    .get(id) as RoomRow | undefined;
  if (!r) return null;
  return { id: r.id, name: r.name, keyB64: r.keyB64, createdAt: r.createdAt, members: getRoomMembers(db, r.id) };
}

export function upsertRoom(db: Db, r: { id: string; name: string; keyB64: string; createdAt: number }): void {
  db.prepare(
    `INSERT INTO rooms(id, name, key_b64, created_at) VALUES (?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name`,
  ).run(r.id, r.name, r.keyB64, r.createdAt);
}

export function deleteRoom(db: Db, id: string): void {
  db.prepare('DELETE FROM room_messages WHERE room_id=?').run(id);
  db.prepare('DELETE FROM room_members WHERE room_id=?').run(id);
  db.prepare('DELETE FROM rooms WHERE id=?').run(id);
}

export function getRoomMembers(db: Db, roomId: string): string[] {
  const rows = db
    .prepare('SELECT peer_id as peerId FROM room_members WHERE room_id=? ORDER BY peer_id')
    .all(roomId) as Array<{ peerId: string }>;
  return rows.map((r) => r.peerId);
}

export function setRoomMembers(db: Db, roomId: string, members: string[]): void {
  const tx = db.transaction((ms: string[]) => {
    db.prepare('DELETE FROM room_members WHERE room_id=?').run(roomId);
    const ins = db.prepare('INSERT OR IGNORE INTO room_members(room_id, peer_id) VALUES (?,?)');
    for (const m of ms) ins.run(roomId, m);
  });
  tx(members);
}

export function addRoomMember(db: Db, roomId: string, peerId: string): void {
  db.prepare('INSERT OR IGNORE INTO room_members(room_id, peer_id) VALUES (?,?)').run(roomId, peerId);
}

export function removeRoomMember(db: Db, roomId: string, peerId: string): void {
  db.prepare('DELETE FROM room_members WHERE room_id=? AND peer_id=?').run(roomId, peerId);
}

export function insertRoomMessage(db: Db, m: RoomMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO room_messages(id, room_id, from_peer_id, from_name, direction, ts, body)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(m.id, m.roomId, m.fromPeerId, m.fromName, m.direction, m.ts, m.body);
}

export function roomHistory(db: Db, roomId: string, limit: number, before?: number): RoomMessage[] {
  const rows = before
    ? (db
        .prepare(
          `SELECT id, room_id as roomId, from_peer_id as fromPeerId, from_name as fromName,
                  direction, ts, body
             FROM room_messages WHERE room_id=? AND ts<? ORDER BY ts DESC LIMIT ?`,
        )
        .all(roomId, before, limit) as RoomMessage[])
    : (db
        .prepare(
          `SELECT id, room_id as roomId, from_peer_id as fromPeerId, from_name as fromName,
                  direction, ts, body
             FROM room_messages WHERE room_id=? ORDER BY ts DESC LIMIT ?`,
        )
        .all(roomId, limit) as RoomMessage[]);
  return rows.reverse();
}

// ── mailbox (relay-side storage of sealed envelopes) ─────────────────────────

export type MailboxEnvelopeRow = {
  id: string;
  recipient: string;
  sender: string;
  ctB64: string;
  ts: number;
  storedAt: number;
};

const MAILBOX_PER_RECIPIENT_CAP = 200;
const MAILBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function mailboxStore(
  db: Db,
  e: { id: string; recipient: string; sender: string; ctB64: string; ts: number },
): { stored: boolean; reason?: string } {
  // Drop too-old envelopes proactively when we touch the table.
  db.prepare('DELETE FROM mailbox WHERE stored_at < ?').run(Date.now() - MAILBOX_TTL_MS);
  const count = db
    .prepare('SELECT COUNT(*) as n FROM mailbox WHERE recipient=?')
    .get(e.recipient) as { n: number };
  if (count.n >= MAILBOX_PER_RECIPIENT_CAP) {
    return { stored: false, reason: 'recipient mailbox full' };
  }
  db.prepare(
    `INSERT OR REPLACE INTO mailbox(id, recipient, sender, ct_b64, ts, stored_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(e.id, e.recipient, e.sender, e.ctB64, e.ts, Date.now());
  return { stored: true };
}

export function mailboxListFor(db: Db, recipient: string, limit = 200): MailboxEnvelopeRow[] {
  return db
    .prepare(
      `SELECT id, recipient, sender, ct_b64 as ctB64, ts, stored_at as storedAt
         FROM mailbox WHERE recipient=? ORDER BY ts ASC LIMIT ?`,
    )
    .all(recipient, limit) as MailboxEnvelopeRow[];
}

export function mailboxDelete(db: Db, recipient: string, ids: string[]): number {
  if (ids.length === 0) return 0;
  // Bind only what matches the recipient so a stranger can't delete others'.
  const stmt = db.prepare('DELETE FROM mailbox WHERE recipient=? AND id=?');
  let n = 0;
  const tx = db.transaction((rows: string[]) => {
    for (const r of rows) n += stmt.run(recipient, r).changes;
  });
  tx(ids);
  return n;
}

export function mailboxCount(db: Db): number {
  const r = db.prepare('SELECT COUNT(*) as n FROM mailbox').get() as { n: number };
  return r.n;
}

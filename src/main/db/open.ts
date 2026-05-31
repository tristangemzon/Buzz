// Encrypted SQLite store using better-sqlite3-multiple-ciphers (SQLCipher).

import { randomUUID, pbkdf2Sync } from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3-multiple-ciphers';
import { SCHEMA_SQL } from './schema.js';

export type Db = Database.Database;

export function openDb(file: string, key: Uint8Array): Db {
  const db = new Database(file);
  // Apply raw key (bypasses KDF). SQLite3MultipleCiphers 2.2.5+ correctly
  // handles the x'hex' notation as raw bytes.
  const hex = Buffer.from(key).toString('hex');
  db.pragma(`key="x'${hex}'"`);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Sanity: this throws if key is wrong (SQLCipher will fail to read header).
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch {
    db.close();
    throw new Error('Failed to open encrypted database (wrong key?)');
  }

  // Apply schema (idempotent).
  db.exec(SCHEMA_SQL);

  // Migration: ensure room_messages has channel_id (added when channels feature
  // landed), and back-fill a default "general" channel for every existing room.
  migrateChannels(db);

  // Migration: ensure newer tables (buddy_requests, room_reads) exist on
  // legacy DBs. The schema apply above already creates them via IF NOT EXISTS,
  // but some old installs were opened before those statements were added.
  migrateBuddyRequestsAndReads(db);

  // Migration: add v0.5.0 columns and tables (reactions, edit/delete support).
  migrateV050(db);

  // Migration: add v0.6.0 columns (replies, @mentions, pinning, roles, categories).
  migrateV060(db);

  return db;
}

/**
 * Opens a database created with bsmc v11 (SQLite3MultipleCiphers < 2.2.5).
 *
 * In v11 the x'hex' raw-key notation was broken (bug #218): the bypass flag
 * was never set, so PBKDF2-HMAC-SHA256 was applied to the literal string
 * "x'hexvalue'" as a passphrase.  In v12 the bypass is now correctly detected
 * even in the single-quoted pragma path, making it impossible to replicate the
 * v11 behaviour through a pragma string alone.
 *
 * Fix: read the ChaCha20 salt from the first 16 bytes of the database file
 * (written there in plaintext by SQLite3MC), manually run
 * PBKDF2-HMAC-SHA256("x'hexvalue'", salt, 64007, 32), then supply the derived
 * bytes as a raw key via the double-quoted x'hex' pragma (bypass=1 in v12).
 *
 * The database is opened without schema changes so it can be read for migration.
 */
export function openDbLegacy(file: string, key: Uint8Array): Db {
  // ChaCha20 cipher constants (SQLite3MC defaults).
  const SALT_LEN = 16;
  const KEY_LEN = 32;
  const KDF_ITER = 64007; // CHACHA20_KDF_ITER_DEFAULT

  // The salt is stored in plaintext at the very start of the database file.
  const fileBuf = fs.readFileSync(file);
  if (fileBuf.length < SALT_LEN) {
    throw new Error('Database file is too small to be a valid legacy database.');
  }
  const salt = fileBuf.subarray(0, SALT_LEN);

  // Reproduce the passphrase string that v11 fed into PBKDF2.
  const hex = Buffer.from(key).toString('hex');
  const passphrase = `x'${hex}'`; // the literal string the buggy v11 used as passphrase

  // Derive the 32-byte ChaCha20 encryption key.
  const derivedKey = pbkdf2Sync(passphrase, salt, KDF_ITER, KEY_LEN, 'sha256');
  const derivedKeyHex = derivedKey.toString('hex');

  // Open with the derived raw key (bypasses KDF in v12 via the x'hex' notation).
  const db = new Database(file);
  db.pragma(`key="x'${derivedKeyHex}'"`);

  // Verify it actually opens (throws on wrong key).
  db.prepare('SELECT count(*) FROM sqlite_master').get();
  return db;
}

function migrateChannels(db: Db): void {
  const cols = db.prepare('PRAGMA table_info(room_messages)').all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === 'channel_id')) {
    db.exec(`ALTER TABLE room_messages ADD COLUMN channel_id TEXT NOT NULL DEFAULT ''`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_room_messages_channel_ts ON room_messages(channel_id, ts DESC)`,
    );
  }

  // Voice-channel feature added the `kind` column on room_channels.
  const ccols = db.prepare('PRAGMA table_info(room_channels)').all() as Array<{
    name: string;
  }>;
  if (!ccols.some((c) => c.name === 'kind')) {
    db.exec(`ALTER TABLE room_channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'`);
  }

  // For each room without any channel rows, create a default "general" channel
  // and attribute existing messages to it.
  const rooms = db.prepare('SELECT id FROM rooms').all() as Array<{ id: string }>;
  const insChan = db.prepare(
    `INSERT OR IGNORE INTO room_channels(id, room_id, name, is_default, created_at)
     VALUES (?, ?, ?, 1, ?)`,
  );
  const updMsgs = db.prepare(
    `UPDATE room_messages SET channel_id=? WHERE room_id=? AND (channel_id='' OR channel_id IS NULL)`,
  );
  const tx = db.transaction(() => {
    for (const r of rooms) {
      const has = db
        .prepare('SELECT COUNT(*) as n FROM room_channels WHERE room_id=?')
        .get(r.id) as { n: number };
      if (has.n === 0) {
        const cid = randomUUID();
        insChan.run(cid, r.id, 'general', Date.now());
        updMsgs.run(cid, r.id);
      } else {
        // Make sure orphaned messages get attributed to the default channel.
        const def = db
          .prepare(
            'SELECT id FROM room_channels WHERE room_id=? AND is_default=1 LIMIT 1',
          )
          .get(r.id) as { id: string } | undefined;
        if (def) updMsgs.run(def.id, r.id);
      }
    }
  });
  tx();
}

function migrateBuddyRequestsAndReads(db: Db): void {
  // The schema is applied with IF NOT EXISTS so this is mostly a no-op, but
  // keep an explicit hook so we can layer further per-install fixups here.
  db.exec(`
    CREATE TABLE IF NOT EXISTS buddy_requests (
      peer_id     TEXT PRIMARY KEY,
      direction   TEXT NOT NULL CHECK (direction IN ('in','out')),
      screen_name TEXT NOT NULL DEFAULT '',
      ts          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_buddy_requests_dir ON buddy_requests(direction);
    CREATE TABLE IF NOT EXISTS room_reads (
      room_id       TEXT PRIMARY KEY,
      last_seen_ts  INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function migrateV050(db: Db): void {
  // Idempotently add v0.5.0 columns and tables to existing databases.
  const msgCols = (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!msgCols.includes('edited_at')) {
    db.exec('ALTER TABLE messages ADD COLUMN edited_at INTEGER');
  }
  if (!msgCols.includes('deleted_at')) {
    db.exec('ALTER TABLE messages ADD COLUMN deleted_at INTEGER');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS reactions (
      msg_id   TEXT NOT NULL,
      peer_id  TEXT NOT NULL,
      emoji    TEXT NOT NULL,
      ts       INTEGER NOT NULL,
      PRIMARY KEY (msg_id, peer_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(msg_id);
  `);
}

function migrateV060(db: Db): void {
  // Idempotently add v0.6.0 columns to existing databases.

  // rooms: add owner_peer_id
  const roomCols = (db.prepare('PRAGMA table_info(rooms)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!roomCols.includes('owner_peer_id')) {
    db.exec("ALTER TABLE rooms ADD COLUMN owner_peer_id TEXT NOT NULL DEFAULT ''");
  }

  // room_members: add role
  const memberCols = (db.prepare('PRAGMA table_info(room_members)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!memberCols.includes('role')) {
    db.exec("ALTER TABLE room_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
  }

  // room_messages: add reply_to_id, mentions, is_pinned, edited_at, deleted_at
  const rmCols = (db.prepare('PRAGMA table_info(room_messages)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!rmCols.includes('reply_to_id'))  db.exec('ALTER TABLE room_messages ADD COLUMN reply_to_id TEXT');
  if (!rmCols.includes('mentions'))     db.exec('ALTER TABLE room_messages ADD COLUMN mentions TEXT');
  if (!rmCols.includes('is_pinned'))    db.exec('ALTER TABLE room_messages ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0');
  if (!rmCols.includes('edited_at'))    db.exec('ALTER TABLE room_messages ADD COLUMN edited_at INTEGER');
  if (!rmCols.includes('deleted_at'))   db.exec('ALTER TABLE room_messages ADD COLUMN deleted_at INTEGER');

  // room_channels: add category
  const chanCols = (db.prepare('PRAGMA table_info(room_channels)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!chanCols.includes('category')) {
    db.exec("ALTER TABLE room_channels ADD COLUMN category TEXT NOT NULL DEFAULT ''");
  }
}

// Encrypted SQLite store using better-sqlite3-multiple-ciphers (SQLCipher).

import { randomUUID } from 'node:crypto';
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
  } catch (err) {
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

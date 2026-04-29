// Encrypted SQLite store using better-sqlite3-multiple-ciphers (SQLCipher).

import Database from 'better-sqlite3-multiple-ciphers';
import { SCHEMA_SQL } from './schema.js';

export type Db = Database.Database;

export function openDb(file: string, key: Uint8Array): Db {
  const db = new Database(file);
  // Apply SQLCipher key as a hex blob via raw key syntax.
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

  return db;
}

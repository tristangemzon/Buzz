// Schema applied (idempotently) on every DB open. Inlined so the bundler
// includes it without any extra asset-copy step.

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS identity (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  peer_id       TEXT NOT NULL,
  screen_name   TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS buddies (
  peer_id       TEXT PRIMARY KEY,
  alias         TEXT NOT NULL,
  grp           TEXT NOT NULL DEFAULT 'Buddies',
  blocked       INTEGER NOT NULL DEFAULT 0,
  warn_level    INTEGER NOT NULL DEFAULT 0,
  added_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_buddies_grp ON buddies(grp);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  peer_id     TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('in','out')),
  ts          INTEGER NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('queued','sent','delivered','read','failed'))
);

CREATE INDEX IF NOT EXISTS idx_messages_peer_ts ON messages(peer_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(direction, status, peer_id);

CREATE TABLE IF NOT EXISTS prefs (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_cache (
  peer_id      TEXT PRIMARY KEY,
  screen_name  TEXT NOT NULL DEFAULT '',
  about_text   TEXT NOT NULL DEFAULT '',
  text_color   TEXT NOT NULL DEFAULT '',
  bg_color     TEXT NOT NULL DEFAULT '',
  font_family  TEXT NOT NULL DEFAULT '',
  avatar       TEXT NOT NULL DEFAULT '',
  bg_image     TEXT NOT NULL DEFAULT '',
  last_seen    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transfers (
  id          TEXT PRIMARY KEY,
  peer_id     TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('in','out')),
  file_name   TEXT NOT NULL,
  file_size   INTEGER NOT NULL,
  file_hash   TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL CHECK (status IN ('pending','active','complete','failed','declined')),
  saved_path  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transfers_peer_ts ON transfers(peer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rooms (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  key_b64        TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  owner_peer_id  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id  TEXT NOT NULL,
  peer_id  TEXT NOT NULL,
  role     TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (room_id, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_room_members_room ON room_members(room_id);

CREATE TABLE IF NOT EXISTS room_messages (
  id            TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL,
  from_peer_id  TEXT NOT NULL,
  from_name     TEXT NOT NULL DEFAULT '',
  direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
  ts            INTEGER NOT NULL,
  body          TEXT NOT NULL,
  channel_id    TEXT NOT NULL DEFAULT '',
  reply_to_id   TEXT,
  mentions      TEXT,
  is_pinned     INTEGER NOT NULL DEFAULT 0,
  edited_at     INTEGER,
  deleted_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_room_messages_room_ts ON room_messages(room_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_room_messages_channel_ts ON room_messages(channel_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_room_messages_from_peer ON room_messages(from_peer_id);

CREATE TABLE IF NOT EXISTS room_channels (
  id          TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'text',
  category    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_room_channels_room ON room_channels(room_id);

CREATE TABLE IF NOT EXISTS mailbox (
  id              TEXT PRIMARY KEY,
  recipient       TEXT NOT NULL,
  sender          TEXT NOT NULL DEFAULT '',
  ct_b64          TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  stored_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mailbox_recipient_ts ON mailbox(recipient, ts ASC);
CREATE INDEX IF NOT EXISTS idx_mailbox_stored_at ON mailbox(stored_at);

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

INSERT OR IGNORE INTO schema_version(version) VALUES (1);
`;

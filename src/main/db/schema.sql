-- Buzz SQLCipher schema (v1).

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
  status      TEXT NOT NULL CHECK (status IN ('queued','sent','delivered','read','failed')),
  edited_at   INTEGER,
  deleted_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_peer_ts ON messages(peer_id, ts DESC);

CREATE TABLE IF NOT EXISTS reactions (
  msg_id   TEXT NOT NULL,
  peer_id  TEXT NOT NULL,
  emoji    TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  PRIMARY KEY (msg_id, peer_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(msg_id);

CREATE TABLE IF NOT EXISTS prefs (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_version(version) VALUES (1);

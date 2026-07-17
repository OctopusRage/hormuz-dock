import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { DATA_DIR } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(`${DATA_DIR}/apphub.db`);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL UNIQUE,
    password   TEXT NOT NULL,          -- scrypt hash: salt:hash
    role       TEXT NOT NULL DEFAULT 'user',  -- 'admin' | 'user'
    created_at TEXT NOT NULL,
    created_by TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL,
    user_id    INTEGER,
    username   TEXT,
    action     TEXT NOT NULL,
    target     TEXT,
    detail     TEXT,
    status     INTEGER
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    name         TEXT,                 -- human label ("claude-ci", "laptop")
    prefix       TEXT NOT NULL,        -- first chars, shown for identification
    hash         TEXT NOT NULL UNIQUE, -- sha256(full key); the plaintext is never stored
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
  CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(hash);
`);

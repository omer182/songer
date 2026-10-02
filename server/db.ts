import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, 'songer.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    image TEXT,
    refresh_token_enc TEXT NOT NULL,
    access_token TEXT,
    access_expires INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );

  -- Song catalog shared across users. norm = normalized "title artists" for search.
  CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY,
    uri TEXT NOT NULL,
    title TEXT NOT NULL,
    artists TEXT NOT NULL,
    album TEXT NOT NULL,
    year INTEGER,
    image TEXT,
    duration_ms INTEGER NOT NULL,
    norm TEXT NOT NULL
  );

  -- Which tracks belong to which of a user's sources: liked, top:short_term, pl:<id>, artist:<id>, ...
  CREATE TABLE IF NOT EXISTS user_tracks (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES tracks(id),
    source TEXT NOT NULL,
    pos INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, source, track_id)
  );
  CREATE INDEX IF NOT EXISTS user_tracks_track ON user_tracks(user_id, track_id);

  CREATE TABLE IF NOT EXISTS playlists (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    image TEXT,
    count INTEGER NOT NULL,
    owner TEXT NOT NULL,
    pos INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );

  CREATE TABLE IF NOT EXISTS artists (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    image TEXT,
    pos INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );

  -- When a source's tracks were last fetched (playlists and artist catalogs load on demand).
  CREATE TABLE IF NOT EXISTS source_sync (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    synced_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, source)
  );

  CREATE TABLE IF NOT EXISTS library_sync (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    error TEXT,
    finished_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS solo_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_label TEXT NOT NULL,
    score INTEGER NOT NULL,
    max_score INTEGER NOT NULL,
    detail TEXT NOT NULL,
    played_at INTEGER NOT NULL
  );
`);

/* ---------- migrations ---------- */

const hasColumn = (table: string, col: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);

/** True when this start changed the schema in a way that needs the Spotify library re-read. */
export let needsResync = false;

// v2: artist IDs for spelling-proof matching, Hebrew artist names, playlist ownership.
if (!hasColumn('tracks', 'artist_ids')) {
  db.exec(`ALTER TABLE tracks ADD COLUMN artist_ids TEXT NOT NULL DEFAULT ''`);
  needsResync = true;
}
if (!hasColumn('playlists', 'owner_id')) {
  db.exec(`ALTER TABLE playlists ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`);
  db.exec(`ALTER TABLE playlists ADD COLUMN collaborative INTEGER NOT NULL DEFAULT 0`);
  needsResync = true;
}
if (needsResync) db.exec('DELETE FROM source_sync');

/** Run fn inside a transaction. node:sqlite has no helper for this. */
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

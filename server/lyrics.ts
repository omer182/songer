// Time-synced lyrics for the sing-along reveal, from LRCLIB (lrclib.net: free, open, no key).
// Spotify doesn't give apps its lyrics. Coverage is great for international songs, partial for Hebrew.

import { db } from './db.js';
import { normTitle } from '../shared/match.js';
import { parseLrc, type LyricLine } from '../shared/lrc.js';

export type { LyricLine };

db.exec(`CREATE TABLE IF NOT EXISTS lyrics (track_id TEXT PRIMARY KEY, lines_json TEXT, fetched_at INTEGER NOT NULL)`);
const getCached = db.prepare('SELECT lines_json, fetched_at FROM lyrics WHERE track_id = ?');
const setCached = db.prepare(
  'INSERT INTO lyrics (track_id, lines_json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(track_id) DO UPDATE SET lines_json = excluded.lines_json, fetched_at = excluded.fetched_at',
);

interface LrcHit {
  trackName: string;
  artistName: string;
  duration: number;
  syncedLyrics: string | null;
}

async function search(params: Record<string, string>): Promise<LrcHit[]> {
  const res = await fetch(`https://lrclib.net/api/search?${new URLSearchParams(params)}`, {
    headers: { 'User-Agent': 'Songer (https://github.com/omer182/songer)' },
  });
  if (!res.ok) throw new Error(`LRCLIB: ${res.status}`);
  return (await res.json()) as LrcHit[];
}

/** Synced lyrics for a track, or null if none were found. Cached (misses for a week). */
export async function getLyrics(trackId: string, title: string, artists: string, durationMs: number): Promise<LyricLine[] | null> {
  const cached = getCached.get(trackId) as { lines_json: string | null; fetched_at: number } | undefined;
  if (cached && (cached.lines_json || Date.now() - cached.fetched_at < 7 * 864e5)) {
    return cached.lines_json ? (JSON.parse(cached.lines_json) as LyricLine[]) : null;
  }
  const artist = artists.split(', ')[0];
  const clean = title.replace(/\s[-–—]\s.*$/, '').replace(/\s*[([].*?[)\]]\s*/g, ' ').trim() || title;
  let hits = (await search({ track_name: clean, artist_name: artist })).filter((h) => h.syncedLyrics);
  if (!hits.length) hits = (await search({ q: `${clean} ${artist}` })).filter((h) => h.syncedLyrics && normTitle(h.trackName) === normTitle(clean));
  // Prefer the version whose length matches (radio edits and live takes have different timings).
  const want = durationMs / 1000;
  hits.sort((a, b) => Math.abs(a.duration - want) - Math.abs(b.duration - want));
  const best = hits.find((h) => Math.abs(h.duration - want) <= 8) ?? null;
  const lines = best ? parseLrc(best.syncedLyrics!) : null;
  setCached.run(trackId, lines && lines.length ? JSON.stringify(lines) : null, Date.now());
  return lines && lines.length ? lines : null;
}

// Deezer's public API (no key, no sign-in) as a source of song *lists*: Spotify won't share playlists
// that aren't yours, but Deezer will. Each Deezer track is matched to its Spotify version for playback.

import { db } from './db.js';
import { api, toTrack, type SpTrack } from './spotify.js';
import { normBasic, normTitle } from '../shared/match.js';
import type { PlaylistInfo, Track } from '../shared/types.js';

const DEEZER = 'https://api.deezer.com';

export interface DzTrack {
  id: number;
  title: string;
  title_short?: string;
  duration: number;
  artist: { name: string };
  album?: { title: string };
  readable?: boolean;
}

async function dz<T>(path: string): Promise<T> {
  const res = await fetch(`${DEEZER}${path}`, { headers: { 'Accept-Language': 'he,en;q=0.8' } });
  if (!res.ok) throw new Error(`Deezer: ${res.status}`);
  const body = (await res.json()) as T & { error?: { message?: string } };
  if (body.error) throw new Error(`Deezer: ${body.error.message ?? 'error'}`);
  return body;
}

/**
 * Deezer's playlist search is literal ("israeli rock 2000" finds nothing, "israeli rock" does), so when a
 * query finds too little, also try it without numbers and then with fewer words, and merge the results.
 */
export async function searchDeezerPlaylists(q: string): Promise<PlaylistInfo[]> {
  type P = { id: number; title: string; nb_tracks: number; picture_medium?: string; user?: { name: string } };
  const words = q.trim().split(/\s+/).filter(Boolean);
  const noNumbers = words.filter((w) => !/^\d+s?$|^'?\d0s$/.test(w));
  const variants = [...new Set([words, noNumbers, noNumbers.slice(0, 2), noNumbers.slice(0, 1)].map((w) => w.join(' ')).filter(Boolean))];
  const seen = new Set<number>();
  const out: PlaylistInfo[] = [];
  for (const v of variants) {
    const r = await dz<{ data: P[] }>(`/search/playlist?limit=25&q=${encodeURIComponent(v)}`);
    for (const p of r.data) {
      if (p.nb_tracks < 5 || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ id: String(p.id), name: p.title, image: p.picture_medium ?? null, count: p.nb_tracks, owner: p.user?.name ?? 'Deezer', available: true });
    }
    if (out.length >= 10) break;
  }
  return out.slice(0, 30);
}

const listCache = new Map<string, { at: number; tracks: DzTrack[] }>();

export async function deezerPlaylistTracks(id: string, max = 400): Promise<DzTrack[]> {
  const hit = listCache.get(id);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.tracks;
  const out: DzTrack[] = [];
  for (let index = 0; out.length < max; index += 100) {
    const page = await dz<{ data: DzTrack[]; next?: string }>(`/playlist/${encodeURIComponent(id)}/tracks?limit=100&index=${index}`);
    out.push(...page.data);
    if (!page.next || !page.data.length) break;
  }
  listCache.set(id, { at: Date.now(), tracks: out });
  return out;
}

/* ---------- matching Deezer → Spotify ---------- */

const getMap = db.prepare('SELECT spotify_id FROM deezer_map WHERE deezer_id = ?');
const setMap = db.prepare(
  'INSERT INTO deezer_map (deezer_id, spotify_id, checked_at) VALUES (?, ?, ?) ON CONFLICT(deezer_id) DO UPDATE SET spotify_id = excluded.spotify_id, checked_at = excluded.checked_at',
);
const getTrack = db.prepare('SELECT * FROM tracks WHERE id = ?');

/** Score how well a Spotify search hit matches the Deezer track. */
function score(d: DzTrack, s: SpTrack, rank: number): number {
  const dt = normTitle(d.title_short || d.title);
  const st = normTitle(s.name);
  let pts = 0;
  if (dt === st) pts += 3;
  else if (dt && st && (st.startsWith(dt) || dt.startsWith(st))) pts += 1.5;
  const diff = Math.abs(s.duration_ms / 1000 - d.duration);
  if (diff <= 3) pts += 2;
  else if (diff <= 10) pts += 1;
  const da = normBasic(d.artist.name);
  if (s.artists.some((a) => normBasic(a.name) === da)) pts += 1.5; // only when both spell it the same way
  // Spotify's search understands transliteration ("Hi Holechet Badrachim" → היא הולכת בדרכים), so its top
  // hit with the same length is almost always right even when the titles are in different scripts.
  if (rank === 0 && diff <= 2) pts += 1;
  return pts - rank * 0.2;
}

async function searchSpotify(userId: string, q: string, limit = 5): Promise<SpTrack[]> {
  const r = await api<{ tracks: { items: (SpTrack | null)[] } }>(userId, `/search?type=track&limit=${limit}&q=${encodeURIComponent(q)}`);
  return r.tracks.items.filter((t): t is SpTrack => !!t?.id);
}

const rowToTrack = (r: Record<string, unknown>): Track => ({
  id: r.id as string,
  uri: r.uri as string,
  title: r.title as string,
  artists: r.artists as string,
  artistIds: String(r.artist_ids || '').split(',').filter(Boolean),
  album: r.album as string,
  year: (r.year as number | null) ?? null,
  image: (r.image as string | null) ?? null,
  durationMs: r.duration_ms as number,
});

/**
 * Find the Spotify version of a Deezer track, or null. Results (including misses) are cached.
 * Field filters match an artist in any spelling, so "Shlomo Artzi" on Deezer still finds "שלמה ארצי".
 */
export async function resolveOnSpotify(userId: string, d: DzTrack): Promise<Track | null> {
  const cached = getMap.get(String(d.id)) as { spotify_id: string | null } | undefined;
  if (cached) {
    if (!cached.spotify_id) return null;
    const row = getTrack.get(cached.spotify_id) as Record<string, unknown> | undefined;
    if (row) return rowToTrack(row);
  }
  const title = (d.title_short || d.title).replace(/"/g, '');
  const artist = d.artist.name.replace(/"/g, '');
  let best: { t: SpTrack; s: number } | null = null;
  const queries = [`track:"${title}" artist:"${artist}"`, `${title} ${artist}`];
  for (const q of queries) {
    const hits = await searchSpotify(userId, q);
    // Hits from the field-filtered query already matched title + artist in Spotify's index (any spelling).
    const bonus = q === queries[0] ? 1 : 0;
    hits.forEach((t, i) => {
      const s = score(d, t, i) + bonus;
      if (!best || s > best.s) best = { t, s };
    });
    if (best && (best as { s: number }).s >= 4) break;
  }
  let found = best as { t: SpTrack; s: number } | null;
  if (!found || found.s < 2.5) {
    // Last resort for titles in different scripts: the artist's songs, accepted only if exactly one has the same length.
    const byArtist = await searchSpotify(userId, `artist:"${artist}"`, 10);
    const sameLength = byArtist.filter((t) => Math.abs(t.duration_ms / 1000 - d.duration) <= 1.5);
    if (sameLength.length === 1) found = { t: sameLength[0], s: 3 };
  }
  const track = found && found.s >= 2.5 ? toTrack(found.t) : null;
  setMap.run(String(d.id), track?.id ?? null, Date.now());
  return track;
}

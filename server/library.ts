import { db, tx } from './db.js';
import { allPages, api, pickImage, SpotifyError, toTrack, type SpAlbumLite, type SpTrack } from './spotify.js';
import { isGameVersion, LIVE, matchesQuery, normBasic, songKey } from '../shared/match.js';
import { deezerPlaylistTracks, resolveOnSpotify } from './deezer.js';
import type { ArtistInfo, LibraryStatus, PlaylistInfo, Source, Suggestion, TopRange, Track } from '../shared/types.js';

const HOUR = 3600_000;
const TOP_RANGES: TopRange[] = ['short_term', 'medium_term', 'long_term'];

/* ---------- storage helpers ---------- */

const upsertTrack = db.prepare(
  `INSERT INTO tracks (id, uri, title, artists, artist_ids, album, year, image, duration_ms, norm)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET title = excluded.title, artists = excluded.artists, artist_ids = excluded.artist_ids,
     album = excluded.album, year = excluded.year, image = COALESCE(excluded.image, tracks.image), norm = excluded.norm`,
);

function saveSource(userId: string, source: string, tracks: (Track | null)[]) {
  const list = tracks.filter((t): t is Track => !!t);
  tx(() => {
    for (const t of list) {
      upsertTrack.run(t.id, t.uri, t.title, t.artists, t.artistIds.join(','), t.album, t.year, t.image, t.durationMs, normBasic(`${t.title} ${t.artists}`));
    }
    db.prepare('DELETE FROM user_tracks WHERE user_id = ? AND source = ?').run(userId, source);
    const ins = db.prepare('INSERT OR IGNORE INTO user_tracks (user_id, track_id, source, pos) VALUES (?, ?, ?, ?)');
    list.forEach((t, i) => ins.run(userId, t.id, source, i));
    db.prepare(
      'INSERT INTO source_sync (user_id, source, synced_at) VALUES (?, ?, ?) ON CONFLICT(user_id, source) DO UPDATE SET synced_at = excluded.synced_at',
    ).run(userId, source, Date.now());
  });
  return list.length;
}

function syncedAt(userId: string, source: string): number {
  const row = db.prepare('SELECT synced_at FROM source_sync WHERE user_id = ? AND source = ?').get(userId, source) as
    | { synced_at: number }
    | undefined;
  return row?.synced_at ?? 0;
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

function tracksForSource(userId: string, source: string): Track[] {
  const rows = db
    .prepare(
      `SELECT t.* FROM user_tracks ut JOIN tracks t ON t.id = ut.track_id
       WHERE ut.user_id = ? AND ut.source = ? ORDER BY ut.pos`,
    )
    .all(userId, source) as Record<string, unknown>[];
  return rows.map(rowToTrack);
}

/* ---------- full library sync (liked, top, recent, playlists, artists) ---------- */

const running = new Map<string, Promise<void>>();

function setStatus(userId: string, status: LibraryStatus['status'], error: string | null = null) {
  db.prepare(
    `INSERT INTO library_sync (user_id, status, error, finished_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, error = excluded.error,
       finished_at = COALESCE(excluded.finished_at, library_sync.finished_at)`,
  ).run(userId, status, error, status === 'syncing' ? null : Date.now());
}

export function syncLibrary(userId: string): Promise<void> {
  const existing = running.get(userId);
  if (existing) return existing;
  const p = (async () => {
    setStatus(userId, 'syncing');
    try {
      const liked = await allPages<{ track: SpTrack }>(userId, '/me/tracks?limit=50', 10000);
      saveSource(userId, 'liked', liked.map((x) => toTrack(x.track)));

      for (const range of TOP_RANGES) {
        const top = await api<{ items: SpTrack[] }>(userId, `/me/top/tracks?time_range=${range}&limit=50`);
        saveSource(userId, `top:${range}`, top.items.map((t) => toTrack(t)));
      }

      const recent = await api<{ items: { track: SpTrack }[] }>(userId, '/me/player/recently-played?limit=50');
      saveSource(userId, 'recent', recent.items.map((x) => toTrack(x.track)));

      type SpPlaylist = { id: string; name: string; images?: { url: string }[] | null; owner?: { display_name?: string; id: string };
        collaborative?: boolean; tracks?: { total: number }; items?: { total: number } };
      const pls = (await allPages<SpPlaylist | null>(userId, '/me/playlists?limit=50', 1000)).filter((p): p is SpPlaylist => !!p);
      tx(() => {
        db.prepare('DELETE FROM playlists WHERE user_id = ?').run(userId);
        const ins = db.prepare(
          'INSERT OR REPLACE INTO playlists (user_id, id, name, image, count, owner, owner_id, collaborative, pos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        );
        pls.forEach((p, i) =>
          ins.run(userId, p.id, p.name, p.images?.[0]?.url ?? null, p.items?.total ?? p.tracks?.total ?? 0,
            p.owner?.display_name || p.owner?.id || '', p.owner?.id ?? '', p.collaborative ? 1 : 0, i),
        );
      });

      type SpArtist = { id: string; name: string; images?: { url: string; width?: number }[] };
      const topArtists = await api<{ items: SpArtist[] }>(userId, '/me/top/artists?time_range=medium_term&limit=50');
      const followed: SpArtist[] = [];
      let next: string | null = '/me/following?type=artist&limit=50';
      while (next && followed.length < 1000) {
        const page: { artists: { items: SpArtist[]; next: string | null } } = await api(userId, next);
        followed.push(...page.artists.items);
        next = page.artists.next;
      }
      const seen = new Set<string>();
      const artists = [...topArtists.items, ...followed].filter((a) => !seen.has(a.id) && seen.add(a.id));
      tx(() => {
        db.prepare('DELETE FROM artists WHERE user_id = ?').run(userId);
        const ins = db.prepare('INSERT OR REPLACE INTO artists (user_id, id, name, image, pos) VALUES (?, ?, ?, ?, ?)');
        artists.forEach((a, i) => ins.run(userId, a.id, a.name, pickImage(a.images), i));
      });
      setStatus(userId, 'idle');
    } catch (e) {
      setStatus(userId, 'error', e instanceof Error ? e.message : String(e));
      throw e;
    }
  })().finally(() => running.delete(userId));
  running.set(userId, p);
  return p;
}

export function libraryStatus(userId: string): LibraryStatus {
  const s = db.prepare('SELECT status, error, finished_at FROM library_sync WHERE user_id = ?').get(userId) as
    | { status: LibraryStatus['status']; error: string | null; finished_at: number | null }
    | undefined;
  const count = (sql: string) => (db.prepare(sql).get(userId) as { n: number }).n;
  return {
    status: running.has(userId) ? 'syncing' : (s?.status ?? 'idle'),
    error: s?.error ?? null,
    finishedAt: s?.finished_at ?? null,
    counts: {
      liked: count("SELECT COUNT(*) n FROM user_tracks WHERE user_id = ? AND source = 'liked'"),
      top: count("SELECT COUNT(DISTINCT track_id) n FROM user_tracks WHERE user_id = ? AND source LIKE 'top:%'"),
      playlists: count('SELECT COUNT(*) n FROM playlists WHERE user_id = ?'),
      artists: count('SELECT COUNT(*) n FROM artists WHERE user_id = ?'),
      indexed: count('SELECT COUNT(DISTINCT track_id) n FROM user_tracks WHERE user_id = ?'),
    },
  };
}

/**
 * Your playlists, playable ones first. Playlists someone else made come back with available=false:
 * Spotify refuses to share their songs with personal apps (copy them into your own to play them).
 */
export function listPlaylists(userId: string): PlaylistInfo[] {
  const rows = db
    .prepare(
      `SELECT id, name, image, count, owner, (owner_id = user_id OR collaborative = 1) AS available
       FROM playlists WHERE user_id = ? AND count > 0 ORDER BY available DESC, pos`,
    )
    .all(userId) as (Omit<PlaylistInfo, 'available'> & { available: number })[];
  return rows.map((r) => ({ ...r, available: !!r.available }));
}

export function listArtists(userId: string): ArtistInfo[] {
  return db.prepare('SELECT id, name, image FROM artists WHERE user_id = ? ORDER BY pos').all(userId) as unknown as ArtistInfo[];
}

/* ---------- on-demand sources ---------- */

async function ensurePlaylist(userId: string, id: string) {
  const source = `pl:${id}`;
  if (Date.now() - syncedAt(userId, source) < 6 * HOUR) return;
  // Spotify renamed playlist "tracks" to "items" in 2026; accept both shapes.
  type Item = { item?: SpTrack | null; track?: SpTrack | null };
  try {
    const items = await allPages<Item>(userId, `/playlists/${encodeURIComponent(id)}/items?limit=50`, 3000);
    saveSource(userId, source, items.map((x) => toTrack(x.item ?? x.track)));
  } catch (e) {
    if (e instanceof SpotifyError && (e.status === 403 || e.status === 404)) {
      throw new SpotifyError(e.status, "Spotify only shares songs from playlists you own. To use this one, add its songs to a playlist of your own in Spotify.");
    }
    throw e;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

type SpAlbumFull = SpAlbumLite & { id: string; album_type: string; tracks: { items: SpTrack[] } };

async function ensureArtist(userId: string, id: string) {
  const source = `artist:${id}`;
  if (Date.now() - syncedAt(userId, source) < 7 * 24 * HOUR) return;
  type AlbumLite = { id: string; name: string; album_type: string; release_date?: string };
  // Spotify caps this endpoint at 10 per page for personal apps (undocumented; 20+ returns "Invalid limit").
  const albums = await allPages<AlbumLite>(userId, `/artists/${encodeURIComponent(id)}/albums?include_groups=album,single&limit=10`, 80);
  // Albums first (studio versions beat singles), skip obvious live/remix records, newest 40 at most.
  const picked = albums
    .filter((a) => !/\b(live|remix(es)?|karaoke|instrumental)\b/i.test(a.name))
    .sort((a, b) => (a.album_type === b.album_type ? (b.release_date ?? '').localeCompare(a.release_date ?? '') : a.album_type === 'album' ? -1 : 1))
    .slice(0, 40);
  // Spotify removed the batch albums endpoint for personal apps, so fetch them one at a time.
  const full = await mapLimit(picked, 4, (a) => api<SpAlbumFull>(userId, `/albums/${a.id}`));
  const seen = new Set<string>();
  const tracks: Track[] = [];
  for (const al of full) {
    for (const t of al.tracks.items) {
      if (!t.artists.some((a) => a.id === id) || LIVE.test(t.name)) continue;
      const tr = toTrack(t, al);
      if (!tr) continue;
      const key = songKey(tr);
      if (seen.has(key)) continue;
      seen.add(key);
      tracks.push(tr);
    }
  }
  saveSource(userId, source, tracks);
}

async function ensureAlbum(userId: string, id: string) {
  const source = `album:${id}`;
  if (syncedAt(userId, source)) return;
  const al = await api<SpAlbumFull>(userId, `/albums/${encodeURIComponent(id)}`);
  saveSource(userId, source, al.tracks.items.map((t) => toTrack(t, al)));
}

export function sourceKey(s: Source): string {
  switch (s.type) {
    case 'top': return `top:${s.range}`;
    case 'liked': return 'liked';
    case 'recent': return 'recent';
    case 'playlist': return `pl:${s.id}`;
    case 'artist': return `artist:${s.id}`;
    case 'album': return `album:${s.id}`;
    case 'deezer': return `dz:${s.id}`;
  }
}

const shuffle = <T>(a: T[]) => {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};

/** Random songs from a Deezer playlist, each matched to Spotify; tries extra songs to cover misses. */
async function deezerPool(userId: string, id: string, count: number): Promise<Track[]> {
  const list = shuffle(await deezerPlaylistTracks(id)).filter((t) => t.readable !== false);
  const out: Track[] = [];
  const seen = new Set<string>();
  // Resolve in small batches until we have enough (each try costs one or two Spotify searches).
  for (let i = 0; i < list.length && out.length < count && i < count * 3; i += 4) {
    const batch = await Promise.all(list.slice(i, i + 4).map((d) => resolveOnSpotify(userId, d).catch(() => null)));
    for (const t of batch) {
      if (!t || out.length >= count) continue;
      const k = songKey(t);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
  }
  if (!out.length) throw new SpotifyError(404, "Couldn't find this playlist's songs on Spotify. Try another playlist.");
  // Keep them in the guess index too.
  tx(() => {
    for (const t of out) upsertTrack.run(t.id, t.uri, t.title, t.artists, t.artistIds.join(','), t.album, t.year, t.image, t.durationMs, normBasic(`${t.title} ${t.artists}`));
    const ins = db.prepare('INSERT OR IGNORE INTO user_tracks (user_id, track_id, source, pos) VALUES (?, ?, ?, 0)');
    for (const t of out) ins.run(userId, t.id, `dz:${id}`);
  });
  return out;
}

/**
 * The artist's songs, most popular first. Spotify no longer exposes popularity or "top tracks" to personal apps,
 * but its search ranks results by how much they're played, so an artist-filtered search reads like their hits list.
 */
async function rankedArtistSongs(userId: string, artistId: string, artistName: string): Promise<Track[]> {
  const out: Track[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < 50; offset += 10) {
    const r = await api<{ tracks: { items: (SpTrack | null)[] } }>(
      userId,
      `/search?type=track&limit=10&offset=${offset}&q=${encodeURIComponent(`artist:"${artistName}"`)}`,
    );
    for (const sp of r.tracks.items) {
      if (!sp || !sp.artists.some((a) => a.id === artistId) || !isGameVersion(sp.name)) continue;
      const t = toTrack(sp);
      if (!t) continue;
      const k = songKey(t);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
    if (r.tracks.items.length < 10) break;
  }
  return out;
}

/**
 * A band's game: mostly their hits, never live versions. At least 5 songs (or ~60% of the game) come from the
 * band's 15 most popular, the rest from the next most popular; the full catalogue only fills gaps.
 */
async function artistPool(userId: string, artistId: string, artistName: string | undefined, count: number): Promise<Track[]> {
  await ensureArtist(userId, artistId);
  const catalog = tracksForSource(userId, `artist:${artistId}`).filter((t) => isGameVersion(t.title));
  const name =
    artistName ||
    (db.prepare('SELECT name FROM artists WHERE user_id = ? AND id = ?').get(userId, artistId) as { name: string } | undefined)?.name ||
    catalog[0]?.artists.split(', ')[0];
  let ranked: Track[] = [];
  try {
    if (name) ranked = await rankedArtistSongs(userId, artistId, name);
  } catch (e) {
    console.warn(`Popularity ranking unavailable for ${artistId}:`, e instanceof Error ? e.message : e);
  }

  const hits = ranked.slice(0, 15);
  const nextBest = ranked.slice(15);
  const hitCount = Math.min(hits.length, Math.max(5, Math.round(count * 0.6)));
  const chosen = shuffle(hits).slice(0, hitCount);
  const used = new Set(chosen.map(songKey));
  const take = (list: Track[]) => {
    for (const t of shuffle(list)) {
      if (chosen.length >= count) return;
      const k = songKey(t);
      if (!used.has(k)) {
        used.add(k);
        chosen.push(t);
      }
    }
  };
  take(nextBest);
  take(hits); // small bands may not have enough "next best" songs
  take(catalog);
  if (!chosen.length) throw new SpotifyError(404, 'No playable songs found for this artist.');
  // Keep them in the guess index.
  tx(() => {
    for (const t of chosen) upsertTrack.run(t.id, t.uri, t.title, t.artists, t.artistIds.join(','), t.album, t.year, t.image, t.durationMs, normBasic(`${t.title} ${t.artists}`));
    const ins = db.prepare('INSERT OR IGNORE INTO user_tracks (user_id, track_id, source, pos) VALUES (?, ?, ?, 0)');
    for (const t of chosen) ins.run(userId, t.id, `artist:${artistId}`);
  });
  return shuffle(chosen);
}

/** Pick `count` random, de-duplicated songs from a source, loading it from Spotify if needed. */
export async function buildPool(userId: string, source: Source, count: number): Promise<Track[]> {
  if (source.type === 'deezer') return deezerPool(userId, source.id, count);
  if (source.type === 'artist') return artistPool(userId, source.id, source.name, count);
  if (source.type === 'playlist') await ensurePlaylist(userId, source.id);
  if (source.type === 'album') await ensureAlbum(userId, source.id);
  if (['top', 'liked', 'recent'].includes(source.type) && !syncedAt(userId, sourceKey(source))) await syncLibrary(userId);
  const seen = new Set<string>();
  const unique = tracksForSource(userId, sourceKey(source)).filter((t) => {
    const k = songKey(t);
    return !seen.has(k) && seen.add(k);
  });
  return shuffle(unique).slice(0, count);
}

/* ---------- search ---------- */

export async function suggest(userId: string, q: string): Promise<Suggestion[]> {
  const query = normBasic(q);
  if (query.length < 2) return [];
  const first = query.split(' ').sort((a, b) => b.length - a.length)[0];
  type Hit = { id: string; title: string; artists: string; artist_ids: string; norm: string };
  const local = (
    db
      .prepare(
        `SELECT DISTINCT t.id, t.title, t.artists, t.artist_ids, t.norm FROM tracks t
         WHERE t.norm LIKE ? AND EXISTS (SELECT 1 FROM user_tracks ut WHERE ut.user_id = ? AND ut.track_id = t.id)
         LIMIT 300`,
      )
      .all(`%${first}%`, userId) as Hit[]
  )
    .filter((r) => matchesQuery(r.norm, query))
    .sort((a, b) => Number(b.norm.startsWith(query)) - Number(a.norm.startsWith(query)) || a.title.length - b.title.length);

  let remote: Omit<Hit, 'norm'>[] = [];
  try {
    const res = await api<{ tracks: { items: (SpTrack | null)[] } }>(userId, `/search?type=track&limit=10&q=${encodeURIComponent(q)}`);
    remote = res.tracks.items
      .filter((t): t is SpTrack => !!t?.id)
      .map((t) => ({ id: t.id!, title: t.name, artists: t.artists.map((a) => a.name).join(', '), artist_ids: t.artists.map((a) => a.id).join(',') }));
  } catch {
    /* local results are enough if Spotify search hiccups */
  }

  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const s of [...local.slice(0, 6), ...remote, ...local.slice(6)]) {
    const key = songKey(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, trackId: s.id, title: s.title, artists: s.artists, artistIds: s.artist_ids.split(',').filter(Boolean) });
    if (out.length >= 8) break;
  }
  return out;
}

export async function searchArtists(userId: string, q: string): Promise<ArtistInfo[]> {
  type SpArtist = { id: string; name: string; images?: { url: string; width?: number }[] };
  const res = await api<{ artists: { items: (SpArtist | null)[] } }>(userId, `/search?type=artist&limit=10&q=${encodeURIComponent(q)}`);
  return res.artists.items.filter((a): a is SpArtist => !!a).map((a) => ({ id: a.id, name: a.name, image: pickImage(a.images) }));
}

export function saveSoloResult(userId: string, label: string, score: number, maxScore: number, detail: unknown) {
  db.prepare('INSERT INTO solo_results (user_id, source_label, score, max_score, detail, played_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    userId, label, score, maxScore, JSON.stringify(detail), Date.now(),
  );
}

import { db, tx } from './db.js';
import { allPages, api, pickImage, SpotifyError, toTrack, type SpAlbumLite, type SpTrack } from './spotify.js';
import { matchesQuery, normBasic, songKey } from '../shared/match.js';
import type { ArtistInfo, LibraryStatus, PlaylistInfo, Source, Suggestion, TopRange, Track } from '../shared/types.js';

const HOUR = 3600_000;
const TOP_RANGES: TopRange[] = ['short_term', 'medium_term', 'long_term'];

/* ---------- storage helpers ---------- */

const upsertTrack = db.prepare(
  `INSERT INTO tracks (id, uri, title, artists, album, year, image, duration_ms, norm)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET title = excluded.title, artists = excluded.artists, album = excluded.album,
     year = excluded.year, image = COALESCE(excluded.image, tracks.image), norm = excluded.norm`,
);

function saveSource(userId: string, source: string, tracks: (Track | null)[]) {
  const list = tracks.filter((t): t is Track => !!t);
  tx(() => {
    for (const t of list) {
      upsertTrack.run(t.id, t.uri, t.title, t.artists, t.album, t.year, t.image, t.durationMs, normBasic(`${t.title} ${t.artists}`));
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
        tracks?: { total: number }; items?: { total: number } };
      const pls = (await allPages<SpPlaylist | null>(userId, '/me/playlists?limit=50', 1000)).filter((p): p is SpPlaylist => !!p);
      tx(() => {
        db.prepare('DELETE FROM playlists WHERE user_id = ?').run(userId);
        const ins = db.prepare('INSERT OR REPLACE INTO playlists (user_id, id, name, image, count, owner, pos) VALUES (?, ?, ?, ?, ?, ?, ?)');
        pls.forEach((p, i) =>
          ins.run(userId, p.id, p.name, p.images?.[0]?.url ?? null, p.items?.total ?? p.tracks?.total ?? 0, p.owner?.display_name || p.owner?.id || '', i),
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

export function listPlaylists(userId: string): PlaylistInfo[] {
  return db.prepare('SELECT id, name, image, count, owner FROM playlists WHERE user_id = ? ORDER BY pos').all(userId) as unknown as PlaylistInfo[];
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
      throw new SpotifyError(e.status, "Spotify won't share this playlist's songs with Songer. Spotify-made playlists are off-limits to personal apps; try one made by a person.");
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
  const albums = await allPages<AlbumLite>(userId, `/artists/${encodeURIComponent(id)}/albums?include_groups=album,single&limit=50`, 300);
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
      if (!t.artists.some((a) => a.id === id)) continue;
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

/** Pick `count` random, de-duplicated songs from a source, loading it from Spotify if needed. */
export async function buildPool(userId: string, source: Source, count: number): Promise<Track[]> {
  if (source.type === 'playlist') await ensurePlaylist(userId, source.id);
  if (source.type === 'artist') await ensureArtist(userId, source.id);
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
  const local = (
    db
      .prepare(
        `SELECT DISTINCT t.title, t.artists, t.norm FROM tracks t
         WHERE t.norm LIKE ? AND EXISTS (SELECT 1 FROM user_tracks ut WHERE ut.user_id = ? AND ut.track_id = t.id)
         LIMIT 300`,
      )
      .all(`%${first}%`, userId) as { title: string; artists: string; norm: string }[]
  )
    .filter((r) => matchesQuery(r.norm, query))
    .sort((a, b) => Number(b.norm.startsWith(query)) - Number(a.norm.startsWith(query)) || a.title.length - b.title.length);

  let remote: { title: string; artists: string }[] = [];
  try {
    const res = await api<{ tracks: { items: (SpTrack | null)[] } }>(userId, `/search?type=track&limit=10&q=${encodeURIComponent(q)}`);
    remote = res.tracks.items.filter((t): t is SpTrack => !!t).map((t) => ({ title: t.name, artists: t.artists.map((a) => a.name).join(', ') }));
  } catch {
    /* local results are enough if Spotify search hiccups */
  }

  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const s of [...local.slice(0, 6), ...remote, ...local.slice(6)]) {
    const key = songKey(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, title: s.title, artists: s.artists });
    if (out.length >= 8) break;
  }
  return out;
}

export async function searchArtists(userId: string, q: string): Promise<ArtistInfo[]> {
  type SpArtist = { id: string; name: string; images?: { url: string; width?: number }[] };
  const res = await api<{ artists: { items: (SpArtist | null)[] } }>(userId, `/search?type=artist&limit=10&q=${encodeURIComponent(q)}`);
  return res.artists.items.filter((a): a is SpArtist => !!a).map((a) => ({ id: a.id, name: a.name, image: pickImage(a.images) }));
}

export async function searchPlaylists(userId: string, q: string): Promise<PlaylistInfo[]> {
  type SpPl = { id: string; name: string; images?: { url: string }[] | null; owner?: { display_name?: string; id: string };
    tracks?: { total: number }; items?: { total: number } };
  const res = await api<{ playlists: { items: (SpPl | null)[] } }>(userId, `/search?type=playlist&limit=10&q=${encodeURIComponent(q)}`);
  return res.playlists.items
    .filter((p): p is SpPl => !!p)
    .map((p) => ({ id: p.id, name: p.name, image: p.images?.[0]?.url ?? null, count: p.items?.total ?? p.tracks?.total ?? 0, owner: p.owner?.display_name || p.owner?.id || '' }));
}

export function saveSoloResult(userId: string, label: string, score: number, maxScore: number, detail: unknown) {
  db.prepare('INSERT INTO solo_results (user_id, source_label, score, max_score, detail, played_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    userId, label, score, maxScore, JSON.stringify(detail), Date.now(),
  );
}

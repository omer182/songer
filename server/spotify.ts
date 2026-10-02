import { config } from './config.js';
import { db } from './db.js';
import { decrypt, encrypt } from './auth.js';
import type { Track } from '../shared/types.js';

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';

// streaming + user-read-email + user-read-private are required by the Web Playback SDK.
export const SCOPES = [
  'user-top-read',
  'user-library-read',
  'user-read-recently-played',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-follow-read',
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

export class SpotifyError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function authorizeUrl(state: string): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: config.spotify.clientId,
    scope: SCOPES,
    redirect_uri: config.redirectUri,
    state,
    show_dialog: 'false',
  });
  return `${ACCOUNTS}/authorize?${q}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const basic = Buffer.from(`${config.spotify.clientId}:${config.spotify.clientSecret}`).toString('base64');
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new SpotifyError(res.status, `Spotify token request failed: ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

/** Exchange the OAuth code, fetch the profile and upsert the user. Returns the user id. */
export async function completeLogin(code: string): Promise<string> {
  const tok = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri });
  if (!tok.refresh_token) throw new Error('Spotify did not return a refresh token.');
  const meRes = await fetch(`${API}/me`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  if (!meRes.ok) {
    // 403 here usually means the account isn't on the app's user list in the Spotify dashboard.
    throw new SpotifyError(meRes.status, meRes.status === 403
      ? 'This Spotify account is not on the app\'s user list. Add it under User Management in the Spotify dashboard.'
      : `Could not read your Spotify profile (${meRes.status}).`);
  }
  const me = (await meRes.json()) as { id: string; display_name: string | null; images?: { url: string }[] };
  if (config.allowedIds.length && !config.allowedIds.includes(me.id)) {
    throw new SpotifyError(403, 'This Spotify account is not allowed on this Songer server.');
  }
  db.prepare(
    `INSERT INTO users (id, name, image, refresh_token_enc, access_token, access_expires, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, image = excluded.image,
       refresh_token_enc = excluded.refresh_token_enc, access_token = excluded.access_token,
       access_expires = excluded.access_expires`,
  ).run(
    me.id,
    me.display_name || me.id,
    me.images?.[0]?.url ?? null,
    encrypt(tok.refresh_token),
    tok.access_token,
    Date.now() + tok.expires_in * 1000,
    Date.now(),
  );
  return me.id;
}

const refreshing = new Map<string, Promise<string>>();

/** A valid access token for the user, refreshed when it's within a minute of expiring. */
export async function accessToken(userId: string): Promise<{ token: string; expiresAt: number }> {
  const row = db.prepare('SELECT access_token, access_expires, refresh_token_enc FROM users WHERE id = ?').get(userId) as
    | { access_token: string | null; access_expires: number; refresh_token_enc: string }
    | undefined;
  if (!row) throw new SpotifyError(401, 'Unknown user. Sign in again.');
  if (row.access_token && row.access_expires - Date.now() > 60_000) {
    return { token: row.access_token, expiresAt: row.access_expires };
  }
  let p = refreshing.get(userId);
  if (!p) {
    p = (async () => {
      const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(row.refresh_token_enc) });
      db.prepare('UPDATE users SET access_token = ?, access_expires = ?, refresh_token_enc = COALESCE(?, refresh_token_enc) WHERE id = ?').run(
        tok.access_token,
        Date.now() + tok.expires_in * 1000,
        tok.refresh_token ? encrypt(tok.refresh_token) : null,
        userId,
      );
      return tok.access_token;
    })().finally(() => refreshing.delete(userId));
    refreshing.set(userId, p);
  }
  const token = await p;
  const fresh = db.prepare('SELECT access_expires FROM users WHERE id = ?').get(userId) as { access_expires: number };
  return { token, expiresAt: fresh.access_expires };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET a Spotify Web API path (or full URL) as the user, retrying rate limits and server errors. */
export async function api<T>(userId: string, pathOrUrl: string, attempt = 0): Promise<T> {
  const { token } = await accessToken(userId);
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429 && attempt < 5) {
    const wait = Number(res.headers.get('retry-after') || 1);
    await sleep(Math.min(wait, 30) * 1000 + 250);
    return api<T>(userId, pathOrUrl, attempt + 1);
  }
  if (res.status >= 500 && attempt < 3) {
    await sleep(800 * (attempt + 1));
    return api<T>(userId, pathOrUrl, attempt + 1);
  }
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      msg = ((await res.json()) as { error?: { message?: string } }).error?.message || msg;
    } catch {
      /* not json */
    }
    throw new SpotifyError(res.status, `Spotify: ${msg}`);
  }
  return (await res.json()) as T;
}

interface Page<T> {
  items: T[];
  next: string | null;
}

/** Follow `next` links. maxItems guards against enormous libraries. */
export async function allPages<T>(userId: string, first: string, maxItems = 5000): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = first;
  while (url && out.length < maxItems) {
    const page: Page<T> = await api<Page<T>>(userId, url);
    out.push(...page.items);
    url = page.next;
  }
  return out;
}

/* ---------- mapping ---------- */

export interface SpTrack {
  id: string | null;
  uri: string;
  name: string;
  is_local?: boolean;
  type?: string;
  duration_ms: number;
  artists: { id: string; name: string }[];
  album?: { name: string; release_date?: string; images?: { url: string; width?: number }[] };
}

export interface SpAlbumLite {
  name: string;
  release_date?: string;
  images?: { url: string; width?: number }[];
}

function pickImage(images?: { url: string; width?: number }[]): string | null {
  if (!images?.length) return null;
  const mid = images.find((i) => (i.width ?? 0) >= 250 && (i.width ?? 0) <= 700);
  return (mid ?? images[0]).url;
}

/** Convert a Spotify track object to ours. Album can be supplied for album-track listings. */
export function toTrack(t: SpTrack | null | undefined, album?: SpAlbumLite): Track | null {
  if (!t || !t.id || t.is_local || (t.type && t.type !== 'track') || t.duration_ms < 30_000) return null;
  const al = t.album ?? album;
  const year = al?.release_date ? Number(al.release_date.slice(0, 4)) || null : null;
  return {
    id: t.id,
    uri: t.uri,
    title: t.name,
    artists: t.artists.map((a) => a.name).join(', '),
    album: al?.name ?? '',
    year,
    image: pickImage(al?.images),
    durationMs: t.duration_ms,
  };
}

export { pickImage };

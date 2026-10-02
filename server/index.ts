import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Server } from 'socket.io';
import { config, spotifyConfigured } from './config.js';
import { db, needsResync } from './db.js';
import { cookieOptions, createSession, destroySession, parseCookies, requireUser, signValue, unsignValue } from './auth.js';
import { accessToken, authorizeUrl, completeLogin, SpotifyError } from './spotify.js';
import {
  buildPool, libraryStatus, listArtists, listPlaylists, saveSoloResult, searchArtists, suggest, syncLibrary,
} from './library.js';
import { attachParty } from './party.js';
import { searchDeezerPlaylists } from './deezer.js';
import type { Me, Source } from '../shared/types.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// Express 5 forwards rejected promises to the error handler; this just keeps handlers short.
type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/config', (_req, res) => {
  res.json({ spotifyConfigured: spotifyConfigured(), redirectUri: config.redirectUri, joinBaseUrl: config.joinBaseUrl });
});

/* ---------- auth ---------- */

const STATE_COOKIE = 'songer_oauth';

app.get('/api/auth/login', (_req, res) => {
  if (!spotifyConfigured()) {
    res.status(500).send('Spotify is not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env.');
    return;
  }
  const state = crypto.randomBytes(16).toString('base64url');
  res.cookie(STATE_COOKIE, signValue(state), cookieOptions(10 * 60_000));
  res.redirect(authorizeUrl(state));
});

app.get(
  '/api/auth/callback',
  route(async (req, res) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    const expected = unsignValue(parseCookies(req.headers.cookie)[STATE_COOKIE]);
    res.clearCookie(STATE_COOKIE, { path: '/' });
    if (error) return res.redirect(`/?error=${encodeURIComponent(error === 'access_denied' ? 'You cancelled the Spotify sign-in.' : error)}`);
    if (!code || !state || state !== expected) return res.redirect(`/?error=${encodeURIComponent('Sign-in expired. Try again.')}`);
    try {
      const userId = await completeLogin(code);
      createSession(res, userId);
      syncLibrary(userId).catch(() => {}); // status is reported through /api/library/status
      res.redirect('/');
    } catch (e) {
      res.redirect(`/?error=${encodeURIComponent(e instanceof Error ? e.message : 'Sign-in failed.')}`);
    }
  }),
);

/* ---------- phone pairing: sign a phone in as you by scanning a QR on the signed-in laptop ---------- */
// Spotify sign-in only works at the registered address (127.0.0.1 in dev), so phones get a one-time link instead.

const pairTokens = new Map<string, { userId: string; expires: number }>();

app.post('/api/pair', requireUser, (req, res) => {
  const now = Date.now();
  for (const [t, v] of pairTokens) if (v.expires < now) pairTokens.delete(t);
  const token = crypto.randomBytes(18).toString('base64url');
  pairTokens.set(token, { userId: req.userId!, expires: now + 5 * 60_000 });
  res.json({ url: `${config.joinBaseUrl}/api/pair/${token}`, expiresInSec: 300 });
});

app.get('/api/pair/:token', (req, res) => {
  const p = pairTokens.get(req.params.token);
  pairTokens.delete(req.params.token); // single use
  if (!p || p.expires < Date.now()) {
    res.status(410).send('This link expired or was already used. Make a new one on the laptop.');
    return;
  }
  createSession(res, p.userId);
  res.redirect('/remote');
});

app.post('/api/auth/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => {
  const u = db.prepare('SELECT id, name, image FROM users WHERE id = ?').get(req.userId!) as Me | undefined;
  if (!u) return void res.status(401).json({ error: 'Sign in again.' });
  res.json(u);
});

/** Short-lived access token for the in-browser Spotify player. */
app.get(
  '/api/auth/token',
  requireUser,
  route(async (req, res) => {
    const t = await accessToken(req.userId!);
    res.json({ accessToken: t.token, expiresAt: t.expiresAt });
  }),
);

/* ---------- library ---------- */

app.post('/api/library/sync', requireUser, (req, res) => {
  syncLibrary(req.userId!).catch(() => {});
  res.json(libraryStatus(req.userId!));
});

app.get('/api/library/status', requireUser, (req, res) => {
  res.json(libraryStatus(req.userId!));
});

app.get('/api/library/playlists', requireUser, (req, res) => {
  res.json(listPlaylists(req.userId!));
});

app.get('/api/library/artists', requireUser, (req, res) => {
  res.json(listArtists(req.userId!));
});

app.get(
  '/api/search/artists',
  requireUser,
  route(async (req, res) => res.json(await searchArtists(req.userId!, String(req.query.q || '')))),
);

app.get(
  '/api/search/deezer-playlists',
  requireUser,
  route(async (req, res) => res.json(await searchDeezerPlaylists(String(req.query.q || '')))),
);

app.get(
  '/api/search/songs',
  requireUser,
  route(async (req, res) => res.json(await suggest(req.userId!, String(req.query.q || '')))),
);

app.post(
  '/api/pool',
  requireUser,
  route(async (req, res) => {
    const { source, count } = req.body as { source: Source; count?: number };
    if (!source?.type) return res.status(400).json({ error: 'Pick a source.' });
    res.json(await buildPool(req.userId!, source, Math.min(Math.max(Number(count) || 10, 1), 50)));
  }),
);

app.post('/api/solo/result', requireUser, (req, res) => {
  const { label, score, maxScore, detail } = req.body as { label: string; score: number; maxScore: number; detail: unknown };
  saveSoloResult(req.userId!, String(label || '').slice(0, 100), Number(score) || 0, Number(maxScore) || 0, detail ?? null);
  res.json({ ok: true });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof SpotifyError ? (err.status === 401 ? 401 : err.status === 403 || err.status === 404 ? err.status : 502) : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err instanceof Error ? err.message : 'Something went wrong.' });
});

/* ---------- static web app (production) ---------- */

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
if (fs.existsSync(path.join(webDir, 'index.html'))) {
  app.use(express.static(webDir, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api|\/socket\.io).*/, (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
}

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
attachParty(io);

server.listen(config.port, () => {
  console.log(`Songer server on http://127.0.0.1:${config.port}  (public URL ${config.publicUrl})`);
  if (needsResync) {
    // The schema changed (e.g. Hebrew names, artist IDs): re-read every signed-in library once.
    for (const { id } of db.prepare('SELECT id FROM users').all() as { id: string }[]) {
      syncLibrary(id).then(() => console.log(`Library re-synced for ${id}`)).catch((e) => console.warn(`Re-sync failed for ${id}: ${e.message}`));
    }
  }
  if (!spotifyConfigured()) console.warn('Spotify is not configured yet: set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env');
});

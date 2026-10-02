import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { db } from './db.js';

/* ---------- refresh-token encryption (AES-256-GCM) ---------- */

const encKey = crypto.createHash('sha256').update(config.tokenEncKey).digest();

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(packed: string): string {
  const [iv, tag, body] = packed.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

/* ---------- signed cookies ---------- */

const sign = (v: string) => crypto.createHmac('sha256', config.sessionSecret).update(v).digest('base64url');

export function signValue(v: string): string {
  return `${v}.${sign(v)}`;
}

export function unsignValue(signed: string | undefined): string | null {
  if (!signed) return null;
  const i = signed.lastIndexOf('.');
  if (i < 1) return null;
  const v = signed.slice(0, i);
  const expected = Buffer.from(sign(v));
  const got = Buffer.from(signed.slice(i + 1));
  return expected.length === got.length && crypto.timingSafeEqual(expected, got) ? v : null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const SESSION_COOKIE = 'songer_sid';
const SESSION_DAYS = 60;

export function cookieOptions(maxAgeMs: number) {
  return { httpOnly: true, sameSite: 'lax' as const, secure: config.secureCookies, maxAge: maxAgeMs, path: '/' };
}

/* ---------- sessions ---------- */

export function createSession(res: Response, userId: string) {
  const id = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO sessions (id, user_id, created_at) VALUES (?, ?, ?)').run(id, userId, Date.now());
  res.cookie(SESSION_COOKIE, signValue(id), cookieOptions(SESSION_DAYS * 864e5));
}

/** Resolve the signed-in user from a raw Cookie header (used by Socket.IO too). */
export function userIdFromCookieHeader(header: string | undefined): string | null {
  const sid = unsignValue(parseCookies(header)[SESSION_COOKIE]);
  if (!sid) return null;
  const row = db.prepare('SELECT user_id, created_at FROM sessions WHERE id = ?').get(sid) as
    | { user_id: string; created_at: number }
    | undefined;
  if (!row || Date.now() - row.created_at > SESSION_DAYS * 864e5) return null;
  return row.user_id;
}

export function destroySession(req: Request, res: Response) {
  const sid = unsignValue(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
  }
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  const userId = userIdFromCookieHeader(req.headers.cookie);
  if (!userId) {
    res.status(401).json({ error: 'Sign in with Spotify first.' });
    return;
  }
  req.userId = userId;
  next();
}

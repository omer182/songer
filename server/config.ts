import path from 'node:path';

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}

const publicUrl = (process.env.PUBLIC_URL?.trim() || 'http://127.0.0.1:5173').replace(/\/$/, '');

export const config = {
  port: Number(process.env.PORT || 5100),
  publicUrl,
  joinBaseUrl: (process.env.JOIN_BASE_URL?.trim() || publicUrl).replace(/\/$/, ''),
  redirectUri: `${publicUrl}/api/auth/callback`,
  secureCookies: publicUrl.startsWith('https://'),
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  allowedIds: (process.env.ALLOWED_SPOTIFY_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  spotify: {
    clientId: process.env.SPOTIFY_CLIENT_ID?.trim() || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET?.trim() || '',
  },
  sessionSecret: required('SESSION_SECRET'),
  tokenEncKey: required('TOKEN_ENC_KEY'),
};

export const spotifyConfigured = () => Boolean(config.spotify.clientId && config.spotify.clientSecret);

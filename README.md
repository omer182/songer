# Songer

Name-that-tune on your own Spotify library. Hear the first half-second of a song, guess it, and every miss plays a little more (0.5s, 1s, 2s, 4s, 8s, 15s).

- **Solo**: pick your top tracks, Liked Songs, a band, a playlist or recent plays and guess song by song.
- **Party**: a laptop on the TV plays the music; family and friends scan a QR code, pick a team, and their phones become buzzers. The host judges answers out loud.

Audio comes from Spotify itself through the [Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk): the browser tab becomes a Spotify device called "Songer". The server never touches audio; it stores your login, a song index for guessing, and party state.

## Requirements

- Spotify **Premium** on the account that signs in (the SDK refuses free accounts).
- Chrome, Edge or Firefox **on a computer** for anything that plays music. Phones only join parties as buzzers.
- Node 22.13+ (uses the built-in `node:sqlite`).

## Spotify app setup (once)

1. Go to https://developer.spotify.com/dashboard → **Create app**.
2. Redirect URIs (must match exactly):
   - `http://127.0.0.1:5173/api/auth/callback` (local dev; Spotify rejects `localhost`)
   - `https://songer.omersher.com/api/auth/callback` (homeserver)
3. APIs used: **Web API** and **Web Playback SDK**.
4. Copy Client ID and Client Secret into `.env`.

Personal ("Development mode") Spotify apps allow at most 5 Spotify accounts, added under **User Management**. Songer only needs yours; party guests never sign in.

## Run locally

```bash
cp .env.example .env    # then fill in SPOTIFY_CLIENT_ID / SECRET; generate the two secrets as shown in the file
npm install
npm run dev             # API on :5100, web on http://127.0.0.1:5173
```

Open **http://127.0.0.1:5173** (not `localhost`, or the Spotify sign-in cookie won't match).

To let phones join a party in local dev, set `JOIN_BASE_URL` to your PC's LAN address (Vite prints it as "Network", e.g. `http://192.168.0.178:5173`) so the QR code points somewhere a phone can reach.

```bash
npm test          # matching rules + a full party game over real sockets
npm run typecheck
npm run build && npm start   # production build on :5100
```

## Deploy (homeserver)

Same flow as geoquest:

1. Push to `main` → GitHub Actions runs tests, builds `ghcr.io/omer182/songer:latest`.
2. In Portainer, create a stack from `docker-compose.prod.yml` with `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SESSION_SECRET`, `TOKEN_ENC_KEY` in the stack environment.
3. Nginx Proxy Manager: `songer.omersher.com` → `songer:5100`, SSL on, **Websockets Support on**.

Data (SQLite) lives in the `/data` volume.

## How it fits together

```
web/        React app (Vite). pages/: Login, Home, Solo, PartyHost (setup + TV), Join (phone)
  lib/player.ts   Spotify Web Playback SDK wrapper: primes a track silently, then plays exact clips from 0:00
server/     Express + Socket.IO
  spotify.ts      OAuth, token refresh (refresh token AES-GCM encrypted at rest), API calls with retry
  library.ts      library sync, on-demand playlists/artist catalogs, song pools, guess suggestions
  party.ts        in-memory party rooms: teams, buzzes, judging, scoring; sends audio cues to the host screen
shared/     types + answer matching (title + artist, ignoring "Remastered", "Live", "feat." …)
docs/       plan, clickable prototype, SoundCloud coverage research
```

Spotify limits worth knowing (2026): no 30-second previews, no Spotify-made playlists for personal apps, search returns 10 results per request, and the developer policy doesn't allow quiz games in public apps. Songer is a private, single-household app.

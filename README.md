# Songer

Name-that-tune on your own Spotify library. You hear the first **half-second** of a song and guess it; every miss or skip plays a little more (0.5s → 1s → 2s → 4s → 8s → 15s). Songs always start from 0:00, like [Songless](https://lessgames.com/songless), but the music is *yours*: your top tracks, liked songs, any band or one of your playlists.

Two ways to play:

- **Solo**: pick a source and guess song by song. Type-ahead suggestions search your library and all of Spotify, in Hebrew or English.
- **Party**: a laptop on the TV plays the music. Everyone scans a QR code, picks a team, and their phone becomes a **buzzer**. First team to buzz answers out loud; a judge decides; wrong answers lock the team out and the others can steal.

Self-hosted on the homeserver at **https://songer.omersher.com**. A single-household app: only the owner signs in with Spotify; party guests need no account. To run your own, create your own Spotify app (below).

---

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Spotify app setup](#spotify-app-setup)
- [Local development](#local-development)
- [Playing](#playing)
- [Deploy to the homeserver](#deploy-to-the-homeserver)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [Spotify limits and quirks](#spotify-limits-and-quirks)
- [Troubleshooting](#troubleshooting)

---

## How it works

```
 Laptop on the TV (Chrome)                     Phones (any browser)
 ┌────────────────────────────┐                ┌───────────────────────┐
 │ React app                  │                │ /join/CODE            │
 │ Spotify Web Playback SDK ──┼─ audio ◄── Spotify    team buzzer, or   │
 │  (tab = device "Songer")   │                │  judge: answer + controls
 └──────────┬─────────────────┘                └──────────┬────────────┘
            │ REST + Socket.IO                            │ Socket.IO
            ▼                                             ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ Songer server (Node, one container)                                  │
 │  Spotify OAuth + token refresh   library sync + song index (SQLite)  │
 │  party rooms: teams, buzzes, judging, scores → audio cues to the TV  │
 └──────────────────────────────────────────────────────────────────────┘
```

- **Audio never touches the server.** Spotify's [Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk) turns the browser tab into a Spotify device. To play a clip, the app starts the track silently once ("primes" it), pauses at 0:00, then plays exact clips with local resume/pause.
- **The server** stores your Spotify refresh token (AES-256-GCM encrypted), an index of your library for guess suggestions, solo results, and in-memory party rooms.
- **Answers are matched by Spotify track and artist IDs**, then by normalized title + artist, so "Mr. Brightside – Remastered", another album's copy, or a name spelled in Hebrew vs English all count.

## Requirements

- **Spotify Premium** on the account that signs in (the SDK refuses free accounts).
- **Chrome, Edge or Firefox on a computer** for anything that plays music. Spotify's web player doesn't run in phone browsers; phones only join parties.
- Node **22.13+** for development (uses the built-in `node:sqlite`).

## Spotify app setup

Once, at https://developer.spotify.com/dashboard:

1. **Create app**. Name `Songer`, any description.
2. **Redirect URIs** (must match exactly):
   - `http://127.0.0.1:5173/api/auth/callback`: local dev (Spotify allows plain http only for `127.0.0.1`, never `localhost`)
   - `https://songer.omersher.com/api/auth/callback`: homeserver
3. **APIs used**: tick **Web API** and **Web Playback SDK**.
4. **Settings** → copy the **Client ID**, then **View client secret**.
5. **User Management**: your own account is there as owner. Personal ("Development mode") apps allow at most 5 Spotify accounts; Songer only needs yours.

## Local development

```bash
cp .env.example .env     # fill SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET; generate the two secrets as shown in the file
npm install
npm run dev              # API on :5100, web on :5173 (Vite proxies /api and /socket.io)
```

Open **http://127.0.0.1:5173** (not `localhost`, or the sign-in cookie won't match the redirect).

**Phones in local dev.** Phones can't open `127.0.0.1`. Set `JOIN_BASE_URL` in `.env` to your PC's LAN address (Vite prints it as "Network", e.g. `http://192.168.0.178:5173`) and restart. The party QR code then points there. The phone must be on the same Wi-Fi, and Windows Firewall must allow Node on private networks.

```bash
npm test             # answer matching + a full party game over real sockets
npm run typecheck    # web and server
npm run build        # production build into dist/
npm start            # run the production build on :5100
```

## Playing

### Solo

Home → **Solo** → pick **Top tracks** (4 weeks / 6 months / all time), **Liked Songs**, **A band**, **A playlist** (your own) or **Recently played** → 5, 10 or 15 songs.

Each song: the 0.5s clip plays automatically. Type to search, pick a suggestion, **Guess**; or **Skip** to hear more. Solved on try 1 = 6 points … try 6 = 1 point. `Space` replays the clip.

### Party

1. Connect the laptop to the TV. In Spotify, turn on a **Private Session** (so the party doesn't change your recommendations) and keep the Spotify app on your phone closed (it would show the song name).
2. Home → **Party** → pick the music, number of songs, and 2 to 4 teams → **Open lobby on TV** → **Fullscreen** (`F`).
3. Guests scan the QR (or open `/join` and type the 4-letter code), type a name and pick a team.
4. **Judge**: someone needs to see the answers to rule on shouted guesses. Any of these works, at the same time:
   - **One guest as judge**: on the join screen pick **Be the judge**. Their phone shows the answer and all controls. One judge per party; the TV shows who it is, and the laptop's "Judge: name ✕" button removes them. Judges can't end the party.
   - **Your phone as host remote**: on the laptop, **📱 Host remote** shows a one-time QR (5 minutes) that signs your phone in as you; it shows answers and controls.
   - **The laptop keyboard** (the TV shows no answers, so this is for when you know the songs):

| Key | When | Does |
|---|---|---|
| `Space` | lobby / round / reveal | start / longer clip / next song |
| `Enter` | someone buzzed | correct song (5 → 1 points, fewer for longer clips) |
| `A` | someone buzzed | artist only (+1) |
| `X` | someone buzzed | wrong: team is out for this song, others can steal |
| `R` | round | replay the clip |
| `S` | round | skip the song (reveal, no points) |
| `F` | any | fullscreen |

Buzzing stops the music and plays a quiz-show buzzer on the TV; correct and wrong answers have their own sounds. After the last song: podium, fastest buzz of the night, **Rematch** (same teams, reshuffled songs).

## Deploy to the homeserver

Pushing to `main` runs GitHub Actions (typecheck, tests, Docker build) and publishes **`ghcr.io/omer182/songer:latest`** (also tagged `sha-<commit>`).

### 1. Image visibility (once)

The image is public, so Portainer pulls it without credentials. (New container packages start private on GitHub even for a public repo: package page → Package settings → Change visibility → Public.)

### 2. Data folder

Nothing to do: the container creates `/hosted-apps/songer/data` and fixes its ownership on start (it starts as root, chowns `/data`, then runs as the `node` user). If you run the image with `user:` set, create the folder yourself owned by uid 1000.

### 3. Stack

Portainer → **Stacks** → **Add stack** → name `songer` → Web editor: paste [`docker-compose.prod.yml`](docker-compose.prod.yml). Under **Environment variables** add:

| Name | Value |
|---|---|
| `SPOTIFY_CLIENT_ID` | from the Spotify dashboard |
| `SPOTIFY_CLIENT_SECRET` | from the Spotify dashboard |
| `SESSION_SECRET` | a fresh random value (see below) |
| `TOKEN_ENC_KEY` | another fresh random value |
| `ALLOWED_SPOTIFY_IDS` | optional: your Spotify user ID, to refuse anyone else |

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # run twice, one per secret
```

Keep `TOKEN_ENC_KEY` stable: changing it makes the stored Spotify login unreadable (you'd just sign in again).

### 4. Nginx Proxy Manager

Proxy host **`songer.omersher.com`** → scheme `http`, forward host **`songer`** (or the server's IP), port **`5100`**, **Websockets Support ON** (party buzzers need it), Block Common Exploits on; SSL: Let's Encrypt, Force SSL, HTTP/2.

### 5. Update

Push to `main`, wait for the green Actions run, then in Portainer open the stack → **Pull and redeploy**. A party in progress ends on redeploy (rooms are in memory).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | none | Spotify app credentials |
| `PUBLIC_URL` | `http://127.0.0.1:5173` | Where the browser reaches the app; the Spotify redirect URI is `PUBLIC_URL/api/auth/callback`. `https://` turns on secure cookies |
| `JOIN_BASE_URL` | `PUBLIC_URL` | Base URL in the party QR and the host-remote QR (set to the LAN address in dev) |
| `SESSION_SECRET` | none (required) | Signs session cookies |
| `TOKEN_ENC_KEY` | none (required) | Encrypts the stored Spotify refresh token |
| `ALLOWED_SPOTIFY_IDS` | empty | Comma-separated Spotify user IDs allowed to sign in |
| `PORT` | `5100` | Server port |
| `DATA_DIR` | `./data` (`/data` in Docker) | SQLite location |

## Project structure

```
web/src/
  pages/        Login, Home, Solo, PartyHost (setup + TV), Join (phone: team or judge), Remote (host's phone)
  components/   SourcePicker, GuessInput, ClipBar/Art/Eq, RemoteQr
  lib/          player.ts (Web Playback SDK clip player), api.ts, socket.ts, sfx.ts, partySounds.ts, hooks.ts
server/
  index.ts      Express routes, sign-in, phone pairing, static web app
  spotify.ts    OAuth, token refresh, API calls with retry, track mapping
  library.ts    library sync, on-demand playlists/artist catalogs, song pools, suggestions
  party.ts      party rooms: teams, judge, buzzes, scoring, audio cues (Socket.IO)
  db.ts         SQLite schema + migrations
shared/         types and answer matching (with tests)
docs/           plan, clickable prototype, SoundCloud coverage research
```

## Spotify limits and quirks

Spotify locked down personal ("Development mode") apps in 2024 to 2026. What that means here:

- **5 Spotify accounts max per app; the owner needs Premium.** Fine for a single-household app.
- **No 30-second previews**: audio only through the Web Playback SDK (Premium, desktop browser).
- **Only playlists you own** (or collaborate on) return their songs; other people's and Spotify-made playlists return 403. To play one, copy its songs into a playlist of yours.
- **Artist albums: max 10 per request** (undocumented; 20+ returns "Invalid limit"). **Search: max 10 results.** No batch album/track endpoints, no "artist top tracks", no popularity.
- **Hebrew names**: requests send `Accept-Language: he`, so Israeli artists come back as "אייל לוי" instead of "Eyal Levi"; international names are unaffected. Spotify search also matches transliteration ("kulam ganavim" → כולם גנבים).
- Spotify's developer policy doesn't allow quiz games in public apps; keep this private.

## Troubleshooting

| Problem | Fix |
|---|---|
| `INVALID_CLIENT: Invalid redirect URI` | The URI in the Spotify dashboard must equal `PUBLIC_URL` + `/api/auth/callback` exactly (http vs https, port, no trailing slash) |
| Signed in but bounced back to the sign-in page (dev) | You opened `localhost`; use `http://127.0.0.1:5173` |
| "Playing songs needs Spotify Premium" | The signed-in account isn't Premium |
| "This browser can't play Spotify" | Phone browser or a browser without DRM; use desktop Chrome/Edge/Firefox |
| Playlist: "Spotify only shares songs from playlists you own" | Expected for other people's playlists; copy the songs into your own |
| Phones can't open the QR link (dev) | Set `JOIN_BASE_URL` to the LAN address, same Wi-Fi, firewall allows Node, no Wi-Fi client isolation |
| Buzzers don't connect (homeserver) | Turn on Websockets Support for the proxy host |
| Portainer: `pull access denied` / `unauthorized` | Make the ghcr package public (step 1), or add `ghcr.io` as a registry in Portainer with a `read:packages` token |

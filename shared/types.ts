// Types shared by the API server and the web app.

/** Socket.IO endpoint. Under /play so guests need only one public path (/play/*). */
export const SOCKET_PATH = '/play/socket.io';

/** Clip lengths for each try / party stage, in milliseconds. */
export const STAGES_MS = [500, 1000, 2000, 4000, 8000, 15000] as const;
export const MAX_STAGE = STAGES_MS.length - 1;
/** Party points for a correct song at each stage; naming only the artist earns ARTIST_POINTS. */
export const PARTY_POINTS = [5, 4, 3, 2, 1, 1] as const;
export const ARTIST_POINTS = 1;
/** A wrong answer costs the team this much (scores can go below zero); the team stays in the round. */
export const WRONG_PENALTY = 1;

export interface Track {
  id: string;
  uri: string;
  title: string;
  /** Comma-separated artist names (Hebrew names for Israeli artists, as Spotify spells them in Hebrew). */
  artists: string;
  /** Spotify artist IDs: language-independent, used for answer matching. */
  artistIds: string[];
  album: string;
  year: number | null;
  image: string | null;
  durationMs: number;
}

export type TopRange = 'short_term' | 'medium_term' | 'long_term';

export type Source =
  | { type: 'top'; range: TopRange }
  | { type: 'liked' }
  | { type: 'recent' }
  | { type: 'playlist'; id: string; name?: string }
  | { type: 'artist'; id: string; name?: string }
  | { type: 'album'; id: string; name?: string }
  /** A public Deezer playlist; songs are matched to Spotify for playback. */
  | { type: 'deezer'; id: string; name?: string };

export interface Me {
  id: string;
  name: string;
  image: string | null;
}

export interface LibraryStatus {
  status: 'idle' | 'syncing' | 'error';
  error: string | null;
  finishedAt: number | null;
  counts: { liked: number; top: number; playlists: number; artists: number; indexed: number };
}

export interface PlaylistInfo {
  id: string;
  name: string;
  image: string | null;
  count: number;
  owner: string;
  /** False for playlists someone else made: Spotify won't share their songs with personal apps. */
  available: boolean;
}

export interface ArtistInfo {
  id: string;
  name: string;
  image: string | null;
}

export interface Suggestion {
  key: string;
  /** Spotify track ID of this exact version. */
  trackId: string;
  title: string;
  artists: string;
  artistIds: string[];
}

/* ---------------- party ---------------- */

export type PartyPhase = 'lobby' | 'round' | 'buzzed' | 'reveal' | 'final';

export interface PartyMember {
  id: string;
  name: string;
  connected: boolean;
}

export interface PartyTeam {
  id: string;
  name: string;
  color: string;
  score: number;
  members: PartyMember[];
}

export interface PartyState {
  code: string;
  joinUrl: string;
  phase: PartyPhase;
  packLabel: string;
  teams: PartyTeam[];
  songIndex: number;
  songCount: number;
  stage: number;
  buzz: { teamId: string; playerName: string; seconds: number } | null;
  last: { teamId: string | null; points: number; artistOnly: boolean } | null;
  /** Current song. Sent to the host always; to phones only once revealed. */
  song: Track | null;
  toast: string | null;
  fastestBuzz: { playerName: string; teamId: string; seconds: number } | null;
  /** Someone who joined by QR to see the answers and run the game from their phone. */
  judge: { name: string; connected: boolean } | null;
}

/** Audio instructions the server sends to the host screen, which owns the Spotify player. */
export type PartyCue =
  | { kind: 'load'; uri: string }
  | { kind: 'clip'; uri: string; ms: number }
  /** Play the whole song (ms = its length) for the sing-along. */
  | { kind: 'reveal'; uri: string; ms: number }
  | { kind: 'stop' };

export type HostAction =
  | { type: 'start' }
  | { type: 'longer' }
  | { type: 'replay' }
  | { type: 'skip' }
  | { type: 'judge'; verdict: 'song' | 'artist' | 'wrong' }
  | { type: 'next' }
  | { type: 'rematch' }
  | { type: 'removeJudge' }
  | { type: 'end' };

export interface CreatePartyPayload {
  packLabel: string;
  tracks: Track[];
  teams: { name: string; color: string }[];
}

export type Ack<T> = (res: { ok: true; data: T } | { ok: false; error: string }) => void;

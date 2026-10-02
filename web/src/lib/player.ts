// Wraps Spotify's Web Playback SDK so the rest of the app can say "play the first N ms of this song".
// The browser tab becomes a Spotify Connect device named "Songer". Audio streams from Spotify straight
// into this tab; our server only hands out the access token.
//
// Clip timing: a track is "primed" once (started silently, paused, rewound to 0). After that each clip
// is a local resume/pause, which is much faster and steadier than asking the Web API to start playback.

import { api } from './api';

/* ---- minimal SDK typings ---- */
interface SdkTrack {
  id: string | null;
  uri: string;
  linked_from?: { uri: string | null; id: string | null };
}
interface SdkState {
  paused: boolean;
  position: number;
  timestamp: number;
  track_window: { current_track: SdkTrack | null };
}
interface SdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(ev: string, cb: (arg: never) => void): boolean;
  getCurrentState(): Promise<SdkState | null>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(ms: number): Promise<void>;
  setVolume(v: number): Promise<void>;
  activateElement(): Promise<void>;
}
declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: { Player: new (o: { name: string; getOAuthToken: (cb: (t: string) => void) => void; volume: number }) => SdkPlayer };
  }
}

export type PlayerStatus = 'idle' | 'loading' | 'ready' | 'error';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class SongerPlayer {
  status: PlayerStatus = 'idle';
  error: string | null = null;
  private player: SdkPlayer | null = null;
  private deviceId: string | null = null;
  private initPromise: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private stateWaiters = new Set<(s: SdkState) => void>();
  private primedUri: string | null = null;
  private volume = 0.8;
  private clipTimer = 0;
  private clipSeq = 0;
  /** Set while a clip is audible, for drawing the playhead. */
  private clip: { startedAt: number; lenMs: number; fromMs: number } | null = null;

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((f) => f());
  }
  private fail(msg: string) {
    this.status = 'error';
    this.error = msg;
    this.emit();
  }

  /** Load the SDK and connect. Safe to call repeatedly. */
  init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.status = 'loading';
    this.error = null;
    this.emit();
    this.initPromise = new Promise<void>((resolve, reject) => {
      const start = () => {
        const p = new window.Spotify!.Player({
          name: 'Songer',
          volume: this.volume,
          getOAuthToken: (cb) => {
            api.token().then((t) => cb(t.accessToken)).catch(() => this.fail('Your Spotify session expired. Sign in again.'));
          },
        });
        const bad = (msg: string) => () => {
          this.fail(msg);
          this.initPromise = null;
          reject(new Error(msg));
        };
        p.addListener('initialization_error', bad('This browser can\'t play Spotify. Use Chrome, Edge or Firefox on a computer.'));
        p.addListener('authentication_error', bad('Spotify rejected the sign-in. Sign out and sign in again.'));
        p.addListener('account_error', bad('Playing songs needs Spotify Premium on the signed-in account.'));
        p.addListener('playback_error', (() => this.fail('Spotify couldn\'t play that song. Try the next one.')) as never);
        p.addListener('ready', (({ device_id }: { device_id: string }) => {
          this.deviceId = device_id;
          this.status = 'ready';
          this.error = null;
          this.emit();
          resolve();
        }) as never);
        p.addListener('not_ready', (() => {
          this.deviceId = null;
          this.status = 'loading';
          this.emit();
        }) as never);
        p.addListener('player_state_changed', ((s: SdkState | null) => {
          this.maskMediaSession();
          if (s) this.stateWaiters.forEach((w) => w(s));
        }) as never);
        this.player = p;
        p.connect().then((ok) => {
          if (!ok) bad('Could not connect to Spotify.')();
        });
      };
      if (window.Spotify) start();
      else {
        window.onSpotifyWebPlaybackSDKReady = start;
        const s = document.createElement('script');
        s.src = 'https://sdk.scdn.co/spotify-player.js';
        s.async = true;
        s.onerror = () => {
          this.fail('Could not load the Spotify player. Check your connection.');
          this.initPromise = null;
          reject(new Error('sdk load failed'));
        };
        document.head.appendChild(s);
      }
    });
    return this.initPromise;
  }

  /** Call from a click handler so the browser lets the tab play audio. */
  activate() {
    this.player?.activateElement().catch(() => {});
  }

  /** Hide the song from the OS media popup and lock screen. */
  private maskMediaSession() {
    try {
      if ('mediaSession' in navigator && 'MediaMetadata' in window) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: 'Songer', artist: 'Name that tune' });
      }
    } catch {
      /* not supported */
    }
  }

  private waitForState(pred: (s: SdkState) => boolean, timeoutMs: number): Promise<SdkState | null> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (s: SdkState | null) => {
        if (done) return;
        done = true;
        this.stateWaiters.delete(check);
        clearInterval(poll);
        clearTimeout(timer);
        resolve(s);
      };
      const check = (s: SdkState) => pred(s) && finish(s);
      this.stateWaiters.add(check);
      const poll = setInterval(() => this.player?.getCurrentState().then((s) => s && check(s)), 120);
      const timer = setTimeout(() => finish(null), timeoutMs);
    });
  }

  private static isTrack(s: SdkState, uri: string) {
    const t = s.track_window.current_track;
    return !!t && (t.uri === uri || t.linked_from?.uri === uri);
  }

  /** Start the track silently on this device, then pause and rewind it to 0:00. */
  private async prime(uri: string) {
    if (this.primedUri === uri) return;
    await this.init();
    const p = this.player!;
    await p.setVolume(0);
    let lastErr = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      const { accessToken } = await api.token();
      const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${this.deviceId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris: [uri], position_ms: 0 }),
      });
      if (res.ok || res.status === 204) {
        lastErr = '';
        break;
      }
      lastErr = `Spotify refused to start playback (${res.status}).`;
      await sleep(600 * (attempt + 1)); // a fresh device is sometimes "not found" for a moment
    }
    if (lastErr) {
      await p.setVolume(this.volume);
      throw new Error(lastErr);
    }
    await this.waitForState((s) => SongerPlayer.isTrack(s, uri) && !s.paused, 6000);
    await p.pause();
    await p.seek(0);
    await this.waitForState((s) => SongerPlayer.isTrack(s, uri) && s.paused, 1500);
    await p.setVolume(this.volume);
    this.primedUri = uri;
  }

  /** Get the next song ready ahead of time (silent). */
  preload(uri: string) {
    if (this.clip) return Promise.resolve(); // don't interrupt something audible
    return this.prime(uri).catch(() => {});
  }

  /** Play `lenMs` of a song starting at `fromMs` (0 = the very start). Resolves when the clip ends or is stopped. */
  async playClip(uri: string, lenMs: number, fromMs = 0): Promise<void> {
    const seq = ++this.clipSeq;
    window.clearTimeout(this.clipTimer);
    this.clip = null;
    this.emit();
    await this.prime(uri);
    if (seq !== this.clipSeq) return;
    const p = this.player!;
    await p.seek(fromMs);
    await p.resume();
    const s = await this.waitForState((st) => SongerPlayer.isTrack(st, uri) && !st.paused, 2500);
    if (seq !== this.clipSeq) return;
    // Compensate for audio that already played before the state event reached us.
    const playedMs = s ? Math.max(0, s.position - fromMs + (performance.timeOrigin + performance.now() - s.timestamp)) : 0;
    const remaining = Math.max(0, lenMs - playedMs);
    this.clip = { startedAt: performance.now() - playedMs, lenMs, fromMs };
    this.emit();
    await new Promise<void>((resolve) => {
      this.clipTimer = window.setTimeout(async () => {
        if (seq === this.clipSeq) {
          await p.pause();
          await p.seek(0);
          this.clip = null;
          this.emit();
        }
        resolve();
      }, remaining);
    });
  }

  async stop() {
    this.clipSeq++;
    window.clearTimeout(this.clipTimer);
    const wasPlaying = !!this.clip;
    this.clip = null;
    this.emit();
    if (wasPlaying && this.player) {
      await this.player.pause();
      await this.player.seek(0);
    }
  }

  /** Position in ms inside the song while a clip plays, else null. */
  position(): number | null {
    if (!this.clip) return null;
    return this.clip.fromMs + Math.min(this.clip.lenMs, performance.now() - this.clip.startedAt);
  }

  isPlaying() {
    return !!this.clip;
  }
}

export const player = new SongerPlayer();

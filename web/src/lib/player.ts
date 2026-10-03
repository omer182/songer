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
  private primeLock: Promise<void> = Promise.resolve();
  private preparing = false;
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
        // Spotify fires playback_error for transient hiccups (e.g. while a track is still loading) and then recovers.
        // Real failures surface as a rejected playClip(), so this only logs.
        p.addListener('playback_error', ((e: { message?: string }) => console.warn('Spotify playback_error:', e?.message)) as never);
        p.addListener('ready', (async ({ device_id }: { device_id: string }) => {
          this.deviceId = device_id;
          this.primedUri = null;
          // Make this tab the active Spotify device before we report ready; otherwise the first
          // "play on device X" calls come back 404 "Device not found" for a few seconds.
          await this.activateDevice().catch((e) => console.warn('Could not activate the Songer device yet:', e));
          this.status = 'ready';
          this.error = null;
          this.emit();
          resolve();
        }) as never);
        p.addListener('not_ready', (() => {
          this.primedUri = null;
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

  private async webApi(method: string, path: string, body?: unknown): Promise<Response> {
    const { accessToken } = await api.token();
    return fetch(`https://api.spotify.com/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** Transfer playback to this tab and wait until Spotify's servers list it as a device. */
  private async activateDevice() {
    if (!this.deviceId) return;
    await this.webApi('PUT', '/me/player', { device_ids: [this.deviceId], play: false });
    for (let i = 0; i < 20; i++) {
      const res = await this.webApi('GET', '/me/player/devices');
      if (res.ok) {
        const { devices } = (await res.json()) as { devices: { id: string }[] };
        if (devices.some((d) => d.id === this.deviceId)) return;
      }
      await sleep(200);
    }
  }

  /** Ask Spotify to start `uri` at `fromMs` on this tab, retrying the usual transient failures. */
  private async startOnDevice(uri: string, fromMs: number) {
    let lastErr = '';
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await this.webApi('PUT', `/me/player/play?device_id=${this.deviceId}`, { uris: [uri], position_ms: fromMs });
      if (res.ok) return;
      lastErr = `Spotify refused to start playback (${res.status}).`;
      if (res.status === 404) await this.activateDevice(); // "Device not found": re-register this tab, then retry at once
      else if (res.status === 429) await sleep(Math.min(Number(res.headers.get('retry-after') || 1), 5) * 1000);
      else if (res.status >= 500) await sleep(400);
      else break; // 401/403 and friends won't fix themselves
    }
    throw new Error(lastErr);
  }

  /**
   * Computers: start the track at volume 0, pause, rewind, so every clip after that is an instant local resume.
   * Phones can't change volume from a web page, so a "silent" warm-up would be heard (the double-play bug):
   * there we skip it and playClip starts the song directly. Calls run one at a time.
   */
  private prime(uri: string): Promise<void> {
    const run = this.primeLock.catch(() => {}).then(() => this.primeNow(uri));
    this.primeLock = run;
    return run;
  }

  private readonly silentPrime = !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

  private async primeNow(uri: string) {
    if (this.primedUri === uri || !this.silentPrime) return;
    await this.init();
    const p = this.player!;
    await p.setVolume(0);
    try {
      await this.startOnDevice(uri, 0);
      await this.waitForState((s) => SongerPlayer.isTrack(s, uri) && !s.paused, 6000);
      await p.pause();
      await p.seek(0);
      await this.waitForState((s) => SongerPlayer.isTrack(s, uri) && s.paused, 1500);
      this.primedUri = uri;
    } finally {
      await p.setVolume(this.volume);
    }
  }

  /** Get the next song ready ahead of time (silent; computers only). */
  preload(uri: string) {
    if (this.clip || this.preparing) return Promise.resolve(); // don't interrupt something audible
    return this.prime(uri).catch(() => {});
  }

  /** True while a song is being loaded before its clip starts (for a "Loading song…" hint). */
  isPreparing() {
    return this.preparing;
  }

  /** Play `lenMs` of a song starting at `fromMs` (0 = the very start). Resolves when the clip ends or is stopped. */
  async playClip(uri: string, lenMs: number, fromMs = 0): Promise<void> {
    const seq = ++this.clipSeq;
    window.clearTimeout(this.clipTimer);
    this.clip = null;
    this.preparing = true;
    this.emit();
    let s: SdkState | null = null;
    try {
      await this.init();
      const p = this.player!;
      if (this.primedUri !== uri && !this.silentPrime) {
        // Phone, new song: one direct start from the right spot (no audible warm-up).
        await (this.primeLock = this.primeLock.catch(() => {}).then(() => this.startOnDevice(uri, fromMs)));
        this.primedUri = uri;
        s = await this.waitForState((st) => SongerPlayer.isTrack(st, uri) && !st.paused, 6000);
      } else {
        await this.prime(uri);
        if (seq !== this.clipSeq) return;
        await p.seek(fromMs);
        await p.resume();
        s = await this.waitForState((st) => SongerPlayer.isTrack(st, uri) && !st.paused, 2500);
      }
    } finally {
      if (seq === this.clipSeq) {
        this.preparing = false;
        this.emit();
      }
    }
    const p = this.player!;
    if (seq !== this.clipSeq) {
      if (!this.preparing && !this.clip) await p.pause(); // stopped while starting: don't leave it playing
      return;
    }
    // Compensate for audio that already played before the state event reached us.
    const playedMs = s ? Math.min(lenMs, Math.max(0, s.position - fromMs + (performance.timeOrigin + performance.now() - s.timestamp))) : 0;
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

  /** Pause where we are (no rewind). Returns the position in ms, to resume with playClip(uri, rest, position). */
  async pause(): Promise<number | null> {
    const pos = this.position();
    this.clipSeq++;
    window.clearTimeout(this.clipTimer);
    this.clip = null;
    this.emit();
    await this.player?.pause();
    return pos;
  }

  async stop() {
    this.clipSeq++;
    window.clearTimeout(this.clipTimer);
    const wasPlaying = !!this.clip;
    this.clip = null;
    this.preparing = false;
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

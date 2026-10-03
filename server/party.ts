import crypto from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { config } from './config.js';
import { userIdFromCookieHeader } from './auth.js';
import {
  ARTIST_POINTS, GET_READY_MS, MAX_STAGE, PARTY_POINTS, STAGES_MS, WRONG_PENALTY,
  type Ack, type CreatePartyPayload, type HostAction, type PartyCue, type PartyPhase, type PartyState, type PartyTeam, type Track,
} from '../shared/types.js';

// Rooms live in memory: a party lasts one evening and nothing here needs to survive a restart.

interface Player {
  id: string;
  name: string;
  teamId: string;
  socketId: string | null;
}

interface Judge {
  id: string;
  name: string;
  socketId: string | null;
}

interface Room {
  code: string;
  judge: Judge | null;
  hostUserId: string;
  packLabel: string;
  tracks: Track[];
  teams: PartyTeam[];
  players: Map<string, Player>;
  phase: PartyPhase;
  songIndex: number;
  stage: number;
  buzz: PartyState['buzz'];
  last: PartyState['last'];
  toast: string | null;
  fastestBuzz: PartyState['fastestBuzz'];
  roundStartedAt: number;
  touchedAt: number;
  /** Pending "Get ready" timer for the current round. */
  readyTimer: ReturnType<typeof setTimeout> | null;
}

const rooms = new Map<string, Room>();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O

function newCode(): string {
  for (;;) {
    const code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
    if (!rooms.has(code)) return code;
  }
}

const clean = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const shuffle = <T>(a: T[]) => {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};

// Drop rooms nobody has touched for 8 hours.
setInterval(() => {
  const cutoff = Date.now() - 8 * 3600_000;
  for (const [code, r] of rooms) if (r.touchedAt < cutoff) rooms.delete(code);
}, 600_000).unref();

export function attachParty(io: Server) {
  const hostChannel = (code: string) => `host:${code}`;
  const playerChannel = (code: string) => `players:${code}`;
  // Host remotes see what the TV sees (including the answer) but don't get audio cues.
  const remoteChannel = (code: string) => `remote:${code}`;

  function stateFor(r: Room, forHost: boolean): PartyState {
    const song = r.tracks[r.songIndex] ?? null;
    const showSong = forHost ? r.phase !== 'lobby' : r.phase === 'reveal';
    return {
      code: r.code,
      joinUrl: `${config.joinBaseUrl}/play/${r.code}`,
      phase: r.phase,
      packLabel: r.packLabel,
      teams: r.teams.map((t) => ({
        ...t,
        members: [...r.players.values()]
          .filter((p) => p.teamId === t.id)
          .map((p) => ({ id: p.id, name: p.name, connected: !!p.socketId })),
      })),
      songIndex: r.songIndex,
      songCount: r.tracks.length,
      stage: r.stage,
      buzz: r.buzz,
      last: r.last,
      song: showSong ? song : null,
      toast: r.toast,
      fastestBuzz: r.fastestBuzz,
      getReady: !!r.readyTimer,
      judge: r.judge ? { name: r.judge.name, connected: !!r.judge.socketId } : null,
    };
  }

  function broadcast(r: Room) {
    r.touchedAt = Date.now();
    io.to(hostChannel(r.code)).to(remoteChannel(r.code)).emit('party:state', stateFor(r, true));
    io.to(playerChannel(r.code)).emit('party:state', stateFor(r, false));
  }

  const cue = (r: Room, c: PartyCue) => io.to(hostChannel(r.code)).emit('party:cue', c);
  const current = (r: Room) => r.tracks[r.songIndex];

  function clearReady(r: Room) {
    if (r.readyTimer) clearTimeout(r.readyTimer);
    r.readyTimer = null;
  }

  /** New song: a short "Get ready" while the TV loads it silently, then the first 0.5s clip from 0:00. */
  function beginRound(r: Room) {
    clearReady(r);
    Object.assign(r, { phase: 'round', stage: 0, buzz: null, last: null, toast: null });
    const song = current(r);
    cue(r, { kind: 'load', uri: song.uri });
    r.readyTimer = setTimeout(() => {
      r.readyTimer = null;
      if (!rooms.has(r.code) || r.phase !== 'round' || current(r) !== song) return;
      r.roundStartedAt = Date.now();
      broadcast(r);
      cue(r, { kind: 'clip', uri: song.uri, ms: STAGES_MS[0] });
    }, GET_READY_MS);
    broadcast(r);
  }

  function reveal(r: Room, teamId: string | null, points: number, artistOnly = false) {
    Object.assign(r, { phase: 'reveal', buzz: null, toast: null, last: { teamId, points, artistOnly } });
    broadcast(r);
    cue(r, { kind: 'reveal', uri: current(r).uri, ms: current(r).durationMs });
  }

  function hostAction(r: Room, a: HostAction) {
    const team = (id: string | undefined) => r.teams.find((t) => t.id === id);
    switch (a.type) {
      case 'start':
        if (r.phase === 'lobby') {
          r.songIndex = 0;
          beginRound(r);
        }
        return;
      case 'longer':
        if (r.phase !== 'round' || r.readyTimer) return;
        if (r.stage >= MAX_STAGE) return reveal(r, null, 0);
        r.stage++;
        r.toast = null;
        broadcast(r);
        return cue(r, { kind: 'clip', uri: current(r).uri, ms: STAGES_MS[r.stage] });
      case 'replay':
        if (r.phase === 'round' && !r.readyTimer) cue(r, { kind: 'clip', uri: current(r).uri, ms: STAGES_MS[r.stage] });
        return;
      case 'skip':
        clearReady(r);
        if (r.phase === 'round' || r.phase === 'buzzed') reveal(r, null, 0);
        return;
      case 'judge': {
        if (r.phase !== 'buzzed' || !r.buzz) return;
        const t = team(r.buzz.teamId);
        if (!t) return;
        if (a.verdict === 'song') {
          const pts = PARTY_POINTS[r.stage];
          t.score += pts;
          return reveal(r, t.id, pts);
        }
        if (a.verdict === 'artist') {
          t.score += ARTIST_POINTS;
          return reveal(r, t.id, ARTIST_POINTS, true);
        }
        // Wrong: a point off, and everyone (them included) can buzz again.
        t.score -= WRONG_PENALTY;
        r.buzz = null;
        r.phase = 'round';
        r.toast = `${t.name} −${WRONG_PENALTY}. Keep guessing, anyone can buzz!`;
        return broadcast(r);
      }
      case 'next':
        if (r.phase !== 'reveal') return;
        cue(r, { kind: 'stop' });
        if (r.songIndex + 1 < r.tracks.length) {
          r.songIndex++;
          return beginRound(r);
        }
        r.phase = 'final';
        return broadcast(r);
      case 'rematch':
        if (r.phase !== 'final') return;
        r.teams.forEach((t) => (t.score = 0));
        r.tracks = shuffle(r.tracks);
        r.songIndex = 0;
        r.fastestBuzz = null;
        return beginRound(r);
      case 'removeJudge':
        if (r.judge?.socketId) {
          io.to(r.judge.socketId).emit('party:judgeRemoved');
          io.sockets.sockets.get(r.judge.socketId)?.leave(remoteChannel(r.code));
        }
        r.judge = null;
        return broadcast(r);
      case 'end':
        clearReady(r);
        cue(r, { kind: 'stop' });
        io.to(playerChannel(r.code)).to(remoteChannel(r.code)).emit('party:ended');
        rooms.delete(r.code);
        return;
    }
  }

  io.on('connection', (socket: Socket) => {
    const userId = userIdFromCookieHeader(socket.handshake.headers.cookie);
    if (userId) socket.join(`user:${userId}`); // lets a host's phone remote follow new parties

    /* ----- host (the laptop on the TV; must be signed in) ----- */

    socket.on('host:create', (p: CreatePartyPayload, ack: Ack<PartyState>) => {
      if (!userId) return ack({ ok: false, error: 'Sign in with Spotify first.' });
      const tracks = (p?.tracks ?? []).filter((t) => t?.uri && t?.title).slice(0, 50);
      const teams = (p?.teams ?? []).slice(0, 4);
      if (!tracks.length) return ack({ ok: false, error: 'No songs to play.' });
      if (teams.length < 2) return ack({ ok: false, error: 'Add at least two teams.' });
      for (const [code, r] of rooms) if (r.hostUserId === userId) rooms.delete(code); // one party per host
      const r: Room = {
        code: newCode(),
        hostUserId: userId,
        packLabel: clean(p.packLabel, 60) || 'Mixed',
        tracks,
        teams: teams.map((t, i) => ({ id: `t${i + 1}`, name: clean(t.name, 24) || `Team ${i + 1}`, color: clean(t.color, 32), score: 0, members: [] })),
        players: new Map(),
        judge: null,
        readyTimer: null,
        phase: 'lobby',
        songIndex: 0,
        stage: 0,
        buzz: null,
        last: null,
        toast: null,
        fastestBuzz: null,
        roundStartedAt: 0,
        touchedAt: Date.now(),
      };
      rooms.set(r.code, r);
      socket.join(hostChannel(r.code));
      io.to(`user:${userId}`).emit('party:new');
      ack({ ok: true, data: stateFor(r, true) });
    });

    socket.on('host:resume', (p: { code: string }, ack: Ack<PartyState>) => {
      const r = rooms.get(clean(p?.code, 4).toUpperCase());
      if (!r || r.hostUserId !== userId) return ack({ ok: false, error: 'That party has ended.' });
      socket.join(hostChannel(r.code));
      ack({ ok: true, data: stateFor(r, true) });
    });

    /** The host's phone remote: find this host's running party without knowing the code. */
    socket.on('host:current', (_p: unknown, ack: Ack<PartyState | null>) => {
      if (!userId) return ack({ ok: false, error: 'Sign in first.' });
      const r = [...rooms.values()].find((x) => x.hostUserId === userId);
      if (!r) return ack({ ok: true, data: null });
      socket.join(remoteChannel(r.code));
      ack({ ok: true, data: stateFor(r, true) });
    });

    socket.on('host:action', (p: { code: string; action: HostAction }) => {
      const r = rooms.get(clean(p?.code, 4).toUpperCase());
      if (!r || r.hostUserId !== userId || !p.action) return;
      hostAction(r, p.action);
    });

    /* ----- players (phones; no account) ----- */

    let joined: { room: Room; player: Player } | null = null;
    let judging: { room: Room; judge: Judge } | null = null;

    socket.on('party:peek', (p: { code: string }, ack: Ack<PartyState>) => {
      const r = rooms.get(clean(p?.code, 4).toUpperCase());
      if (!r) return ack({ ok: false, error: 'No party with that code. Check the code on the TV.' });
      ack({ ok: true, data: stateFor(r, false) });
    });

    socket.on('player:join', (p: { code: string; name: string; teamId: string; playerId?: string; role?: 'player' | 'judge' }, ack: Ack<{ playerId: string; state: PartyState }>) => {
      const r = rooms.get(clean(p?.code, 4).toUpperCase());
      if (!r) return ack({ ok: false, error: 'No party with that code. Check the code on the TV.' });
      const name = clean(p.name, 20);
      if (!name) return ack({ ok: false, error: 'Type your name.' });
      if (p.role === 'judge') {
        // One judge per party; the same phone (same playerId) can always reclaim the seat after a reconnect.
        if (r.judge && r.judge.id !== p.playerId && r.judge.socketId) return ack({ ok: false, error: `${r.judge.name} is already the judge.` });
        const judge: Judge = { id: r.judge && r.judge.id === p.playerId ? r.judge.id : crypto.randomBytes(8).toString('base64url'), name, socketId: socket.id };
        r.judge = judge;
        judging = { room: r, judge };
        socket.join(remoteChannel(r.code));
        broadcast(r);
        return ack({ ok: true, data: { playerId: judge.id, state: stateFor(r, true) } });
      }
      if (!r.teams.some((t) => t.id === p.teamId)) return ack({ ok: false, error: 'Pick a team.' });
      let player = p.playerId ? r.players.get(p.playerId) : undefined;
      if (player) Object.assign(player, { name, teamId: p.teamId, socketId: socket.id });
      else {
        player = { id: crypto.randomBytes(8).toString('base64url'), name, teamId: p.teamId, socketId: socket.id };
        r.players.set(player.id, player);
      }
      joined = { room: r, player };
      socket.join(playerChannel(r.code));
      broadcast(r);
      ack({ ok: true, data: { playerId: player.id, state: stateFor(r, false) } });
    });

    socket.on('judge:action', (action: HostAction) => {
      if (!judging || !action) return;
      const { room: r, judge } = judging;
      if (!rooms.has(r.code) || r.judge?.id !== judge.id || action.type === 'end') return;
      hostAction(r, action);
    });

    socket.on('player:buzz', () => {
      if (!joined) return;
      const { room: r, player } = joined;
      const t = r.teams.find((x) => x.id === player.teamId);
      if (!rooms.has(r.code) || r.phase !== 'round' || r.readyTimer || !t) return; // no buzzing before the clip
      const seconds = Math.round((Date.now() - r.roundStartedAt) / 100) / 10;
      r.phase = 'buzzed';
      r.toast = null;
      r.buzz = { teamId: t.id, playerName: player.name, seconds };
      if (!r.fastestBuzz || seconds < r.fastestBuzz.seconds) r.fastestBuzz = { playerName: player.name, teamId: t.id, seconds };
      cue(r, { kind: 'stop' });
      broadcast(r);
    });

    socket.on('disconnect', () => {
      if (judging && judging.room.judge?.id === judging.judge.id && judging.judge.socketId === socket.id) {
        judging.judge.socketId = null;
        if (rooms.has(judging.room.code)) broadcast(judging.room);
      }
      if (!joined) return;
      if (joined.player.socketId === socket.id) joined.player.socketId = null;
      if (rooms.has(joined.room.code)) broadcast(joined.room);
    });
  });
}

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import type { PartyCue, PartyState, Track } from '../shared/types.js';

// Exercises a whole party over real sockets: host creates, phones join, buzz, judge, reveal, next, final.

process.env.SESSION_SECRET = 'test-secret';
process.env.TOKEN_ENC_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'songer-test-'));
process.env.JOIN_BASE_URL = 'http://192.168.1.20:5173';

const track = (n: number): Track => ({
  id: `t${n}`, uri: `spotify:track:t${n}`, title: `Song ${n}`, artists: 'Band', album: 'Album', year: 2000, image: null, durationMs: 200000,
});

let url = '';
let hostCookie = '';
let server: http.Server;
const sockets: Socket[] = [];

beforeAll(async () => {
  const { db } = await import('./db.js');
  const { signValue, SESSION_COOKIE } = await import('./auth.js');
  const { attachParty } = await import('./party.js');
  db.prepare("INSERT INTO users (id, name, refresh_token_enc, created_at) VALUES ('omer', 'Omer', 'x', 0)").run();
  db.prepare("INSERT INTO sessions (id, user_id, created_at) VALUES ('sid1', 'omer', ?)").run(Date.now());
  hostCookie = `${SESSION_COOKIE}=${encodeURIComponent(signValue('sid1'))}`;
  server = http.createServer();
  attachParty(new Server(server));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  sockets.forEach((s) => s.disconnect());
  server?.close();
});

function client(cookie?: string): Promise<Socket> {
  const s = connect(url, { transports: ['websocket'], extraHeaders: cookie ? { cookie } : {} });
  sockets.push(s);
  return new Promise((r) => s.on('connect', () => r(s)));
}

function ask<T>(s: Socket, ev: string, payload: unknown): Promise<{ ok: boolean; data?: T; error?: string }> {
  return new Promise((r) => s.emit(ev, payload, r));
}

/** Resolve with the next 'party:state' that satisfies pred. */
function nextState(s: Socket, pred: (st: PartyState) => boolean): Promise<PartyState> {
  return new Promise((r) => {
    const h = (st: PartyState) => {
      if (pred(st)) {
        s.off('party:state', h);
        r(st);
      }
    };
    s.on('party:state', h);
  });
}

describe('party', () => {
  it('rejects hosts who are not signed in', async () => {
    const anon = await client();
    const res = await ask(anon, 'host:create', { packLabel: 'x', tracks: [track(1)], teams: [{ name: 'A', color: '#f00' }, { name: 'B', color: '#0f0' }] });
    expect(res.ok).toBe(false);
  });

  it('plays a full game', async () => {
    const host = await client(hostCookie);
    const cues: PartyCue[] = [];
    host.on('party:cue', (c: PartyCue) => cues.push(c));

    const created = await ask<PartyState>(host, 'host:create', {
      packLabel: 'Israeli 80s',
      tracks: [track(1), track(2)],
      teams: [{ name: 'Savta', color: '#3fd8ff' }, { name: 'Cousins', color: '#ff3d7f' }],
    });
    expect(created.ok).toBe(true);
    const code = created.data!.code;
    expect(code).toMatch(/^[A-Z]{4}$/);
    expect(created.data!.joinUrl).toBe(`http://192.168.1.20:5173/join/${code}`);

    const p1 = await client();
    const p2 = await client();
    const j1 = await ask<{ playerId: string; state: PartyState }>(p1, 'player:join', { code, name: 'Noa', teamId: 't1' });
    const j2 = await ask<{ playerId: string; state: PartyState }>(p2, 'player:join', { code, name: 'Dana', teamId: 't2' });
    expect(j1.ok && j2.ok).toBe(true);
    expect((await ask(p2, 'player:join', { code: 'ZZZZ', name: 'X', teamId: 't1' })).ok).toBe(false);

    // start: phones see the round but not the song; host gets the song and a clip cue
    const phoneRound = nextState(p1, (s) => s.phase === 'round');
    const hostRound = nextState(host, (s) => s.phase === 'round');
    host.emit('host:action', { code, action: { type: 'start' } });
    expect((await phoneRound).song).toBeNull();
    expect((await hostRound).song?.title).toBe('Song 1');
    expect(cues.at(-1)).toEqual({ kind: 'clip', uri: 'spotify:track:t1', ms: 500 });

    // longer clip
    host.emit('host:action', { code, action: { type: 'longer' } });
    await nextState(host, (s) => s.stage === 1);
    expect(cues.at(-1)).toMatchObject({ kind: 'clip', ms: 1000 });

    // Cousins buzz first, Savta's later buzz is ignored
    const buzzed = nextState(host, (s) => s.phase === 'buzzed');
    p2.emit('player:buzz');
    p1.emit('player:buzz');
    const b = await buzzed;
    expect(b.buzz).toMatchObject({ teamId: 't2', playerName: 'Dana' });
    expect(cues.at(-1)).toEqual({ kind: 'stop' });

    // wrong: Cousins locked, Savta steals and gets stage-1 points (4)
    host.emit('host:action', { code, action: { type: 'judge', verdict: 'wrong' } });
    const back = await nextState(host, (s) => s.phase === 'round');
    expect(back.teams.find((t) => t.id === 't2')!.locked).toBe(true);
    p2.emit('player:buzz'); // locked, ignored
    p1.emit('player:buzz');
    await nextState(host, (s) => s.phase === 'buzzed' && s.buzz?.teamId === 't1');
    const phoneReveal = nextState(p1, (s) => s.phase === 'reveal');
    host.emit('host:action', { code, action: { type: 'judge', verdict: 'song' } });
    const rev = await phoneReveal;
    expect(rev.song?.title).toBe('Song 1'); // revealed to phones now
    expect(rev.teams.find((t) => t.id === 't1')!.score).toBe(4);
    expect(rev.last).toEqual({ teamId: 't1', points: 4, artistOnly: false });
    expect(cues.at(-1)).toEqual({ kind: 'reveal', uri: 'spotify:track:t1', ms: 200000 });

    // next song, nobody knows, skip → final
    host.emit('host:action', { code, action: { type: 'next' } });
    const r2 = await nextState(host, (s) => s.phase === 'round' && s.songIndex === 1);
    expect(r2.teams.every((t) => !t.locked)).toBe(true);
    host.emit('host:action', { code, action: { type: 'skip' } });
    await nextState(host, (s) => s.phase === 'reveal' && s.songIndex === 1);
    host.emit('host:action', { code, action: { type: 'next' } });
    const fin = await nextState(host, (s) => s.phase === 'final');
    expect(fin.fastestBuzz?.playerName).toBe('Dana');

    // a reconnecting phone keeps its player id
    const p1b = await client();
    const again = await ask<{ playerId: string }>(p1b, 'player:join', { code, name: 'Noa', teamId: 't1', playerId: j1.data!.playerId });
    expect(again.data!.playerId).toBe(j1.data!.playerId);

    // the host's phone remote finds the party, sees the answer, and can run it
    const remote = await client(hostCookie);
    const cur = await ask<PartyState>(remote, 'host:current', {});
    expect(cur.data?.code).toBe(code);
    const remoteRound = nextState(remote, (s) => s.phase === 'round');
    remote.emit('host:action', { code, action: { type: 'rematch' } });
    expect((await remoteRound).song?.title).toBeTruthy(); // remotes get the answer, phones don't
    expect(cues.at(-1)).toMatchObject({ kind: 'clip', ms: 500 }); // audio still goes to the TV only

    // a guest joins by QR as the judge: one seat, sees the answer, runs the game
    const judge = await client();
    const j = await ask<{ playerId: string; state: PartyState }>(judge, 'player:join', { code, name: 'Abba', teamId: '', role: 'judge' });
    expect(j.ok).toBe(true);
    expect(j.data!.state.song?.title).toBeTruthy();
    const rival = await client();
    const taken = await ask(rival, 'player:join', { code, name: 'Kid', teamId: '', role: 'judge' });
    expect(taken).toMatchObject({ ok: false, error: 'Abba is already the judge.' });
    const judgeSees = nextState(judge, (s) => s.phase === 'reveal');
    judge.emit('judge:action', { type: 'skip' });
    expect((await judgeSees).judge).toEqual({ name: 'Abba', connected: true });
    judge.emit('judge:action', { type: 'end' }); // judges can't end the party
    const removed = new Promise((r) => judge.once('party:judgeRemoved', r));
    host.emit('host:action', { code, action: { type: 'removeJudge' } });
    await removed;
    expect((await ask(rival, 'player:join', { code, name: 'Kid', teamId: '', role: 'judge' })).ok).toBe(true);

    // end
    const ended = new Promise((r) => p2.once('party:ended', r));
    host.emit('host:action', { code, action: { type: 'end' } });
    await ended;
    expect((await ask(p2, 'party:peek', { code })).ok).toBe(false);
  });
});

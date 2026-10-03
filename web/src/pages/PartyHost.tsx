import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import confetti from 'canvas-confetti';
import { MAX_STAGE, PARTY_POINTS, STAGES_MS, WRONG_PENALTY, type HostAction, type PartyCue, type PartyState, type Source } from '../../../shared/types';
import { api, sourceLabel } from '../lib/api';
import { player } from '../lib/player';
import { getSocket, request } from '../lib/socket';
import { useKeys, usePlayerStatus } from '../lib/hooks';
import { Art, ClipBar, CountPicker, Eq } from '../components/bits';
import { SourcePicker } from '../components/SourcePicker';
import { RemoteQrButton } from '../components/RemoteQr';
import { usePartySounds } from '../lib/partySounds';
import { unlockSfx } from '../lib/sfx';
import { TopBar } from './Home';

const COLORS = ['#3fd8ff', '#ff3d7f', '#ffd23f', '#4ade9b'];
const DEFAULT_NAMES = ['Blue team', 'Pink team', 'Yellow team', 'Green team'];
const SESSION_KEY = 'songer:party';

export function PartyHost() {
  const [state, setState] = useState<PartyState | null>(null);
  const [source, setSource] = useState<Source | null>({ type: 'top', range: 'medium_term' });
  const [count, setCount] = useState(15);
  const [teams, setTeams] = useState(DEFAULT_NAMES.slice(0, 3));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const tvRef = useRef<HTMLDivElement>(null);
  usePlayerStatus();
  usePartySounds(state);

  // Socket wiring: state updates and audio cues for this screen.
  useEffect(() => {
    const s = getSocket();
    const onState = (st: PartyState) => setState(st);
    const onCue = (c: PartyCue) => {
      const fail = (e: Error) => setError(e.message);
      if (c.kind === 'clip') player.playClip(c.uri, c.ms).catch(fail);
      else if (c.kind === 'reveal') player.playClip(c.uri, c.ms).catch(fail);
      else if (c.kind === 'load') player.preload(c.uri);
      else player.stop();
    };
    const resume = () => {
      const code = sessionStorage.getItem(SESSION_KEY);
      if (code) request<PartyState>('host:resume', { code }).then(setState).catch(() => sessionStorage.removeItem(SESSION_KEY));
    };
    s.on('party:state', onState);
    s.on('party:cue', onCue);
    s.on('connect', resume);
    if (s.connected) resume();
    return () => {
      s.off('party:state', onState);
      s.off('party:cue', onCue);
      s.off('connect', resume);
      player.stop();
    };
  }, []);

  useEffect(() => {
    if (state?.joinUrl) QRCode.toDataURL(state.joinUrl, { margin: 1, width: 440, color: { dark: '#14112b', light: '#ffffff' } }).then(setQr);
  }, [state?.joinUrl]);

  useEffect(() => {
    if (state?.phase === 'final') confetti({ particleCount: 160, spread: 90, origin: { y: 0.6 } });
  }, [state?.phase]);

  const act = (action: HostAction) => {
    if (!state) return;
    player.activate();
    unlockSfx();
    setError(null);
    getSocket().emit('host:action', { code: state.code, action });
  };

  async function openLobby() {
    if (!source) return;
    player.activate();
    unlockSfx();
    setBusy(true);
    setError(null);
    try {
      const [tracks] = await Promise.all([api.pool(source, count), player.init()]);
      if (tracks.length < 3) throw new Error('That source has too few playable songs. Pick another one.');
      const st = await request<PartyState>('host:create', {
        packLabel: sourceLabel(source),
        tracks,
        teams: teams.map((name, i) => ({ name: name.trim() || DEFAULT_NAMES[i], color: COLORS[i] })),
      });
      sessionStorage.setItem(SESSION_KEY, st.code);
      setState(st);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function endParty() {
    act({ type: 'end' });
    sessionStorage.removeItem(SESSION_KEY);
    setState(null);
    if (document.fullscreenElement) document.exitFullscreen();
  }

  const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : tvRef.current?.requestFullscreen().catch(() => {}));

  useKeys(
    {
      Space: () => {
        if (!state) return;
        if (state.phase === 'lobby') act({ type: 'start' });
        else if (state.phase === 'round') act({ type: 'longer' });
        else if (state.phase === 'reveal') act({ type: 'next' });
      },
      Enter: () => state?.phase === 'buzzed' && act({ type: 'judge', verdict: 'song' }),
      a: () => state?.phase === 'buzzed' && act({ type: 'judge', verdict: 'artist' }),
      x: () => state?.phase === 'buzzed' && act({ type: 'judge', verdict: 'wrong' }),
      s: () => (state?.phase === 'round' || state?.phase === 'buzzed') && act({ type: 'skip' }),
      r: () => state?.phase === 'round' && act({ type: 'replay' }),
      f: fullscreen,
    },
    !!state,
  );

  /* ---------------- setup ---------------- */
  if (!state) {
    return (
      <div className="page">
        <TopBar />
        <div className="setup">
          <div className="row">
            <Link className="back" to="/">← Home</Link>
          </div>
          <h1 className="h1">Party setup</h1>
          <div className="panel">
            <span className="eyebrow">Music</span>
            <SourcePicker value={source} onChange={setSource} />
            <CountPicker value={count} onChange={setCount} presets={[10, 15, 20]} />
          </div>
          <div className="panel">
            <span className="eyebrow">Teams</span>
            {teams.map((t, i) => (
              <div key={i} className="teamrow">
                <span className="sw" style={{ background: COLORS[i] }} />
                <input className="field" value={t} maxLength={24} onChange={(e) => setTeams(teams.map((x, k) => (k === i ? e.target.value : x)))} aria-label={`Team ${i + 1} name`} />
                {teams.length > 2 && (
                  <button className="btn ghost sm" onClick={() => setTeams(teams.filter((_, k) => k !== i))} aria-label="Remove team">✕</button>
                )}
              </div>
            ))}
            {teams.length < 4 && (
              <button className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => setTeams([...teams, DEFAULT_NAMES[teams.length]])}>+ Add team</button>
            )}
          </div>
          {error && <div className="err">{error}</div>}
          {player.status === 'error' && <div className="err">{player.error}</div>}
          <button className="btn lg" disabled={!source || busy} onClick={openLobby}>
            {busy ? <><span className="spin" /> Getting songs and the player ready…</> : 'Open lobby on TV'}
          </button>
          <div className="row wrap">
            <RemoteQrButton className="btn ghost" />
            <span className="muted small">Sign your phone in as the host remote: it shows each answer privately so you can judge.</span>
          </div>
          <div className="tip">
            Connect this computer to the TV and turn on a <b>Private Session</b> in Spotify so the party doesn't change your recommendations. Keep the Spotify app on your phone closed; it shows the song name.
          </div>
        </div>
      </div>
    );
  }

  /* ---------------- TV ---------------- */
  const st = state;
  const teamById = (id: string | null | undefined) => st.teams.find((t) => t.id === id);
  const maxScore = Math.max(...st.teams.map((t) => t.score));
  const head = <span className="eyebrow">Song {st.songIndex + 1} of {st.songCount} · {st.packLabel}</span>;

  const scoreboard = (
    <div className="tv-r">
      <span className="eyebrow">Scores</span>
      {st.teams.map((t) => (
        <div key={t.id} className={`team ${maxScore > 0 && t.score === maxScore ? 'lead' : ''} `}>
          <span className="sw" style={{ background: t.color }} />
          <div>
            <div className="nm">{t.name}</div>
            <div className="mb">
              {t.members.length ? t.members.map((m, k) => <span key={m.id} className={m.connected ? '' : 'off'}>{k ? ', ' : ''}{m.name}</span>) : 'waiting for players…'}
            </div>
          </div>
          <span className="sc">{t.score}</span>
        </div>
      ))}
    </div>
  );

  let left: ReactNode;
  if (st.phase === 'lobby') {
    left = (
      <div className="tv-l">
        <span className="eyebrow">Scan to join · {st.packLabel}</span>
        <div className="row" style={{ gap: 'clamp(14px,2vw,28px)' }}>
          <div className="qr">{qr && <img src={qr} alt="QR code to join" />}</div>
          <div className="stack tight">
            <div className="code">{st.code}</div>
            <div className="muted mono" style={{ fontSize: 'clamp(12px,1.1vw,16px)' }}>{st.joinUrl.replace(/^https?:\/\//, '')}</div>
          </div>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 'clamp(13px,1.3vw,18px)' }}>
          No app, no account. Pick your team, or one person can be the judge.
          {st.judge && <><br /><b style={{ color: 'var(--violet)' }}>Judge: {st.judge.name}</b></>}
        </p>
      </div>
    );
  } else if (st.phase === 'final') {
    const ranked = [...st.teams].sort((a, b) => b.score - a.score);
    const order = [ranked[1], ranked[0], ranked[2]].filter(Boolean);
    const heights: Record<string, string> = { [ranked[0].id]: '92%', [ranked[1]?.id]: '66%', [ranked[2]?.id ?? '-']: '44%' };
    left = (
      <div className="tv-l">
        <span className="eyebrow">Final · {st.songCount} songs · {st.packLabel}</span>
        <div className="big">{ranked[0].name}<br />wins!</div>
        {st.fastestBuzz && (
          <p className="muted" style={{ margin: 0, fontSize: 'clamp(13px,1.3vw,18px)' }}>
            Fastest buzz of the night: {st.fastestBuzz.playerName}, {st.fastestBuzz.seconds}s.
          </p>
        )}
      </div>
    );
    return renderTv(
      <>
        {left}
        <div className="tv-r" style={{ justifyContent: 'flex-end' }}>
          <div className="podium">
            {order.map((t) => (
              <div key={t.id} style={{ height: heights[t.id], background: t.color }}>
                {t.id === ranked[0].id ? '🏆' : t.id === ranked[1]?.id ? '2nd' : '3rd'}
                <span>{t.score}</span>
                <small>{t.name}</small>
              </div>
            ))}
          </div>
        </div>
      </>,
    );
  } else if (st.phase === 'reveal' && st.song) {
    const L = st.last;
    const lt = teamById(L?.teamId);
    left = (
      <div className="tv-l">
        {head}
        <div className="row" style={{ gap: 18 }}>
          <Art src={st.song.image} size="clamp(90px,13vw,200px)" radius={16} />
          <div className="grow">
            <div className="big" dir="auto" style={{ fontSize: 'clamp(24px,3.4vw,52px)' }}>{st.song.title}</div>
            <div className="muted" dir="auto" style={{ fontSize: 'clamp(13px,1.4vw,20px)' }}>
              {st.song.artists}{st.song.year ? ` · ${st.song.year}` : ''}
            </div>
          </div>
        </div>
        <div className="buzzcard" style={{ background: lt ? `color-mix(in srgb, ${lt.color} 22%, transparent)` : '#ffffff10' }}>
          <span className="eyebrow">{lt ? (L!.artistOnly ? 'Artist only' : 'Got it') : 'Nobody got it'}</span>
          <b>{lt ? `+${L!.points} ${lt.name}` : 'No points this time'}</b>
        </div>
      </div>
    );
  } else if (st.phase === 'buzzed' && st.buzz) {
    const t = teamById(st.buzz.teamId)!;
    left = (
      <div className="tv-l">
        {head}
        <div className="buzzcard" style={{ background: `color-mix(in srgb, ${t.color} 22%, #120e2a)`, boxShadow: `inset 0 0 0 2px ${t.color}` }}>
          <span className="eyebrow" style={{ color: t.color }}>{st.buzz.playerName} buzzed · {st.buzz.seconds}s</span>
          <b style={{ color: t.color }}>{t.name}</b>
          <span className="muted" style={{ fontSize: 'clamp(13px,1.4vw,20px)' }}>Say the song out loud. Worth {PARTY_POINTS[st.stage]} points.</span>
        </div>
        <ClipBar stage={st.stage} />
      </div>
    );
  } else {
    left = (
      <div className="tv-l">
        {head}
        <div className="big">Name that<br />tune</div>
        <Eq />
        <ClipBar stage={st.stage} />
        <span className="mono muted" style={{ fontSize: 'clamp(12px,1.1vw,16px)' }}>
          Clip {STAGES_MS[st.stage] / 1000}s · worth {PARTY_POINTS[st.stage]} pts · buzz on your phone
        </span>
      </div>
    );
  }

  return renderTv(
    <>
      {left}
      {scoreboard}
      {st.toast && <div className="toast">{st.toast}</div>}
    </>,
  );

  function renderTv(inner: ReactNode) {
    const b = (label: ReactNode, action: HostAction, cls = '', key = '') => (
      <button className={`btn sm ${cls}`} onClick={() => act(action)}>
        {label}
        {key && <span className="kbd">{key}</span>}
      </button>
    );
    return (
      <div className="page">
        <div className="tvwrap" ref={tvRef}>
          <div className="tv">{inner}</div>
          <div className="host">
            <span className="lbl">Host</span>
            {st.phase === 'lobby' && b('Start game', { type: 'start' }, 'yellow', 'Space')}
            {st.phase === 'round' && (
              <>
                {b(st.stage < MAX_STAGE ? `Longer clip (${STAGES_MS[st.stage + 1] / 1000}s)` : 'Reveal', { type: 'longer' }, 'yellow', 'Space')}
                {b('Replay', { type: 'replay' }, 'ghost', 'R')}
                {b('Skip song', { type: 'skip' }, 'ghost', 'S')}
              </>
            )}
            {st.phase === 'buzzed' && (
              <>
                {b(`✓ Song +${PARTY_POINTS[st.stage]}`, { type: 'judge', verdict: 'song' }, 'green', 'Enter')}
                {b('Artist only +1', { type: 'judge', verdict: 'artist' }, 'ghost', 'A')}
                {b(`✕ Wrong −${WRONG_PENALTY}`, { type: 'judge', verdict: 'wrong' }, 'red', 'X')}
              </>
            )}
            {st.phase === 'reveal' && b(st.songIndex + 1 < st.songCount ? 'Next song' : 'Final scores', { type: 'next' }, 'yellow', 'Space')}
            {st.phase === 'final' && b('Rematch', { type: 'rematch' }, 'yellow')}
            <span className="grow" />
            {error && <span className="small" style={{ color: 'var(--red)' }}>{error}</span>}
            {player.status === 'error' && <span className="small" style={{ color: 'var(--red)' }}>{player.error}</span>}
            {st.judge && (
              <button className="btn ghost sm" title="Remove the judge" onClick={() => act({ type: 'removeJudge' })}>
                Judge: {st.judge.name}{st.judge.connected ? '' : ' (offline)'} ✕
              </button>
            )}
            <RemoteQrButton />
            <button className="btn ghost sm" onClick={fullscreen}>Fullscreen <span className="kbd">F</span></button>
            <button className="btn ghost sm" onClick={endParty}>End party</button>
          </div>
        </div>
      </div>
    );
  }
}

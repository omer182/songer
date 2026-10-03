import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { HostAction, PartyState } from '../../../shared/types';
import { getSocket, request } from '../lib/socket';
import { Art, Logo } from '../components/bits';
import { usePartySounds } from '../lib/partySounds';
import { unlockSfx } from '../lib/sfx';
import { HostPanel } from './Remote';

// The phone side of a party: pick a name and team (or be the judge), then the screen is one big buzzer.
// No account; we remember the player in localStorage so a refresh or a dropped connection rejoins.

const JUDGE = 'judge';

interface Saved {
  playerId: string;
  name: string;
  /** A team id, or JUDGE. */
  teamId: string;
}
const storeKey = (code: string) => `songer:join:${code}`;
const load = (code: string): Saved | null => {
  try {
    return JSON.parse(localStorage.getItem(storeKey(code)) || 'null');
  } catch {
    return null;
  }
};

export function Join() {
  const { code: rawCode } = useParams();
  const code = (rawCode || '').toUpperCase();
  const nav = useNavigate();
  const [entry, setEntry] = useState('');
  const [state, setState] = useState<PartyState | null>(null);
  const [me, setMe] = useState<Saved | null>(null);
  const [name, setName] = useState('');
  const [teamId, setTeamId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const meRef = useRef<Saved | null>(null);
  meRef.current = me;
  usePartySounds(state, { onlyTeamId: me?.teamId ?? '-' }); // your own team's buzz / right / wrong

  const join = useCallback(
    (who: { name: string; teamId: string; playerId?: string }) =>
      request<{ playerId: string; state: PartyState }>('player:join', { code, ...who, role: who.teamId === JUDGE ? 'judge' : 'player' }).then((r) => {
        const m = { playerId: r.playerId, name: who.name, teamId: who.teamId };
        localStorage.setItem(storeKey(code), JSON.stringify(m));
        setMe(m);
        setState(r.state);
      }),
    [code],
  );

  useEffect(() => {
    if (!code) return;
    const s = getSocket();
    const saved = load(code);
    if (saved) {
      setName(saved.name);
      setTeamId(saved.teamId);
    }
    const onConnect = () => {
      const m = meRef.current ?? saved;
      if (m) join(m).catch(() => request<PartyState>('party:peek', { code }).then(setState).catch((e) => setError(e.message)));
      else request<PartyState>('party:peek', { code }).then(setState).catch((e) => setError(e.message));
    };
    const onState = (st: PartyState) => setState(st);
    const onEnded = () => {
      setEnded(true);
      localStorage.removeItem(storeKey(code));
    };
    const onJudgeRemoved = () => {
      localStorage.removeItem(storeKey(code));
      setMe(null);
      setTeamId('');
      setError('The host removed you as judge. You can join a team instead.');
      request<PartyState>('party:peek', { code }).then(setState).catch(() => {});
    };
    s.on('connect', onConnect);
    s.on('party:state', onState);
    s.on('party:ended', onEnded);
    s.on('party:judgeRemoved', onJudgeRemoved);
    if (s.connected) onConnect();
    return () => {
      s.off('connect', onConnect);
      s.off('party:state', onState);
      s.off('party:ended', onEnded);
      s.off('party:judgeRemoved', onJudgeRemoved);
    };
  }, [code, join]);

  const submitJoin = () => {
    setError(null);
    join({ name: name.trim(), teamId, playerId: me?.playerId ?? load(code)?.playerId }).catch((e: Error) => setError(e.message));
  };

  /* ----- no code yet: type it ----- */
  if (!code) {
    return (
      <div className="page fit">
        <div className="phone">
          <div className="mid" style={{ width: '100%' }}>
            <h1 className="h1">Join a party</h1>
            <p className="muted" style={{ margin: 0 }}>Type the 4-letter code on the TV.</p>
            <input className="field mono center" style={{ fontSize: 28, letterSpacing: '0.2em' }} maxLength={4} value={entry} onChange={(e) => setEntry(e.target.value.toUpperCase())} autoFocus />
            <button className="btn lg" style={{ width: '100%' }} disabled={entry.length !== 4} onClick={() => nav(`/join/${entry}`)}>Join</button>
          </div>
        </div>
      </div>
    );
  }

  if (ended) {
    return (
      <div className="page fit"><div className="phone"><div className="mid"><h1 className="h1">The party ended</h1><p className="muted">Thanks for playing!</p></div></div></div>
    );
  }

  if (!state) {
    return (
      <div className="page fit"><div className="phone"><div className="mid">{error ? <div className="err">{error}</div> : <span className="spin" />}</div></div></div>
    );
  }

  /* ----- judge: answers + controls ----- */
  if (me?.teamId === JUDGE) {
    return <HostPanel state={state} act={(a: HostAction) => getSocket().emit('judge:action', a)} role={`Judge ${me.name}`} />;
  }

  const myTeam = state.teams.find((t) => t.id === me?.teamId);
  const judgeTaken = !!state.judge?.connected;

  /* ----- pick name + team ----- */
  if (!me || !myTeam) {
    return (
      <div className="page fit">
        <div className="phone" style={{ textAlign: 'left' }}>
          <div className="hd"><Logo size="sm" link={false} /><span className="mono muted">{state.code}</span></div>
          <h1 className="h1">You're invited</h1>
          <p className="muted" style={{ margin: 0 }}>{state.packLabel} · {state.songCount} songs</p>
          <input className="field" placeholder="Your name" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} dir="auto" />
          <div className="teampick">
            {state.teams.map((t) => (
              <button key={t.id} aria-pressed={teamId === t.id} style={{ color: t.color }} onClick={() => setTeamId(t.id)}>
                <span className="sw" style={{ background: t.color }} />
                <span className="grow" style={{ color: 'var(--fg)' }}>{t.name}</span>
                <span className="small muted">{t.members.map((m) => m.name).join(', ')}</span>
              </button>
            ))}
            <button aria-pressed={teamId === JUDGE} disabled={judgeTaken} style={{ color: 'var(--violet)', opacity: judgeTaken ? 0.5 : 1 }} onClick={() => setTeamId(JUDGE)}>
              <span className="sw" style={{ background: 'var(--violet)' }} />
              <span className="grow" style={{ color: 'var(--fg)' }}>
                Be the judge
                <span className="small muted" style={{ display: 'block', fontFamily: 'var(--body)', fontWeight: 400 }}>
                  {judgeTaken ? `${state.judge!.name} is the judge` : 'See the answers, run the game, no team'}
                </span>
              </span>
            </button>
          </div>
          {error && <div className="err">{error}</div>}
          <button className="btn lg" disabled={!name.trim() || !teamId} onClick={submitJoin}>
            {teamId === JUDGE ? 'Join as judge' : `Join ${state.teams.find((t) => t.id === teamId)?.name ?? 'a team'}`}
          </button>
        </div>
      </div>
    );
  }

  /* ----- in the game ----- */
  const buzz = () => {
    unlockSfx();
    navigator.vibrate?.(80);
    getSocket().emit('player:buzz');
  };
  const rank = [...state.teams].sort((a, b) => b.score - a.score).findIndex((t) => t.id === myTeam.id) + 1;
  let mid: ReactNode;
  if (state.phase === 'lobby') {
    mid = (
      <div className="mid">
        <div className="h1" style={{ color: myTeam.color }}>You're in!</div>
        <div className="muted">{myTeam.members.map((m) => m.name).join(', ')}</div>
        <div className="muted small">The first song starts soon. Watch the TV.</div>
      </div>
    );
  } else if (state.phase === 'round') {
    mid = (
      <button
        className="buzz"
        disabled={myTeam.locked}
        onPointerDown={(e) => {
          e.preventDefault();
          buzz();
        }}
        style={{ background: `radial-gradient(circle at 35% 30%, #fff5 0, transparent 42%), ${myTeam.color}`, boxShadow: `0 10px 0 color-mix(in srgb, ${myTeam.color} 55%, #000)` }}
      >
        {myTeam.locked ? 'OUT' : 'BUZZ'}
      </button>
    );
  } else if (state.phase === 'buzzed' && state.buzz) {
    const mine = state.buzz.teamId === myTeam.id;
    const other = state.teams.find((t) => t.id === state.buzz!.teamId);
    mid = mine ? (
      <div className="mid">
        <div className="h1" style={{ color: myTeam.color }}>{state.buzz.playerName === me.name ? 'You buzzed first!' : `${state.buzz.playerName} buzzed!`}</div>
        <div className="muted">Say the song out loud</div>
      </div>
    ) : (
      <div className="mid"><div className="h2" style={{ color: other?.color }}>{other?.name} buzzed…</div><div className="muted small">If they're wrong, you can steal.</div></div>
    );
  } else if (state.phase === 'reveal') {
    const got = state.last?.teamId === myTeam.id;
    mid = (
      <div className="mid">
        {state.song && <Art src={state.song.image} size={120} radius={14} />}
        <div className="h2" dir="auto">{state.song?.title}</div>
        <div className="muted" dir="auto">{state.song?.artists}</div>
        {got && <div className="mono" style={{ fontSize: 28, fontWeight: 800, color: myTeam.color }}>+{state.last!.points}</div>}
      </div>
    );
  } else {
    mid = (
      <div className="mid">
        <div className="h1" style={{ color: myTeam.color, fontSize: 48 }}>{['1st', '2nd', '3rd', '4th'][rank - 1]}</div>
        <div className="muted">{myTeam.score} points</div>
      </div>
    );
  }

  return (
    <div className="page fit">
      <div className="phone">
        <div className="hd">
          <span style={{ color: myTeam.color }}>{myTeam.name}</span>
          <span className="mono">{myTeam.score} pts</span>
        </div>
        <div className="muted small">
          {state.phase === 'lobby' ? `Hi ${me.name}` : `Song ${state.songIndex + 1} of ${state.songCount}`}
        </div>
        {mid}
        <div className="muted small">{me.name} · code {state.code}</div>
      </div>
    </div>
  );
}

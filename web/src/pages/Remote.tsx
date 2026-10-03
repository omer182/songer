import { useEffect, useState } from 'react';
import { MAX_STAGE, PARTY_POINTS, STAGES_MS, type HostAction, type PartyState } from '../../../shared/types';
import { getSocket, request } from '../lib/socket';
import { Art, Logo } from '../components/bits';

// The host's phone: shows the answer privately and has the judge buttons, so the TV never spoils it.

export function Remote() {
  const [state, setState] = useState<PartyState | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const s = getSocket();
    const find = () =>
      request<PartyState | null>('host:current', {})
        .then((st) => {
          setState(st);
          setError(null);
        })
        .catch((e) => setError(e.message));
    const onState = (st: PartyState) => setState(st);
    const onEnded = () => setState(null);
    s.on('connect', find);
    s.on('party:state', onState);
    s.on('party:new', find);
    s.on('party:ended', onEnded);
    if (s.connected) find();
    return () => {
      s.off('connect', find);
      s.off('party:state', onState);
      s.off('party:new', find);
      s.off('party:ended', onEnded);
    };
  }, []);

  const act = (action: HostAction) => {
    if (!state) return;
    getSocket().emit('host:action', { code: state.code, action });
  };

  if (state === undefined) {
    return <div className="page center" style={{ paddingTop: '30vh' }}>{error ? <div className="err">{error}</div> : <span className="spin" />}</div>;
  }

  if (!state) {
    return (
      <div className="page fit">
        <div className="phone">
          <div className="hd"><Logo size="sm" link={false} /><span className="mono muted">Host remote</span></div>
          <div className="mid">
            <div className="h2">No party running</div>
            <p className="muted" style={{ margin: 0 }}>Open the lobby on the laptop. This screen picks it up automatically.</p>
          </div>
        </div>
      </div>
    );
  }

  return <HostPanel state={state} act={act} role="Host" />;
}

/** The answer + judge controls screen, shared by the host's phone remote and a judge who joined by QR. */
export function HostPanel({ state, act: send, role }: { state: PartyState; act: (a: HostAction) => void; role: string }) {
  const act = (a: HostAction) => {
    navigator.vibrate?.(30);
    send(a);
  };
  const st = state;
  const buzzTeam = st.teams.find((t) => t.id === st.buzz?.teamId);
  const big = (label: string, action: HostAction, cls = '') => (
    <button className={`btn lg ${cls}`} style={{ width: '100%' }} onClick={() => act(action)}>
      {label}
    </button>
  );

  return (
    <div className="page fit">
      <div className="phone" style={{ textAlign: 'left', minHeight: 'auto' }}>
        <div className="hd">
          <Logo size="sm" link={false} />
          <span className="mono muted">{role} · {st.code}</span>
        </div>

        {st.phase === 'lobby' ? (
          <div className="panel">
            <span className="eyebrow">Lobby · {st.packLabel}</span>
            <span className="muted">{st.teams.reduce((n, t) => n + t.members.length, 0)} players joined</span>
          </div>
        ) : st.phase === 'final' ? (
          <div className="panel"><span className="eyebrow">Game over</span><span className="h2">{[...st.teams].sort((a, b) => b.score - a.score)[0].name} wins</span></div>
        ) : (
          st.song && (
            <div className="panel" style={{ gap: 8 }}>
              <span className="eyebrow">Song {st.songIndex + 1} of {st.songCount} · the answer (only you see this)</span>
              <div className="row" style={{ gap: 12 }}>
                <Art src={st.song.image} size={72} radius={10} />
                <div className="grow">
                  <div className="h2" dir="auto" style={{ fontSize: 22 }}>{st.song.title}</div>
                  <div className="muted" dir="auto">{st.song.artists}{st.song.year ? ` · ${st.song.year}` : ''}</div>
                </div>
              </div>
            </div>
          )
        )}

        {st.phase === 'buzzed' && buzzTeam && st.buzz && (
          <div className="buzzcard" style={{ background: `color-mix(in srgb, ${buzzTeam.color} 22%, transparent)`, boxShadow: `inset 0 0 0 2px ${buzzTeam.color}` }}>
            <span className="eyebrow" style={{ color: buzzTeam.color }}>{st.buzz.playerName} buzzed · {st.buzz.seconds}s</span>
            <b style={{ color: buzzTeam.color, fontSize: 30 }}>{buzzTeam.name}</b>
          </div>
        )}
        {st.toast && st.phase === 'round' && <div className="tip">{st.toast}</div>}

        <div className="stack">
          {st.phase === 'lobby' && big('Start game', { type: 'start' }, 'yellow')}
          {st.phase === 'round' && (
            <>
              <span className="mono muted small">Playing {STAGES_MS[st.stage] / 1000}s clip · worth {PARTY_POINTS[st.stage]} pts</span>
              {big(st.stage < MAX_STAGE ? `Longer clip (${STAGES_MS[st.stage + 1] / 1000}s)` : 'Reveal', { type: 'longer' }, 'yellow')}
              <div className="row">
                <button className="btn ghost grow" onClick={() => act({ type: 'replay' })}>Replay</button>
                <button className="btn ghost grow" onClick={() => act({ type: 'skip' })}>Skip song</button>
              </div>
            </>
          )}
          {st.phase === 'buzzed' && (
            <>
              {big(`✓ Song +${PARTY_POINTS[st.stage]}`, { type: 'judge', verdict: 'song' }, 'green')}
              <div className="row">
                <button className="btn ghost grow" onClick={() => act({ type: 'judge', verdict: 'artist' })}>Artist only +1</button>
                <button className="btn red grow" onClick={() => act({ type: 'judge', verdict: 'wrong' })}>✕ Wrong</button>
              </div>
            </>
          )}
          {st.phase === 'reveal' && big(st.songIndex + 1 < st.songCount ? 'Next song' : 'Final scores', { type: 'next' }, 'yellow')}
          {st.phase === 'final' && big('Rematch', { type: 'rematch' }, 'yellow')}
        </div>

        <div className="stack tight">
          <span className="eyebrow">Scores</span>
          {st.teams.map((t) => (
            <div key={t.id} className="row" style={{ background: 'var(--card)', borderRadius: 10, padding: '8px 12px', opacity: t.locked && st.phase !== 'reveal' ? 0.45 : 1 }}>
              <span style={{ width: 10, height: 22, borderRadius: 3, background: t.color }} />
              <span className="grow" style={{ fontWeight: 600 }}>{t.name}</span>
              <span className="muted small">{t.members.length} 👤</span>
              <span className="mono" style={{ fontWeight: 800 }}>{t.score}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

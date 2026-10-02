import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MAX_STAGE, REVEAL_MS, STAGES_MS, type Source, type Suggestion, type Track } from '../../../shared/types';
import { isCorrect } from '../../../shared/match';
import { api, sourceLabel } from '../lib/api';
import { player } from '../lib/player';
import { useKeys, usePlayerStatus } from '../lib/hooks';
import { Art, ClipBar } from '../components/bits';
import { SourcePicker } from '../components/SourcePicker';
import { GuessInput } from '../components/GuessInput';
import { TopBar } from './Home';
import { celebrate } from '../lib/celebrate';

type Try = { type: 'skip' } | { type: 'miss' | 'win'; guess: Suggestion };
interface SongResult {
  track: Track;
  tries: Try[];
  won: boolean;
}

const COUNTS = [5, 10, 15];
const pointsFor = (tries: number) => 7 - tries; // solved on try 1 = 6 points … try 6 = 1 point

export function Solo() {
  const [phase, setPhase] = useState<'pick' | 'loading' | 'play' | 'summary'>('pick');
  const [source, setSource] = useState<Source | null>({ type: 'top', range: 'medium_term' });
  const [count, setCount] = useState(10);
  const [pool, setPool] = useState<Track[]>([]);
  const [i, setI] = useState(0);
  const [stage, setStage] = useState(0);
  const [tries, setTries] = useState<Try[]>([]);
  const [done, setDone] = useState(false);
  const [guess, setGuess] = useState<Suggestion | null>(null);
  const [results, setResults] = useState<SongResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const saved = useRef(false);
  usePlayerStatus();

  const track = pool[i];
  const score = results.reduce((s, r) => s + (r.won ? pointsFor(r.tries.length) : 0), 0);
  const won = done && tries.at(-1)?.type === 'win';

  const play = useCallback((t: Track, ms: number) => {
    setError(null);
    player.playClip(t.uri, ms).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => () => void player.stop(), []);

  async function start() {
    if (!source) return;
    player.activate();
    setPhase('loading');
    setError(null);
    try {
      const [tracks] = await Promise.all([api.pool(source, count), player.init()]);
      if (!tracks.length) throw new Error('That source has no playable songs. Pick another one.');
      setPool(tracks);
      setResults([]);
      saved.current = false;
      beginSong(tracks, 0);
      setPhase('play');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('pick');
    }
  }

  function beginSong(list: Track[], idx: number) {
    setI(idx);
    setStage(0);
    setTries([]);
    setDone(false);
    setGuess(null);
    play(list[idx], STAGES_MS[0]);
  }

  function advance(t: Try) {
    const next = [...tries, t];
    setTries(next);
    setGuess(null);
    if (t.type === 'win') celebrate((7 - next.length) / 6); // try 1 = full blast, try 6 = a sprinkle
    if (t.type === 'win' || stage >= MAX_STAGE) {
      setDone(true);
      setResults((r) => [...r, { track, tries: next, won: t.type === 'win' }]);
      play(track, REVEAL_MS);
    } else {
      const s = stage + 1;
      setStage(s);
      setTimeout(() => play(track, STAGES_MS[s]), t.type === 'miss' ? 300 : 80);
    }
  }

  function submit() {
    if (!guess || !track) return;
    advance({ type: isCorrect(guess, track) ? 'win' : 'miss', guess });
  }

  function nextSong() {
    player.stop();
    if (i + 1 < pool.length) beginSong(pool, i + 1);
    else setPhase('summary');
  }

  useEffect(() => {
    if (phase !== 'summary' || saved.current) return;
    saved.current = true;
    api
      .soloResult({
        label: sourceLabel(source),
        score,
        maxScore: results.length * 6,
        detail: results.map((r) => ({ id: r.track.id, title: r.track.title, artists: r.track.artists, tries: r.tries.length, won: r.won })),
      })
      .catch(() => {});
  }, [phase, score, results, source]);

  useKeys(
    {
      Space: () => (phase === 'play' && track ? (player.isPlaying() ? player.stop() : play(track, done ? REVEAL_MS : STAGES_MS[stage])) : undefined),
      Enter: () => (phase === 'play' && done ? nextSong() : undefined),
    },
    phase === 'play',
  );

  const triesList = (
    <div className="tries">
      {STAGES_MS.map((_, k) => {
        const t = tries[k];
        if (!t) return <div key={k} className="try empty" />;
        if (t.type === 'skip')
          return (
            <div key={k} className="try">
              <span className="k">⤼</span>
              <span className="k">Skipped</span>
            </div>
          );
        return (
          <div key={k} className="try">
            <span className={t.type === 'win' ? 'ok' : 'x'}>{t.type === 'win' ? '✓' : '✕'}</span>
            <span className="t" dir="auto">{t.guess.title}</span>
            <span className="k t" style={{ marginLeft: 'auto' }} dir="auto">{t.guess.artists}</span>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="page">
      <TopBar />
      {phase === 'pick' || phase === 'loading' ? (
        <div className="solo">
          <div className="topline">
            <Link className="back" to="/">← Home</Link>
            <span className="score">Solo</span>
          </div>
          <h1 className="h1">Pick the music</h1>
          <SourcePicker value={source} onChange={setSource} />
          <div className="row wrap">
            <span className="eyebrow">Songs</span>
            {COUNTS.map((n) => (
              <button key={n} className="chip" aria-pressed={count === n} onClick={() => setCount(n)}>
                {n}
              </button>
            ))}
          </div>
          {error && <div className="err">{error}</div>}
          <button className="btn lg" disabled={!source || phase === 'loading'} onClick={start}>
            {phase === 'loading' ? <><span className="spin" /> Getting songs and the player ready…</> : `Play ${count} songs`}
          </button>
          <p className="muted small center" style={{ margin: 0 }}>Six tries per song. Every miss or skip unlocks a longer clip.</p>
        </div>
      ) : phase === 'summary' ? (
        <div className="solo">
          <div className="topline">
            <span className="muted" dir="auto">{sourceLabel(source)}</span>
            <span className="score">done</span>
          </div>
          <div className="big-score">
            {score}
            <span className="muted" style={{ fontSize: 22 }}> / {results.length * 6}</span>
          </div>
          <p className="muted center" style={{ margin: 0 }}>
            {score >= results.length * 3.6 ? 'You really do know your music.' : score >= results.length * 1.8 ? 'Not bad. The intros got you a few times.' : 'Spotify thinks you listen to these. Spotify might be wrong.'}
          </p>
          <div className="stack tight">
            {results.map((r) => (
              <div key={r.track.id} className="sumrow">
                <Art src={r.track.image} size={36} radius={8} />
                <div className="grow">
                  <div dir="auto" style={{ fontWeight: 600 }}>{r.track.title}</div>
                  <div className="small muted" dir="auto">{r.track.artists}</div>
                </div>
                <div className="sq">
                  {STAGES_MS.map((_, k) => {
                    const t = r.tries[k];
                    return <i key={k} className={t ? (t.type === 'miss' ? 'm' : t.type === 'skip' ? 's' : 'g') : ''} />;
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="row">
            <button className="btn ghost grow" onClick={() => setPhase('pick')}>New source</button>
            <button className="btn grow" onClick={start}>Play again</button>
          </div>
        </div>
      ) : (
        <div className="solo">
          <div className="topline">
            <button className="back" onClick={() => { player.stop(); setPhase('pick'); }}>← Sources</button>
            <span className="muted t" dir="auto">{sourceLabel(source)}</span>
            <span className="score">{i + 1}/{pool.length} · {score} pts</span>
          </div>
          {error && <div className="err">{error}</div>}
          {player.status === 'error' && <div className="err">{player.error}</div>}
          {done ? (
            <>
              <div className="reveal">
                <Art src={track.image} size={160} radius={18} />
                <div>
                  <div className="h1" dir="auto" style={{ fontSize: 26 }}>{track.title}</div>
                  <div className="muted" dir="auto">
                    {track.artists}
                    {track.album && ` · ${track.album}`}
                    {track.year && ` · ${track.year}`}
                  </div>
                </div>
                <span className={`result ${won ? 'win' : 'lose'}`}>{won ? `Got it on try ${tries.length} · +${pointsFor(tries.length)}` : 'Missed it'}</span>
              </div>
              <ClipBar stage={MAX_STAGE} revealed />
              {triesList}
              <div className="row">
                <button className="btn ghost grow" onClick={() => play(track, REVEAL_MS)}>▶ Hear more</button>
                <button className="btn grow" onClick={nextSong}>{i + 1 < pool.length ? 'Next song' : 'See results'}</button>
              </div>
              <a className="small center" href={`https://open.spotify.com/track/${track.id}`} target="_blank" rel="noreferrer">Open in Spotify</a>
            </>
          ) : (
            <>
              <ClipBar stage={stage} />
              <button
                className={`playbtn ${player.isPlaying() ? 'playing' : ''}`}
                aria-label={player.isPlaying() ? 'Stop' : 'Play clip'}
                onClick={() => (player.isPlaying() ? player.stop() : play(track, STAGES_MS[stage]))}
              />
              <div className="stagetxt">
                Clip {STAGES_MS[stage] / 1000}s · try {tries.length + 1} of 6 · <span className="kbd">Space</span> replays
              </div>
              {triesList}
              <GuessInput key={`${i}-${tries.length}`} onPick={setGuess} onSubmit={submit} />
              <div className="row">
                <button className="btn ghost grow" onClick={() => advance({ type: 'skip' })}>
                  {stage < MAX_STAGE ? `Skip (+${(STAGES_MS[stage + 1] - STAGES_MS[stage]) / 1000}s)` : 'Give up'}
                </button>
                <button className="btn grow" disabled={!guess} onClick={submit}>Guess</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MAX_STAGE, STAGES_MS, type Source, type Suggestion, type Track } from '../../../shared/types';
import { isCorrect, sameArtist } from '../../../shared/match';
import { api, sourceLabel } from '../lib/api';
import { player } from '../lib/player';
import { useKeys, usePlayerStatus } from '../lib/hooks';
import { Art, ClipBar, CountPicker, RevealCover } from '../components/bits';
import { SourcePicker } from '../components/SourcePicker';
import { GuessInput } from '../components/GuessInput';
import { TopBar } from './Home';
import { celebrate } from '../lib/celebrate';

/** artist: a wrong song, but by the right artist (shown in yellow). */
type Try = { type: 'skip' } | { type: 'miss' | 'win'; guess: Suggestion; artist?: boolean };
interface SongResult {
  track: Track;
  tries: Try[];
  won: boolean;
  /** Skipped without playing it out: no points, and it doesn't count toward the maximum. */
  skipped?: boolean;
}

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
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [skipped, setSkipped] = useState(false); // this song was skipped (reveal shows "Skipped") // short pause before a new song's first clip
  const startTimer = useRef(0);
  const saved = useRef(false);
  usePlayerStatus();

  const track = pool[i];
  const playedCount = results.filter((r) => !r.skipped).length;
  const score = results.reduce((s, r) => s + (r.won ? pointsFor(r.tries.length) : 0), 0);
  const won = done && tries.at(-1)?.type === 'win';

  const play = useCallback((t: Track, ms: number, fromMs = 0) => {
    setError(null);
    setPausedAt(null);
    player.playClip(t.uri, ms, fromMs).catch((e: Error) => setError(e.message));
  }, []);

  /** After the round the whole song plays; tapping the cover pauses and resumes it. */
  const playFull = useCallback((t: Track, fromMs = 0) => play(t, Math.max(1000, t.durationMs - fromMs), fromMs), [play]);
  const toggleReveal = () => {
    if (!track) return;
    if (player.isPlaying()) player.pause().then((pos) => setPausedAt(pos ?? 0));
    else playFull(track, pausedAt ?? 0);
  };

  useEffect(() => () => {
    window.clearTimeout(startTimer.current);
    void player.stop();
  }, []);

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

  /** New song: show "Loading song…" for a moment (and let the player get ready), then play the first 0.5s. */
  function beginSong(list: Track[], idx: number) {
    setI(idx);
    setStage(0);
    setTries([]);
    setDone(false);
    setSkipped(false);
    setGuess(null);
    setWaiting(true);
    window.clearTimeout(startTimer.current);
    player.preload(list[idx].uri);
    startTimer.current = window.setTimeout(() => {
      setWaiting(false);
      play(list[idx], STAGES_MS[0]);
    }, 1500);
  }

  function advance(t: Try) {
    const next = [...tries, t];
    setTries(next);
    setGuess(null);
    if (t.type === 'win') celebrate((7 - next.length) / 6); // try 1 = full blast, try 6 = a sprinkle
    if (t.type === 'win' || stage >= MAX_STAGE) {
      setDone(true);
      setResults((r) => [...r, { track, tries: next, won: t.type === 'win' }]);
      playFull(track);
    } else {
      const s = stage + 1;
      setStage(s);
      setTimeout(() => play(track, STAGES_MS[s]), t.type === 'miss' ? 300 : 80);
    }
  }

  function submit() {
    if (!guess || !track) return;
    const win = isCorrect(guess, track);
    advance({ type: win ? 'win' : 'miss', guess, artist: !win && sameArtist(guess, track) });
  }

  /** Skip this song entirely (bad intro, or you'd rather not): straight to the next one, no points. */
  /** Skip this song: reveal it (and play it, like any reveal), no points, not counted in the maximum. */
  function skipSong() {
    if (!track) return;
    window.clearTimeout(startTimer.current);
    setWaiting(false);
    setSkipped(true);
    setDone(true);
    setResults((r) => [...r, { track, tries, won: false, skipped: true }]);
    playFull(track);
  }

  function nextSong() {
    player.activate(); // a click: lets the browser keep the audio unlocked
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
        maxScore: playedCount * 6,
        detail: results.map((r) => ({ id: r.track.id, title: r.track.title, artists: r.track.artists, tries: r.tries.length, won: r.won, skipped: !!r.skipped })),
      })
      .catch(() => {});
  }, [phase, score, results, source]);

  useKeys(
    {
      Space: () => (phase === 'play' && track ? (done ? toggleReveal() : player.isPlaying() ? player.stop() : play(track, STAGES_MS[stage])) : undefined),
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
          <div key={k} className={`try ${t.type === 'miss' && t.artist ? 'artist' : ''}`} title={t.type === 'miss' && t.artist ? 'Right artist, wrong song' : undefined}>
            <span className={t.type === 'win' ? 'ok' : t.artist ? 'half' : 'x'}>{t.type === 'win' ? '✓' : t.artist ? '≈' : '✕'}</span>
            <span className="t" dir="auto">{t.guess.title}</span>
            <span className="k t" style={{ marginLeft: 'auto' }} dir="auto">{t.guess.artists}</span>
            {t.type === 'miss' && t.artist && <span className="artist-tag">right artist</span>}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="page fit">
      <TopBar />
      {phase === 'pick' || phase === 'loading' ? (
        <div className="solo">
          <div className="topline">
            <Link className="back" to="/">← Home</Link>
            <span className="score">Solo</span>
          </div>
          <h1 className="h1">Pick the music</h1>
          <SourcePicker value={source} onChange={setSource} />
          <CountPicker value={count} onChange={setCount} presets={[5, 10, 15]} />
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
            <span className="muted" style={{ fontSize: 22 }}> / {playedCount * 6}</span>
          </div>
          <p className="muted center" style={{ margin: 0 }}>
            {score >= playedCount * 3.6 ? 'You really do know your music.' : score >= playedCount * 1.8 ? 'Not bad. The intros got you a few times.' : 'Spotify thinks you listen to these. Spotify might be wrong.'}
          </p>
          <div className="stack tight sumlist">
            {results.map((r) => (
              <div key={r.track.id} className="sumrow">
                <Art src={r.track.image} size={36} radius={8} />
                <div className="grow">
                  <div dir="auto" style={{ fontWeight: 600 }}>{r.track.title}</div>
                  <div className="small muted" dir="auto">{r.track.artists}</div>
                </div>
                {r.skipped ? (
                  <span className="mono muted small">skipped</span>
                ) : (
                  <div className="sq">
                    {STAGES_MS.map((_, k) => {
                      const t = r.tries[k];
                      return <i key={k} className={t ? (t.type === 'miss' ? (t.artist ? 'a' : 'm') : t.type === 'skip' ? 's' : 'g') : ''} />;
                    })}
                  </div>
                )}
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
                <RevealCover src={track.image} durationMs={track.durationMs} pausedAt={pausedAt} onToggle={toggleReveal} />
                <div>
                  <div className="h1" dir="auto" style={{ fontSize: 26 }}>{track.title}</div>
                  <div className="muted" dir="auto">
                    {track.artists}
                    {track.album && ` · ${track.album}`}
                    {track.year && ` · ${track.year}`}
                  </div>
                </div>
                <span className={`result ${won ? 'win' : 'lose'}`} style={skipped ? { color: 'var(--muted)', background: 'var(--card)' } : undefined}>
                  {won ? `Got it on try ${tries.length} · +${pointsFor(tries.length)}` : skipped ? 'Skipped' : 'Missed it'}
                </span>
              </div>
              <ClipBar stage={MAX_STAGE} revealed />
              {triesList}
              <div className="row">
                <button className="btn ghost grow" onClick={() => playFull(track)}>⏮ From the start</button>
                <button className="btn grow" onClick={nextSong}>{i + 1 < pool.length ? 'Next song' : 'See results'}</button>
              </div>
              <a className="small center" href={`https://open.spotify.com/track/${track.id}`} target="_blank" rel="noreferrer">Open in Spotify</a>
            </>
          ) : (
            <>
              <ClipBar stage={stage} waiting={waiting} />
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
                <button className="btn grow" disabled={!guess} onClick={() => { (document.activeElement as HTMLElement | null)?.blur(); submit(); }}>Guess</button>
              </div>
              <button className="back small center" style={{ textDecoration: 'underline', justifySelf: 'center' }} onClick={skipSong}>
                Skip this song ⏭
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

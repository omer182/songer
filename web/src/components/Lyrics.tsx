import { useEffect, useRef, useState } from 'react';
import type { Track } from '../../../shared/types';
import type { LyricLine } from '../../../shared/lrc';
import { player } from '../lib/player';
import { useFrame } from '../lib/hooks';

const cache = new Map<string, LyricLine[] | null>();

/** Karaoke-style synced lyrics for the song that's playing: previous, current (big) and next line. */
export function Lyrics({ song }: { song: Track }) {
  const [lines, setLines] = useState<LyricLine[] | null | undefined>(cache.get(song.id));
  const [idx, setIdx] = useState(-1);
  const last = useRef(-1);

  useEffect(() => {
    last.current = -1;
    setIdx(-1);
    if (cache.has(song.id)) return setLines(cache.get(song.id));
    setLines(undefined);
    let live = true;
    const q = new URLSearchParams({ id: song.id, title: song.title, artists: song.artists, durationMs: String(song.durationMs) });
    fetch(`/api/lyrics?${q}`, { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((d: { lines: LyricLine[] | null }) => {
        cache.set(song.id, d.lines);
        if (live) setLines(d.lines);
      })
      .catch(() => live && setLines(null));
    return () => {
      live = false;
    };
  }, [song.id, song.title, song.artists, song.durationMs]);

  useFrame(() => {
    if (!lines?.length) return;
    const pos = player.position();
    if (pos == null) return; // paused: keep the current line
    let i = -1;
    for (let k = 0; k < lines.length && lines[k].t <= pos + 150; k++) i = k;
    if (i !== last.current) {
      last.current = i;
      setIdx(i);
    }
  });

  if (lines === undefined) return <div className="lyrics muted">Finding the lyrics…</div>;
  if (!lines?.length) return <div className="lyrics muted small">No synced lyrics for this song.</div>;
  const at = (k: number) => (k >= 0 && k < lines.length ? lines[k].text || '♪' : '');
  return (
    <div className="lyrics" aria-live="polite">
      <div className="ly-prev" dir="auto">{idx > 0 ? at(idx - 1) : ''}</div>
      <div className="ly-cur" dir="auto">{idx >= 0 ? at(idx) : '♪'}</div>
      <div className="ly-next" dir="auto">{at(idx + 1)}</div>
    </div>
  );
}

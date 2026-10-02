import { useRef } from 'react';
import { STAGES_MS } from '../../../shared/types';
import { player } from '../lib/player';
import { useFrame, usePlayerStatus } from '../lib/hooks';

// Segment widths follow the clip lengths: 0.5s, +0.5s, +1s, +2s, +4s, +7s = 15s.
const SEGMENTS = STAGES_MS.map((ms, i) => ms - (i ? STAGES_MS[i - 1] : 0));
const TOTAL = STAGES_MS[STAGES_MS.length - 1];

export function ClipBar({ stage, revealed = false }: { stage: number; revealed?: boolean }) {
  const ph = useRef<HTMLDivElement>(null);
  useFrame(() => {
    const el = ph.current;
    if (!el) return;
    const pos = player.position();
    el.style.opacity = pos == null ? '0' : '1';
    if (pos != null) el.style.left = `calc(${(Math.min(pos, TOTAL) / TOTAL) * 100}% - 1px)`;
  });
  return (
    <div className="stack tight">
      <div className="clip">
        {SEGMENTS.map((w, i) => (
          <div key={i} className={`sg ${i <= stage ? 'on' : revealed ? 'rest' : ''}`} style={{ flex: w }} />
        ))}
        <div className="ph" ref={ph} style={{ opacity: 0 }} />
      </div>
      <div className="clip-lbl">
        <span>0:00</span>
        <span>0:04</span>
        <span>0:08</span>
        <span>0:15</span>
      </div>
    </div>
  );
}

export function Art({ src, size, radius }: { src: string | null; size: number | string; radius?: number }) {
  return (
    <span className="art" style={{ width: size, height: size, borderRadius: radius }}>
      {src && <img src={src} alt="" loading="lazy" />}
    </span>
  );
}

/** Animated equalizer that moves while a clip is audible. */
export function Eq({ bars = 14 }: { bars?: number }) {
  usePlayerStatus();
  return (
    <div className={`eq ${player.isPlaying() ? 'on' : ''}`} aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  );
}

export function Logo() {
  return (
    <a className="logo" href="/">
      song<b>er</b>
    </a>
  );
}

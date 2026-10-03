import { useRef, useState } from 'react';
import { STAGES_MS } from '../../../shared/types';
import { player } from '../lib/player';
import { useFrame, usePlayerStatus } from '../lib/hooks';

// Segment widths follow the clip lengths: 0.5s, +0.5s, +1s, +2s, +4s, +7s = 15s.
const SEGMENTS = STAGES_MS.map((ms, i) => ms - (i ? STAGES_MS[i - 1] : 0));
const TOTAL = STAGES_MS[STAGES_MS.length - 1];

export function ClipBar({ stage, revealed = false, waiting = false }: { stage: number; revealed?: boolean; waiting?: boolean }) {
  const ph = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLSpanElement>(null);
  useFrame(() => {
    const pos = player.position();
    const pct = pos == null ? 0 : (Math.min(pos, TOTAL) / TOTAL) * 100;
    if (ph.current) {
      ph.current.style.opacity = pos == null ? '0' : '1';
      ph.current.style.left = `calc(${pct}% - 1px)`;
    }
    // The bar fills while the clip plays, so you can see how much you're hearing.
    if (fill.current) fill.current.style.width = pos == null ? '0' : `${pct}%`;
    if (status.current) {
      const loading = waiting || player.isPreparing();
      status.current.textContent = loading ? 'Loading song…' : pos != null ? 'Playing' : '';
      status.current.className = `clip-status ${loading ? 'loading' : pos != null ? 'playing' : ''}`;
    }
  });
  return (
    <div className="stack tight">
      <div className="clip">
        {SEGMENTS.map((w, i) => (
          <div key={i} className={`sg ${i <= stage ? 'on' : revealed ? 'rest' : ''}`} style={{ flex: w }} />
        ))}
        <div className="fill" ref={fill} />
        <div className="ph" ref={ph} style={{ opacity: 0 }} />
      </div>
      <div className="clip-lbl">
        <span>0:00</span>
        <span ref={status} className="clip-status" />
        <span>0:15</span>
      </div>
    </div>
  );
}

const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

/** Album cover that pauses/resumes the reveal when tapped, with the song's progress underneath. */
export function RevealCover({ src, durationMs, pausedAt, onToggle, size = 160 }: { src: string | null; durationMs: number; pausedAt: number | null; onToggle: () => void; size?: number }) {
  usePlayerStatus();
  const bar = useRef<HTMLDivElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  useFrame(() => {
    const pos = player.position() ?? pausedAt ?? 0;
    if (bar.current) bar.current.style.width = `${Math.min(100, (pos / durationMs) * 100)}%`;
    if (time.current) time.current.textContent = `${fmt(pos)} / ${fmt(durationMs)}`;
  });
  const playing = player.isPlaying();
  return (
    <div className="stack tight" style={{ justifyItems: 'center' }}>
      <button className="cover" onClick={onToggle} aria-label={playing ? 'Pause the song' : 'Play the song'} style={{ width: size, height: size }}>
        <Art src={src} size={size} radius={18} />
        <span className={`cover-icon ${playing ? 'is-playing' : ''}`} aria-hidden="true">{playing ? '❚❚' : '▶'}</span>
      </button>
      <div className="songbar" style={{ width: size }}><div ref={bar} /></div>
      <span ref={time} className="mono muted small" />
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

// Bar heights echo the clip lengths: each try hears a little more of the song.
const MARK_BARS = [22, 34, 48, 64, 82, 100];

/** The Songer mark: an equalizer tile, the wordmark and "by Rio". */
export function Logo({ size = 'md', link = true }: { size?: 'sm' | 'md' | 'lg'; link?: boolean }) {
  const inner = (
    <>
      <span className="brand-mark" aria-hidden="true">
        {MARK_BARS.map((h, i) => (
          <i key={i} style={{ height: `${h}%`, animationDelay: `${i * 0.11}s` }} />
        ))}
      </span>
      <span className="brand-text">
        <span className="brand-word">
          song<b>er</b>
        </span>
        <span className="brand-by">by Rio</span>
      </span>
    </>
  );
  const cls = `brand ${size}`;
  return link ? (
    <a className={cls} href="/" aria-label="Songer by Rio, home">
      {inner}
    </a>
  ) : (
    <span className={cls}>{inner}</span>
  );
}

/** Preset song counts plus "Custom": a slider from 5 to 50 in steps of 5. */
export function CountPicker({ value, onChange, presets }: { value: number; onChange: (n: number) => void; presets: number[] }) {
  const [custom, setCustom] = useState(!presets.includes(value));
  return (
    <div className="stack tight">
      <div className="row wrap">
        <span className="eyebrow">Songs</span>
        {presets.map((n) => (
          <button key={n} className="chip" aria-pressed={!custom && value === n} onClick={() => { setCustom(false); onChange(n); }}>
            {n}
          </button>
        ))}
        <button className="chip" aria-pressed={custom} onClick={() => setCustom(true)}>
          Custom{custom ? `: ${value}` : ''}
        </button>
      </div>
      {custom && (
        <div className="row">
          <span className="mono muted small">5</span>
          <input
            type="range"
            className="grow"
            min={5}
            max={50}
            step={5}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
            aria-label="Number of songs"
            style={{ accentColor: 'var(--pink)' }}
          />
          <span className="mono muted small">50</span>
          <span className="mono" style={{ fontWeight: 800, minWidth: 28, textAlign: 'right' }}>{value}</span>
        </div>
      )}
    </div>
  );
}

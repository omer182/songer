import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { player } from './player';

/** Re-render when the Spotify player's status changes. */
export function usePlayerStatus() {
  return useSyncExternalStore(
    (cb) => player.subscribe(cb),
    () => `${player.status}|${player.error ?? ''}|${player.isPlaying()}|${player.isPreparing()}`,
  );
}

/** requestAnimationFrame loop that calls fn every frame while mounted. */
export function useFrame(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let id = 0;
    const loop = () => {
      ref.current();
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, []);
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Keyboard shortcuts, ignored while typing in an input. */
export function useKeys(map: Record<string, () => void>, enabled = true) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.matches?.('input, textarea')) return;
      const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const fn = ref.current[key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

export const isPhone = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

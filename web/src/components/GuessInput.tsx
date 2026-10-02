import { useEffect, useRef, useState } from 'react';
import type { Suggestion } from '../../../shared/types';
import { api } from '../lib/api';
import { useDebounced } from '../lib/hooks';

/** Type-ahead over your library plus all of Spotify. Calls onPick with the chosen song. */
export function GuessInput({ onPick, onSubmit, disabled }: { onPick: (s: Suggestion | null) => void; onSubmit?: () => void; disabled?: boolean }) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Suggestion | null>(null);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const dq = useDebounced(q.trim(), 180);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (picked || dq.length < 2) {
      setItems([]);
      return;
    }
    const ctl = new AbortController();
    api
      .searchSongs(dq, ctl.signal)
      .then((r) => {
        setItems(r);
        setHl(0);
        setOpen(true);
      })
      .catch(() => {});
    return () => ctl.abort();
  }, [dq, picked]);

  const pick = (s: Suggestion) => {
    setPicked(s);
    setQ(`${s.title} — ${s.artists}`);
    setOpen(false);
    onPick(s);
  };

  return (
    <div className="guess">
      {open && items.length > 0 && !picked && (
        <div className="ac" role="listbox">
          {items.map((s, i) => (
            <button key={s.key} role="option" aria-selected={i === hl} className={i === hl ? 'hl' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)}>
              <span dir="auto">{s.title}</span>
              <small dir="auto">· {s.artists}</small>
            </button>
          ))}
        </div>
      )}
      <input
        ref={input}
        value={q}
        disabled={disabled}
        dir="auto"
        autoComplete="off"
        placeholder="Know it? Start typing the song…"
        onChange={(e) => {
          setQ(e.target.value);
          if (picked) {
            setPicked(null);
            onPick(null);
          }
        }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onFocus={() => items.length && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && picked) {
            e.preventDefault();
            onSubmit?.();
            return;
          }
          if (!open || !items.length) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHl((h) => (h + 1) % items.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHl((h) => (h - 1 + items.length) % items.length);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(items[hl]);
          } else if (e.key === 'Escape') setOpen(false);
        }}
      />
    </div>
  );
}

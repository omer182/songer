import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Suggestion } from '../../../shared/types';
import { api } from '../lib/api';
import { useDebounced } from '../lib/hooks';

/**
 * Type-ahead over your library plus all of Spotify. While you type, the closest song title is completed
 * inline (the added part is selected, so typing on simply replaces it, and Enter takes it).
 * Picking a song closes the phone keyboard.
 */
export function GuessInput({ onPick, onSubmit, disabled }: { onPick: (s: Suggestion | null) => void; onSubmit?: () => void; disabled?: boolean }) {
  const [typed, setTyped] = useState(''); // what the player actually typed
  const [shown, setShown] = useState(''); // typed + inline completion
  const [picked, setPicked] = useState<Suggestion | null>(null);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const dq = useDebounced(typed.trim(), 180);
  const input = useRef<HTMLInputElement>(null);
  const noComplete = useRef(false); // after a delete, or while a phone keyboard is composing a word
  const composing = useRef(false);
  const selectFrom = useRef<number | null>(null);

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

  // Inline completion with the best suggestion, when its title starts with what was typed.
  useEffect(() => {
    const top = items[0];
    if (!top || picked || noComplete.current || composing.current || document.activeElement !== input.current) return;
    if (typed.length >= 2 && top.title.length > typed.length && top.title.toLowerCase().startsWith(typed.toLowerCase())) {
      selectFrom.current = typed.length;
      setShown(typed + top.title.slice(typed.length));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  useLayoutEffect(() => {
    if (selectFrom.current != null && input.current) {
      input.current.setSelectionRange(selectFrom.current, shown.length);
      selectFrom.current = null;
    }
  }, [shown]);

  const pick = (s: Suggestion) => {
    setPicked(s);
    const text = `${s.title} — ${s.artists}`;
    setTyped(text);
    setShown(text);
    setOpen(false);
    onPick(s);
    input.current?.blur(); // closes the keyboard on phones
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
        value={shown}
        disabled={disabled}
        dir="auto"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        placeholder="Know it? Start typing the song…"
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => (composing.current = false)}
        onChange={(e) => {
          const inputType = (e.nativeEvent as InputEvent).inputType ?? '';
          noComplete.current = inputType.startsWith('delete');
          setTyped(e.target.value);
          setShown(e.target.value);
          if (picked) {
            setPicked(null);
            onPick(null);
          }
        }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onFocus={() => items.length && !picked && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && picked) {
            e.preventDefault();
            input.current?.blur();
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
          } else if (e.key === 'Enter' || (e.key === 'Tab' && shown !== typed)) {
            e.preventDefault();
            pick(items[hl]);
          } else if (e.key === 'Escape') {
            setShown(typed);
            setOpen(false);
          }
        }}
      />
    </div>
  );
}

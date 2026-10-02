import { useEffect, useState } from 'react';
import type { ArtistInfo, PlaylistInfo, Source, TopRange } from '../../../shared/types';
import { api } from '../lib/api';
import { useDebounced } from '../lib/hooks';
import { Art } from './bits';

type Tab = 'top' | 'liked' | 'recent' | 'artist' | 'playlist';
const TABS: [Tab, string][] = [
  ['top', 'Top tracks'],
  ['liked', 'Liked Songs'],
  ['artist', 'A band'],
  ['playlist', 'A playlist'],
  ['recent', 'Recently played'],
];
const RANGES: [TopRange, string][] = [
  ['short_term', 'Last 4 weeks'],
  ['medium_term', '6 months'],
  ['long_term', 'All time'],
];

const isPlaylist = (x: ArtistInfo | PlaylistInfo): x is PlaylistInfo => 'count' in x;

export function SourcePicker({ value, onChange, likedCount }: { value: Source | null; onChange: (s: Source) => void; likedCount?: number }) {
  const [tab, setTab] = useState<Tab>(value && value.type !== 'album' ? value.type : 'top');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const [mine, setMine] = useState<{ artist?: ArtistInfo[]; playlist?: PlaylistInfo[] }>({});
  const [found, setFound] = useState<(ArtistInfo | PlaylistInfo)[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setQ('');
    setFound(null);
    setErr(null);
    if (tab === 'artist' && !mine.artist) api.artists().then((a) => setMine((m) => ({ ...m, artist: a }))).catch((e) => setErr(e.message));
    if (tab === 'playlist' && !mine.playlist) api.playlists().then((p) => setMine((m) => ({ ...m, playlist: p }))).catch((e) => setErr(e.message));
    if (tab === 'top' && value?.type !== 'top') onChange({ type: 'top', range: 'medium_term' });
    if (tab === 'liked') onChange({ type: 'liked' });
    if (tab === 'recent') onChange({ type: 'recent' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    if (dq.length < 2 || (tab !== 'artist' && tab !== 'playlist')) {
      setFound(null);
      return;
    }
    let live = true;
    (tab === 'artist' ? api.searchArtists(dq) : api.searchPlaylists(dq))
      .then((r) => live && setFound(r))
      .catch((e) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [dq, tab]);

  const list = (found ?? (tab === 'artist' ? mine.artist : tab === 'playlist' ? mine.playlist : null)) || [];
  const selectedId = value && 'id' in value ? value.id : null;

  return (
    <div className="picker">
      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" className="chip" aria-pressed={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'top' && (
        <div className="stack tight">
          <span className="muted small">The songs you play most, as Spotify sees it.</span>
          <div className="row wrap">
            {RANGES.map(([r, label]) => (
              <button key={r} className="chip" aria-pressed={value?.type === 'top' && value.range === r} onClick={() => onChange({ type: 'top', range: r })}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {tab === 'liked' && <span className="muted small">Random songs from your Liked Songs{likedCount ? ` (${likedCount.toLocaleString()})` : ''}.</span>}
      {tab === 'recent' && <span className="muted small">The last 50 songs you played.</span>}

      {(tab === 'artist' || tab === 'playlist') && (
        <div className="stack tight">
          <input
            className="field"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tab === 'artist' ? 'Search any band or artist…' : 'Search public playlists, e.g. "israeli 80s"…'}
            dir="auto"
          />
          <span className="muted small">
            {found ? 'Search results' : tab === 'artist' ? 'Artists you play and follow' : 'Your playlists'}
          </span>
          {err && <div className="err">{err}</div>}
          <div className="optlist">
            {list.length === 0 && !err && <span className="muted small">{found ? 'Nothing found.' : 'Loading…'}</span>}
            {list.map((x) => (
              <button
                key={x.id}
                className="opt"
                aria-pressed={selectedId === x.id}
                onClick={() => onChange(tab === 'artist' ? { type: 'artist', id: x.id, name: x.name } : { type: 'playlist', id: x.id, name: x.name })}
              >
                <Art src={x.image} size={40} radius={tab === 'artist' ? 20 : 8} />
                <div className="grow">
                  <div className="t" dir="auto">{x.name}</div>
                  {isPlaylist(x) && (
                    <div className="s" dir="auto">
                      {x.count} songs{x.owner ? ` · ${x.owner}` : ''}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

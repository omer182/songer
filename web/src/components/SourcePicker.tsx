import { useEffect, useState } from 'react';
import type { ArtistInfo, PlaylistInfo, Source, TopRange } from '../../../shared/types';
import { api } from '../lib/api';
import { useDebounced } from '../lib/hooks';
import { Art } from './bits';

type Tab = 'top' | 'liked' | 'recent' | 'artist' | 'playlist' | 'deezer';
const TABS: [Tab, string][] = [
  ['top', 'Top tracks'],
  ['liked', 'Liked Songs'],
  ['artist', 'A band'],
  ['playlist', 'My playlists'],
  ['deezer', 'Find a playlist'],
  ['recent', 'Recently played'],
];
const RANGES: [TopRange, string][] = [
  ['short_term', 'Last 4 weeks'],
  ['medium_term', '6 months'],
  ['long_term', 'All time'],
];
// Deezer's search ranks Hebrew queries far better than English ones for Israeli music.
const QUICK_FINDS = ['להיטים ישראלים', 'רוק ישראלי', 'מזרחית', 'שנות ה-80', 'שנות ה-90', 'שנות ה-2000', '90s hits', '80s hits', 'rock classics', 'Disney'];

const isPlaylist = (x: ArtistInfo | PlaylistInfo): x is PlaylistInfo => 'count' in x;

export function SourcePicker({ value, onChange, likedCount }: { value: Source | null; onChange: (s: Source) => void; likedCount?: number }) {
  const [tab, setTab] = useState<Tab>(value && value.type !== 'album' ? value.type : 'top');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 350);
  const [mine, setMine] = useState<{ artist?: ArtistInfo[]; playlist?: PlaylistInfo[] }>({});
  const [found, setFound] = useState<(ArtistInfo | PlaylistInfo)[] | null>(null);
  const [searching, setSearching] = useState(false);
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

  // Remote search: any artist on Spotify, or any public playlist on Deezer.
  useEffect(() => {
    if (dq.length < 2 || (tab !== 'artist' && tab !== 'deezer')) {
      setFound(null);
      return;
    }
    let live = true;
    setSearching(true);
    setErr(null);
    (tab === 'artist' ? api.searchArtists(dq) : api.searchDeezerPlaylists(dq))
      .then((r) => live && setFound(r))
      .catch((e) => live && setErr(e.message))
      .finally(() => live && setSearching(false));
    return () => {
      live = false;
    };
  }, [dq, tab]);

  const ownFiltered = (mine.playlist ?? []).filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()));
  const list: (ArtistInfo | PlaylistInfo)[] =
    (tab === 'artist' ? (found ?? mine.artist) : tab === 'playlist' ? (mine.playlist ? ownFiltered : undefined) : tab === 'deezer' ? found : null) || [];
  const selectedId = value && 'id' in value ? value.id : null;
  const hasUnavailable = tab === 'playlist' && list.some((p) => isPlaylist(p) && !p.available);

  const pick = (x: ArtistInfo | PlaylistInfo) => {
    if (isPlaylist(x) && !x.available) return;
    if (tab === 'artist') onChange({ type: 'artist', id: x.id, name: x.name });
    else if (tab === 'deezer') onChange({ type: 'deezer', id: x.id, name: x.name });
    else onChange({ type: 'playlist', id: x.id, name: x.name });
  };

  const placeholder = { artist: 'Search any band or artist…', playlist: 'Filter your playlists…', deezer: 'Search playlists, e.g. רוק ישראלי or 90s hits…' } as Record<Tab, string>;
  const caption =
    tab === 'deezer'
      ? found
        ? `Playlists from Deezer · songs play from your Spotify`
        : 'Any public playlist, by genre, decade or mood. Hebrew searches work best for Israeli music.'
      : found
        ? 'Search results'
        : tab === 'artist'
          ? 'Artists you play and follow'
          : 'Your playlists';

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

      {(tab === 'artist' || tab === 'playlist' || tab === 'deezer') && (
        <div className="stack tight">
          <input className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder[tab]} dir="auto" />
          {tab === 'deezer' && !q && (
            <div className="row wrap">
              {QUICK_FINDS.map((s) => (
                <button key={s} className="chip" onClick={() => setQ(s)} dir="auto">{s}</button>
              ))}
            </div>
          )}
          <span className="muted small">
            {caption} {searching && <span className="spin" style={{ width: 12, height: 12, verticalAlign: 'middle' }} />}
          </span>
          {err && <div className="err">{err}</div>}
          <div className="optlist">
            {list.length === 0 && !err && !(tab === 'deezer' && !found) && (
              <span className="muted small">{found || (tab === 'playlist' && mine.playlist) ? 'Nothing found.' : 'Loading…'}</span>
            )}
            {list.map((x) => {
              const off = isPlaylist(x) && !x.available;
              return (
                <button
                  key={x.id}
                  className="opt"
                  aria-pressed={selectedId === x.id}
                  disabled={off}
                  style={off ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
                  title={off ? `Made by ${(x as PlaylistInfo).owner}. Copy its songs into a playlist of yours to play it.` : undefined}
                  onClick={() => pick(x)}
                >
                  <Art src={x.image} size={40} radius={tab === 'artist' ? 20 : 8} />
                  <div className="grow">
                    <div className="t" dir="auto">{x.name}</div>
                    {isPlaylist(x) && (
                      <div className="s" dir="auto">
                        {off ? `Made by ${x.owner} · copy it to use it` : `${x.count} songs${x.owner ? ` · ${x.owner}` : ''}`}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
          {hasUnavailable && (
            <span className="muted small">
              Greyed-out playlists were made by someone else, and Spotify won't share their songs with personal apps. In the Spotify app, select all their songs
              (Ctrl+A) → Add to playlist → New playlist, then press Refresh on the home screen. Or try <b>Find a playlist</b>.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

import type { ArtistInfo, LibraryStatus, Me, PlaylistInfo, Source, Suggestion, Track } from '../../../shared/types';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      msg = ((await res.json()) as { error?: string }).error || msg;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body?: unknown) => call<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const api = {
  config: () => call<{ spotifyConfigured: boolean; redirectUri: string; joinBaseUrl: string }>('/api/config'),
  me: () => call<Me>('/api/me'),
  logout: () => post<{ ok: true }>('/api/auth/logout'),
  token: () => call<{ accessToken: string; expiresAt: number }>('/api/auth/token'),
  status: () => call<LibraryStatus>('/api/library/status'),
  sync: () => post<LibraryStatus>('/api/library/sync'),
  playlists: () => call<PlaylistInfo[]>('/api/library/playlists'),
  artists: () => call<ArtistInfo[]>('/api/library/artists'),
  searchArtists: (q: string) => call<ArtistInfo[]>(`/api/search/artists?q=${encodeURIComponent(q)}`),
  searchSongs: (q: string, signal?: AbortSignal) => call<Suggestion[]>(`/api/search/songs?q=${encodeURIComponent(q)}`, { signal }),
  pool: (source: Source, count: number) => post<Track[]>('/api/pool', { source, count }),
  soloResult: (body: { label: string; score: number; maxScore: number; detail: unknown }) => post('/api/solo/result', body),
};

export function sourceLabel(s: Source | null): string {
  if (!s) return '';
  switch (s.type) {
    case 'top':
      return `Top tracks · ${{ short_term: '4 weeks', medium_term: '6 months', long_term: 'all time' }[s.range]}`;
    case 'liked':
      return 'Liked Songs';
    case 'recent':
      return 'Recently played';
    default:
      return s.name || s.type;
  }
}

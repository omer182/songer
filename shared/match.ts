// Answer matching shared by server (dedupe, search) and web (guess checking).
// A guess counts when the normalized title matches and at least one artist overlaps,
// so the album version, a remaster and a compilation copy of a song are all accepted.

const VERSION_WORDS =
  /\b(remaster(ed)?|re-?recorded|live|version|edit|mix|remix|mono|stereo|demo|acoustic|radio|single|bonus|deluxe|anniversary|explicit|clean|instrumental|from|feat\.?|ft\.?|featuring|with)\b/i;

/** Lowercase, strip accents/niqqud and punctuation, collapse spaces. Keeps Hebrew and other scripts. */
export function normBasic(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-֑ͯ-ׇ]/g, '') // combining accents, Hebrew niqqud/cantillation
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Title without version noise: "Song (Remastered 2011)", "Song - Live at X", "Song [feat. Y]". */
export function normTitle(title: string): string {
  let t = title;
  // bracketed parts that describe a version
  t = t.replace(/[([{][^)\]}]*[)\]}]/g, (m) => (VERSION_WORDS.test(m) ? ' ' : m));
  // " - Remastered 2009", " - Live", " - Radio Edit"
  t = t.replace(/\s[-–—]\s.*$/, (m) => (VERSION_WORDS.test(m) ? ' ' : m));
  // trailing "feat. X"
  t = t.replace(/\s(feat\.?|ft\.?|featuring)\s.*$/i, ' ');
  const n = normBasic(t);
  return n || normBasic(title);
}

/** Live recordings, in English or Hebrew (\b only works for Latin letters, so Hebrew gets its own pattern). */
export const LIVE = /\blive\b|(^|[\s([\-])(לייב|הופעה|גרסה חיה|בהופעה)($|[\s)\]\-])/i;

/** Versions that make a bad "name that tune" clip: sessions, demos, remixes, acoustic takes, commentary. */
export const ODD_VERSION =
  /\b(recorded at|session|sessions|demo|acoustic|unplugged|remix|remixed|instrumental|karaoke|commentary|interview|rehearsal|a cappella|acapella)\b/i;

/** A title worth putting in a game: not live, not an odd version, and an actual name. */
export const isGameVersion = (title: string) => !LIVE.test(title) && !ODD_VERSION.test(title) && title.trim() !== '' && !/^[\s\-–—]/.test(title);

export function normArtist(artist: string): string {
  return normBasic(artist.replace(/^the\s+/i, ''));
}

export interface SongRef {
  title: string;
  /** Comma-separated or array of artist names. */
  artists: string | string[];
  /** Spotify IDs, when known. They make matching independent of how a name is spelled (Eyal Levi / אייל לוי). */
  trackId?: string;
  id?: string;
  artistIds?: string[];
}

const artistList = (a: string | string[]) =>
  (Array.isArray(a) ? a : a.split(/\s*,\s*/)).map(normArtist).filter(Boolean);

/** Stable key for deduping the same song across albums/versions. */
export function songKey(s: SongRef): string {
  return `${normTitle(s.title)}|${artistList(s.artists)[0] ?? ''}`;
}

export function isCorrect(guess: SongRef, answer: SongRef): boolean {
  const gid = guess.trackId ?? guess.id;
  const aid = answer.trackId ?? answer.id;
  if (gid && aid && gid === aid) return true;
  if (normTitle(guess.title) !== normTitle(answer.title)) return false;
  if (guess.artistIds?.length && answer.artistIds?.length && guess.artistIds.some((x) => answer.artistIds!.includes(x))) return true;
  const a = new Set(artistList(answer.artists));
  return artistList(guess.artists).some((x) => a.has(x));
}

/** Every query token must appear in the haystack (already normBasic'd). */
export function matchesQuery(haystack: string, query: string): boolean {
  const tokens = normBasic(query).split(' ').filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => haystack.includes(t));
}

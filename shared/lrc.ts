// Synced-lyrics (LRC) parsing, shared by the server and tests.

export interface LyricLine {
  /** Start time in ms. */
  t: number;
  text: string;
}

/** "[01:23.45] text" lines → sorted { t, text } (blank lines kept as pauses). */
export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) out.push({ t: Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000), text });
  }
  return out.sort((a, b) => a.t - b.t);
}

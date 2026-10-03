import { describe, expect, it } from 'vitest';
import { isCorrect, matchesQuery, normBasic, normTitle, songKey } from './match.js';

describe('normTitle', () => {
  it('drops version noise', () => {
    expect(normTitle('Mr. Brightside')).toBe('mr brightside');
    expect(normTitle('Karma Police (Remastered)')).toBe('karma police');
    expect(normTitle('Creep - Remastered 2009')).toBe('creep');
    expect(normTitle('Adam\'s Song - Live')).toBe('adam s song');
    expect(normTitle('Hold On (feat. Someone)')).toBe('hold on');
    expect(normTitle('Song [Radio Edit]')).toBe('song');
  });
  it('keeps meaningful brackets and dashes', () => {
    expect(normTitle('(I Can\'t Get No) Satisfaction')).toBe('i can t get no satisfaction');
    expect(normTitle('Why\'d You Only Call Me When You\'re High?')).toBe('why d you only call me when you re high');
  });
  it('handles Hebrew, including niqqud', () => {
    expect(normTitle('לא עוזב את העיר')).toBe('לא עוזב את העיר');
    expect(normBasic('שָׁלוֹם')).toBe('שלום');
  });
});

describe('isCorrect', () => {
  const answer = { title: 'All The Small Things', artists: 'blink-182' };
  it('accepts other versions of the same song', () => {
    expect(isCorrect({ title: 'All the Small Things - Remastered', artists: 'blink-182' }, answer)).toBe(true);
  });
  it('rejects a different song or a cover', () => {
    expect(isCorrect({ title: 'First Date', artists: 'blink-182' }, answer)).toBe(false);
    expect(isCorrect({ title: 'All The Small Things', artists: 'Some Cover Band' }, answer)).toBe(false);
  });
  it('matches any featured artist', () => {
    expect(isCorrect({ title: 'Song', artists: 'B' }, { title: 'Song', artists: ['A', 'B'] })).toBe(true);
  });
  it('ignores a leading "The"', () => {
    expect(isCorrect({ title: 'Last Nite', artists: 'Strokes' }, { title: 'Last Nite', artists: 'The Strokes' })).toBe(true);
  });
});

describe('songKey / matchesQuery', () => {
  it('dedupes versions', () => {
    expect(songKey({ title: 'Creep', artists: 'Radiohead' })).toBe(songKey({ title: 'Creep - Remastered', artists: 'Radiohead, X' }));
  });
  it('needs every token', () => {
    const h = normBasic('Do I Wanna Know? Arctic Monkeys');
    expect(matchesQuery(h, 'wanna arctic')).toBe(true);
    expect(matchesQuery(h, 'wanna radiohead')).toBe(false);
    expect(matchesQuery(h, '  ')).toBe(false);
  });
});

describe('isCorrect with Spotify IDs', () => {
  const answer = { id: 'trk1', title: 'מעולה', artists: 'אייל לוי', artistIds: ['art1'] };
  it('accepts the exact track regardless of spelling', () => {
    expect(isCorrect({ trackId: 'trk1', title: 'Meule', artists: 'Eyal Levi' }, answer)).toBe(true);
  });
  it('accepts another version by the same artist ID even when names are spelled differently', () => {
    expect(isCorrect({ trackId: 'trk2', title: 'מעולה', artists: 'Eyal Levi', artistIds: ['art1'] }, answer)).toBe(true);
  });
  it('rejects the same title by a different artist', () => {
    expect(isCorrect({ trackId: 'trk3', title: 'מעולה', artists: 'מישהו אחר', artistIds: ['art9'] }, answer)).toBe(false);
  });
});

describe('LIVE', () => {
  it('spots live versions in English and Hebrew', async () => {
    const { LIVE } = await import('./match.js');
    for (const t of ['Adam\'s Song - Live', 'Song (Live at Wembley)', 'שיר - לייב', 'שיר (הופעה חיה)', 'בהופעה בקיסריה']) expect(LIVE.test(t)).toBe(true);
    for (const t of ['Alive', 'Oliver', 'Delivery', 'חי', 'עם ישראל חי', 'Liverpool']) expect(LIVE.test(t)).toBe(false);
  });
});

describe('isGameVersion', () => {
  it('keeps normal songs and drops odd versions', async () => {
    const { isGameVersion } = await import('./match.js');
    for (const x of ['505', 'R U Mine?', 'הלוואי', "Adam's Song"]) expect(isGameVersion(x)).toBe(true);
    for (const x of ['- - Recorded at Electric Lady Studios, New York', 'Song - Acoustic', 'Song (Demo)', 'Song - Live', 'Song (Commentary)']) expect(isGameVersion(x)).toBe(false);
  });
});

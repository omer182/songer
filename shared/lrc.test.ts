import { describe, expect, it } from 'vitest';
import { parseLrc } from './lrc.js';

describe('parseLrc', () => {
  it('parses timestamps, multi-stamps and blank pause lines', () => {
    const lines = parseLrc('[ar:x]\n[00:01.50] First\n[00:03.00][00:10.00] Chorus\n[00:05.25]\n');
    expect(lines).toEqual([
      { t: 1500, text: 'First' },
      { t: 3000, text: 'Chorus' },
      { t: 5250, text: '' },
      { t: 10000, text: 'Chorus' },
    ]);
  });
});

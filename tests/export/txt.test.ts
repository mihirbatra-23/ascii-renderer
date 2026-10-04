import { describe, expect, it } from 'vitest';
import { halftoneChar, snapshotToText } from '../../src/export/txt';
import { makeSnapshot } from './helpers';

describe('snapshotToText', () => {
  it('emits rows of exactly cols characters with a trailing newline', () => {
    const snap = makeSnapshot({ rows: ['ab  ', ' @#.', '    '] });
    const text = snapshotToText(snap, '\n');
    expect(text).toBe('ab  \n @#.\n    \n');
    for (const line of text.split('\n').slice(0, -1)) expect([...line]).toHaveLength(4);
  });

  it('supports CRLF line endings', () => {
    const snap = makeSnapshot({ rows: ['ab', 'cd'] });
    expect(snapshotToText(snap, '\r\n')).toBe('ab\r\ncd\r\n');
  });

  it('keeps braille and block characters as single code points', () => {
    const snap = makeSnapshot({ rows: ['⠁⣿⠀', '▘█ '], params: { mode: 'braille' } });
    const lines = snapshotToText(snap).split('\n');
    expect(lines[0]).toBe('⠁⣿⠀');
    expect(lines[1]).toBe('▘█ ');
  });

  it('maps halftone coverage onto the four-step dot ramp', () => {
    const snap = makeSnapshot({ rows: ['xxxx'], params: { mode: 'halftone' }, tone: [0, 0.3, 0.6, 1] });
    expect(snapshotToText(snap)).toBe(' ·•●\n');
    expect(halftoneChar(Number.NaN)).toBe(' ');
    expect(halftoneChar(-1)).toBe(' ');
    expect(halftoneChar(2)).toBe('●');
  });

  it('replaces empty or control characters with spaces so the grid never shifts', () => {
    const snap = makeSnapshot({ rows: ['abc'] });
    snap.chars[0] = '';
    snap.chars[1] = '\t';
    expect(snapshotToText(snap)).toBe('  c\n');
  });
});

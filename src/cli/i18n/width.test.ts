/**
 * Terminal cell measurement and wrapping.
 *
 * This exists because the help text was wrapped by `String.length`, which counts
 * UTF-16 code units: the Japanese help came out 152 cells wide against a promised
 * 88, and the test that was supposed to catch it measured the same wrong unit. So
 * the cases below are mostly the ones `.length` gets wrong.
 */

import { describe, expect, it } from 'vitest';
import { charWidth, displayWidth, wrapToWidth } from './width';

const cp = (ch: string): number => ch.codePointAt(0)!;

describe('displayWidth', () => {
  it('counts Latin text by the character', () => {
    expect(displayWidth('')).toBe(0);
    expect(displayWidth('stegoshard save')).toBe(15);
    // Accented Latin still occupies one cell each, precomposed…
    expect(displayWidth('déjà vu')).toBe(7);
    // …and decomposed, where the combining marks add nothing but `.length` counts
    // them. This is the French and Portuguese help text.
    expect(displayWidth('déjà vu')).toBe(7);
    expect('déjà vu'.length).toBe(9); // what the old assertion measured
  });

  it('gives CJK two cells, as a terminal does', () => {
    expect(displayWidth('画像')).toBe(4);
    expect(displayWidth('パスワードが違います')).toBe(20);
    expect(displayWidth('無法復原')).toBe(8);
    // Fullwidth punctuation and the CJK comma are wide too; they end most lines
    // of the Japanese help.
    expect(displayWidth('（最大 1 GiB）')).toBe(14);
    expect(displayWidth('、。')).toBe(4);
  });

  it('measures mixed lines, which is what the help actually contains', () => {
    // A flag column in ASCII against a wide description: 23 cells of column,
    // plus 6 characters at 2 cells each.
    expect(displayWidth('  --binary             画像ではなく')).toBe(23 + 12);
  });

  it('counts an astral character once, not twice', () => {
    // Two code units, one character, and two cells because a terminal draws
    // emoji wide. `.length` would say 2 for the wrong reason.
    expect(displayWidth('\u{1f512}')).toBe(2);
    expect(charWidth(cp('a'))).toBe(1);
    expect(charWidth(0x0301)).toBe(0);
    expect(charWidth(cp('あ'))).toBe(2);
  });
});

describe('wrapToWidth', () => {
  it('breaks Latin prose on spaces', () => {
    const lines = wrapToWidth('the quick brown fox jumps over the lazy dog', 16);
    expect(lines).toEqual(['the quick brown', 'fox jumps over', 'the lazy dog']);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(16);
  });

  it('keeps every line inside the width for CJK, which has no spaces to break on', () => {
    // The failing case: one unbroken run wider than the terminal. A space-only
    // wrapper emits it whole, which is how a 152-cell line got out.
    const text = 'このコマンドは画像のなかに秘密を保存します。復元にはパスワードが必要です。';
    const lines = wrapToWidth(text, 20);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(displayWidth(line), line).toBeLessThanOrEqual(20);
    // Nothing is dropped or duplicated by the hard break.
    expect(lines.join('')).toBe(text);
  });

  it('does not strand closing punctuation at the head of a line', () => {
    // Kinsoku: a line may not begin with 。or 」. The break moves back one
    // character instead.
    for (const width of [8, 10, 12, 14]) {
      const lines = wrapToWidth('秘密を保存しました。次は復元です。', width);
      for (const line of lines) {
        expect(line.startsWith('。'), `${width}: ${line}`).toBe(false);
        expect(displayWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('breaks a token too long to fit rather than letting it run off', () => {
    // A path or URL in a description, with no space to break on.
    const lines = wrapToWidth('see docs/THREAT-MODEL.md#deniability-and-duress for more', 20);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(20);
    expect(lines.join(' ').replace(/ /g, '')).toBe(
      'seedocs/THREAT-MODEL.md#deniability-and-duressformore',
    );
  });

  it('handles the degenerate widths without looping or losing text', () => {
    expect(wrapToWidth('', 10)).toEqual([]);
    expect(wrapToWidth('   ', 10)).toEqual([]);
    // A width narrower than a single wide character still terminates, and still
    // emits every character.
    expect(wrapToWidth('画像', 1).join('')).toBe('画像');
  });

  it('collapses the whitespace it wrapped on', () => {
    // The renderer joins with single spaces, so incoming newlines and runs of
    // spaces in a catalog string must not survive into the column.
    expect(wrapToWidth('a  b\n\tc', 40)).toEqual(['a b c']);
  });
});

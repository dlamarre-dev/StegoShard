/**
 * Terminal width, in cells rather than characters.
 *
 * `String.length` counts UTF-16 code units, which is the wrong unit twice over
 * for a terminal: a Japanese or Chinese character occupies **two** cells, and an
 * astral character occupies two code units. Wrapping the help text by `.length`
 * produced Japanese lines 152 cells wide against a promised 88.
 *
 * Written here rather than taken from `string-width` because this is a runtime
 * dependency of a CLI that advertises adding none, and of a 13KB launcher. The
 * table below covers the eight languages shipped; anything else counts as one
 * cell, which is what a terminal does for Latin, Greek and Cyrillic anyway.
 */

/** East Asian Wide and Fullwidth ranges (UAX #11), plus the CJK blocks in use. */
const WIDE: readonly [number, number][] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compat, enclosed CJK
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f9ff], // Emoji, which a terminal also draws double-width
  [0x20000, 0x3fffd], // CJK extensions B and beyond
];

/** Combining marks add nothing to the line: they sit on the previous cell. */
const ZERO: readonly [number, number][] = [
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x20d0, 0x20f0],
  [0xfe00, 0xfe0f], // variation selectors
];

const inRanges = (cp: number, ranges: readonly [number, number][]): boolean =>
  ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

/** Cells one character occupies. */
export function charWidth(cp: number): 0 | 1 | 2 {
  if (inRanges(cp, ZERO)) return 0;
  return inRanges(cp, WIDE) ? 2 : 1;
}

/** Cells a string occupies in a terminal. */
export function displayWidth(text: string): number {
  let cells = 0;
  for (const ch of text) cells += charWidth(ch.codePointAt(0)!);
  return cells;
}

/**
 * Characters that must not begin a line (a small subset of Japanese and Chinese
 * kinsoku rules). A hard break lands one character earlier rather than leaving a
 * full stop or a closing bracket stranded at the start of a line.
 */
const NEVER_STARTS_LINE = new Set([...'、。，．：；！？」』）］｝〉》”’', ...',.:;!?)]}']);

/**
 * Break `text` into lines of at most `width` cells.
 *
 * Spaces are the preferred break, but they are not enough: Japanese and Chinese
 * text has none, so a run wider than the line is broken by character. That hard
 * break is also what keeps a long path or URL inside the column instead of
 * letting one token run off the terminal.
 */
export function wrapToWidth(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';

  /** Cut `token` into width-sized pieces, flushing full lines as it goes. */
  const hardBreak = (token: string): void => {
    const chars = [...token];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      const w = charWidth(ch.codePointAt(0)!);
      if (displayWidth(line) + w > width && line !== '') {
        // Avoid stranding punctuation at the head of the next line.
        if (NEVER_STARTS_LINE.has(ch) && [...line].length > 1) {
          const back = [...line];
          const moved = back.pop()!;
          lines.push(back.join(''));
          line = moved;
        } else {
          lines.push(line);
          line = '';
        }
      }
      line += ch;
    }
  };

  for (const token of text.split(/\s+/).filter((t) => t !== '')) {
    const tokenWidth = displayWidth(token);
    if (line === '') {
      if (tokenWidth <= width) line = token;
      else hardBreak(token);
    } else if (displayWidth(line) + 1 + tokenWidth <= width) {
      line += ` ${token}`;
    } else {
      lines.push(line);
      line = '';
      if (tokenWidth <= width) line = token;
      else hardBreak(token);
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/**
 * Measure-driven greedy word wrap, shared by the PDF text paths (vector fonts
 * and canvas-rendered Unicode). Splits on whitespace when present; a single
 * "word" wider than the line (typical for CJK text, which has no spaces) is
 * broken per character.
 */

/** Wrap `text` into lines of at most `maxWidth` per the `measure` callback. */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  let line = '';

  const push = () => {
    if (line) lines.push(line);
    line = '';
  };

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const trial = line ? `${line} ${word}` : word;
    if (measure(trial) <= maxWidth) {
      line = trial;
      continue;
    }
    push();
    if (measure(word) <= maxWidth) {
      line = word;
      continue;
    }
    // The word alone overflows (CJK run, long URL): break per character.
    for (const ch of word) {
      const t = line + ch;
      if (line && measure(t) > maxWidth) {
        push();
        line = ch;
      } else {
        line = t;
      }
    }
  }
  push();
  return lines.length > 0 ? lines : [''];
}

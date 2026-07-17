import { describe, it, expect } from 'vitest';
import { wrapText } from './text-wrap';

// Width = character count → easy to reason about limits.
const byLength = (s: string) => s.length;

describe('wrapText', () => {
  it('wraps at spaces and never exceeds the width', () => {
    const lines = wrapText('the quick brown fox jumps over the lazy dog', 12, byLength);
    expect(lines.every((l) => l.length <= 12)).toBe(true);
    expect(lines.join(' ')).toBe('the quick brown fox jumps over the lazy dog');
  });

  it('breaks spaceless CJK runs per character', () => {
    const zh = '这些页面包含一个加密文件以带纠错的二维码图像编码';
    const lines = wrapText(zh, 8, byLength);
    expect(lines.every((l) => l.length <= 8)).toBe(true);
    expect(lines.join('')).toBe(zh);
  });

  it('breaks an over-long single word (URL) instead of overflowing', () => {
    const url = 'https://github.com/dlamarre-dev/StegoShard';
    const lines = wrapText(url, 20, byLength);
    expect(lines.every((l) => l.length <= 20)).toBe(true);
    expect(lines.join('')).toBe(url);
  });

  it('keeps astral characters (emoji) intact when char-splitting', () => {
    const lines = wrapText('😀😀😀😀', 4, byLength);
    expect(lines.join('')).toBe('😀😀😀😀');
    for (const l of lines) expect([...l].every((c) => c === '😀')).toBe(true);
  });

  it('handles empty and whitespace-only input', () => {
    expect(wrapText('', 10, byLength)).toEqual(['']);
    expect(wrapText('   ', 10, byLength)).toEqual(['']);
  });
});

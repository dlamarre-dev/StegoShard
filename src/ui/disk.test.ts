import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import { extractZip } from './disk';

const enc = (s: string) => new TextEncoder().encode(s);

describe('extractZip', () => {
  it('keeps image + .key entries and ignores anything else', () => {
    const zip = zipSync({
      'page-01.png': enc('img1'),
      'page-02.jpg': enc('img2'),
      'imagevault.key': enc('KEYDATA'),
      'readme.txt': enc('ignored'),
    });
    const { images, keyBlock } = extractZip(zip);
    expect(images.length).toBe(2);
    expect(keyBlock && new TextDecoder().decode(keyBlock)).toBe('KEYDATA');
  });

  it('works without a .key entry', () => {
    const { images, keyBlock } = extractZip(zipSync({ 'a.png': enc('x') }));
    expect(images.length).toBe(1);
    expect(keyBlock).toBeUndefined();
  });

  it('rejects a zip with too many entries (bomb guard)', () => {
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < 160; i++) entries[`p-${i}.png`] = enc('x');
    expect(() => extractZip(zipSync(entries))).toThrow(/too many/);
  });
});

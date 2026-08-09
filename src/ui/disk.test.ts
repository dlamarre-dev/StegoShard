import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import { MAX_ZIP_ENTRIES, extractZip } from './disk';

const enc = (s: string) => new TextEncoder().encode(s);

describe('extractZip', () => {
  it('keeps image + .key entries and ignores anything else', () => {
    const zip = zipSync({
      'page-01.png': enc('img1'),
      'page-02.jpg': enc('img2'),
      'stegoshard.key': enc('KEYDATA'),
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

  // Straddle the real boundary rather than testing well past it: an off-by-one
  // or a silently widened budget would slip through a loop that only ever
  // builds an archive far larger than the cap.
  const zipOf = (count: number): Uint8Array => {
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < count; i++) entries[`p-${i}.png`] = enc('x');
    return zipSync(entries);
  };

  it('accepts a zip at exactly the entry limit', () => {
    expect(extractZip(zipOf(MAX_ZIP_ENTRIES)).images.length).toBe(MAX_ZIP_ENTRIES);
  });

  it('rejects a zip one entry past the limit (bomb guard)', () => {
    expect(() => extractZip(zipOf(MAX_ZIP_ENTRIES + 1))).toThrow(/too many/);
  });
});

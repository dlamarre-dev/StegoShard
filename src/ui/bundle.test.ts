import { describe, it, expect } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import { packBundle, unpackBundle } from './bundle';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('packBundle / unpackBundle', () => {
  it('round-trips several files', () => {
    const back = unpackBundle(
      packBundle([
        { name: 'notes.txt', bytes: enc('one') },
        { name: 'photo.jpg', bytes: enc('two') },
        { name: 'key.pem', bytes: enc('three') },
      ]),
    );
    expect(back.map((f) => f.name).sort()).toEqual(['key.pem', 'notes.txt', 'photo.jpg']);
    expect(dec(back.find((f) => f.name === 'photo.jpg')!.bytes)).toBe('two');
  });

  it('keeps both files when two share a basename', () => {
    const back = unpackBundle(
      packBundle([
        { name: 'a.txt', bytes: enc('first') },
        { name: 'a.txt', bytes: enc('second') },
      ]),
    );
    expect(back).toHaveLength(2);
    expect(back.map((f) => dec(f.bytes)).sort()).toEqual(['first', 'second']);
  });

  // The archive is decrypted from a vault, but its entry names were chosen by
  // whoever built that vault; a traversal must not reach outside the output dir.
  it('strips path traversal from entry names', () => {
    const back = unpackBundle(
      zipSync({ '../../etc/passwd': enc('nope'), 'sub/dir/ok.txt': enc('yes') }),
    );
    expect(back.map((f) => f.name).sort()).toEqual(['ok.txt', 'passwd']);
    for (const f of back) {
      expect(f.name).not.toContain('/');
      expect(f.name).not.toContain('..');
    }
  });

  it('rejects an archive with nothing readable in it', () => {
    expect(() => unpackBundle(zipSync({}))).toThrow(/no readable entries/);
  });

  it('stores rather than deflates — buildPayload gzips right after', () => {
    const body = enc('x'.repeat(5000));
    const zip = packBundle([{ name: 'a.bin', bytes: body }]);
    expect(zip.length).toBeGreaterThan(body.length);
    expect(dec(unzipSync(zip)['a.bin']!)).toBe(dec(body));
  });
});

describe('bundle resource bounds', () => {
  // The .zip comes out of a decrypted vault, but its contents were chosen by
  // whoever built that vault, the same premise that motivates the traversal
  // guard above, applied to expansion.
  it('refuses an archive that expands past the budget', () => {
    // ~2 MB of zeroes deflates to a few KB: small on the wire, large in memory.
    const bomb = zipSync({ 'big.bin': new Uint8Array(2_000_000) }, { level: 9 });
    expect(bomb.length).toBeLessThan(100_000);
    expect(() => unpackBundle(bomb, { maxEntries: 10, maxTotalBytes: 1000 })).toThrow(
      /expands past/,
    );
  });

  it('refuses an archive with too many entries', () => {
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < 50; i++) entries[`f-${i}.bin`] = enc('x');
    expect(() =>
      unpackBundle(zipSync(entries), { maxEntries: 10, maxTotalBytes: 1 << 20 }),
    ).toThrow(/more than 10 entries/);
  });

  it('still accepts an archive inside the budget', () => {
    const zip = packBundle([{ name: 'a.txt', bytes: enc('small') }]);
    expect(unpackBundle(zip, { maxEntries: 10, maxTotalBytes: 1 << 20 })).toHaveLength(1);
  });

  it('bounds the total across entries, not just each one', () => {
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < 5; i++) entries[`f-${i}.bin`] = new Uint8Array(400);
    expect(() => unpackBundle(zipSync(entries), { maxEntries: 100, maxTotalBytes: 1000 })).toThrow(
      /expands past/,
    );
  });
});

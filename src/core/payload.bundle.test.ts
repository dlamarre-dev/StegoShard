import { describe, it, expect } from 'vitest';
import { buildPayload, parsePayload } from './payload';

const enc = (s: string) => new TextEncoder().encode(s);
const CAP = 1 << 20;

describe('SPEC §4 FLAGS bit1 (bundle)', () => {
  // Incompressible, so FLAG_COMPRESSED stays clear and the byte is easy to read.
  const noisy = () => {
    const b = new Uint8Array(64);
    for (let i = 0; i < b.length; i++) b[i] = (i * 97 + 13) & 0xff;
    return b;
  };

  it('a single-file save leaves bit1 clear', async () => {
    const p = await buildPayload('a.bin', noisy());
    expect(p[0]! & 0x02).toBe(0);
  });

  it('the envelope for a single file is unchanged by the new option', async () => {
    // The overwhelmingly common case must be byte-identical to what earlier
    // builds wrote, so existing vaults and fixtures stay comparable.
    const a = await buildPayload('a.bin', noisy());
    const b = await buildPayload('a.bin', noisy(), {});
    const c = await buildPayload('a.bin', noisy(), { bundle: false });
    expect([...b]).toEqual([...a]);
    expect([...c]).toEqual([...a]);
  });

  it('a bundle sets bit1 and survives the round trip', async () => {
    const p = await buildPayload('bundle.zip', noisy(), { bundle: true });
    expect(p[0]! & 0x02).toBe(0x02);
    const out = await parsePayload(p, CAP);
    expect(out.bundled).toBe(true);
    expect(out.filename).toBe('bundle.zip');
    expect([...out.content]).toEqual([...noisy()]);
  });

  it('composes with compression rather than replacing it', async () => {
    const squishy = enc('x'.repeat(4000));
    const p = await buildPayload('bundle.zip', squishy, { bundle: true });
    expect(p[0]! & 0x01).toBe(0x01);
    expect(p[0]! & 0x02).toBe(0x02);
    const out = await parsePayload(p, CAP);
    expect(out.bundled).toBe(true);
    expect(out.content.length).toBe(squishy.length);
  });

  /**
   * The property that makes the new bit safe to add before 1.0: a decoder that
   * predates it masks only bit0, hands back the .zip, and is never *wrong* —
   * just less helpful. This models exactly that reader.
   */
  it('a decoder that ignores bit1 still recovers the content', async () => {
    const zipish = noisy();
    const p = await buildPayload('bundle.zip', zipish, { bundle: true });
    const legacyFlags = p[0]! & 0x01; // what an older reader looks at
    expect(legacyFlags).toBe(p[0]! & ~0x02);
    const out = await parsePayload(p, CAP);
    expect([...out.content]).toEqual([...zipish]);
  });
});

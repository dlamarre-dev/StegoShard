import { describe, it, expect } from 'vitest';
import { compressOpportunistic, gzipCompress, gzipDecompress } from './compress';

describe('gzip', () => {
  it('round-trips', async () => {
    const data = new TextEncoder().encode('hello '.repeat(100));
    const back = await gzipDecompress(await gzipCompress(data));
    expect([...back]).toEqual([...data]);
  });

  it('compresses repetitive data (and inflates back)', async () => {
    const data = new Uint8Array(1000).fill(7);
    const gz = await gzipCompress(data);
    expect(gz.length).toBeLessThan(data.length);
    expect([...(await gzipDecompress(gz))]).toEqual([...data]);
  });
});

describe('compressOpportunistic', () => {
  it('keeps compression when it helps', async () => {
    const data = new Uint8Array(1000).fill(0);
    const res = await compressOpportunistic(data);
    expect(res.compressed).toBe(true);
    expect(res.data.length).toBeLessThan(data.length);
  });

  it('aborts decompression past the byte cap (gzip-bomb guard)', async () => {
    const gz = await gzipCompress(new Uint8Array(50_000).fill(7));
    await expect(gzipDecompress(gz, 1000)).rejects.toThrow(/exceeds/);
  });

  it('skips compression for incompressible data', async () => {
    // Pseudo-random, deterministic bytes: gzip cannot shrink these.
    let s = 12345;
    const data = Uint8Array.from({ length: 512 }, () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return (s >> 16) & 0xff;
    });
    const res = await compressOpportunistic(data);
    expect(res.compressed).toBe(false);
    expect([...res.data]).toEqual([...data]);
  });
});

/** Error paths for payload.ts: name-length, truncation, gzip-bomb cap. */
import { describe, it, expect } from 'vitest';
import { buildPayload, parsePayload } from './payload';

describe('buildPayload guards', () => {
  it('rejects a filename longer than 65535 bytes', async () => {
    await expect(buildPayload('a'.repeat(70000), new Uint8Array(1))).rejects.toThrow(
      /filename too long/,
    );
  });
});

describe('parsePayload guards', () => {
  it('rejects a too-short envelope', async () => {
    await expect(parsePayload(new Uint8Array(2), 1024)).rejects.toThrow(/too short/);
  });

  it('rejects a truncated filename', async () => {
    // flags=0, nameLen=0xffff, but no name bytes follow.
    const bytes = Uint8Array.of(0, 0xff, 0xff);
    await expect(parsePayload(bytes, 1024)).rejects.toThrow(/truncated filename/);
  });

  it('round-trips uncompressed content', async () => {
    const content = globalThis.crypto.getRandomValues(new Uint8Array(64)); // incompressible
    const env = await buildPayload('n.bin', content);
    const out = await parsePayload(env, 1024);
    expect(out.filename).toBe('n.bin');
    expect([...out.content]).toEqual([...content]);
  });

  it('enforces the decompression (gzip-bomb) cap on compressed content', async () => {
    const bomb = new Uint8Array(200_000); // all zeros → compresses tiny, inflates to 200 KB
    const env = await buildPayload('big.txt', bomb);
    // Envelope must actually be compressed for the cap to apply.
    expect(env[0]! & 0x01).toBe(1);
    await expect(parsePayload(env, 1000)).rejects.toBeTruthy();
    // With a generous cap it restores.
    const ok = await parsePayload(env, 300_000);
    expect(ok.content.length).toBe(200_000);
  });
});

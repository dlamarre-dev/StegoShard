import { describe, it, expect } from 'vitest';
import { buildPayload, parsePayload } from './payload';

describe('payload envelope', () => {
  it('round-trips filename and content', async () => {
    const content = new TextEncoder().encode('secret contents here');
    const env = await buildPayload('notes.txt', content);
    const parsed = await parsePayload(env, 1024 * 1024);
    expect(parsed.filename).toBe('notes.txt');
    expect([...parsed.content]).toEqual([...content]);
  });

  it('preserves a Unicode filename', async () => {
    const env = await buildPayload('clés-privées 🔑.env', new Uint8Array([1, 2, 3]));
    expect((await parsePayload(env, 1024 * 1024)).filename).toBe('clés-privées 🔑.env');
  });

  it('compresses repetitive content transparently', async () => {
    const content = new Uint8Array(2000).fill(65);
    const env = await buildPayload('big.txt', content);
    // Envelope should be much smaller than the raw content when compressed.
    expect(env.length).toBeLessThan(content.length);
    expect([...(await parsePayload(env, 1024 * 1024)).content]).toEqual([...content]);
  });

  it('handles empty content', async () => {
    const env = await buildPayload('empty', new Uint8Array(0));
    const parsed = await parsePayload(env, 1024 * 1024);
    expect(parsed.filename).toBe('empty');
    expect(parsed.content.length).toBe(0);
  });
});

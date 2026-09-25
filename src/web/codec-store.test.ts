/**
 * The codec preference survives a browser that blocks site data.
 *
 * Found in review: the read ran bare while `main.ts` loaded, and `localStorage`
 * throws when storage is blocked, which stopped the web app before it showed
 * anything.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { storeCodec, storedCodec } from './codec-store';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('codec store', () => {
  it('falls back to color and ignores writes when storage throws', () => {
    const blocked = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });
    expect(storedCodec()).toBe('color');
    expect(() => storeCodec('qr')).not.toThrow();
  });

  it('remembers the choice when storage works', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    });
    expect(storedCodec()).toBe('color');
    storeCodec('qr');
    expect(storedCodec()).toBe('qr');
  });
});

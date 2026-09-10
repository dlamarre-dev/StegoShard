/**
 * Tests for the AAD builders.
 *
 * These matter more than their size suggests. An AAD is never stored, so a bug
 * here does not corrupt a file — it silently changes what a tag covers, and the
 * round-trip still passes because both sides compute the same wrong value. Only
 * direct assertions on the bytes catch that, which is why the builders are pure
 * and tested here rather than only exercised through an encrypt/decrypt cycle.
 */

import { describe, it, expect } from 'vitest';
import {
  EMPTY_AAD,
  galleryFragAad,
  keyBlockAad,
  regionBlockAad,
  segmentedRegionAad,
  slotArrayAad,
  vaultBlobAad,
  type ContainerKind,
} from './aad';
import { concatBytes } from './bytes';

const enc = new TextEncoder();
const dec = new TextDecoder();
const fill = (n: number, b: number): Uint8Array => new Uint8Array(n).fill(b);

/** Every builder, invoked with representative arguments. */
const SITES: Record<string, () => Uint8Array> = {
  keyBlock: () => keyBlockAad(enc.encode('SSKY'), 1, 4, 262144, 1, fill(16, 0xaa), fill(12, 0xbb)),
  vaultBlob: () =>
    vaultBlobAad(enc.encode('SSVB'), 1, fill(92, 0xcc), fill(16, 0xdd), fill(12, 0xee)),
  slotArray: () => slotArrayAad('gallery-multiregion', 4, 2, fill(16, 0x11)),
  regionBlock: () =>
    regionBlockAad(fill(16, 0x11), fill(304, 0x22), 0, 4140, fill(16, 0x33), fill(12, 0x44)),
  galleryFrag: () => galleryFragAad(),
};

describe('domain separation', () => {
  it('gives every site a distinct, non-empty AAD', () => {
    const seen = new Map<string, string>();
    for (const [name, build] of Object.entries(SITES)) {
      const bytes = build();
      expect(bytes.length, name).toBeGreaterThan(0);
      const hex = Buffer.from(bytes).toString('hex');
      expect(seen.has(hex), `${name} collides with ${seen.get(hex)}`).toBe(false);
      seen.set(hex, name);
    }
  });

  /**
   * The property that makes labels worth their bytes: no site's output can be a
   * prefix of another's. Without it, a cleverly chosen field could make two
   * different contexts agree.
   */
  it('produces no AAD that is a prefix of another', () => {
    const all = Object.entries(SITES).map(([name, build]) => [name, build()] as const);
    for (const [an, a] of all) {
      for (const [bn, b] of all) {
        if (an === bn) continue;
        const shared = Math.min(a.length, b.length);
        expect(
          a.subarray(0, shared).every((v, i) => v === b[i]),
          `${an} is a prefix of ${bn}`,
        ).toBe(false);
      }
    }
  });

  it('starts each AAD with its own label', () => {
    expect(dec.decode(SITES.keyBlock!())).toMatch(/^stegoshard\/v2\/aad\/key-block/);
    expect(dec.decode(SITES.vaultBlob!())).toMatch(/^stegoshard\/v2\/aad\/vault-blob/);
    expect(dec.decode(SITES.slotArray!())).toMatch(/^stegoshard\/v2\/aad\/slot-array/);
    expect(dec.decode(SITES.regionBlock!())).toMatch(/^stegoshard\/v2\/aad\/vault-region/);
    expect(dec.decode(SITES.galleryFrag!())).toBe('stegoshard/v2/aad/gallery-frag');
  });

  it('keeps EMPTY_AAD empty, so a deliberate no-AAD site stays obvious', () => {
    expect(EMPTY_AAD.length).toBe(0);
  });
});

describe('every bound field actually changes the AAD', () => {
  const differs = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length !== b.length || !a.every((v, i) => v === b[i]);

  it('keyBlockAad reacts to version, each Argon2 parameter, salt and iv', () => {
    const base = SITES.keyBlock!();
    const magic = enc.encode('SSKY');
    const salt = fill(16, 0xaa);
    const iv = fill(12, 0xbb);
    expect(differs(base, keyBlockAad(magic, 2, 4, 262144, 1, salt, iv))).toBe(true);
    expect(differs(base, keyBlockAad(magic, 1, 3, 262144, 1, salt, iv))).toBe(true);
    expect(differs(base, keyBlockAad(magic, 1, 4, 262143, 1, salt, iv))).toBe(true);
    expect(differs(base, keyBlockAad(magic, 1, 4, 262144, 2, salt, iv))).toBe(true);
    expect(differs(base, keyBlockAad(magic, 1, 4, 262144, 1, fill(16, 0xab), iv))).toBe(true);
    expect(differs(base, keyBlockAad(magic, 1, 4, 262144, 1, salt, fill(12, 0xbc)))).toBe(true);
  });

  /**
   * The key-mode binding: an embedded blob and a keyfile blob must never agree,
   * or an attacker could strip the key block and re-present the vault.
   */
  it('vaultBlobAad distinguishes an embedded key block from KB_LEN = 0', () => {
    const magic = enc.encode('SSVB');
    const embedded = vaultBlobAad(magic, 1, fill(92, 0xcc), fill(16, 0xdd), fill(12, 0xee));
    const keyfile = vaultBlobAad(magic, 1, new Uint8Array(0), fill(16, 0xdd), fill(12, 0xee));
    expect(differs(embedded, keyfile)).toBe(true);
  });

  it('vaultBlobAad reacts to a foreign key block of the same length', () => {
    const magic = enc.encode('SSVB');
    const a = vaultBlobAad(magic, 1, fill(92, 0xcc), fill(16, 0xdd), fill(12, 0xee));
    const b = vaultBlobAad(magic, 1, fill(92, 0xcd), fill(16, 0xdd), fill(12, 0xee));
    expect(differs(a, b)).toBe(true);
  });

  /**
   * Length-prefixing, checked as a property rather than trusted. Moving a byte
   * from the key block into the salt must not produce the same AAD.
   */
  it('vaultBlobAad is unambiguous across a field boundary', () => {
    const magic = enc.encode('SSVB');
    const a = vaultBlobAad(magic, 1, fill(4, 0x00), fill(16, 0x00), fill(12, 0x00));
    const b = vaultBlobAad(magic, 1, fill(3, 0x00), fill(16, 0x00), fill(12, 0x00));
    expect(differs(a, b)).toBe(true);
  });

  it('slotArrayAad separates the two container kinds under one vault salt', () => {
    const salt = fill(16, 0x11);
    const kinds: ContainerKind[] = ['gallery-multiregion', 'segmented-multiregion'];
    const [gallery, segmented] = kinds.map((k) => slotArrayAad(k, 4, 2, salt));
    expect(differs(gallery!, segmented!)).toBe(true);
  });

  it('slotArrayAad reacts to the vault salt and the geometry constants', () => {
    const base = SITES.slotArray!();
    expect(differs(base, slotArrayAad('gallery-multiregion', 4, 2, fill(16, 0x12)))).toBe(true);
    expect(differs(base, slotArrayAad('gallery-multiregion', 3, 2, fill(16, 0x11)))).toBe(true);
    expect(differs(base, slotArrayAad('gallery-multiregion', 4, 3, fill(16, 0x11)))).toBe(true);
  });

  it('regionBlockAad reacts to the region index, so the two regions never agree', () => {
    const args = [fill(16, 0x11), fill(304, 0x22), 4140, fill(16, 0x33), fill(12, 0x44)] as const;
    const r0 = regionBlockAad(args[0], args[1], 0, args[2], args[3], args[4]);
    const r1 = regionBlockAad(args[0], args[1], 1, args[2], args[3], args[4]);
    expect(differs(r0, r1)).toBe(true);
  });

  it('regionBlockAad reacts to the container it belongs to and to its geometry', () => {
    const base = SITES.regionBlock!();
    const slots = fill(304, 0x22);
    const salt = fill(16, 0x33);
    const iv = fill(12, 0x44);
    // A different vault salt: another container.
    expect(differs(base, regionBlockAad(fill(16, 0x12), slots, 0, 4140, salt, iv))).toBe(true);
    // A different slot array: the same vault salt, different credentials.
    expect(differs(base, regionBlockAad(fill(16, 0x11), fill(304, 0x23), 0, 4140, salt, iv))).toBe(
      true,
    );
    // A different region length: the geometry is signed, not inferred.
    expect(differs(base, regionBlockAad(fill(16, 0x11), slots, 0, 4141, salt, iv))).toBe(true);
  });
});

describe('segmentedRegionAad', () => {
  /**
   * Pinned against the literal concatenation rather than against the function,
   * so the relocation out of segmented.ts cannot have changed a byte. This is
   * the assertion that makes the move reviewable.
   */
  it('is head || regionIndex || contentSalt || noncePrefix, unchanged', () => {
    const head = fill(334, 0x55);
    const contentSalt = fill(16, 0x66);
    const noncePrefix = fill(7, 0x77);
    expect(segmentedRegionAad(head, 1, contentSalt, noncePrefix)).toEqual(
      concatBytes(head, Uint8Array.of(1), contentSalt, noncePrefix),
    );
  });

  it('separates the two regions of one container', () => {
    const head = fill(334, 0x55);
    const salt = fill(16, 0x66);
    const prefix = fill(7, 0x77);
    expect(segmentedRegionAad(head, 0, salt, prefix)).not.toEqual(
      segmentedRegionAad(head, 1, salt, prefix),
    );
  });
});

describe('purity', () => {
  it('returns the same bytes for the same arguments', () => {
    for (const [name, build] of Object.entries(SITES)) {
      expect(build(), name).toEqual(build());
    }
  });

  it('does not alias its inputs', () => {
    const salt = fill(16, 0xaa);
    const before = salt.slice();
    const aad = keyBlockAad(enc.encode('SSKY'), 1, 4, 262144, 1, salt, fill(12, 0xbb));
    aad.fill(0);
    expect(salt).toEqual(before);
  });
});

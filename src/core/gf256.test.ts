import { describe, it, expect } from 'vitest';
import { gfAdd, gfMul, gfInv, gfDiv, FIELD_POLY, FIELD_GENERATOR } from './gf256';

describe('GF(256) arithmetic', () => {
  it('addition is XOR and self-inverse', () => {
    expect(gfAdd(0x53, 0xca)).toBe(0x53 ^ 0xca);
    expect(gfAdd(0xff, 0xff)).toBe(0);
  });

  it('multiplication by 0 and 1', () => {
    for (let a = 0; a < 256; a++) {
      expect(gfMul(a, 0)).toBe(0);
      expect(gfMul(a, 1)).toBe(a);
    }
  });

  it('is commutative', () => {
    expect(gfMul(0x57, 0x83)).toBe(gfMul(0x83, 0x57));
  });

  it('pins the field parameters', () => {
    // These two constants decide every byte the erasure coder produces, and
    // nothing else in this file would notice if they changed: encoding and
    // decoding with the same wrong field round-trips perfectly. Measured, not
    // assumed: swapping POLY to 0x12D, which is also primitive with generator 2,
    // leaves all 620 tests of this suite green, and leaves the Python
    // conformance suite green too once its fixtures are regenerated, which is
    // what CI does on every run.
    expect(FIELD_POLY).toBe(0x11d);
    expect(FIELD_GENERATOR).toBe(0x02);
  });

  it('matches a known product of this field, not the AES one', () => {
    // 0x57 * 0x13 is the classic worked example, but the published answer 0xFE
    // belongs to the AES field 0x11B. This project reduces by 0x11D, where the
    // same product is 0xE0. An earlier version of this test carried the AES
    // value in its name and asserted commutativity in its body, which detected
    // nothing at all.
    expect(gfMul(0x57, 0x13)).toBe(0xe0);
  });

  it('inverse: a * a^-1 === 1 for every non-zero element', () => {
    for (let a = 1; a < 256; a++) {
      expect(gfMul(a, gfInv(a))).toBe(1);
    }
  });

  it('division is the inverse of multiplication', () => {
    for (let a = 0; a < 256; a++) {
      for (const b of [1, 2, 0x53, 0xff]) {
        expect(gfDiv(gfMul(a, b), b)).toBe(a);
      }
    }
  });

  it('rejects inverse/division by zero', () => {
    expect(() => gfInv(0)).toThrow(RangeError);
    expect(() => gfDiv(1, 0)).toThrow(RangeError);
  });
});

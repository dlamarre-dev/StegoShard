/** Error paths + base64 helpers for bytes.ts (coverage of the guard branches). */
import { describe, it, expect } from 'vitest';
import { fromBase64, readU16, readU32, toBase64, writeU16, writeU32 } from './bytes';

describe('base64 round-trip', () => {
  it('round-trips arbitrary bytes', () => {
    const b = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect([...fromBase64(toBase64(b))]).toEqual([...b]);
    expect(toBase64(new Uint8Array(0))).toBe('');
    expect(fromBase64('').length).toBe(0);
  });
});

describe('u16/u32 bounds', () => {
  it('writeU16 rejects out-of-range values', () => {
    const buf = new Uint8Array(2);
    expect(() => writeU16(buf, 0, -1)).toThrow(/u16 out of range/);
    expect(() => writeU16(buf, 0, 0x10000)).toThrow(/u16 out of range/);
  });
  it('readU16 rejects out-of-bounds reads', () => {
    expect(() => readU16(new Uint8Array(1), 0)).toThrow(/u16 read out of bounds/);
  });
  it('writeU32 rejects out-of-range values', () => {
    const buf = new Uint8Array(4);
    expect(() => writeU32(buf, 0, -1)).toThrow(/u32 out of range/);
    expect(() => writeU32(buf, 0, 0x1_0000_0000)).toThrow(/u32 out of range/);
  });
  it('readU32 rejects out-of-bounds reads', () => {
    expect(() => readU32(new Uint8Array(3), 0)).toThrow(/u32 read out of bounds/);
  });
  it('writeU32/readU32 round-trip a full-range value', () => {
    const buf = new Uint8Array(4);
    writeU32(buf, 0, 0xdeadbeef);
    expect(readU32(buf, 0)).toBe(0xdeadbeef);
  });
});

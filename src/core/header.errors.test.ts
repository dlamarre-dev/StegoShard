/** Guard branches for header.ts (encode/decode/*ImagePayload). */
import { describe, it, expect } from 'vitest';
import {
  type Header,
  HEADER_LEN,
  decodeHeader,
  decodeImagePayload,
  encodeHeader,
  encodeImagePayload,
} from './header';

function mkHeader(over: Partial<Header> = {}): Header {
  return {
    version: 1,
    setId: new Uint8Array(8),
    shardIndex: 0,
    k: 2,
    m: 2,
    codecId: 0,
    profile: 0,
    shardLen: 10,
    blobLen: 15, // <= k*shardLen
    hash: new Uint8Array(4),
    ...over,
  };
}

describe('encodeHeader guards', () => {
  it('rejects a bad setId length', () => {
    expect(() => encodeHeader(mkHeader({ setId: new Uint8Array(7) }))).toThrow(/setId length/);
  });
  it('rejects a bad hash length', () => {
    expect(() => encodeHeader(mkHeader({ hash: new Uint8Array(3) }))).toThrow(/hash length/);
  });
  it('round-trips a valid header', () => {
    const h = mkHeader({ shardIndex: 3 });
    const decoded = decodeHeader(encodeHeader(h));
    expect(decoded.k).toBe(2);
    expect(decoded.shardIndex).toBe(3);
  });
});

describe('decodeHeader guards', () => {
  it('rejects a too-short buffer', () => {
    expect(() => decodeHeader(new Uint8Array(HEADER_LEN - 1))).toThrow(/too short/);
  });
  it('rejects bad magic', () => {
    const bytes = encodeHeader(mkHeader());
    bytes[0] = bytes[0]! ^ 0xff;
    expect(() => decodeHeader(bytes)).toThrow(/bad magic/);
  });
  it('rejects an unsupported version', () => {
    expect(() => decodeHeader(encodeHeader(mkHeader({ version: 2 })))).toThrow(/unsupported version/);
  });
  it('rejects invalid k/m', () => {
    expect(() => decodeHeader(encodeHeader(mkHeader({ k: 0 })))).toThrow(/invalid k\/m/);
    expect(() => decodeHeader(encodeHeader(mkHeader({ k: 200, m: 100 })))).toThrow(/invalid k\/m/);
  });
  it('rejects a shard index out of range', () => {
    expect(() => decodeHeader(encodeHeader(mkHeader({ shardIndex: 4 })))).toThrow(
      /shard index .* out of range/,
    );
  });
  it('rejects an invalid shard length', () => {
    expect(() => decodeHeader(encodeHeader(mkHeader({ shardLen: 0, blobLen: 1 })))).toThrow(
      /invalid shard length/,
    );
  });
  it('rejects an invalid blob length', () => {
    expect(() => decodeHeader(encodeHeader(mkHeader({ blobLen: 0 })))).toThrow(/invalid blob length/);
    expect(() => decodeHeader(encodeHeader(mkHeader({ blobLen: 999 })))).toThrow(
      /invalid blob length/,
    );
  });
});

describe('image payload guards', () => {
  it('encodeImagePayload rejects a shard-length mismatch', () => {
    expect(() => encodeImagePayload(mkHeader({ shardLen: 10 }), new Uint8Array(5))).toThrow(
      /shard length mismatch/,
    );
  });
  it('decodeImagePayload rejects a truncated shard', () => {
    const payload = encodeImagePayload(mkHeader({ shardLen: 10 }), new Uint8Array(10));
    expect(() => decodeImagePayload(payload.slice(0, HEADER_LEN + 5))).toThrow(/truncated shard/);
  });
});

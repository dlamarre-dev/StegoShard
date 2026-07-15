import { describe, it, expect } from 'vitest';
import {
  CODEC_QR_GRID,
  FORMAT_VERSION,
  type Header,
  HEADER_LEN,
  PROFILE_DISK,
  decodeHeader,
  decodeImagePayload,
  encodeHeader,
  encodeImagePayload,
} from './header';

function sampleHeader(overrides: Partial<Header> = {}): Header {
  return {
    version: FORMAT_VERSION,
    setId: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
    shardIndex: 3,
    k: 4,
    m: 2,
    codecId: CODEC_QR_GRID,
    profile: PROFILE_DISK,
    shardLen: 100,
    blobLen: 380,
    hash: Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
    ...overrides,
  };
}

describe('header encode/decode', () => {
  it('is exactly HEADER_LEN bytes', () => {
    expect(encodeHeader(sampleHeader()).length).toBe(HEADER_LEN);
  });

  it('round-trips every field', () => {
    const h = sampleHeader();
    const decoded = decodeHeader(encodeHeader(h));
    expect(decoded).toEqual(h);
  });

  it('rejects a bad magic', () => {
    const bytes = encodeHeader(sampleHeader());
    bytes[0] = bytes[0]! ^ 0xff;
    expect(() => decodeHeader(bytes)).toThrow(/magic/);
  });

  it('rejects an unknown version', () => {
    const bytes = encodeHeader(sampleHeader({ version: 99 }));
    expect(() => decodeHeader(bytes)).toThrow(/version/);
  });

  it('rejects out-of-range k/m', () => {
    const bytes = encodeHeader(sampleHeader({ k: 200, m: 100 })); // k+m > 256
    expect(() => decodeHeader(bytes)).toThrow(/k\/m/);
  });

  it('rejects a blob length larger than k*shardLen', () => {
    const bytes = encodeHeader(sampleHeader({ k: 4, shardLen: 100, blobLen: 999999 }));
    expect(() => decodeHeader(bytes)).toThrow(/blob length/);
  });
});

describe('image payload (header + shard)', () => {
  it('round-trips header and shard bytes', () => {
    const h = sampleHeader({ shardLen: 5, blobLen: 5 });
    const shard = Uint8Array.from([10, 20, 30, 40, 50]);
    const { header, shard: out } = decodeImagePayload(encodeImagePayload(h, shard));
    expect(header.shardIndex).toBe(3);
    expect([...out]).toEqual([...shard]);
  });

  it('rejects a shard whose length disagrees with the header', () => {
    const h = sampleHeader({ shardLen: 5 });
    expect(() => encodeImagePayload(h, new Uint8Array(4))).toThrow(/length/);
  });
});

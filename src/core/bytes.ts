/**
 * Small, dependency-free byte helpers shared across the core (crypto, codec,
 * erasure coding, payload). Kept pure and browser-agnostic so they run
 * unchanged under Node (tests), the service worker, and browser pages.
 */

/** Lowercase hex string for a byte array (e.g. for set-id filenames). */
export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Base64-encode a byte array (for persisting small blobs like the key block). */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Decode a base64 string produced by toBase64. */
export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Concatenate byte arrays into a single Uint8Array. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Write a 16-bit unsigned integer, big-endian, at the given offset. */
export function writeU16(buf: Uint8Array, offset: number, value: number): void {
  if (value < 0 || value > 0xffff) throw new RangeError(`u16 out of range: ${value}`);
  buf[offset] = (value >>> 8) & 0xff;
  buf[offset + 1] = value & 0xff;
}

/** Read a 16-bit unsigned integer, big-endian, at the given offset. */
export function readU16(buf: Uint8Array, offset: number): number {
  const hi = buf[offset];
  const lo = buf[offset + 1];
  if (hi === undefined || lo === undefined) throw new RangeError('u16 read out of bounds');
  return (hi << 8) | lo;
}

/** Write a 32-bit unsigned integer, big-endian, at the given offset. */
export function writeU32(buf: Uint8Array, offset: number, value: number): void {
  if (value < 0 || value > 0xffffffff) throw new RangeError(`u32 out of range: ${value}`);
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

/** Read a 32-bit unsigned integer, big-endian, at the given offset. */
export function readU32(buf: Uint8Array, offset: number): number {
  const b0 = buf[offset];
  const b1 = buf[offset + 1];
  const b2 = buf[offset + 2];
  const b3 = buf[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
    throw new RangeError('u32 read out of bounds');
  }
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
}

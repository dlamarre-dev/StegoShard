/**
 * CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320), the same function as
 * zlib's `crc32`, so the Python reference decoder gets it from the standard
 * library for free.
 *
 * Used by the color-grid codec (SPEC §2.2) to tell a good block from a damaged
 * one. The Reed-Solomon layer in reed-solomon.ts is an *erasure* code: it can
 * rebuild blocks it knows are missing, but it cannot find the bad ones by
 * itself. The CRC is what turns a corrupt block into a known erasure.
 *
 * This is an integrity check against accidental damage, never a security
 * primitive; authenticity comes from AES-GCM (SPEC §5).
 */

const TABLE = /* @__PURE__ */ (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32 of a byte range, as an unsigned 32-bit number. */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

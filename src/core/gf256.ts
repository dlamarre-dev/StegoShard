/**
 * Arithmetic over the Galois field GF(2^8), the field used by the Reed-Solomon
 * erasure coding (see reed-solomon.ts) and specified in SPEC.md.
 *
 * Field parameters (frozen; the Python reference decoder must match):
 *   - reducing polynomial: 0x11D  (x^8 + x^4 + x^3 + x^2 + 1)
 *   - generator / primitive element: 0x02
 *
 * Multiplication and division use precomputed exp/log tables so field ops are
 * O(1) table lookups.
 */

const POLY = 0x11d;
const GENERATOR = 0x02;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // Multiply x by the generator in GF(2^8).
    x = mulNoTable(x, GENERATOR);
  }
  // Duplicate the cycle so exp[i + 255] === exp[i]; lets callers add logs
  // without a modulo.
  for (let i = 255; i < 512; i++) {
    EXP[i] = EXP[i - 255]!;
  }
})();

/** Carry-less multiply with polynomial reduction; used only to seed tables. */
function mulNoTable(a: number, b: number): number {
  let result = 0;
  let aa = a;
  let bb = b;
  while (bb > 0) {
    if (bb & 1) result ^= aa;
    bb >>= 1;
    aa <<= 1;
    if (aa & 0x100) aa ^= POLY;
  }
  return result & 0xff;
}

/** Addition in GF(2^8) is XOR (same as subtraction). */
export function gfAdd(a: number, b: number): number {
  return (a ^ b) & 0xff;
}

/** Multiplication in GF(2^8). */
export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** Multiplicative inverse in GF(2^8); throws for 0 (no inverse). */
export function gfInv(a: number): number {
  if (a === 0) throw new RangeError('GF(256): 0 has no multiplicative inverse');
  return EXP[255 - LOG[a]!]!;
}

/** Division in GF(2^8); throws when dividing by 0. */
export function gfDiv(a: number, b: number): number {
  if (b === 0) throw new RangeError('GF(256): division by zero');
  if (a === 0) return 0;
  return EXP[(LOG[a]! - LOG[b]! + 255) % 255]!;
}

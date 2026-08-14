/**
 * Dump the TypeScript GF(2^8) field to JSON so tests/erasure can compare it,
 * exhaustively, against an independent implementation.
 *
 * Why a dump and not a bridge. tests/compliance keeps a long-lived Node process
 * (scripts/crypto-bridge.ts) because the CAVP set is 7,875 vectors per direction
 * and spawning Node per vector would cost tens of minutes. Here the whole field
 * is 65,536 products, and they can be handed over in one call, so this follows
 * the simpler pattern of scripts/gen-stego-samples.ts instead: run once, write a
 * file, let pytest read it.
 *
 * Everything below is derived through the module's public API. The exp/log
 * tables are rebuilt by repeated multiplication rather than read out of the
 * module, so what gets compared is what callers actually see. A private table
 * that disagreed with gfMul would be invisible to callers and is not what this
 * measures.
 *
 * Run with: npx tsx scripts/dump-gf-tables.ts <output.json>
 */

import { writeFileSync } from 'node:fs';
import { gfMul, gfInv, gfDiv, FIELD_POLY, FIELD_GENERATOR } from '../src/core/gf256';

function main(): void {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: tsx scripts/dump-gf-tables.ts <output.json>');
    process.exit(2);
  }

  // All 65,536 products, row-major: mul[a * 256 + b] === gfMul(a, b).
  const mul = new Uint8Array(256 * 256);
  for (let a = 0; a < 256; a++) {
    for (let b = 0; b < 256; b++) {
      mul[a * 256 + b] = gfMul(a, b);
    }
  }

  // All 65,280 quotients with a non-zero divisor, row-major over b in 1..255:
  // div[a * 255 + (b - 1)] === gfDiv(a, b).
  const div = new Uint8Array(256 * 255);
  for (let a = 0; a < 256; a++) {
    for (let b = 1; b < 256; b++) {
      div[a * 255 + (b - 1)] = gfDiv(a, b);
    }
  }

  // inv[a - 1] === gfInv(a) for a in 1..255. Zero has no inverse and throws.
  const inv = new Uint8Array(255);
  for (let a = 1; a < 256; a++) {
    inv[a - 1] = gfInv(a);
  }

  // exp[i] = g^i, built with the public multiply rather than read from the
  // module's own table. log is its inverse; log[0] stays 0 and is never a valid
  // input, matching the convention in gf256.ts.
  const exp = new Uint8Array(255);
  const log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x = gfMul(x, FIELD_GENERATOR);
  }

  const hex = (a: Uint8Array): string => Buffer.from(a).toString('hex');
  writeFileSync(
    out,
    JSON.stringify({
      poly: FIELD_POLY,
      generator: FIELD_GENERATOR,
      mul: hex(mul),
      div: hex(div),
      inv: hex(inv),
      exp: hex(exp),
      log: hex(log),
    }) + '\n',
  );
  console.log(
    `wrote ${out}: poly=0x${FIELD_POLY.toString(16)} generator=0x${FIELD_GENERATOR.toString(16)}`,
  );
}

main();

/**
 * Generate the sample images shown in the README — one per output form, using
 * the production pipeline so they are exactly what the tool writes.
 *
 * Run with: npm run samples
 *
 * The two PNGs come out complete. The paper sample is emitted as a real PDF;
 * turning its first vault page into `sample-paper.png` needs a PDF rasterizer,
 * which the project does not depend on. Any one will do, e.g.:
 *
 *   pdftoppm -png -r 110 -f 2 -l 2 docs/images/sample-paper.pdf docs/images/page
 *
 * (page 1 is the instruction sheet, so the vault page is `-f 2`.)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CODEC_COLOR_GRID,
  CODEC_QR_GRID,
  DEFAULT_ARGON2,
  PROFILE_DISK,
  PROFILE_PAPER,
  codecName,
  createKeyBlock,
  drawBrandBand,
  exportVault,
  getCodec,
  recoveryLines,
  serializeKeyBlock,
  type VaultKey,
} from '../src/core/index';
import { imageDataToPng } from '../src/cli/node-image-io';
import { buildCliPaperPdf } from '../src/cli/paper';

const OUT = resolve(process.cwd(), 'docs/images');

const PASSWORD = 'correct horse battery staple';
const FILENAME = 'wallet-backup.dat';
const TITLE = 'WALLET BACKUP';
const DATE = '2026-08-02';

/** A deterministic stand-in for a real secret. */
function pseudoRandom(len: number, seed: number): Uint8Array {
  let s = seed >>> 0;
  return Uint8Array.from({ length: len }, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 24) & 0xff;
  });
}

async function makeKey(): Promise<VaultKey> {
  const { dek, block } = await createKeyBlock(PASSWORD, DEFAULT_ARGON2);
  return { dek, keyBlock: serializeKeyBlock(block) };
}

/** Render the first image of a disk save, branded exactly as the apps write it. */
async function sampleImage(name: string, codecId: number, content: Uint8Array): Promise<number> {
  const key = await makeKey();
  const { imagePayloads } = await exportVault(FILENAME, content, key, {
    profile: PROFILE_DISK,
    codecId,
  });
  const codec = getCodec(codecId);
  const total = imagePayloads.length;
  const img = drawBrandBand(codec.encode(imagePayloads[0]!, PROFILE_DISK), {
    recovery: recoveryLines(codecName(codecId)),
    lines: [TITLE, DATE, `1 / ${total}`],
  });
  writeFileSync(resolve(OUT, `${name}.png`), imageDataToPng(img));
  console.log(`${name}.png — ${img.width}x${img.height} px, image 1 of ${total}`);
  return total;
}

async function samplePaper(content: Uint8Array): Promise<void> {
  const key = await makeKey();
  const { imagePayloads } = await exportVault(FILENAME, content, key, {
    profile: PROFILE_PAPER,
    codecId: CODEC_QR_GRID,
  });
  const codec = getCodec(CODEC_QR_GRID);
  const built = await buildCliPaperPdf(
    imagePayloads,
    (p) => codec.encode(p, PROFILE_PAPER),
    imageDataToPng,
    { title: TITLE, date: DATE, locale: 'en', includeInstructions: true },
  );
  writeFileSync(resolve(OUT, 'sample-paper.pdf'), built.pdf);
  console.log(
    `sample-paper.pdf — ${imagePayloads.length} vault page(s) + 1 instruction sheet\n` +
      '  rasterize page 2 to sample-paper.png (see the header comment)',
  );
}

mkdirSync(OUT, { recursive: true });

// One secret, both codecs, so the counts are directly comparable.
const content = pseudoRandom(40_000, 4242);
const color = await sampleImage('sample-color-grid', CODEC_COLOR_GRID, content);
const qr = await sampleImage('sample-qr-grid', CODEC_QR_GRID, content);
console.log(`\n${content.length} bytes: ${color} colour images vs ${qr} QR images`);

// Paper is capped far lower per page (767 bytes of shard), so it gets a much
// smaller secret — enough to show the page furniture without committing a
// twenty-page PDF to the repo.
await samplePaper(pseudoRandom(600, 77));
console.log(`\nsamples written to ${OUT}`);

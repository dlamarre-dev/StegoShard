/**
 * Generate conformance fixtures for the Python reference decoder.
 *
 * The extension's own core encodes a file into image payloads and renders them
 * to PNGs (exactly the QR-grid codec output), alongside a manifest and the
 * expected content. The Python decoder then reads these back and must recover
 * the original file — proving the two implementations agree on the format.
 *
 * Run with: npm run fixtures -- <output-dir>
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import {
  createKeyBlock,
  DEFAULT_ARGON2,
  embedKeyBlockStego,
  embedKeyBlockStegoJpeg,
  serializeKeyBlock,
  exportVault,
  getCodec,
  decodeHeader,
  PROFILE_DISK,
  type KeyMode,
  type VaultKey,
} from '../src/core/index';

const outRoot = process.argv[2] ?? '';
if (!outRoot) {
  console.error('usage: tsx scripts/gen-fixtures.ts <output-dir>');
  process.exit(2);
}

// Cheap Argon2 params keep fixture generation fast; the real params travel in
// the key block, so the decoder derives with whatever is stored here.
const ARGON2 = { iterations: 1, memoryKiB: 256, parallelism: 1 };
const PASSWORD = 'correct horse battery staple';
const FILENAME = 'secret-notes.txt';

function pseudoRandom(len: number, seed: number): Uint8Array {
  let s = seed >>> 0;
  return Uint8Array.from({ length: len }, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 24) & 0xff;
  });
}

function writePng(path: string, img: { data: Uint8ClampedArray; width: number; height: number }) {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  writeFileSync(path, PNG.sync.write(png));
}

async function makeKey(): Promise<VaultKey> {
  const { dek, block } = await createKeyBlock(PASSWORD, ARGON2);
  return { dek, keyBlock: serializeKeyBlock(block) };
}

/** A deterministic textured baseline JPEG (enough |coef|≥2 carriers for stego). */
function makeJpegCover(w: number, h: number): Uint8Array {
  const data = Buffer.alloc(w * h * 4);
  let s = 0x5a5a5a5a >>> 0;
  for (let i = 0; i < w * h; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i * 4] = (s >>> 24) & 0xff;
    data[i * 4 + 1] = (s >>> 16) & 0xff;
    data[i * 4 + 2] = (s >>> 8) & 0xff;
    data[i * 4 + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data, width: w, height: h }, 85).data);
}

async function generate(
  name: string,
  keyMode: KeyMode,
  content: Uint8Array,
  coverJpeg = false,
): Promise<void> {
  const dir = join(outRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const key = await makeKey();
  const { imagePayloads, keyBlock } = await exportVault(FILENAME, content, key, {
    profile: PROFILE_DISK,
    keyMode,
  });
  const codec = getCodec(decodeHeader(imagePayloads[0]!).codecId);

  imagePayloads.forEach((payload, i) => {
    const img = codec.encode(payload, PROFILE_DISK);
    writePng(join(dir, `page-${String(i + 1).padStart(2, '0')}.png`), img);
  });

  if (keyMode === 'stego') {
    // Hide the key block in a deterministic cover photo (a 128×128 gradient) and
    // write it as a PNG. The reference decoder must extract it with the password.
    // Uses the production Argon2id defaults — the stego cost is not stored, so a
    // decoder assumes the defaults (SPEC §5.3).
    const w = 128;
    const h = 128;
    const rgba = new Uint8Array(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      rgba[p * 4] = (p * 7) & 0xff;
      rgba[p * 4 + 1] = (p * 13) & 0xff;
      rgba[p * 4 + 2] = (p * 29) & 0xff;
      rgba[p * 4 + 3] = 255;
    }
    if (coverJpeg) {
      // Hide the key in a baseline JPEG's DCT coefficients (SPEC §5.4). The
      // Python reference decoder must extract it with only the password.
      const cover = makeJpegCover(128, 128);
      const key = await embedKeyBlockStegoJpeg(cover, keyBlock, PASSWORD, DEFAULT_ARGON2);
      writeFileSync(join(dir, 'key.jpg'), key);
    } else {
      await embedKeyBlockStego(rgba, w, h, keyBlock, PASSWORD, DEFAULT_ARGON2);
      writePng(join(dir, 'key.png'), { data: new Uint8ClampedArray(rgba), width: w, height: h });
    }
  } else if (keyMode !== 'embedded') {
    writeFileSync(join(dir, 'vault.key'), keyBlock);
  }
  writeFileSync(join(dir, 'expected.bin'), content);
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      { password: PASSWORD, filename: FILENAME, keyMode, images: imagePayloads.length },
      null,
      2,
    ),
  );
  console.log(`fixture ${name}: ${imagePayloads.length} image(s), keyMode=${keyMode}`);
}

const content = pseudoRandom(4000, 20260713);
await generate('embedded', 'embedded', content);
await generate('keyfile', 'keyfile', content);
await generate('stego', 'stego', content);
await generate('stego-jpeg', 'stego', content, true);
console.log(`fixtures written to ${outRoot}`);

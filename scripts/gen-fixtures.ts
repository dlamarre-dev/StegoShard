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
  type BinaryVariant,
  binaryKeyName,
  binaryVaultName,
  createKeyBlock,
  DEFAULT_ARGON2,
  embedKeyBlockStego,
  embedKeyBlockStegoJpeg,
  galleryEncode,
  serializeKeyBlock,
  exportVault,
  exportVaultBinary,
  getCodec,
  decodeHeader,
  PROFILE_DISK,
  wrapBinary,
  type GalleryCover,
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
function makeJpegCover(w: number, h: number, seed = 0x5a5a5a5a): Uint8Array {
  const data = Buffer.alloc(w * h * 4);
  let s = seed >>> 0;
  for (let i = 0; i < w * h; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i * 4] = (s >>> 24) & 0xff;
    data[i * 4 + 1] = (s >>> 16) & 0xff;
    data[i * 4 + 2] = (s >>> 8) & 0xff;
    data[i * 4 + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data, width: w, height: h }, 85).data);
}

/** A deterministic noisy RGBA cover (ample RGB LSB capacity for a gallery slot). */
function makeRgbaCover(w: number, h: number, seed: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  let s = seed >>> 0;
  for (let p = 0; p < w * h; p++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    rgba[p * 4] = (s >>> 24) & 0xff;
    rgba[p * 4 + 1] = (s >>> 16) & 0xff;
    rgba[p * 4 + 2] = (s >>> 8) & 0xff;
    rgba[p * 4 + 3] = 255;
  }
  return rgba;
}

/** Gallery Mode fixture (SPEC §9): a secret fragmented + decoy-padded across
 * photos, which the Python decoder must restore blindly. Uses the frozen default
 * gallery Argon2 cost (not stored), so the decoder derives with those defaults. */
async function generateGallery(
  name: string,
  coverJpeg: boolean,
  keyMode: KeyMode = 'embedded',
): Promise<void> {
  const dir = join(outRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const covers: GalleryCover[] = [];
  for (let i = 0; i < 8; i++) {
    if (coverJpeg) {
      covers.push({
        kind: 'jpeg',
        name: `cover-${i}.jpg`,
        jpeg: makeJpegCover(256, 256, 0x100 + i),
      });
    } else {
      covers.push({
        kind: 'rgba',
        name: `cover-${i}.png`,
        rgba: makeRgbaCover(256, 256, 0x200 + i),
        width: 256,
        height: 256,
      });
    }
  }

  const res = await galleryEncode(FILENAME, content, PASSWORD, covers, { keyMode });
  // Keyfile gallery: the key block is delivered separately, not embedded.
  if (keyMode === 'keyfile') writeFileSync(join(dir, 'vault.key'), res.keyBlock);
  res.images.forEach((img, i) => {
    const idx = String(i + 1).padStart(2, '0');
    if (img.kind === 'jpeg') {
      writeFileSync(join(dir, `photo-${idx}.jpg`), img.jpeg);
    } else {
      writePng(join(dir, `photo-${idx}.png`), {
        data: new Uint8ClampedArray(img.rgba),
        width: img.width,
        height: img.height,
      });
    }
  });
  if (coverJpeg) {
    // A foreign JPEG (not part of the gallery) whose eligible-carrier count sits
    // just above the slot size but below the 4x margin — the case that used to
    // drain the position keystream. The decoder must skip it, not abort.
    writeFileSync(join(dir, 'foreign.jpg'), makeJpegCover(112, 112, 0x333));
  }
  writeFileSync(join(dir, 'expected.bin'), content);
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        password: PASSWORD,
        filename: FILENAME,
        keyMode,
        images: res.images.length,
        k: res.k,
        m: res.m,
        decoys: res.decoys,
      },
      null,
      2,
    ),
  );
  console.log(
    `fixture ${name}: gallery ${res.images.length} photo(s) (k=${res.k} m=${res.m} decoys=${res.decoys})`,
  );
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

/** Binary-container fixture (SPEC §8): a single file the Python decoder must
 * restore via decode_vault_binary, plus a matching key container in keyfile mode. */
async function generateBinary(
  name: string,
  keyMode: KeyMode,
  variant: BinaryVariant,
  content: Uint8Array,
): Promise<void> {
  const dir = join(outRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const key = await makeKey();
  const { container, keyBlock } = await exportVaultBinary(FILENAME, content, key, {
    keyMode,
    variant,
  });
  const vaultName = binaryVaultName(variant);
  writeFileSync(join(dir, vaultName), container);
  let keyName: string | undefined;
  if (keyMode === 'keyfile') {
    keyName = binaryKeyName(variant);
    writeFileSync(join(dir, keyName), wrapBinary(keyBlock, variant));
  }
  writeFileSync(join(dir, 'expected.bin'), content);
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      { password: PASSWORD, filename: FILENAME, keyMode, variant, vault: vaultName, key: keyName },
      null,
      2,
    ),
  );
  console.log(`fixture ${name}: binary ${variant}, keyMode=${keyMode}`);
}

const content = pseudoRandom(4000, 20260713);
await generate('embedded', 'embedded', content);
await generate('keyfile', 'keyfile', content);
await generate('stego', 'stego', content);
await generate('stego-jpeg', 'stego', content, true);
await generateBinary('binary-branded', 'embedded', 'branded', content);
await generateBinary('binary-disguised', 'keyfile', 'disguised', content);
await generateGallery('gallery-png', false);
await generateGallery('gallery-jpeg', true);
await generateGallery('gallery-keyfile', false, 'keyfile');
console.log(`fixtures written to ${outRoot}`);

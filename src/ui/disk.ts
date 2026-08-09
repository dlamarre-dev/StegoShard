/**
 * Disk destination flow (plan §6): the offline default, needing no network
 * permission. Save renders the vault's image set to PNG files — either as
 * individual downloads or bundled into one .zip; restore reads image files (or
 * a .zip) back and reconstructs the original file.
 */

import {
  type BinaryVariant,
  FileTooLargeError,
  binaryKeyName,
  binaryVaultName,
  buildDuressDbContainer,
  buildNonPossessionDbContainer,
  shareFileText,
  randomBytes,
  KEY_FACTOR_LEN,
  getCodec,
  exportVault,
  galleryDecode,
  galleryEncode,
  importVault,
  MAX_FILE_BYTES,
  MAX_FILE_BYTES_BINARY_UI,
  MAX_IMAGES,
  PROFILE_DISK,
  shamirRecover,
  TooManyFilesError,
  VerificationError,
  decodeHeader,
  toHex,
  unwrapBinary,
  verifyGalleryExport,
  wrapBinary,
  verifyImageExport,
  type KeyMode,
  type OnProgress,
  type VaultKey,
} from '@core';
import type { AccessMode } from './save-controller';
import {
  decryptBinaryInWorker,
  encryptBinaryDisguisedInWorker,
  encryptBinaryInWorker,
} from './run-in-worker';
import { Unzip, UnzipInflate, zipSync } from 'fflate';
import {
  decodeImageBytes,
  downloadBlob,
  embedKeyImage,
  embedKeyFactorImage,
  extractKeyImage,
  extractKeyFactorImage,
  fileToGalleryCover,
  galleryImageToBlob,
  imageWithLabelToPngBlob,
  stegoKeyName,
  type LabelBand,
} from './image-io';
import {
  MAX_BROWSER_CONTAINER_BYTES,
  MAX_BROWSER_INPUT_FILES,
  MAX_BROWSER_MEDIA_BYTES,
  MAX_BROWSER_TOTAL_INPUT_BYTES,
  assertBlobSize,
  assertBrowserInputs,
  boundedBlobBytes,
} from './input-limits';

export interface SaveOptions {
  keyMode: KeyMode;
  /** Image codec (SPEC §2). Defaults to qr-grid when unset. */
  codecId?: number | undefined;
  /** When set, a readable title band is drawn above each image. */
  label?: { title?: string; date?: string } | undefined;
  /** Bundle all images (+ .key) into a single .zip instead of many files. */
  asZip?: boolean;
  /**
   * For the 'stego' key mode: the cover photo to hide the key block in, and the
   * password that keys the embedding (the same one that unlocks the vault).
   */
  stego?: { cover: File; password: string } | undefined;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Download a set of files. When there is more than one, they are grouped into a
 * `subdir` under the browser's download folder (so a save never scatters loose
 * files), with a small gap between downloads to avoid batch-blocking.
 */
async function deliver(downloads: { name: string; blob: Blob }[], subdir: string): Promise<void> {
  const multi = downloads.length > 1;
  for (let i = 0; i < downloads.length; i++) {
    downloadBlob(downloads[i]!.blob, downloads[i]!.name, multi ? subdir : undefined);
    if (i < downloads.length - 1) await new Promise((r) => setTimeout(r, 150));
  }
}

const octet = (bytes: Uint8Array, type = 'application/octet-stream'): Blob =>
  new Blob([bytes as BufferSource], { type });

/**
 * Confirm a produced stego cover actually yields the key block back (the LSB/DCT
 * carrier is the fragile part). Throws VerificationError otherwise.
 */
async function verifyStegoKeyCover(
  bytes: Uint8Array,
  name: string,
  password: string,
  expected: Uint8Array,
  // The single-region paths (disk/paper/branded .ssbn) hide a 92-byte key block;
  // the multi-region paths (gallery, disguised .db) hide the 32-byte key factor.
  variant: 'block' | 'factor' = 'block',
): Promise<void> {
  const file = new File([bytes as BlobPart], name);
  const recovered =
    variant === 'factor'
      ? await extractKeyFactorImage(file, password)
      : await extractKeyImage(file, password);
  if (!recovered || recovered.length !== expected.length) throw new VerificationError();
  for (let i = 0; i < expected.length; i++)
    if (recovered[i] !== expected[i]) throw new VerificationError();
}

/** Encode a file into a set of PNG images and download them (or a .zip). */
export async function saveFileToDisk(
  file: File,
  key: VaultKey,
  options: SaveOptions,
): Promise<{ imageCount: number; setId: string; keyMode: KeyMode }> {
  assertBlobSize(file, MAX_FILE_BYTES);
  if (options.stego) assertBrowserInputs([options.stego.cover]);
  const content = new Uint8Array(await file.arrayBuffer());
  const { imagePayloads, setId, keyBlock, keyMode } = await exportVault(file.name, content, key, {
    profile: PROFILE_DISK,
    codecId: options.codecId,
    keyMode: options.keyMode,
  });
  const codecId = decodeHeader(imagePayloads[0]!).codecId;
  const codec = getCodec(codecId);
  const setHex = toHex(setId);
  const total = imagePayloads.length;

  const pngs: { name: string; bytes: Uint8Array }[] = [];
  for (let i = 0; i < total; i++) {
    const img = codec.encode(imagePayloads[i]!, PROFILE_DISK);
    const band: LabelBand | undefined = options.label
      ? { ...options.label, index: i + 1, total }
      : undefined;
    const index = String(i + 1).padStart(2, '0');
    pngs.push({
      name: `stegoshard-${setHex}-${index}.png`,
      bytes: await blobBytes(await imageWithLabelToPngBlob(img, band, codecId)),
    });
  }
  // The key block is external for keyfile/stego modes. In stego mode it is
  // hidden inside the user's cover photo (a lossless PNG); otherwise it is a
  // plain .key file. Bundled into the .zip only for the .key case — the stego
  // image is always delivered on its own so it can be stored as an innocuous
  // photo, separate from the obviously-StegoShard set.
  let externalKey: { name: string; bytes: Uint8Array; mime: string } | undefined;
  if (keyMode === 'stego') {
    if (!options.stego) throw new Error('stego mode requires a cover image and password');
    const key = await embedKeyImage(options.stego.cover, keyBlock, options.stego.password);
    externalKey = {
      name: stegoKeyName(options.stego.cover.name, key.ext, setHex),
      bytes: key.bytes,
      mime: key.mime,
    };
  } else if (keyMode !== 'embedded') {
    externalKey = {
      name: `stegoshard-${setHex}.key`,
      bytes: keyBlock,
      mime: 'application/octet-stream',
    };
  }

  // Collect everything this save produces, then deliver. A separate key (a .key
  // or a stego cover) is always delivered on its own — never inside the .zip —
  // so the two factors stay physically separate.
  const downloads: { name: string; blob: Blob }[] = [];
  if (options.asZip) {
    const entries: Record<string, Uint8Array> = {};
    for (const p of pngs) entries[p.name] = p.bytes;
    const zipped = zipSync(entries, { level: 0 }); // PNGs are already compressed
    downloads.push({ name: `stegoshard-${setHex}.zip`, blob: octet(zipped) });
  } else {
    for (const p of pngs) downloads.push({ name: p.name, blob: octet(p.bytes, 'image/png') });
  }
  if (externalKey)
    downloads.push({ name: externalKey.name, blob: octet(externalKey.bytes, externalKey.mime) });

  // Prove the set (and, for stego, the key cover) restores before handing it over.
  await verifyImageExport(imagePayloads, key.dek, file.name, content);
  if (keyMode === 'stego' && externalKey && options.stego) {
    await verifyStegoKeyCover(
      externalKey.bytes,
      externalKey.name,
      options.stego.password,
      keyBlock,
    );
  }

  await deliver(downloads, `stegoshard-${setHex}`);
  return { imageCount: total, setId: setHex, keyMode };
}

/** The text file handed to one threshold holder (§10.6 / §10.8 item 4). */
function shareDownloads(
  shares: Uint8Array[],
  k: number,
  n: number,
): { name: string; blob: Blob }[] {
  return shares.map((share, i) => ({
    name: `stegoshard-share-${i + 1}.txt`,
    blob: new Blob([shareFileText(share, i + 1, n, k, 'and load them at restore.')], {
      type: 'text/plain',
    }),
  }));
}

/**
 * Build a disguised .db vault in a §10 access mode (duress or non-possession) on
 * the main thread. Payloads are bucket-capped, so the extra Argon2id is a brief,
 * opt-in blocking cost; the plain path stays on the worker. Returns the downloads.
 */
async function buildDisguisedMode(
  file: File,
  content: Uint8Array,
  options: {
    mode: AccessMode;
    password: string;
    keyMode: KeyMode;
    stego?: { cover: File; password: string } | undefined;
    duressPassword?: string | undefined;
    decoy?: File | undefined;
    threshold?: { k: number; n: number } | undefined;
    onProgress?: OnProgress | undefined;
  },
): Promise<{ name: string; blob: Blob }[]> {
  const vaultName = binaryVaultName('disguised');
  // keyfile/stego mint a 32-byte external key factor (§10.3) that composes with the
  // access mode as an extra layer (needed on top of the password / duress / shares).
  const keyFactor = options.keyMode === 'embedded' ? null : randomBytes(KEY_FACTOR_LEN);

  async function deliverFactor(): Promise<{ name: string; blob: Blob }[]> {
    if (!keyFactor) return [];
    if (options.keyMode === 'keyfile') {
      return [
        { name: binaryKeyName('disguised'), blob: octet(wrapBinary(keyFactor, 'disguised')) },
      ];
    }
    if (!options.stego) throw new Error('stego mode requires a cover image and password');
    const k = await embedKeyFactorImage(options.stego.cover, keyFactor, options.stego.password);
    const dl = {
      name: stegoKeyName(options.stego.cover.name, k.ext, ''),
      blob: octet(k.bytes, k.mime),
    };
    await verifyStegoKeyCover(
      await blobBytes(dl.blob),
      dl.name,
      options.stego.password,
      keyFactor,
      'factor',
    );
    return [dl];
  }

  if (options.mode === 'duress') {
    if (!options.duressPassword || !options.decoy) {
      throw new Error('duress mode requires a duress password and a decoy file');
    }
    assertBrowserInputs([file, options.decoy], {
      perFile: MAX_FILE_BYTES_BINARY_UI,
      total: MAX_BROWSER_TOTAL_INPUT_BYTES,
    });
    const decoyContent = await boundedBlobBytes(options.decoy, MAX_FILE_BYTES_BINARY_UI);
    // Core builds + self-verifies both regions and wraps the container.
    const { container } = await buildDuressDbContainer(
      file.name,
      content,
      options.decoy.name,
      decoyContent,
      options.password,
      options.duressPassword,
      keyFactor,
      undefined,
      options.onProgress,
    );
    return [{ name: vaultName, blob: octet(container) }, ...(await deliverFactor())];
  }
  // non-possession
  if (!options.threshold) throw new Error('non-possession mode requires a threshold');
  const { k, n } = options.threshold;
  const { container, shares } = await buildNonPossessionDbContainer(
    file.name,
    content,
    options.password,
    k,
    n,
    keyFactor,
    undefined,
    options.onProgress,
  );
  return [
    { name: vaultName, blob: octet(container) },
    ...shareDownloads(shares, k, n),
    ...(await deliverFactor()),
  ];
}

/**
 * Save the vault as a single binary container file (SPEC §8) instead of images.
 * In keyfile mode the key is delivered as a matching container; in stego mode it
 * stays a cover image. No image-count ceiling applies (up to 100 MiB).
 */
export async function saveFileToBinary(
  file: File,
  key: VaultKey,
  options: {
    keyMode: KeyMode;
    variant: BinaryVariant;
    stego?: SaveOptions['stego'];
    password?: string | undefined;
    mode?: AccessMode | undefined;
    duressPassword?: string | undefined;
    decoy?: File | undefined;
    threshold?: { k: number; n: number } | undefined;
    /** Expert extra entropy. Forwarded to the worker, which has its own module
     *  state and so cannot see the layer installed on this thread. */
    userEntropy?: string | undefined;
    onProgress?: OnProgress | undefined;
  },
): Promise<{ keyMode: KeyMode; variant: BinaryVariant }> {
  assertBrowserInputs(
    [
      file,
      ...(options.decoy ? [options.decoy] : []),
      ...(options.stego ? [options.stego.cover] : []),
    ],
    { perFile: MAX_FILE_BYTES_BINARY_UI, total: MAX_BROWSER_TOTAL_INPUT_BYTES },
  );
  const content = new Uint8Array(await file.arrayBuffer());
  const keyMode = options.keyMode;
  const mode = options.mode ?? 'plain';

  // Disguised .db is a §10 multi-region container keyed by the per-save password
  // (not the managed key). The worker returns the generated key factor for keyfile
  // delivery; the container round-trip is verified inside the worker.
  if (options.variant === 'disguised') {
    if (!options.password) throw new Error('the disguised .db vault requires a per-save password');
    // Duress / non-possession run on the main thread (bucket-capped payloads); the
    // plain path stays on the worker. keyfile/stego compose with these modes as an
    // extra external key factor (§10.3) layered on top of the duress password / shares.
    if (mode !== 'plain') {
      const downloads = await buildDisguisedMode(file, content, {
        mode,
        password: options.password,
        keyMode,
        stego: options.stego,
        duressPassword: options.duressPassword,
        decoy: options.decoy,
        threshold: options.threshold,
        onProgress: options.onProgress,
      });
      const modeId = toHex(randomBytes(4));
      await deliver(downloads, `stegoshard-${modeId}`);
      return { keyMode, variant: 'disguised' };
    }
    const { container, keyBlock: keyFactor } = await encryptBinaryDisguisedInWorker(
      file.name,
      content,
      options.password,
      keyMode,
      options.userEntropy,
      options.onProgress,
    );
    const downloads: { name: string; blob: Blob }[] = [
      { name: binaryVaultName('disguised'), blob: octet(container) },
    ];
    if (keyMode === 'stego') {
      if (!options.stego) throw new Error('stego mode requires a cover image and password');
      // The .db is a multi-region path → hide the 32-byte key factor (SSKF), not a
      // 92-byte key block.
      const stegoKey = await embedKeyFactorImage(
        options.stego.cover,
        keyFactor,
        options.stego.password,
      );
      const dl = {
        name: stegoKeyName(options.stego.cover.name, stegoKey.ext, ''),
        blob: octet(stegoKey.bytes, stegoKey.mime),
      };
      downloads.push(dl);
      await verifyStegoKeyCover(
        await blobBytes(dl.blob),
        dl.name,
        options.stego.password,
        keyFactor,
        'factor',
      );
    } else if (keyMode === 'keyfile') {
      downloads.push({
        name: binaryKeyName('disguised'),
        blob: octet(wrapBinary(keyFactor, 'disguised')),
      });
    }
    const disguisedId = toHex(randomBytes(4));
    await deliver(downloads, `stegoshard-${disguisedId}`);
    return { keyMode, variant: 'disguised' };
  }

  const keyBlock = key.keyBlock;
  // Encrypt + verify off the main thread (the worker also runs the post-save
  // round-trip check) so the UI stays responsive and the progress bar animates.
  const container = await encryptBinaryInWorker(
    file.name,
    content,
    key,
    keyMode,
    options.variant,
    options.userEntropy,
    options.onProgress,
  );
  const downloads: { name: string; blob: Blob }[] = [
    { name: binaryVaultName(options.variant), blob: octet(container) },
  ];

  if (keyMode === 'stego') {
    if (!options.stego) throw new Error('stego mode requires a cover image and password');
    const stegoKey = await embedKeyImage(options.stego.cover, keyBlock, options.stego.password);
    downloads.push({
      name: stegoKeyName(options.stego.cover.name, stegoKey.ext, ''),
      blob: octet(stegoKey.bytes, stegoKey.mime),
    });
  } else if (keyMode === 'keyfile') {
    downloads.push({
      name: binaryKeyName(options.variant),
      blob: octet(wrapBinary(keyBlock, options.variant)),
    });
  }
  // The container round-trip is verified inside the worker; here we only still
  // need to prove the stego key cover yields the key block back.
  if (keyMode === 'stego' && options.stego) {
    const stegoDownload = downloads[downloads.length - 1]!;
    await verifyStegoKeyCover(
      await blobBytes(stegoDownload.blob),
      stegoDownload.name,
      options.stego.password,
      keyBlock,
    );
  }
  // No setId on the binary path — group the vault + key under a random-id folder.
  const id = toHex(randomBytes(4));
  await deliver(downloads, `stegoshard-${id}`);
  return { keyMode, variant: options.variant };
}

export interface GallerySaveResult {
  imageCount: number;
  k: number;
  m: number;
  decoys: number;
  setId: string;
}

/**
 * Gallery Mode (SPEC §9): hide a secret fragmented across the given cover photos
 * plus decoys, then download every (modified) photo, keeping each cover's own
 * filename so the set blends into a photo library (no telltale zip). By default
 * the key is embedded in the fragments; keyMode 'keyfile'/'stego' deliver it
 * separately (a loose .key or hidden in a cover photo — a deniability trade-off).
 */
export async function saveGalleryToDisk(
  secret: File,
  covers: File[],
  password: string,
  options: {
    keyMode?: KeyMode;
    stego?: SaveOptions['stego'];
    mode?: AccessMode;
    threshold?: { k: number; n: number } | undefined;
  } = {},
): Promise<GallerySaveResult> {
  assertBlobSize(secret, MAX_FILE_BYTES);
  assertBrowserInputs([...covers, ...(options.stego ? [options.stego.cover] : [])]);
  const keyMode = options.keyMode ?? 'embedded';
  const mode = options.mode ?? 'plain';
  const content = new Uint8Array(await secret.arrayBuffer());
  const galleryCovers = await Promise.all(covers.map(fileToGalleryCover));
  const res = await galleryEncode(secret.name, content, password, galleryCovers, {
    keyMode,
    // Duress is refused upstream (winnowing block); gallery does plain + Mode B.
    mode: mode === 'nonpossession' ? 'nonpossession' : 'plain',
    threshold: options.threshold,
  });
  const setHex = toHex(res.setId);

  // Two covers can share a basename, and gallery reuses cover names — disambiguate.
  const downloads: { name: string; blob: Blob }[] = [];
  const used = new Set<string>();
  for (const img of res.images) {
    const { name, blob } = await galleryImageToBlob(img);
    let unique = name;
    for (let n = 2; used.has(unique); n++) unique = name.replace(/(\.[^.]+)?$/, `-${n}$1`);
    used.add(unique);
    downloads.push({ name: unique, blob });
  }
  // A separate key rides alongside the photos when not embedded.
  if (keyMode === 'stego') {
    if (!options.stego) throw new Error('stego mode requires a cover image and password');
    // Gallery is a multi-region path: the external artifact is the 32-byte key
    // factor (§10.3), hidden in its own SSKF envelope, not a 92-byte key block.
    const k = await embedKeyFactorImage(options.stego.cover, res.keyBlock, options.stego.password);
    downloads.push({
      name: stegoKeyName(options.stego.cover.name, k.ext, setHex),
      blob: octet(k.bytes, k.mime),
    });
  } else if (keyMode === 'keyfile') {
    // Deniability caveat: a `.key` (and its telltale name) sitting beside the
    // photos gives the gallery away. keyfile trades deniability for a key you
    // can store apart from the photos — opt-in, unlike the deniable stego/embedded
    // modes. Stego keeps the cover's own filename (blends in); keyfile does not.
    downloads.push({ name: `stegoshard-${setHex}.key`, blob: octet(res.keyBlock) });
  }

  // Non-possession (Mode B): the shares recover the secret that gates verification.
  const thresholdSecret =
    mode === 'nonpossession' && res.shares ? await shamirRecover(res.shares) : undefined;

  // Prove the photos blind-winnow back to the original before delivering.
  const externalKeyBlock = keyMode === 'embedded' ? undefined : res.keyBlock;
  await verifyGalleryExport(
    res.images,
    password,
    externalKeyBlock,
    secret.name,
    content,
    thresholdSecret,
  );
  if (keyMode === 'stego' && options.stego) {
    const cover = downloads[downloads.length - 1]!;
    await verifyStegoKeyCover(
      await blobBytes(cover.blob),
      cover.name,
      options.stego.password,
      res.keyBlock,
      'factor',
    );
  }

  // After the stego-cover check, add the threshold share files for holders.
  if (thresholdSecret && res.shares && options.threshold) {
    downloads.push(...shareDownloads(res.shares, options.threshold.k, options.threshold.n));
  }

  // Neutral folder name (the bare set id, no "stegoshard-" prefix) so grouping
  // the photos doesn't itself betray the gallery.
  await deliver(downloads, setHex);
  return { imageCount: res.images.length, k: res.k, m: res.m, decoys: res.decoys, setId: setHex };
}

/** Restore a secret from a set of gallery photos (blind winnowing) and download it. */
export async function restoreGalleryFromDisk(
  files: File[],
  password: string,
  keyFile?: File,
  secret?: Uint8Array | undefined,
): Promise<{ filename: string }> {
  assertBrowserInputs([...files, ...(keyFile ? [keyFile] : [])]);
  const covers = await Promise.all(files.map(fileToGalleryCover));
  // Optional external key (keyfile/stego galleries): a .key, a binary key
  // container, or a stego cover de-embedded with the restore password.
  let keyBlock: Uint8Array | undefined;
  if (keyFile) {
    const bytes = await blobBytes(keyFile);
    const unwrapped = unwrapBinary(bytes);
    keyBlock = unwrapped
      ? unwrapped.payload
      : isKey(keyFile.name)
        ? bytes
        : ((await extractKeyFactorImage(keyFile, password)) ?? undefined);
  }
  // Mode B (non-possession): `secret` is recovered from a threshold share quorum.
  const { filename, content } = await galleryDecode(covers, password, { keyBlock, secret });
  downloadBlob(new Blob([content as BufferSource]), filename);
  return { filename };
}

const isZip = (name: string) => name.toLowerCase().endsWith('.zip');
const isKey = (name: string) => name.toLowerCase().endsWith('.key');
const isPdf = (name: string) => name.toLowerCase().endsWith('.pdf');
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

// Bounds for restoring from an untrusted .zip (zip-bomb / resource guard).
// Generous enough for real photo sets, tight enough to reject an archive that
// claims gigabytes.
// A disk backup never holds more than MAX_IMAGES images (plus a .key and a
// little slack), so bound the archive by *that*, not by the much larger gallery
// input budget. Mirrors `MAX_ZIP_ENTRIES` in src/cli/inputs.ts.
export const MAX_ZIP_ENTRIES = MAX_IMAGES + 4;
const MAX_ENTRY_BYTES = MAX_BROWSER_MEDIA_BYTES;
const MAX_TOTAL_BYTES = MAX_BROWSER_TOTAL_INPUT_BYTES;

/**
 * Extract only image/.key entries from a zip, within the size/count budgets.
 * Streams each entry and enforces the caps on the *actual* inflated bytes (not
 * the attacker-declarable header size), aborting before a zip bomb can grow
 * unbounded. Runs synchronously: fflate's `Unzip` + `UnzipInflate` deliver all
 * data during the single `push` below.
 */
export function extractZip(zipBytes: Uint8Array): { images: Uint8Array[]; keyBlock?: Uint8Array } {
  const images: Uint8Array[] = [];
  let keyBlock: Uint8Array | undefined;
  let count = 0;
  let total = 0;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    const name = file.name;
    if (!(IMAGE_RE.test(name) || isKey(name))) return; // never decompressed
    count += 1;
    if (count > MAX_ZIP_ENTRIES) throw new Error('restore: too many entries in the .zip');

    const parts: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      size += chunk.length;
      total += chunk.length;
      if (size > MAX_ENTRY_BYTES) throw new Error('restore: a .zip entry is too large');
      if (total > MAX_TOTAL_BYTES) throw new Error('restore: .zip contents are too large');
      parts.push(chunk.slice()); // fflate may reuse the buffer — copy it
      if (final) {
        const bytes = parts.length === 1 ? parts[0]! : concatChunks(parts, size);
        if (isKey(name)) keyBlock = bytes;
        else images.push(bytes);
      }
    };
    file.start();
  };
  unzip.push(zipBytes, true);

  return keyBlock ? { images, keyBlock } : { images };
}

function concatChunks(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Reconstruct the original file from image files, a .zip of them, a printed
 * PDF (paper mode), or a mix. The separate key, when needed, may be a `.key`
 * file (loose or inside the zip) or a **stego cover image** that hides the key
 * block — the latter is de-embedded with the restore password. `extraPayloads`
 * lets callers add already-decoded payloads (e.g. live camera captures).
 */
export async function restoreFileFromDisk(
  files: File[],
  password: string,
  keyFile?: File,
  extraPayloads: Uint8Array[] = [],
  onProgress?: OnProgress,
  secret?: Uint8Array | undefined,
): Promise<{ filename: string }> {
  assertBrowserInputs(files, {
    perFile: MAX_BROWSER_CONTAINER_BYTES,
    total: MAX_BROWSER_TOTAL_INPUT_BYTES,
  });
  for (const file of files) {
    if (!isZip(file.name) && !/\.(?:ssbn|db)$/i.test(file.name)) {
      assertBlobSize(file, MAX_BROWSER_MEDIA_BYTES);
    }
  }
  if (keyFile) assertBlobSize(keyFile, MAX_BROWSER_MEDIA_BYTES);
  if (extraPayloads.length > MAX_BROWSER_INPUT_FILES) {
    throw new TooManyFilesError(extraPayloads.length, MAX_BROWSER_INPUT_FILES);
  }
  let decodedTotal = 0;
  for (const payload of extraPayloads) {
    decodedTotal += payload.byteLength;
    if (decodedTotal > MAX_BROWSER_TOTAL_INPUT_BYTES) {
      throw new FileTooLargeError(decodedTotal, MAX_BROWSER_TOTAL_INPUT_BYTES);
    }
  }
  const images: Uint8Array[] = [];
  const payloads: Uint8Array[] = [...extraPayloads];
  // A key input can be a raw .key, a binary key container (branded/disguised),
  // or a stego cover image (de-embedded with the restore password).
  let keyBlock: Uint8Array | undefined;
  if (keyFile) {
    const bytes = await boundedBlobBytes(keyFile, MAX_BROWSER_MEDIA_BYTES);
    const unwrapped = unwrapBinary(bytes);
    keyBlock = unwrapped
      ? unwrapped.payload
      : isKey(keyFile.name)
        ? bytes
        : // A stego cover carries either a 92-byte key block (single-region: disk /
          // paper / branded .ssbn) or the 32-byte key factor (multi-region .db).
          // The two envelopes self-distinguish by magic, so try block then factor;
          // only the one actually embedded returns non-null.
          ((await extractKeyImage(keyFile, password)) ??
          (await extractKeyFactorImage(keyFile, password)) ??
          undefined);
  }

  // A single binary vault container short-circuits the image pipeline. (Camera
  // captures arrive as extraPayloads and are always images, so skip the probe.)
  if (extraPayloads.length === 0) {
    for (const file of files) {
      const bytes = await boundedBlobBytes(file, MAX_BROWSER_CONTAINER_BYTES);
      if (unwrapBinary(bytes)) {
        const { filename, content } = await decryptBinaryInWorker(
          bytes,
          password,
          keyBlock,
          secret,
          onProgress,
        );
        downloadBlob(new Blob([content as BufferSource]), filename);
        return { filename };
      }
    }
  }

  for (const file of files) {
    if (isZip(file.name)) {
      const extracted = extractZip(await boundedBlobBytes(file, MAX_BROWSER_CONTAINER_BYTES));
      images.push(...extracted.images);
      if (extracted.keyBlock) keyBlock = extracted.keyBlock;
    } else if (isKey(file.name)) {
      keyBlock = await boundedBlobBytes(file, MAX_BROWSER_MEDIA_BYTES);
    } else if (isPdf(file.name)) {
      // Lazy: keeps pdf-lib out of the initial bundle (only paper users pay).
      const { extractPdfPayloads } = await import('./pdf-restore');
      payloads.push(
        ...(await extractPdfPayloads(await boundedBlobBytes(file, MAX_BROWSER_MEDIA_BYTES))),
      );
    } else {
      images.push(await boundedBlobBytes(file, MAX_BROWSER_MEDIA_BYTES));
    }
  }

  for (const bytes of images) {
    const payload = await decodeImageBytes(bytes);
    // A single unreadable image is fine — erasure coding tolerates losses.
    if (payload) payloads.push(payload);
  }
  if (payloads.length === 0) throw new Error('restore: no readable images found');

  const { filename, content } = await importVault(payloads, password, { keyBlock });
  downloadBlob(new Blob([content as BufferSource]), filename);
  return { filename };
}

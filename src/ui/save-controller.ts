/**
 * Shared save orchestration. The extension popup, the web app, and the guided
 * wizard all describe a save the same way (a `SaveRequest`) and call `runSave`,
 * so the branching over destination / key mode lives in exactly one place
 * instead of being copied into each surface's click handler.
 *
 * It wraps the destination flows in `disk.ts` / `paper.ts`
 * and returns a localized result note (via the caller's `msg`, since the
 * extension and web build use different i18n backends). Paper is imported
 * lazily so surfaces that never use it don't pull it into the bundle.
 */

import {
  type BinaryVariant,
  type KeyMode,
  type ManifestEntry,
  type OnProgress,
  type VaultKey,
  CODEC_COLOR_GRID,
  CODEC_QR_GRID,
  WrongPasswordError,
  clearUserEntropy,
  installUserEntropy,
  parseKeyBlock,
  unlockKeyBlock,
} from '@core';
import { saveFileToBinary, saveFileToDisk, saveGalleryToDisk } from './disk';
import { resolveSaveInput } from './bundle';

export type SaveDestination = 'disk' | 'paper' | 'binary' | 'sqlite' | 'gallery';

/**
 * Which image codec the digital destinations render with (SPEC §2).
 *
 * 'color' packs ~3x the bytes per image, so a vault needs about a third as many
 * files; 'qr' is the conservative choice, readable by any phone. Paper is always
 * 'qr': print, ink and camera white balance make colour a liability there.
 */
export type CodecChoice = 'color' | 'qr';

/** Codecs offered to the user, in display order. */
export const CODEC_CHOICES: readonly CodecChoice[] = ['color', 'qr'];

/**
 * True when a destination writes one opaque file rather than a set of images.
 *
 * The pre-save copy has to follow: telling someone saving a `.ssbn` that we are
 * about to "download images" is simply wrong. Keys that need both wordings carry
 * a `File` variant, chosen through `destKey`.
 */
export function writesOneFile(dest: SaveDestination): boolean {
  return dest === 'binary' || dest === 'sqlite';
}

/** Pick the image- or file-worded variant of a message key for a destination. */
export function destKey(base: string, dest: SaveDestination): string {
  return writesOneFile(dest) ? `${base}File` : base;
}

/** Destinations that render images, and so let the user pick a codec. */
export function codecApplies(dest: SaveDestination): boolean {
  return dest === 'disk';
}

/** Map a user choice to the CODEC_ID stored in the image header. */
export function codecIdFor(dest: SaveDestination, codec: CodecChoice | undefined): number {
  if (!codecApplies(dest)) return CODEC_QR_GRID;
  return codec === 'color' ? CODEC_COLOR_GRID : CODEC_QR_GRID;
}

/** §10 access mode for the deniable paths (gallery, .db). Mutually exclusive. */
export type AccessMode = 'plain' | 'duress' | 'nonpossession';

/** A localizer with the same shape in both the extension and the web app. */
export type Msg = (key: string, subs?: string | string[]) => string;

/** For the 'stego' key mode: the cover photo and the password that keys it. */
export interface StegoInput {
  cover: File;
  password: string;
}

export interface SaveRequest {
  dest: SaveDestination;
  /** The secret(s) to protect. Several files are zipped into one bundle. */
  files: File[];
  /**
   * The vault key for every destination except `gallery` (which derives its own
   * key from `galleryPassword`). The extension passes its managed session key;
   * the web app mints a fresh one per save.
   */
  key?: VaultKey | undefined;
  keyMode?: KeyMode;
  /** Image codec for the disk destination. Ignored elsewhere. */
  codec?: CodecChoice | undefined;
  /**
   * Readable caption stamped into the brand strip on disk images, and used for
   * the paper PDF's heading. The date is expected on every save (it is stamped
   * with the sequence number whether or not a title was asked for); the title is
   * the optional part.
   */
  label?: { title?: string | undefined; date?: string | undefined } | undefined;
  asZip?: boolean | undefined;
  includeInstructions?: boolean;
  passwordHint?: string | undefined;
  keyLocation?: string | undefined;
  stego?: StegoInput | undefined;
  locale?: string | undefined;
  /** Gallery Mode only: the cover photos and its own password. */
  covers?: File[];
  galleryPassword?: string;
  /**
   * Per-save password for the disguised `.db` path (§10 multi-region). Required
   * for `dest: 'sqlite'`; ignored elsewhere (those paths use the managed key).
   */
  password?: string | undefined;
  /**
   * §10 access mode for the deniable paths. 'plain' (default), 'duress' (Mode A,
   * `.db` only, needs `duressPassword` + `decoy`), or 'nonpossession' (Mode B,
   * gallery or `.db`, needs `threshold`, delivers Shamir shares).
   */
  accessMode?: AccessMode | undefined;
  /** Mode A: the duress password + the plausible decoy file it reveals. */
  duressPassword?: string | undefined;
  decoy?: File | undefined;
  /** Mode B: the k-of-n threshold. */
  threshold?: { k: number; n: number } | undefined;
  /**
   * Expert option: extra entropy typed by the user (mashed keys, dice rolls),
   * XORed into every random draw of this save on top of the platform CSPRNG,
   * which is always used regardless. Generation-side only; nothing is stored,
   * so restoring needs no trace of it. Never persisted: a remembered entropy
   * string is a reused one.
   */
  userEntropy?: string | undefined;
  /** Progress callback for the binary path (the slow, large-file destination). */
  onProgress?: OnProgress;
}

/**
 * Confirm a typed stego password actually unlocks this device's managed key, so
 * a stego cover can never be keyed by a password that won't later restore it.
 * Extension-only (the web app's stego password is the save password by design).
 */
export async function verifyStegoPassword(
  keyBlock: Uint8Array,
  password: string,
): Promise<boolean> {
  try {
    await unlockKeyBlock(parseKeyBlock(keyBlock), password);
    return true;
  } catch (err) {
    // Only a genuine password mismatch is "false"; a corrupt key block or any
    // other failure is surfaced, not silently reported as a wrong password.
    if (err instanceof WrongPasswordError) return false;
    throw err;
  }
}

function diskNote(msg: Msg, keyMode: KeyMode, imageCount: number): string {
  const key =
    keyMode === 'embedded'
      ? 'statusSaved'
      : keyMode === 'stego'
        ? 'statusSavedStego'
        : 'statusSavedKeyfile';
  return msg(key, String(imageCount));
}

function binaryNote(msg: Msg, keyMode: KeyMode, variant: BinaryVariant): string {
  const key =
    keyMode === 'embedded'
      ? 'statusSavedBinary'
      : keyMode === 'stego'
        ? 'statusSavedBinaryStego'
        : 'statusSavedBinaryKeyfile';
  return msg(key, msg(variant === 'branded' ? 'binaryVariantBranded' : 'binaryVariantDisguised'));
}

function galleryNote(msg: Msg, keyMode: KeyMode, imageCount: number): string {
  const key =
    keyMode === 'embedded'
      ? 'statusGallerySaved'
      : keyMode === 'stego'
        ? 'statusGallerySavedStego'
        : 'statusGallerySavedKeyfile';
  return msg(key, String(imageCount));
}

/**
 * The result of a save: the localized summary line, plus what was actually
 * written.
 *
 * The manifest is not decoration. Deniable destinations name their artifacts
 * after nothing in particular (`cache.db`, `recovery-1.txt`) so without a list
 * saying which file is which, the user is left guessing. It is returned for
 * every destination, because that need does not depend on the naming.
 */
export interface SaveOutcome {
  note: string;
  manifest: ManifestEntry[];
}

/**
 * What the user must keep to restore, given the destination and key mode, plus
 * whether the artifacts must be stored losslessly (the fragile LSB carriers).
 * Returns i18n keys so both surfaces render the same recovery checklist.
 *
 * Complements `SaveOutcome.manifest`: this says what to keep, that says what was
 * created.
 */
export interface RecoveryGuidance {
  items: string[];
  lossless: boolean;
}
export function recoveryGuidance(dest: SaveDestination, keyMode: KeyMode): RecoveryGuidance {
  const items = ['recoveryPassword'];
  if (dest === 'gallery') items.push('recoveryPhotos');
  else if (dest === 'binary' || dest === 'sqlite') items.push('recoveryFile');
  else items.push('recoveryImages'); // disk / paper
  if (keyMode === 'keyfile') items.push('recoveryKeyfile');
  else if (keyMode === 'stego') items.push('recoveryCover');
  // LSB carriers (a stego key cover, or Gallery Mode's photos) are destroyed by
  // any recompression/resize, so call that out explicitly.
  const lossless = keyMode === 'stego' || dest === 'gallery';
  return { items, lossless };
}

/**
 * Run a save and return a localized result note. Throws on any failure.
 *
 * The optional user-entropy layer is installed for the duration of the save and
 * torn down afterwards, so it can never leak into a later operation the user did
 * not ask it for. The pipeline worker runs on its own thread with its own module
 * state, so requests routed through it carry the string along (see disk.ts).
 */
export async function runSave(req: SaveRequest, msg: Msg): Promise<SaveOutcome> {
  if (req.userEntropy) await installUserEntropy(req.userEntropy);
  try {
    return await performSave(req, msg);
  } finally {
    clearUserEntropy();
  }
}

async function performSave(req: SaveRequest, msg: Msg): Promise<SaveOutcome> {
  // One file passes through untouched; several are zipped and marked, so every
  // destination below sees the single (name, blob) the envelope carries.
  const { file, bundle } = await resolveSaveInput(req.files);
  if (req.dest === 'gallery') {
    const covers = req.covers ?? [];
    if (!req.galleryPassword) throw new Error('gallery mode requires a password');
    const keyMode = req.keyMode ?? 'embedded';
    const accessMode = req.accessMode ?? 'plain';
    // Duress is not available on gallery: the winnowing key is password-derived,
    // so two credentials would find different fragment sets (SPEC §10.11).
    if (accessMode === 'duress') throw new Error(msg('errDuressGallery'));
    if (accessMode === 'nonpossession' && !req.threshold) {
      throw new Error(msg('errNoThreshold'));
    }
    const res = await saveGalleryToDisk(file, covers, req.galleryPassword, {
      bundle,
      keyMode,
      stego: req.stego,
      mode: accessMode,
      threshold: req.threshold,
    });
    return { note: galleryNote(msg, keyMode, res.imageCount), manifest: res.manifest };
  }

  if (!req.key) throw new Error('a vault key is required');
  const keyMode = req.keyMode ?? 'embedded';

  if (req.dest === 'paper') {
    const { saveFileToPaper } = await import('./paper');
    const { imageCount, manifest } = await saveFileToPaper(file, req.key, {
      bundle,
      keyMode,
      title: req.label?.title || undefined,
      date: req.label?.date,
      includeInstructions: req.includeInstructions,
      passwordHint: req.passwordHint,
      keyLocation: req.keyLocation,
      stego: req.stego,
      locale: req.locale,
    });
    return { note: msg('statusSavedPdf', String(imageCount)), manifest };
  }

  if (req.dest === 'binary' || req.dest === 'sqlite') {
    // Two destinations map to the one binary container: 'binary' is a branded
    // .ssbn (an EXCLUDED path, single-region and managed key), 'sqlite' is the
    // disguised .db, which under §10 is a mandatory multi-region container keyed
    // by a per-save PASSWORD (each region gets its own DEK; the managed key is
    // not used on this supported path).
    const variant: BinaryVariant = req.dest === 'sqlite' ? 'disguised' : 'branded';
    const accessMode = req.accessMode ?? 'plain';
    // Access modes exist only on the supported .db path, never on branded .ssbn.
    if (variant === 'branded' && accessMode !== 'plain') throw new Error(msg('errModeExcluded'));
    if (variant === 'disguised' && !req.password) throw new Error(msg('errNoPassword'));
    if (accessMode === 'duress' && (!req.duressPassword || !req.decoy)) {
      throw new Error(msg('errDuressInputs'));
    }
    if (accessMode === 'nonpossession' && !req.threshold) throw new Error(msg('errNoThreshold'));
    const { variant: saved, manifest } = await saveFileToBinary(file, req.key, {
      bundle,
      keyMode,
      variant,
      stego: req.stego,
      password: req.password,
      mode: accessMode,
      duressPassword: req.duressPassword,
      decoy: req.decoy,
      threshold: req.threshold,
      userEntropy: req.userEntropy,
      onProgress: req.onProgress,
    });
    return { note: binaryNote(msg, keyMode, saved), manifest };
  }

  // disk
  const { imageCount, manifest } = await saveFileToDisk(file, req.key, {
    bundle,
    keyMode,
    codecId: codecIdFor('disk', req.codec),
    label: req.label,
    asZip: req.asZip ?? true,
    stego: req.stego,
  });
  return { note: diskNote(msg, keyMode, imageCount), manifest };
}

/**
 * Shared save orchestration. The extension popup, the web app, and the guided
 * wizard all describe a save the same way (a `SaveRequest`) and call `runSave`,
 * so the branching over destination / key mode lives in exactly one place
 * instead of being copied into each surface's click handler.
 *
 * It wraps the destination flows in `disk.ts` / `paper.ts` / `google-photos.ts`
 * and returns a localized result note (via the caller's `msg`, since the
 * extension and web build use different i18n backends). Paper and cloud are
 * imported lazily so surfaces that never use them don't pull them into the
 * bundle.
 */

import {
  type BinaryVariant,
  type KeyMode,
  type VaultKey,
  WrongPasswordError,
  parseKeyBlock,
  unlockKeyBlock,
} from '@core';
import { saveFileToBinary, saveFileToDisk, saveGalleryToDisk } from './disk';

export type SaveDestination = 'disk' | 'paper' | 'binary' | 'sqlite' | 'cloud' | 'gallery';

/** A localizer with the same shape in both the extension and the web app. */
export type Msg = (key: string, subs?: string | string[]) => string;

/** For the 'stego' key mode: the cover photo and the password that keys it. */
export interface StegoInput {
  cover: File;
  password: string;
}

export interface SaveRequest {
  dest: SaveDestination;
  /** The secret to protect. */
  file: File;
  /**
   * The vault key for every destination except `gallery` (which derives its own
   * key from `galleryPassword`). The extension passes its managed session key;
   * the web app mints a fresh one per save.
   */
  key?: VaultKey | undefined;
  keyMode?: KeyMode;
  /** Readable title band drawn above disk images. */
  label?: { title?: string; date?: string } | undefined;
  asZip?: boolean | undefined;
  includeInstructions?: boolean;
  passwordHint?: string | undefined;
  keyLocation?: string | undefined;
  stego?: StegoInput | undefined;
  locale?: string | undefined;
  /** Gallery Mode only: the cover photos and its own password. */
  covers?: File[];
  galleryPassword?: string;
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

/** Run a save and return a localized result note. Throws on any failure. */
export async function runSave(req: SaveRequest, msg: Msg): Promise<{ note: string }> {
  if (req.dest === 'gallery') {
    const covers = req.covers ?? [];
    if (!req.galleryPassword) throw new Error('gallery mode requires a password');
    const keyMode = req.keyMode ?? 'embedded';
    const res = await saveGalleryToDisk(req.file, covers, req.galleryPassword, {
      keyMode,
      stego: req.stego,
    });
    return { note: galleryNote(msg, keyMode, res.imageCount) };
  }

  if (!req.key) throw new Error('a vault key is required');
  const keyMode = req.keyMode ?? 'embedded';

  if (req.dest === 'cloud') {
    const { saveToPhotos } = await import('./google-photos');
    const { imageCount, albumTitle } = await saveToPhotos(req.file, req.key, {
      keyMode,
      title: req.label?.title || undefined,
      date: req.label?.date,
    });
    return { note: msg('statusSavedCloud', [String(imageCount), albumTitle]) };
  }

  if (req.dest === 'paper') {
    const { saveFileToPaper } = await import('./paper');
    const { imageCount } = await saveFileToPaper(req.file, req.key, {
      keyMode,
      title: req.label?.title || undefined,
      date: req.label?.date,
      includeInstructions: req.includeInstructions,
      passwordHint: req.passwordHint,
      keyLocation: req.keyLocation,
      stego: req.stego,
      locale: req.locale,
    });
    return { note: msg('statusSavedPdf', String(imageCount)) };
  }

  if (req.dest === 'binary' || req.dest === 'sqlite') {
    // Two destinations map to the one binary container: 'binary' is a branded
    // .ssbn, 'sqlite' is disguised with a valid SQLite header (.db).
    const variant: BinaryVariant = req.dest === 'sqlite' ? 'disguised' : 'branded';
    const { variant: saved } = await saveFileToBinary(req.file, req.key, {
      keyMode,
      variant,
      stego: req.stego,
    });
    return { note: binaryNote(msg, keyMode, saved) };
  }

  // disk
  const { imageCount } = await saveFileToDisk(req.file, req.key, {
    keyMode,
    label: req.label,
    asZip: req.asZip ?? true,
    stego: req.stego,
  });
  return { note: diskNote(msg, keyMode, imageCount) };
}

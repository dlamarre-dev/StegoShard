/**
 * Shared restore orchestration — the mirror of `save-controller.ts`. Every
 * surface (extension popup, web app, guided wizard) describes a restore as a
 * `RestoreRequest` and calls `runRestore`, so the standard-vs-gallery branch
 * lives in one place. Returns a localized result note via the caller's `msg`.
 */

import { type OnProgress, decodeShareText, shamirRecover } from '@core';
import { restoreFileFromDisk, restoreGalleryFromDisk } from './disk';
import type { Msg } from './save-controller';

export type RestoreMode = 'standard' | 'gallery';

export interface RestoreRequest {
  mode: RestoreMode;
  files: File[];
  password: string;
  /** A `.key` file or a stego cover image (standard, or a keyfile/stego gallery). */
  keyFile?: File | undefined;
  /**
   * Non-possession (Mode B): the threshold share files (`.txt`) the holder gathered.
   * Any `k` of the `n` recover the gating secret; fewer leave the vault sealed.
   */
  shareFiles?: File[] | undefined;
  /** Standard mode only: already-decoded payloads (e.g. live camera captures). */
  extraPayloads?: Uint8Array[];
  /** Progress callback for the binary path (the slow, large-file container). */
  onProgress?: OnProgress;
}

// A dash-grouped Crockford-base32 token, so instruction prose in the share file
// is ignored (mirrors the CLI's recoverSecret).
const SHARE_TOKEN = /[0-9A-Za-z]{5}(?:-[0-9A-Za-z]{1,5})+/;

/** Recover the Mode B gating secret from the gathered share files, or undefined. */
async function recoverSecretFromShares(files: File[] | undefined): Promise<Uint8Array | undefined> {
  if (!files || files.length === 0) return undefined;
  const shares = await Promise.all(
    files.map(async (f) => {
      const text = await f.text();
      const match = SHARE_TOKEN.exec(text);
      return decodeShareText(match ? match[0] : text.trim());
    }),
  );
  return shamirRecover(shares);
}

/** Run a restore and return the recovered filename plus a localized note. */
export async function runRestore(
  req: RestoreRequest,
  msg: Msg,
): Promise<{ filename: string; note: string }> {
  const secret = await recoverSecretFromShares(req.shareFiles);
  const { filename } =
    req.mode === 'gallery'
      ? await restoreGalleryFromDisk(req.files, req.password, req.keyFile, secret)
      : await restoreFileFromDisk(
          req.files,
          req.password,
          req.keyFile,
          req.extraPayloads ?? [],
          req.onProgress,
          secret,
        );
  return { filename, note: msg('statusRestored', filename) };
}

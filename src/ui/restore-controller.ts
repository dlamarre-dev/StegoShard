/**
 * Shared restore orchestration — the mirror of `save-controller.ts`. Every
 * surface (extension popup, web app, guided wizard) describes a restore as a
 * `RestoreRequest` and calls `runRestore`, so the standard-vs-gallery branch
 * lives in one place. Returns a localized result note via the caller's `msg`.
 */

import { restoreFileFromDisk, restoreGalleryFromDisk } from './disk';
import type { Msg } from './save-controller';

export type RestoreMode = 'standard' | 'gallery';

export interface RestoreRequest {
  mode: RestoreMode;
  files: File[];
  password: string;
  /** A `.key` file or a stego cover image (standard, or a keyfile/stego gallery). */
  keyFile?: File | undefined;
  /** Standard mode only: already-decoded payloads (e.g. live camera captures). */
  extraPayloads?: Uint8Array[];
}

/** Run a restore and return the recovered filename plus a localized note. */
export async function runRestore(
  req: RestoreRequest,
  msg: Msg,
): Promise<{ filename: string; note: string }> {
  const { filename } =
    req.mode === 'gallery'
      ? await restoreGalleryFromDisk(req.files, req.password, req.keyFile)
      : await restoreFileFromDisk(req.files, req.password, req.keyFile, req.extraPayloads ?? []);
  return { filename, note: msg('statusRestored', filename) };
}

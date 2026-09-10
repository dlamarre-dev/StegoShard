/**
 * How a command's outcome reaches the caller.
 *
 * `run()` computes structured results and hands them here; this module decides
 * whether they become prose for a person or a document for a program. Keeping
 * the two behind one interface is what stops `--json` from sprinkling an
 * `if (json)` through every command branch, and it keeps the invariant both
 * modes depend on in one place: **results go to stdout, everything else to
 * stderr**. A stray write on the wrong stream breaks a pipeline in JSON mode and
 * a `| jq` in either.
 *
 * The presenter is stateful because warnings arrive before the result does
 * (`--password` is warned about while the password is still being resolved), and
 * the JSON envelope has to carry them alongside the result rather than ahead of
 * it.
 */

import {
  collapseManifest,
  type FilePurpose,
  type ManifestEntry,
  type OnProgress,
  type Progress,
} from '@core';
import type {
  GalleryRestoreResult,
  GallerySaveResult,
  RestoreResult,
  SaveResult,
} from '../api/node/commands';
import type { CliFailure } from './errors';
import type { CliIo } from './io';
import { t, type CliKey } from './i18n';

/** Machine-stable identifier for a non-fatal warning. Never localized. */
export type WarningCode =
  /** The password was typed on the command line, where the shell records it. */
  | 'PASSWORD_FLAG_VISIBLE'
  /** The entropy string was typed on the command line, likewise. */
  | 'ENTROPY_FLAG_VISIBLE'
  /** Above the length floor but weak, and explicitly acknowledged. */
  | 'WEAK_PASSWORD'
  /** A CJK font could not be found, so the PDF fell back. */
  | 'FONT_FALLBACK'
  /** The secret is large enough that the image count is worth mentioning. */
  | 'LARGE_SECRET'
  /**
   * The restored vault is OLDER than the newest export this machine recorded.
   * A warning, never a failure: the older copy may be the only one that survived,
   * and refusing to restore it would turn a detection into a denial of service.
   */
  | 'VAULT_ROLLBACK'
  /**
   * The vault carries an identity this machine has never seen, while others are
   * recorded. Informational: a first restore on a new machine looks exactly the
   * same as a substituted vault, and the registry cannot tell them apart.
   */
  | 'VAULT_UNKNOWN'
  /** The registry could not be read. Rollback detection is off for this run. */
  | 'VAULT_REGISTRY_UNREADABLE'
  /**
   * The vault was written, but the registry could not be. A warning rather than
   * a failure because the artifact the user asked for exists: reporting the save
   * as failed would invite a caller to retry, or to clean up a real vault. The
   * cost is that the next export of this label reuses the number.
   */
  | 'VAULT_REGISTRY_UNWRITABLE';

export interface CliWarning {
  code: WarningCode;
  /** Already localized, except where the source string is English-only. */
  message: string;
  details?: Record<string, string | number>;
}

export interface EstimateResult {
  images: number;
  k: number;
  m: number;
}

/**
 * One method per thing a command can produce. Implementations must write results
 * to `io.out` and nothing else to it.
 */
export interface Presenter {
  /** Record a non-fatal warning. Emitted immediately and, in JSON, again with the result. */
  warn(warning: CliWarning): void;
  /**
   * A short factual line that is neither a warning nor part of the result: the
   * vault identity counter, today. Human output prints it; JSON collects it into
   * an additive `notes` array, which per docs/VERSIONING.md §3 does not bump the
   * schema.
   */
  note(text: string): void;
  progress(quiet: boolean): { onProgress?: OnProgress; done: () => void };
  save(res: SaveResult): void;
  restore(res: RestoreResult): void;
  gallerySave(res: GallerySaveResult): void;
  galleryRestore(res: GalleryRestoreResult): void;
  estimate(res: EstimateResult): void;
  /**
   * The command failed. The human presenter writes nothing (the bootstrap owns
   * that), so this exists for JSON, where the failure is itself the document a
   * caller parses off stdout.
   */
  failure(failure: CliFailure, err: unknown): void;
}

/** Plain-English purpose for each produced file (the app localizes the same set). */
const PURPOSE_KEYS = {
  vault: 'purposeVault',
  archive: 'purposeArchive',
  document: 'purposeDocument',
  photos: 'purposePhotos',
  keyfile: 'purposeKeyfile',
  stegoCover: 'purposeStegoCover',
  share: 'purposeShare',
} as const satisfies Record<FilePurpose, CliKey>;

/**
 * "Files created" block for the end of a save.
 *
 * Every destination gets one, not just the deniable ones: `cache.db` and
 * `recovery-1.txt` are anonymous by design, and `stegoshard-a1b2-07.png` still
 * does not say which file holds the key. Numbered runs collapse to first … last
 * so a 40-image save stays readable.
 */
function manifestLines(manifest: readonly ManifestEntry[]): string {
  if (manifest.length === 0) return '';
  const groups = collapseManifest(manifest);
  const rendered = groups.map((g) => ({
    name: g.count > 1 ? `${g.first} … ${g.last}` : g.first,
    text: g.count > 1 ? `${t(PURPOSE_KEYS[g.purpose])} (${g.count})` : t(PURPOSE_KEYS[g.purpose]),
  }));
  const width = Math.max(...rendered.map((r) => r.name.length));
  return `${t('outFilesCreated')}\n${rendered
    .map((r) => `  ${r.name.padEnd(width)}  ${r.text}`)
    .join('\n')}\n`;
}

/**
 * What a restore produced. A bundle unpacks to several files, so naming the
 * envelope ("bundle.zip") and one output path would describe neither.
 */
function restoredLine(res: { filename: string; files: string[] }): string {
  const files = res.files;
  if (files.length === 1) {
    return `${t('outRestoredOne', { name: res.filename, path: files[0]! })}\n`;
  }
  return `${t('outRestoredMany', { count: files.length })}\n${files
    .map((f) => `  ${f}`)
    .join('\n')}\n`;
}

const PHASE_KEYS = {
  compress: 'phaseCompress',
  encrypt: 'phaseEncrypt',
  decrypt: 'phaseDecrypt',
  verify: 'phaseVerify',
  unlock: 'phaseUnlock',
  render: 'phaseRender',
} as const satisfies Record<Progress['phase'], CliKey>;

/**
 * The terminal presenter: exactly the output StegoShard has always produced.
 *
 * Results and the manifest go to stdout; progress, warnings and counts go to
 * stderr, so `stegoshard restore … > out` and `| jq` both stay usable.
 */
export function humanPresenter(io: CliIo): Presenter {
  return {
    warn(warning) {
      io.err(`${warning.message}\n`);
    },

    note(text) {
      io.err(`${text}\n`);
    },

    /**
     * A progress reporter on stderr. On a TTY it redraws a single line with a
     * live percentage; when piped it emits one plain line per phase change.
     * Returns no callback when quiet, plus a `done()` to finish the line.
     */
    progress(quiet) {
      if (quiet) return { done: () => {} };
      const tty = Boolean(io.isStderrTty);
      let lastLabel = '';
      let wroteTty = false;
      const onProgress: OnProgress = (p) => {
        const key = PHASE_KEYS[p.phase];
        const label = key ? t(key) : p.phase;
        if (tty) {
          const suffix = p.total > 0 ? `… ${Math.floor((p.done / p.total) * 100)}%` : '…';
          io.err(`\r\x1b[2K${label}${suffix}`);
          wroteTty = true;
        } else if (label !== lastLabel) {
          io.err(`${label}…\n`);
          lastLabel = label;
        }
      };
      return {
        onProgress,
        done: () => {
          if (tty && wroteTty) io.err('\r\x1b[2K');
        },
      };
    },

    save(res) {
      const what = res.binary
        ? t('outSavedBinary', { variant: res.binary, keyMode: res.keyMode })
        : t('outSavedImages', { count: res.imageCount, keyMode: res.keyMode });
      io.out(`${t('outSaved', { what })}\n${manifestLines(res.manifest)}`);
      if (res.keyMode !== 'embedded') io.out(`${t('outKeepKeyArtifact')}\n`);
    },

    restore(res) {
      io.err(`${t('outDecoded', { decoded: res.decoded, seen: res.seen })}\n`);
      io.out(restoredLine(res));
    },

    gallerySave(res) {
      io.out(
        `${t('outSavedGallery', {
          files: res.files.length,
          k: res.k,
          m: res.m,
          decoys: res.decoys,
          keyMode: res.keyMode,
        })}\n${manifestLines(res.manifest)}`,
      );
      io.out(`${t('outGalleryKeep', { k: res.k })}\n`);
      if (res.keyMode !== 'embedded') io.out(`${t('outGalleryKeepKey')}\n`);
    },

    galleryRestore(res) {
      io.err(`${t('outScanned', { seen: res.seen })}\n`);
      io.out(restoredLine(res));
    },

    estimate(res) {
      io.out(`${t('outEstimate', { images: res.images, k: res.k, m: res.m })}\n`);
    },

    failure() {
      // The bootstrap in main.ts writes the message and picks the exit code, so
      // that a failure looks the same whether it came from run() or from the
      // parse that precedes it.
    },
  };
}

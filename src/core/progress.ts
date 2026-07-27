/**
 * Progress reporting shared by the CLI (stderr) and the browser UI (a Web Worker
 * that maps these events to postMessage → a progress bar). A framework-agnostic
 * callback so the core stays pure and browser-agnostic.
 *
 * `onProgress` is always an OPTIONAL, trailing parameter on the functions that
 * accept it; `undefined` is a no-op, so adding it is fully back-compatible.
 */

export interface Progress {
  /**
   * Which stage is running. `encrypt`/`decrypt` report real byte counts (the
   * filling bar); `compress`/`unlock` are coarse milestones; `verify` mirrors
   * the post-save re-decrypt; `render` is per-image on the image path.
   */
  phase: 'compress' | 'encrypt' | 'decrypt' | 'verify' | 'unlock' | 'render';
  /** Work done so far (bytes for encrypt/decrypt/compress; items for render). */
  done: number;
  /** Expected total; `0` means indeterminate (show a spinner, not a percentage). */
  total: number;
}

export type OnProgress = (p: Progress) => void;

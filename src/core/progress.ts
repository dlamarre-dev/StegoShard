/**
 * Progress reporting shared by the CLI (stderr) and the browser UI (a Web Worker
 * that maps these events to postMessage → a progress bar). A framework-agnostic
 * callback so the core stays pure and browser-agnostic.
 *
 * `onProgress` is always an OPTIONAL, trailing parameter on the functions that
 * accept it; `undefined` is a no-op, so adding it is fully back-compatible.
 *
 * Events describe one phase at a time. What turns them into a single bar that
 * tracks the whole operation is `progress-plan.ts`, which knows the order the
 * phases come in and how long each one takes.
 */

export interface Progress {
  /**
   * Which stage is running.
   *
   * - `encrypt`/`decrypt` report real byte counts; `render`, `reencode`,
   *   `prepare`, `embed`, `extract` and `deliver` count items (images, covers,
   *   pages, files).
   * - `compress`, `unlock`, `derive`, `verify` are opaque: a `0/1` (or `0/0`)
   *   when they start and a `1/1` when they end. `derive` is a password key
   *   derivation (Argon2id), which is one uninterruptible computation.
   */
  phase:
    | 'compress'
    | 'encrypt'
    | 'decrypt'
    | 'verify'
    | 'unlock'
    | 'render'
    | 'derive'
    | 'prepare'
    | 'reencode'
    | 'embed'
    | 'extract'
    | 'deliver';
  /** Work done so far (bytes for encrypt/decrypt/compress; items for the rest). */
  done: number;
  /** Expected total; `0` means indeterminate (show a spinner, not a percentage). */
  total: number;
}

/**
 * A progress callback. It may return a promise, and the core awaits it at the
 * start of an opaque stage (see `opaqueStage`): that is the one moment a browser
 * has to paint before a long computation blocks its main thread, and a UI that
 * wants the bar visibly moving through the block returns a promise that resolves
 * on the next frame. Returning nothing costs a microtask.
 */
export type OnProgress = (p: Progress) => void | Promise<void>;

/**
 * Deliver one event and wait for the callback if it asked to be waited for.
 *
 * A callback that throws or rejects is ignored: progress is a display, and a
 * broken display must never fail the save it is describing.
 */
export async function report(on: OnProgress | undefined, p: Progress): Promise<void> {
  if (!on) return;
  try {
    await on(p);
  } catch {
    // A progress display failing is not the operation failing.
  }
}

/**
 * Run `fn` as one opaque stage: `0/1` before, `1/1` after.
 *
 * The start event is awaited, so a UI can commit its animation before `fn`
 * (typically an Argon2 derivation) blocks the thread. The end event is sent only
 * on success; a failure leaves the stage open, and the caller's error handling
 * takes the bar down.
 */
export async function opaqueStage<T>(
  on: OnProgress | undefined,
  phase: Progress['phase'],
  fn: () => Promise<T>,
): Promise<T> {
  await report(on, { phase, done: 0, total: 1 });
  const out = await fn();
  await report(on, { phase, done: 1, total: 1 });
  return out;
}

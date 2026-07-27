/**
 * Main-thread wrapper around the pipeline worker (src/ui/pipeline.worker.ts).
 * Exposes promise-returning helpers for the binary encrypt/decrypt path that
 * forward `onProgress` events and rebuild typed core errors so the existing
 * `friendlyError` (which uses `instanceof`) still localizes them.
 *
 * A single lazily-created module worker is reused across calls (keeping the
 * ~256 MiB Argon2 heap warm); requests are multiplexed by a numeric id.
 */

import {
  FileTooLargeError,
  MissingKeyError,
  SegmentedFormatError,
  VerificationError,
  WrongPasswordError,
  type BinaryVariant,
  type KeyMode,
  type OnProgress,
  type VaultKey,
  exportDekRaw,
} from '@core';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  onProgress?: OnProgress | undefined;
}

let worker: Worker | undefined;
const pending = new Map<number, Pending>();
let nextId = 1;

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (ev: MessageEvent) => {
    const data = ev.data as { id: number; type: string; [k: string]: unknown };
    const p = pending.get(data.id);
    if (!p) return;
    if (data.type === 'progress') {
      p.onProgress?.(data.p as Parameters<OnProgress>[0]);
      return;
    }
    pending.delete(data.id);
    if (data.type === 'error') {
      p.reject(reconstructError(data));
    } else {
      p.resolve(data);
    }
  };
  w.onerror = () => {
    // A worker-level failure (e.g. a load error) rejects everything in flight so
    // callers surface an error instead of hanging forever.
    const err = new Error('pipeline worker crashed');
    for (const [, p] of pending) p.reject(err);
    pending.clear();
    worker = undefined;
  };
  worker = w;
  return w;
}

function reconstructError(data: Record<string, unknown>): Error {
  const name = typeof data.name === 'string' ? data.name : 'Error';
  const message = typeof data.message === 'string' ? data.message : 'worker error';
  const extra = data.extra as { size?: number; limit?: number } | undefined;
  switch (name) {
    case 'WrongPasswordError':
      return new WrongPasswordError();
    case 'MissingKeyError':
      return new MissingKeyError();
    case 'VerificationError':
      return new VerificationError();
    case 'SegmentedFormatError':
      return new SegmentedFormatError(message.replace(/^segmented vault: /, ''));
    case 'FileTooLargeError':
      return extra && typeof extra.size === 'number' && typeof extra.limit === 'number'
        ? new FileTooLargeError(extra.size, extra.limit)
        : Object.assign(new Error(message), { name });
    default:
      return Object.assign(new Error(message), { name });
  }
}

function call<T>(
  message: Record<string, unknown>,
  transfer: Transferable[],
  onProgress?: OnProgress,
): Promise<T> {
  const w = getWorker();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
    w.postMessage({ id, ...message }, transfer);
  });
}

/** Encrypt + verify a file into a binary container, off the main thread. */
export async function encryptBinaryInWorker(
  filename: string,
  content: Uint8Array,
  key: VaultKey,
  keyMode: KeyMode,
  variant: BinaryVariant,
  onProgress?: OnProgress,
): Promise<Uint8Array> {
  // Fresh, independent copy of the DEK bytes — safe to transfer. The key block is
  // small and reused by the caller, so it is copied (not transferred).
  const rawDek = await exportDekRaw(key.dek);
  const res = await call<{ container: Uint8Array }>(
    { op: 'encryptBinary', filename, content, rawDek, keyBlock: key.keyBlock, keyMode, variant },
    [content.buffer, rawDek.buffer],
    onProgress,
  );
  return res.container;
}

/** Decrypt a binary container back to { filename, content }, off the main thread. */
export async function decryptBinaryInWorker(
  container: Uint8Array,
  password: string,
  keyBlock: Uint8Array | undefined,
  onProgress?: OnProgress,
): Promise<{ filename: string; content: Uint8Array }> {
  return call<{ filename: string; content: Uint8Array }>(
    { op: 'decryptBinary', container, password, keyBlock },
    [container.buffer],
    onProgress,
  );
}

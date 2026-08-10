/**
 * Main-thread wrapper around the pipeline worker (src/ui/pipeline.worker.ts).
 * Exposes promise-returning helpers for the binary encrypt/decrypt path that
 * forward `onProgress` events and rebuild typed core errors so the existing
 * `friendlyError` (which uses `instanceof`) still localizes them.
 *
 * A single lazily-created module worker is reused across calls (keeping the
 * ~256 MiB Argon2 heap warm). Requests are serialized: the optional entropy
 * mixer is module-global inside the worker and must never overlap operations.
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

interface Queued extends Pending {
  id: number;
  message: Record<string, unknown>;
  transfer: Transferable[];
}

let worker: Worker | undefined;
const pending = new Map<number, Pending>();
const queue: Queued[] = [];
let activeId: number | undefined;
let nextId = 1;

function pump(): void {
  while (activeId === undefined && queue.length > 0) {
    const next = queue.shift()!;
    activeId = next.id;
    pending.set(next.id, next);
    try {
      getWorker().postMessage({ id: next.id, ...next.message }, next.transfer);
      return;
    } catch (err) {
      // Dispatch can fail synchronously — workers blocked by policy, or a
      // transfer list the structured clone cannot handle. The slot was already
      // marked busy above, and no reply will ever arrive to free it, so unwind
      // it here: without this the queue stays pinned to a dead id and every
      // later request hangs forever. `worker` is deliberately left alone: if
      // `new Worker` threw it was never assigned (so the next call retries the
      // construction), and if `postMessage` threw the worker itself is still
      // healthy and worth keeping warm.
      pending.delete(next.id);
      activeId = undefined;
      next.reject(err);
    }
  }
}

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
    activeId = undefined;
    if (data.type === 'error') {
      p.reject(reconstructError(data));
    } else {
      p.resolve(data);
    }
    pump();
  };
  w.onerror = () => {
    // A worker-level failure (e.g. a load error) rejects everything in flight so
    // callers surface an error instead of hanging forever.
    const err = new Error('pipeline worker crashed');
    for (const [, p] of pending) p.reject(err);
    for (const p of queue) p.reject(err);
    pending.clear();
    queue.length = 0;
    activeId = undefined;
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
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    queue.push({
      id,
      message,
      transfer,
      resolve: resolve as (v: unknown) => void,
      reject,
      onProgress,
    });
    pump();
  });
}

/** Encrypt + verify a file into a binary container, off the main thread. */
export async function encryptBinaryInWorker(
  filename: string,
  content: Uint8Array,
  key: VaultKey,
  keyMode: KeyMode,
  variant: BinaryVariant,
  userEntropy?: string | undefined,
  onProgress?: OnProgress,
  bundle = false,
): Promise<Uint8Array> {
  // Fresh, independent copy of the DEK bytes — safe to transfer. The key block is
  // small and reused by the caller, so it is copied (not transferred).
  const rawDek = await exportDekRaw(key.dek);
  const res = await call<{ container: Uint8Array }>(
    {
      op: 'encryptBinary',
      filename,
      content,
      rawDek,
      keyBlock: key.keyBlock,
      keyMode,
      variant,
      userEntropy,
      bundle,
    },
    [content.buffer, rawDek.buffer],
    onProgress,
  );
  return res.container;
}

/**
 * Encrypt + verify a file into a disguised `.db` container (§10 multi-region),
 * off the main thread. Keyed by the password (no managed DEK); returns the
 * container plus the generated 32-byte key factor (empty for embedded mode).
 */
export async function encryptBinaryDisguisedInWorker(
  filename: string,
  content: Uint8Array,
  password: string,
  keyMode: KeyMode,
  userEntropy?: string | undefined,
  onProgress?: OnProgress,
  bundle = false,
): Promise<{ container: Uint8Array; keyBlock: Uint8Array }> {
  const res = await call<{ container: Uint8Array; keyBlock: Uint8Array }>(
    { op: 'encryptBinaryDisguised', filename, content, password, keyMode, userEntropy, bundle },
    [content.buffer],
    onProgress,
  );
  return { container: res.container, keyBlock: res.keyBlock };
}

/** Decrypt a binary container back to { filename, content }, off the main thread.
 *  `secret` is the recovered Shamir S for a Mode B (threshold-gated) .db vault. */
export async function decryptBinaryInWorker(
  container: Uint8Array,
  password: string,
  keyBlock: Uint8Array | undefined,
  secret?: Uint8Array | undefined,
  onProgress?: OnProgress,
): Promise<{ filename: string; content: Uint8Array; bundled: boolean }> {
  return call<{ filename: string; content: Uint8Array; bundled: boolean }>(
    { op: 'decryptBinary', container, password, keyBlock, secret },
    [container.buffer],
    onProgress,
  );
}

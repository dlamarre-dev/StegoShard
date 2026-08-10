/**
 * Pipeline worker: runs the binary (.ssbn/.db) crypto off the main thread so the
 * UI stays responsive and a progress bar can animate. Only the byte-core runs
 * here — file reading, PNG rasterization, and downloads stay on the page (they
 * need the DOM). See src/ui/run-in-worker.ts for the caller-side wrapper.
 *
 * Messages in:  { id, op:'encryptBinary'|'decryptBinary', ... } (see RunReq).
 * Messages out: { id, type:'progress', p } | { id, type:'result', ... }
 *               | { id, type:'error', name, message, extra? }.
 * The DEK crosses only as raw bytes (never a CryptoKey); large buffers are
 * transferred, not copied.
 */

/// <reference lib="webworker" />

import {
  FileTooLargeError,
  MAX_FILE_BYTES_BINARY_UI,
  type BinaryVariant,
  type KeyMode,
  type OnProgress,
  clearUserEntropy,
  exportVaultBinary,
  exportVaultBinaryDisguised,
  importDek,
  installUserEntropy,
  importVaultBinary,
  verifyBinaryExport,
  verifyDisguisedExport,
} from '@core';

type RunReq =
  | {
      id: number;
      op: 'encryptBinary';
      filename: string;
      content: Uint8Array;
      rawDek: Uint8Array;
      keyBlock: Uint8Array;
      keyMode: KeyMode;
      variant: BinaryVariant;
      /** Expert extra entropy: this thread has its own module state, so the
       *  layer installed on the page does not reach here on its own. */
      userEntropy?: string | undefined;
      bundle?: boolean | undefined;
    }
  | {
      id: number;
      op: 'encryptBinaryDisguised';
      filename: string;
      content: Uint8Array;
      password: string;
      keyMode: KeyMode;
      userEntropy?: string | undefined;
      bundle?: boolean | undefined;
    }
  | {
      id: number;
      op: 'decryptBinary';
      container: Uint8Array;
      password: string;
      keyBlock?: Uint8Array;
      secret?: Uint8Array;
    };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function errorPayload(id: number, err: unknown) {
  const e = err instanceof Error ? err : new Error(String(err));
  const extra = e instanceof FileTooLargeError ? { size: e.size, limit: e.limit } : undefined;
  return { id, type: 'error' as const, name: e.name, message: e.message, extra };
}

interface Reply {
  message: Record<string, unknown>;
  transfer: Transferable[];
}

async function runEncrypt(req: Extract<RunReq, { op: 'encryptBinary' }>): Promise<Reply> {
  const onProgress: OnProgress = (p) => ctx.postMessage({ id: req.id, type: 'progress', p });
  const dek = await importDek(req.rawDek);
  req.rawDek.fill(0);
  const key = { dek, keyBlock: req.keyBlock };
  if (req.userEntropy) await installUserEntropy(req.userEntropy);
  try {
    const { container } = await exportVaultBinary(
      req.filename,
      req.content,
      key,
      {
        keyMode: req.keyMode,
        variant: req.variant,
        maxBytes: MAX_FILE_BYTES_BINARY_UI,
        bundle: req.bundle,
      },
      onProgress,
    );
    await verifyBinaryExport(container, dek, req.filename, req.content, onProgress);
    return { message: { id: req.id, type: 'result', container }, transfer: [container.buffer] };
  } finally {
    // The worker is long-lived and reused across saves: never let one save's
    // entropy layer linger into the next request.
    clearUserEntropy();
    req.content.fill(0);
  }
}

async function runEncryptDisguised(
  req: Extract<RunReq, { op: 'encryptBinaryDisguised' }>,
): Promise<Reply> {
  const onProgress: OnProgress = (p) => ctx.postMessage({ id: req.id, type: 'progress', p });
  // The disguised .db path derives its slot KEK from the password (each region has
  // its own DEK), so no managed key crosses to the worker here. The generated key
  // factor (keyfile mode) is returned so the page can deliver the .key.
  if (req.userEntropy) await installUserEntropy(req.userEntropy);
  try {
    const { container, keyBlock, regionIndex, dek } = await exportVaultBinaryDisguised(
      req.filename,
      req.content,
      req.password,
      { keyMode: req.keyMode, maxBytes: MAX_FILE_BYTES_BINARY_UI, bundle: req.bundle },
      onProgress,
    );
    await verifyDisguisedExport(container, dek, regionIndex, req.filename, req.content, onProgress);
    return {
      message: { id: req.id, type: 'result', container, keyBlock },
      transfer: [container.buffer],
    };
  } finally {
    clearUserEntropy();
    req.content.fill(0);
  }
}

async function runDecrypt(req: Extract<RunReq, { op: 'decryptBinary' }>): Promise<Reply> {
  const onProgress: OnProgress = (p) => ctx.postMessage({ id: req.id, type: 'progress', p });
  const { filename, content, bundled } = await importVaultBinary(
    req.container,
    req.password,
    { keyBlock: req.keyBlock, secret: req.secret ?? null, maxBytes: MAX_FILE_BYTES_BINARY_UI },
    onProgress,
  );
  return {
    message: { id: req.id, type: 'result', filename, content, bundled },
    transfer: [content.buffer],
  };
}

// Dispatch by operation via a fixed table rather than a branch, so the op is a
// lookup key into a closed handler set — there is no request-controlled condition
// guarding a crypto action.
const HANDLERS: { [K in RunReq['op']]: (req: Extract<RunReq, { op: K }>) => Promise<Reply> } = {
  encryptBinary: runEncrypt,
  encryptBinaryDisguised: runEncryptDisguised,
  decryptBinary: runDecrypt,
};

ctx.onmessage = async (ev: MessageEvent<RunReq>) => {
  // A dedicated worker only ever receives messages from its same-origin creating
  // context; its message events carry an empty origin, so this never rejects a
  // legitimate message, but it rejects any message bearing an unexpected origin.
  if (ev.origin && ev.origin !== ctx.location.origin) return;
  const req = ev.data;
  const handler = HANDLERS[req.op] as ((r: RunReq) => Promise<Reply>) | undefined;
  if (!handler) {
    // Unknown/malformed op: reply with an error so the caller's promise rejects
    // instead of hanging forever. (Internal callers only ever send known ops.)
    ctx.postMessage(errorPayload(req.id, new Error(`unknown worker op: ${String(req.op)}`)));
    return;
  }
  try {
    const { message, transfer } = await handler(req);
    ctx.postMessage(message, transfer);
  } catch (err) {
    ctx.postMessage(errorPayload(req.id, err));
  }
};

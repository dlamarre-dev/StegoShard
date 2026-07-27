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
  exportVaultBinary,
  importDek,
  importVaultBinary,
  verifyBinaryExport,
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
    }
  | {
      id: number;
      op: 'decryptBinary';
      container: Uint8Array;
      password: string;
      keyBlock?: Uint8Array;
    };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function errorPayload(id: number, err: unknown) {
  const e = err instanceof Error ? err : new Error(String(err));
  const extra = e instanceof FileTooLargeError ? { size: e.size, limit: e.limit } : undefined;
  return { id, type: 'error' as const, name: e.name, message: e.message, extra };
}

ctx.onmessage = async (ev: MessageEvent<RunReq>) => {
  const req = ev.data;
  const onProgress: OnProgress = (p) => ctx.postMessage({ id: req.id, type: 'progress', p });
  try {
    if (req.op === 'encryptBinary') {
      const dek = await importDek(req.rawDek);
      const key = { dek, keyBlock: req.keyBlock };
      const { container } = await exportVaultBinary(
        req.filename,
        req.content,
        key,
        { keyMode: req.keyMode, variant: req.variant, maxBytes: MAX_FILE_BYTES_BINARY_UI },
        onProgress,
      );
      await verifyBinaryExport(container, dek, req.filename, req.content, onProgress);
      ctx.postMessage({ id: req.id, type: 'result', container }, [container.buffer]);
    } else {
      const { filename, content } = await importVaultBinary(
        req.container,
        req.password,
        req.keyBlock ? { keyBlock: req.keyBlock } : {},
        onProgress,
      );
      ctx.postMessage({ id: req.id, type: 'result', filename, content }, [content.buffer]);
    }
  } catch (err) {
    ctx.postMessage(errorPayload(req.id, err));
  }
};

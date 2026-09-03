/**
 * JSON-RPC 2.0 over newline-delimited stdio, hand-rolled.
 *
 * MCP's stdio transport is one JSON object per line in each direction: no
 * `Content-Length` framing, no SSE, no authentication. That is about a hundred
 * lines, and writing them is cheaper than the alternative.
 *
 * **Why not `@modelcontextprotocol/sdk`.** StegoShard has six runtime
 * dependencies. The SDK brings express, cors, raw-body, eventsource,
 * pkce-challenge, zod, ajv and their transitives, all of which would become
 * production dependencies: in `THIRD_PARTY_NOTICES.txt`, which is byte-exact and
 * gated on every PR, in the SBOM, and in `npm audit --omit=dev`. It would also
 * put an HTTP server and an OAuth implementation inside
 * `dist-cli/stegoshard.js`, the same artifact `docs/CLAIMS.md` row 1 covers and
 * that `deno compile` ships without `--allow-net`. The claim would remain true
 * and would look false to anyone auditing the bundle, which is worse than a
 * dependency: it is a dependency that costs credibility.
 *
 * The honest cost is no schema-validation library and protocol revisions tracked
 * by hand. `tools.ts` validates every argument explicitly, and the version list
 * below is pinned rather than negotiated open-endedly.
 */

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** Protocol revisions this server knows. The first is what it prefers. */
export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** Standard JSON-RPC 2.0 error codes, plus the two we actually raise. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export type RpcId = string | number | null;

export interface RpcRequest {
  jsonrpc: '2.0';
  id?: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

/** Thrown by a handler to answer with a JSON-RPC error rather than a result. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export type RpcHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

export interface RpcStreams {
  input: Readable;
  output: Writable;
  /** Diagnostics. Never stdout: that stream *is* the protocol. */
  log?: (text: string) => void;
}

/**
 * Serve JSON-RPC until the input stream ends.
 *
 * Requests are handled **in sequence**. A save is CPU- and memory-heavy (Argon2id
 * at 256 MiB), and an agent that pipelined three of them would multiply that by
 * three for no benefit; ordering is also one less thing for a hand-rolled loop to
 * get wrong.
 */
export async function serveRpc(streams: RpcStreams, handle: RpcHandler): Promise<void> {
  const { input, output, log } = streams;
  const write = (msg: unknown) => output.write(`${JSON.stringify(msg)}\n`);

  const reply = (id: RpcId, result: unknown) => write({ jsonrpc: '2.0', id, result });
  const fail = (id: RpcId, error: RpcErrorBody) => write({ jsonrpc: '2.0', id, error });

  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === '') continue;

    let msg: RpcRequest;
    try {
      msg = JSON.parse(line) as RpcRequest;
    } catch {
      // A malformed line must not kill the loop: the peer may recover, and a
      // server that exits on one bad byte is a server that loses a session to a
      // truncated write.
      fail(null, { code: RPC.PARSE_ERROR, message: 'invalid JSON' });
      continue;
    }

    if (typeof msg !== 'object' || msg === null || typeof msg.method !== 'string') {
      fail(msg?.id ?? null, { code: RPC.INVALID_REQUEST, message: 'not a JSON-RPC request' });
      continue;
    }

    // No `id` means a notification: JSON-RPC forbids answering it at all.
    const isNotification = msg.id === undefined;

    try {
      const result = await handle(msg.method, msg.params);
      if (!isNotification) reply(msg.id ?? null, result);
    } catch (err) {
      if (isNotification) {
        log?.(`error handling notification ${msg.method}: ${String(err)}\n`);
        continue;
      }
      if (err instanceof RpcError) {
        fail(msg.id ?? null, {
          code: err.code,
          message: err.message,
          ...(err.data !== undefined ? { data: err.data } : {}),
        });
      } else {
        fail(msg.id ?? null, {
          code: RPC.INTERNAL_ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

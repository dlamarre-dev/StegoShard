/**
 * The JSON-RPC loop, driven through fake streams.
 *
 * Hand-rolling the transport means these are the tests that stand in for a
 * library's own test suite. They pin the framing rules a peer relies on: one
 * response per request, none for a notification, ids echoed, and a malformed
 * line answered rather than fatal.
 */

import { Readable, Writable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { RPC, RpcError, serveRpc, type RpcHandler } from './rpc';

/** Feed `lines` in, collect the parsed responses. */
async function exchange(lines: string[], handle: RpcHandler): Promise<Record<string, unknown>[]> {
  const input = Readable.from([lines.map((l) => `${l}\n`).join('')]);
  let out = '';
  const output = new Writable({
    write(chunk, _enc, cb) {
      out += String(chunk);
      cb();
    },
  });
  await serveRpc({ input, output }, handle);
  return out
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const echo: RpcHandler = (method, params) => ({ method, params });

describe('framing', () => {
  it('answers one request with one response, echoing the id', async () => {
    const res = await exchange(['{"jsonrpc":"2.0","id":7,"method":"ping"}'], () => ({}));
    expect(res).toHaveLength(1);
    expect(res[0]).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
  });

  it('echoes a string id unchanged', async () => {
    const res = await exchange(['{"jsonrpc":"2.0","id":"abc","method":"ping"}'], () => ({}));
    expect(res[0]!.id).toBe('abc');
  });

  // JSON-RPC forbids replying to a notification. A client that receives one
  // treats it as a protocol violation.
  it('sends nothing back for a notification', async () => {
    const res = await exchange(['{"jsonrpc":"2.0","method":"notifications/initialized"}'], echo);
    expect(res).toEqual([]);
  });

  it('handles requests in order', async () => {
    const res = await exchange(
      [1, 2, 3].map((id) => `{"jsonrpc":"2.0","id":${id},"method":"ping"}`),
      // Resolve out of order on purpose: the loop must still serialize.
      async (_m, p) => {
        await new Promise((r) => setTimeout(r, 5));
        return p ?? {};
      },
    );
    expect(res.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('ignores blank lines', async () => {
    const res = await exchange(['', '{"jsonrpc":"2.0","id":1,"method":"ping"}', ''], () => ({}));
    expect(res).toHaveLength(1);
  });
});

describe('malformed input', () => {
  // A server that exits on one bad byte loses a session to a truncated write.
  it('answers a parse error and keeps going', async () => {
    const res = await exchange(
      ['not json at all', '{"jsonrpc":"2.0","id":2,"method":"ping"}'],
      () => ({}),
    );
    expect(res).toHaveLength(2);
    expect(res[0]).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: RPC.PARSE_ERROR, message: 'invalid JSON' },
    });
    expect(res[1]!.id).toBe(2);
  });

  it('rejects a message with no method', async () => {
    const res = await exchange(['{"jsonrpc":"2.0","id":3}'], () => ({}));
    expect((res[0]!.error as { code: number }).code).toBe(RPC.INVALID_REQUEST);
    expect(res[0]!.id).toBe(3);
  });

  it('rejects a bare JSON value', async () => {
    const res = await exchange(['42'], () => ({}));
    expect((res[0]!.error as { code: number }).code).toBe(RPC.INVALID_REQUEST);
  });
});

describe('handler failures', () => {
  it('passes an RpcError through with its code', async () => {
    const res = await exchange(['{"jsonrpc":"2.0","id":1,"method":"nope"}'], () => {
      throw new RpcError(RPC.METHOD_NOT_FOUND, 'unknown method: nope');
    });
    expect(res[0]!.error).toEqual({
      code: RPC.METHOD_NOT_FOUND,
      message: 'unknown method: nope',
    });
  });

  it('carries an RpcError data payload when there is one', async () => {
    const res = await exchange(['{"jsonrpc":"2.0","id":1,"method":"x"}'], () => {
      throw new RpcError(RPC.INVALID_PARAMS, 'bad', { field: 'inputs' });
    });
    expect((res[0]!.error as { data: unknown }).data).toEqual({ field: 'inputs' });
  });

  it('turns an unexpected throw into an internal error rather than dying', async () => {
    const res = await exchange(
      ['{"jsonrpc":"2.0","id":1,"method":"x"}', '{"jsonrpc":"2.0","id":2,"method":"x"}'],
      (_m, p) => {
        if (p === undefined) throw new Error('boom');
        return {};
      },
    );
    expect((res[0]!.error as { code: number }).code).toBe(RPC.INTERNAL_ERROR);
    expect((res[0]!.error as { message: string }).message).toBe('boom');
    // And the second request is still served.
    expect(res[1]!.id).toBe(2);
  });

  it('does not answer a notification that threw', async () => {
    const logged: string[] = [];
    const input = Readable.from(['{"jsonrpc":"2.0","method":"x"}\n']);
    let out = '';
    const output = new Writable({
      write(c, _e, cb) {
        out += String(c);
        cb();
      },
    });
    await serveRpc({ input, output, log: (t) => logged.push(t) }, () => {
      throw new Error('boom');
    });
    expect(out).toBe('');
    expect(logged.join('')).toContain('boom');
  });
});

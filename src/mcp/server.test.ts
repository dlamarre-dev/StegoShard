/**
 * The server end to end: a real session over fake streams.
 *
 * Two properties matter more than any individual response.
 *
 * **stdout carries JSON-RPC and nothing else.** It *is* the protocol here, so a
 * stray write of any kind corrupts the session. That is the single most likely
 * bug in a transport written by hand, and the same assertion class the `--json`
 * mode needs, which is why both surfaces get one.
 *
 * **The server opens no socket.** The claim in docs/CLAIMS.md rests on it, so it
 * is checked mechanically against the source rather than asserted in prose.
 */

import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { runMcp } from './server';
import type { CliIo } from '../cli/io';

const SLOW = { timeout: 90_000 };
const PW = 'a long unrelated passphrase for the mcp server test';
const tmp = () => mkdtempSync(join(tmpdir(), 'ss-mcpsrv-'));

/**
 * A parsed JSON-RPC response. Loose on purpose: these tests read into whatever
 * the server sent, and asserting a precise shape here would only restate the
 * production types rather than check them.
 */
type RpcMessage = {
  jsonrpc?: string;
  id?: unknown;
  result?: Record<string, unknown> & {
    protocolVersion?: string;
    serverInfo?: { name?: string };
    tools?: { name: string }[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: { text: string }[];
  };
  error?: { code: number; message: string };
};

interface Session {
  responses: RpcMessage[];
  stdoutRaw: string;
  stderr: string;
}

/** Run a whole session and collect both streams. */
async function session(args: string[], messages: unknown[]): Promise<Session> {
  const input = Readable.from([messages.map((m) => `${JSON.stringify(m)}\n`).join('')]);
  let stdoutRaw = '';
  const output = new Writable({
    write(chunk, _enc, cb) {
      stdoutRaw += String(chunk);
      cb();
    },
  });
  let stderr = '';
  const io: CliIo = {
    out: () => {
      throw new Error('the MCP server must never write to io.out');
    },
    err: (t) => void (stderr += t),
    env: { STEGOSHARD_PASSWORD: PW },
    isStdinTty: false,
    isStderrTty: false,
  };
  await runMcp(io, args, { input, output });
  const responses = stdoutRaw
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as RpcMessage);
  return { responses, stdoutRaw, stderr };
}

const init = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't', version: '0' },
  },
};

function secretIn(dir: string): string {
  const path = join(dir, 's.txt');
  writeFileSync(path, 'mcp server test secret');
  return path;
}

/** The nth response's `result`, asserted present so the assertions stay readable. */
function resultOf(s: Session, i: number): NonNullable<RpcMessage['result']> {
  const msg = s.responses[i];
  expect(msg, `no response at index ${i}`).toBeDefined();
  expect(msg!.error, `response ${i} was an error: ${JSON.stringify(msg!.error)}`).toBeUndefined();
  expect(msg!.result, `response ${i} carried no result`).toBeDefined();
  return msg!.result!;
}

/** The nth response's `error`, asserted present. */
function errorOf(s: Session, i: number): NonNullable<RpcMessage['error']> {
  const msg = s.responses[i];
  expect(msg, `no response at index ${i}`).toBeDefined();
  expect(msg!.error, `response ${i} was not an error`).toBeDefined();
  return msg!.error!;
}

describe('the handshake', () => {
  it('initializes, ignores the notification, and lists tools', async () => {
    const root = tmp();
    const { responses } = await session(
      ['--root', root],
      [
        init,
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ],
    );
    // Two requests, two responses: the notification produced none.
    expect(responses).toHaveLength(2);
    const s = { responses, stdoutRaw: '', stderr: '' };
    expect(resultOf(s, 0).protocolVersion).toBe('2025-06-18');
    expect(resultOf(s, 0).serverInfo?.name).toBe('stegoshard');
    expect(resultOf(s, 1).tools?.map((t) => t.name)).toEqual([
      'stegoshard_estimate',
      'stegoshard_save',
      'stegoshard_restore',
    ]);
  });

  it('echoes a protocol revision it knows', async () => {
    const { responses } = await session(
      ['--root', tmp()],
      [{ ...init, params: { ...init.params, protocolVersion: '2024-11-05' } }],
    );
    expect(resultOf({ responses, stdoutRaw: '', stderr: '' }, 0).protocolVersion).toBe(
      '2024-11-05',
    );
  });

  it('names its own when the client asks for one it does not know', async () => {
    const { responses } = await session(
      ['--root', tmp()],
      [{ ...init, params: { ...init.params, protocolVersion: '1999-01-01' } }],
    );
    expect(resultOf({ responses, stdoutRaw: '', stderr: '' }, 0).protocolVersion).toBe(
      '2025-06-18',
    );
  });

  it('answers ping and rejects an unknown method', async () => {
    const { responses } = await session(
      ['--root', tmp()],
      [
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', id: 2, method: 'resources/list' },
      ],
    );
    const s = { responses, stdoutRaw: '', stderr: '' };
    expect(resultOf(s, 0)).toEqual({});
    expect(errorOf(s, 1).code).toBe(-32601);
  });
});

describe('startup is legible to the operator', () => {
  it('says on stderr that the interface is unstable and what the roots are', async () => {
    const root = tmp();
    const { stderr } = await session(['--root', root], []);
    expect(stderr).toMatch(/unstable/);
    expect(stderr).toContain(root);
  });

  // Forgetting --root must be loud, not silently permissive or silently useless.
  it('warns when no root was configured', async () => {
    const { stderr } = await session([], []);
    expect(stderr).toMatch(/NO --root/);
  });

  it('says when inline passwords were allowed', async () => {
    const { stderr } = await session(['--root', tmp(), '--allow-inline-password'], []);
    expect(stderr).toMatch(/inline passwords ALLOWED/i);
  });
});

describe('tool calls', () => {
  it('returns a result as both text and structured content', async () => {
    const root = tmp();
    const input = secretIn(root);
    const { responses } = await session(
      ['--root', root],
      [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'stegoshard_estimate', arguments: { input } },
        },
      ],
    );
    const result = resultOf({ responses, stdoutRaw: '', stderr: '' }, 0);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.images).toBeGreaterThan(0);
    // The text block carries the same object, for a client that reads only text.
    expect(JSON.parse(result.content![0]!.text)).toEqual(result.structuredContent);
  });

  /**
   * A failed call is a *result* with `isError`, not a JSON-RPC error. MCP draws
   * that line so the model sees what went wrong instead of the client swallowing
   * it as a transport fault.
   */
  it('reports a refused path as a tool error, not a protocol error', async () => {
    const outside = secretIn(tmp());
    const { responses } = await session(
      ['--root', tmp()],
      [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'stegoshard_estimate', arguments: { input: outside } },
        },
      ],
    );
    const result = resultOf({ responses, stdoutRaw: '', stderr: '' }, 0);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content![0]!.text).code).toBe('PATH_OUTSIDE_ROOT');
  });

  it('reports a malformed call as a protocol error', async () => {
    const { responses } = await session(
      ['--root', tmp()],
      [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'stegoshard_estimate', arguments: { input: 42 } },
        },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} },
      ],
    );
    const s = { responses, stdoutRaw: '', stderr: '' };
    expect(errorOf(s, 0).code).toBe(-32602);
    expect(errorOf(s, 1).code).toBe(-32602);
  });

  it('saves and restores across one session', SLOW, async () => {
    const root = tmp();
    const input = secretIn(root);
    const pw = { env: 'STEGOSHARD_PASSWORD' };
    const { responses, stdoutRaw } = await session(
      ['--root', root],
      [
        init,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'stegoshard_save',
            arguments: { inputs: [input], out_dir: join(root, 'v'), password_source: pw },
          },
        },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'stegoshard_restore',
            arguments: {
              inputs: [join(root, 'v')],
              out_dir: join(root, 'out'),
              password_source: pw,
            },
          },
        },
      ],
    );
    const s = { responses, stdoutRaw, stderr: '' };
    expect(resultOf(s, 1).structuredContent?.imageCount).toBeGreaterThan(0);
    expect(resultOf(s, 2).structuredContent?.filename).toBe('s.txt');

    // Byte-identical, through the agent surface.
    const restored = readdirSync(join(root, 'out'));
    expect(restored).toEqual(['s.txt']);
    expect(readFileSync(join(root, 'out', 's.txt'), 'utf8')).toBe('mcp server test secret');

    // stdout purity: every line is a JSON-RPC response and nothing else.
    for (const line of stdoutRaw.split('\n').filter((l) => l !== '')) {
      const msg = JSON.parse(line) as { jsonrpc?: string; id?: unknown };
      expect(msg.jsonrpc, `stray line on stdout: ${line.slice(0, 80)}`).toBe('2.0');
      expect(msg.id).toBeDefined();
    }
  });
});

/**
 * The mechanical evidence behind the docs/CLAIMS.md row.
 *
 * Asserted against the source rather than by trying to observe the absence of a
 * connection, which no test can do convincingly.
 */
describe('the server is network-incapable', () => {
  it('imports no network builtin and calls no fetch', () => {
    const dir = join(import.meta.dirname);
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(2);
    for (const file of files) {
      const code = readFileSync(join(dir, file), 'utf8');
      for (const builtin of ['node:net', 'node:http', 'node:https', 'node:dgram', 'node:tls']) {
        expect(code, `${file} imports ${builtin}`).not.toContain(`'${builtin}'`);
      }
      // Word-boundary match, so a comment mentioning "fetch the file" is fine but
      // a call is not.
      expect(code, `${file} calls fetch`).not.toMatch(/\bfetch\s*\(/);
      expect(code, `${file} opens a server`).not.toMatch(/createServer\s*\(/);
    }
  });
});

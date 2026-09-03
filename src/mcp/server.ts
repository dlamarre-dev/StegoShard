/**
 * `stegoshard mcp`: the Model Context Protocol server.
 *
 * stdio only. It opens no socket, binds no port and speaks no HTTP, so the
 * property `docs/THREAT-MODEL.md` states for the local web UI, that the server
 * exposes no endpoint, is not weakened here. The released binaries still carry no
 * network permission, and this needs none: stdin and stdout are free, and
 * `--allow-read`, `--allow-write` and `--allow-env` are already granted. That is
 * the contrast with `stegoshard ui`, which is excluded from those binaries
 * precisely because it would need `--allow-net`.
 *
 * What it *does* cost is written down in docs/THREAT-MODEL.md and worth repeating
 * at the top of the implementation: **the agent is the network client.** Every
 * argument and every result may be transmitted to a model provider and retained.
 * And a restore writes recovered plaintext into `out_dir`, where the agent's own
 * filesystem tools can read it, so driving a restore from an agent is a decision
 * to show the agent the secret.
 */

import { parseArgs } from 'node:util';
import type { Readable, Writable } from 'node:stream';
import { PolicyError, makePolicy } from './policy';
import { RPC, RpcError, SUPPORTED_PROTOCOLS, serveRpc } from './rpc';
import { callTool, toolDefinitions } from './tools';
import type { CliIo } from '../cli/io';
import { jsonErrorCode } from '../cli/json';
import { toCliFailure } from '../cli/errors';

const SERVER_INFO = { name: 'stegoshard', version: '0.9.0' } as const;

export interface McpOptions {
  roots: string[];
  allowInlinePassword: boolean;
}

/** Parse the `mcp` subcommand's own flags. It shares none with save/restore. */
export function parseMcpArgs(args: string[]): McpOptions {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      root: { type: 'string', multiple: true },
      'allow-inline-password': { type: 'boolean' },
    },
  });
  return {
    roots: (values.root as string[] | undefined) ?? [],
    allowInlinePassword: values['allow-inline-password'] === true,
  };
}

/**
 * Turn any failure into a tool result the agent can act on.
 *
 * MCP distinguishes a *protocol* error (the call was malformed) from a *tool*
 * error (the call was well-formed and the work failed). Only the first is a
 * JSON-RPC error; the second is a normal result carrying `isError: true`, so the
 * model sees what went wrong instead of the client swallowing it. The code is the
 * same one `--json` would report, from the same classifier.
 */
function toolFailure(err: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  const code = err instanceof PolicyError ? err.code : jsonErrorCode(err);
  const message = err instanceof PolicyError ? err.message : toCliFailure(err).message;
  const details = err instanceof PolicyError ? err.details : undefined;
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(details ? { code, message, details } : { code, message }),
      },
    ],
    isError: true,
  };
}

/**
 * Run the server until its input closes. Resolves with the process exit code.
 *
 * The streams are a parameter, defaulting to the real ones, for the same reason
 * `run(argv, io)` takes its io: a server that reaches for `process.stdin` cannot
 * be driven by a test, and this is the layer where framing bugs live.
 */
export async function runMcp(
  io: CliIo,
  args: string[],
  streams: { input: Readable; output: Writable } = { input: process.stdin, output: process.stdout },
): Promise<number> {
  const opts = parseMcpArgs(args);
  const policy = makePolicy(opts.roots, {
    allowInlinePassword: opts.allowInlinePassword,
    env: io.env,
  });

  // stderr is free here, because stdout *is* the protocol. One line, so an
  // operator watching the log knows what they started and on what terms.
  io.err(
    `stegoshard mcp: unstable interface (see docs/API.md); ` +
      `${policy.roots.length === 0 ? 'NO --root configured, every tool call will be refused' : `roots: ${policy.roots.join(', ')}`}` +
      `${opts.allowInlinePassword ? '; inline passwords ALLOWED' : ''}\n`,
  );

  await serveRpc(
    { input: streams.input, output: streams.output, log: (t) => io.err(t) },
    async (method, params) => {
      switch (method) {
        case 'initialize': {
          const asked = (params as { protocolVersion?: string } | undefined)?.protocolVersion;
          // Echo the client's version when we know it, else name our preferred
          // one and let the client decide whether it can proceed.
          const protocolVersion =
            asked && (SUPPORTED_PROTOCOLS as readonly string[]).includes(asked)
              ? asked
              : SUPPORTED_PROTOCOLS[0];
          return {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          };
        }

        case 'notifications/initialized':
          return undefined; // a notification: serveRpc sends nothing back

        case 'ping':
          return {};

        case 'tools/list':
          return { tools: toolDefinitions(policy.allowInlinePassword) };

        case 'tools/call': {
          const call = params as { name?: unknown; arguments?: unknown } | undefined;
          if (typeof call?.name !== 'string') {
            throw new RpcError(RPC.INVALID_PARAMS, 'tools/call needs a "name"');
          }
          try {
            const { result } = await callTool(policy, call.name, call.arguments);
            return {
              content: [{ type: 'text', text: JSON.stringify(result) }],
              structuredContent: result,
            };
          } catch (err) {
            // A malformed call is a protocol error; a failed one is a result.
            if (err instanceof RpcError) throw err;
            return toolFailure(err);
          }
        }

        default:
          throw new RpcError(RPC.METHOD_NOT_FOUND, `unknown method: ${method}`);
      }
    },
  );

  return 0;
}

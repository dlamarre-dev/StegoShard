/**
 * The tool surface and its dispatch.
 *
 * The `tools/list` payload **is** the contract an agent reads, so it is pinned as
 * a snapshot: a change to a name, a schema or a description is a change to what
 * every client sees, and it should be a deliberate line in a review.
 *
 * The rest are the refusals. Each one is a decision recorded in `tools.ts`, so
 * each gets a test that fails if the decision is quietly reversed.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { callTool, toolDefinitions } from './tools';
import { makePolicy, PolicyError } from './policy';
import { RPC, RpcError } from './rpc';

const SLOW = { timeout: 90_000 };
const PW = 'a long unrelated passphrase for the mcp tests';
const tmp = () => mkdtempSync(join(tmpdir(), 'ss-mcp-'));

function secretIn(dir: string, name = 's.txt'): string {
  const path = join(dir, name);
  writeFileSync(path, 'mcp tool test secret');
  return path;
}

const envPolicy = (root: string, extra: Record<string, string> = {}) =>
  makePolicy([root], { env: { STEGOSHARD_PASSWORD: PW, ...extra } });

/** Assert a PolicyError by code, not by prose. */
async function expectPolicy(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(PolicyError);
  await expect(p).rejects.toMatchObject({ code });
}

describe('the advertised tools', () => {
  it('are exactly three, named for the operations they perform', () => {
    expect(toolDefinitions(false).map((t) => t.name)).toEqual([
      'stegoshard_estimate',
      'stegoshard_save',
      'stegoshard_restore',
    ]);
  });

  // This payload is the third-party contract. A diff here is a deliberate act.
  it('match the pinned schema', () => {
    expect(toolDefinitions(false)).toMatchSnapshot();
  });

  it('advertise no inline password property by default', () => {
    for (const tool of toolDefinitions(false)) {
      const props = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(Object.keys(props)).not.toContain('password');
    }
  });

  it('advertise one only when the operator opted in', () => {
    const save = toolDefinitions(true).find((t) => t.name === 'stegoshard_save')!;
    const props = (save.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toContain('password');
    // And the description says what it costs, since that text reaches the model.
    expect(JSON.stringify(props.password)).toMatch(/transcript/);
  });

  // The absent options are decisions, not omissions.
  it('expose no access mode, no force, and no entropy option', () => {
    for (const tool of toolDefinitions(true)) {
      const props = Object.keys(
        (tool.inputSchema as { properties: Record<string, unknown> }).properties,
      );
      for (const forbidden of ['mode', 'decoy', 'threshold', 'duress_password', 'force']) {
        expect(props, `${tool.name} must not accept ${forbidden}`).not.toContain(forbidden);
      }
      for (const p of props) expect(p).not.toMatch(/entropy/);
    }
  });

  it('say plainly that a restore writes plaintext the agent can read', () => {
    const restore = toolDefinitions(false).find((t) => t.name === 'stegoshard_restore')!;
    expect(restore.description).toMatch(/plaintext/);
    expect(restore.description).toMatch(/agent can read/);
  });
});

describe('path confinement reaches every path argument', () => {
  it('refuses an input outside the root', async () => {
    const root = tmp();
    const outside = secretIn(tmp());
    await expectPolicy(
      callTool(envPolicy(root), 'stegoshard_estimate', { input: outside }),
      'PATH_OUTSIDE_ROOT',
    );
  });

  it('refuses an out_dir outside the root', async () => {
    const root = tmp();
    const input = secretIn(root);
    await expectPolicy(
      callTool(envPolicy(root), 'stegoshard_save', {
        inputs: [input],
        out_dir: join(tmp(), 'v'),
        password_source: { env: 'STEGOSHARD_PASSWORD' },
      }),
      'PATH_OUTSIDE_ROOT',
    );
  });

  it('refuses every call when no root was configured', async () => {
    const root = tmp();
    const input = secretIn(root);
    await expectPolicy(
      callTool(makePolicy([]), 'stegoshard_estimate', { input }),
      'ROOT_NOT_CONFIGURED',
    );
  });
});

describe('credential rules', () => {
  it('refuses an environment variable outside the namespace', async () => {
    const root = tmp();
    const input = secretIn(root);
    await expectPolicy(
      callTool(envPolicy(root, { AWS_SECRET_ACCESS_KEY: 'x' }), 'stegoshard_save', {
        inputs: [input],
        out_dir: join(root, 'v'),
        password_source: { env: 'AWS_SECRET_ACCESS_KEY' },
      }),
      'ENV_NOT_ALLOWED',
    );
  });

  it('refuses an inline password by default', async () => {
    const root = tmp();
    const input = secretIn(root);
    await expectPolicy(
      callTool(envPolicy(root), 'stegoshard_save', {
        inputs: [input],
        out_dir: join(root, 'v'),
        password: PW,
      }),
      'INLINE_PASSWORD_REFUSED',
    );
  });
});

describe('the access modes are refused, with a reason', () => {
  for (const [key, value] of [
    ['mode', 'duress'],
    ['decoy', 'decoy.pdf'],
    ['threshold', '2-of-3'],
    ['duress_password_file', 'pw.txt'],
  ] as const) {
    it(`refuses "${key}"`, async () => {
      const root = tmp();
      const input = secretIn(root);
      const p = callTool(envPolicy(root), 'stegoshard_save', {
        inputs: [input],
        out_dir: join(root, 'v'),
        password_source: { env: 'STEGOSHARD_PASSWORD' },
        [key]: value,
      });
      await expectPolicy(p, 'MODE_NOT_AVAILABLE');
      // The message must point somewhere useful, not just say no.
      await expect(p).rejects.toMatchObject({ message: expect.stringContaining('command line') });
    });
  }
});

describe('argument validation', () => {
  const root = tmp();
  const p = envPolicy(root);

  const invalid: [string, unknown][] = [
    ['a non-object', 'not-an-object'],
    ['a missing input', {}],
    ['an empty inputs array', { inputs: [], out_dir: 'v' }],
    ['a non-string in inputs', { inputs: [1], out_dir: 'v' }],
    ['a bad codec', { input: 'a.txt', codec: 'rainbow' }],
    ['a non-boolean paper', { input: 'a.txt', paper: 'yes' }],
    [
      'a password_source with both keys',
      {
        inputs: ['a'],
        out_dir: 'v',
        password_source: { env: 'STEGOSHARD_PASSWORD', file: 'p' },
      },
    ],
    ['a password_source with neither', { inputs: ['a'], out_dir: 'v', password_source: {} }],
  ];

  for (const [what, args] of invalid) {
    it(`rejects ${what} as invalid params`, async () => {
      const tool = (args as { input?: unknown })?.input ? 'stegoshard_estimate' : 'stegoshard_save';
      await expect(callTool(p, tool, args)).rejects.toBeInstanceOf(RpcError);
      await expect(callTool(p, tool, args)).rejects.toMatchObject({ code: RPC.INVALID_PARAMS });
    });
  }

  it('rejects an unknown tool', async () => {
    await expect(callTool(p, 'stegoshard_delete_everything', {})).rejects.toMatchObject({
      code: RPC.METHOD_NOT_FOUND,
    });
  });

  it('rejects disguise without binary', async () => {
    const dir = tmp();
    const input = secretIn(dir);
    await expect(
      callTool(envPolicy(dir), 'stegoshard_save', {
        inputs: [input],
        out_dir: join(dir, 'v'),
        password_source: { env: 'STEGOSHARD_PASSWORD' },
        disguise: true,
      }),
    ).rejects.toMatchObject({ code: RPC.INVALID_PARAMS });
  });
});

describe('the operations themselves', () => {
  it('estimates without a password', async () => {
    const root = tmp();
    const input = secretIn(root);
    const { result } = await callTool(envPolicy(root), 'stegoshard_estimate', { input });
    expect(Object.keys(result).sort()).toEqual(['images', 'k', 'm']);
    expect(result.images).toBeGreaterThan(0);
  });

  it('saves and restores, returning the --json result shapes', SLOW, async () => {
    const root = tmp();
    const input = secretIn(root);
    const policy = envPolicy(root);

    const saved = await callTool(policy, 'stegoshard_save', {
      inputs: [input],
      out_dir: join(root, 'vault'),
      password_source: { env: 'STEGOSHARD_PASSWORD' },
    });
    // Byte-identical to what `--json` reports, because it is the same function.
    expect(Object.keys(saved.result).sort()).toEqual([
      'files',
      'imageCount',
      'keyMode',
      'manifest',
      'setId',
    ]);

    const restored = await callTool(policy, 'stegoshard_restore', {
      inputs: [join(root, 'vault')],
      out_dir: join(root, 'out'),
      password_source: { env: 'STEGOSHARD_PASSWORD' },
    });
    expect(restored.result.filename).toBe('s.txt');
    expect(restored.result.decoded).toBe(restored.result.seen);
  });

  // No `force` is passed, ever, so a name collision is the agent's to resolve.
  it('refuses to overwrite rather than clobbering', SLOW, async () => {
    const root = tmp();
    const input = secretIn(root);
    const policy = envPolicy(root);
    const args = {
      inputs: [join(root, 'vault')],
      out_dir: join(root, 'out'),
      password_source: { env: 'STEGOSHARD_PASSWORD' },
    };
    await callTool(policy, 'stegoshard_save', {
      inputs: [input],
      out_dir: join(root, 'vault'),
      password_source: { env: 'STEGOSHARD_PASSWORD' },
    });
    await callTool(policy, 'stegoshard_restore', args);
    await expect(callTool(policy, 'stegoshard_restore', args)).rejects.toMatchObject({
      code: 'OUTPUT_EXISTS',
    });
  });
});

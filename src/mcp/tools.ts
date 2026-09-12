/**
 * The tools an agent can call, their schemas, and the validation behind them.
 *
 * Three, deliberately: estimate, save, restore. Each returns the **same result
 * object** the `--json` envelope carries, from the same functions in
 * `src/cli/json.ts`, so a caller that has learned one has learned both and there
 * is no second place for the shape to drift.
 *
 * What is absent matters as much as what is here.
 *
 * **The SPEC §10 access modes are not exposed.** Duress needs a second,
 * independent credential, which would cross the tool boundary into a transcript
 * the agent keeps, and `CredentialsNotIndependentError` would become a recorded
 * oracle relating the two, in a mode whose entire point is that no record exists
 * of which credential is real. Non-possession writes its n threshold shares into
 * `out_dir`, which the agent can read back in the same session, destroying the
 * property before the call even returns. Both stay fully available in the library
 * and in `--json`, where a human is the one holding them. Restore-side
 * `share_files` is allowed: those shares already exist and a person chose to
 * reference them.
 *
 * **Gallery is not exposed in 0.9.** `gallery-save` takes a folder of real
 * photographs and rewrites them in place; it is the flow most likely to be driven
 * badly by an agent, and leaving it out roughly halves this surface.
 *
 * **No `force`.** Overwriting is not something to do on an agent's judgement, so
 * a name collision returns `OUTPUT_EXISTS` and the agent picks another directory.
 *
 * **No `allow_cover_reuse`**, for the same reason one step further. An agent
 * looping `stegoshard_save` over one cover photo is the most plausible way this
 * bug actually happens, and it is precisely the case the guard in
 * `src/core/stego-guard.ts` exists to catch, since this server is a long-lived
 * process. Waiving a cryptographic constraint (SPEC §5.3) is a decision for a
 * person; the agent gets `STEGO_COVER_REUSE` and picks another photo.
 *
 * **No entropy options, no paper prose.** `--entropy*` needs a human choosing
 * randomness; `title`, `locale`, `instructions` and the rest are printed sheets an
 * agent should not be authoring.
 */

import { estimate, restore, save } from '../api/node';
import { estimateResultJson, restoreResultJson, saveResultJson } from '../cli/json';
import {
  PolicyError,
  readPassword,
  resolveInRoot,
  type PasswordSource,
  type Policy,
} from './policy';
import { RPC, RpcError } from './rpc';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const PASSWORD_SOURCE_SCHEMA = {
  description:
    'Where to read the password from. Never pass the password itself: tool arguments are recorded in the agent transcript and may be sent to a model provider.',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['env'],
      properties: {
        env: {
          type: 'string',
          pattern: '^STEGOSHARD_[A-Z0-9_]*$',
          description:
            'Name of an environment variable holding the password. Only STEGOSHARD_* names are readable.',
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          description:
            'Path to a file whose first line is the password. Must be inside a --root directory.',
        },
      },
    },
  ],
} as const;

const INLINE_PASSWORD_SCHEMA = {
  type: 'string',
  description:
    'The password itself. This value will appear in the agent transcript and may be sent to a model provider. Prefer password_source.',
} as const;

/** The advertised tool list. `allowInline` adds the opt-in `password` property. */
export function toolDefinitions(allowInline: boolean): ToolDefinition[] {
  const secret = (props: Record<string, unknown>) => ({
    password_source: PASSWORD_SOURCE_SCHEMA,
    ...(allowInline ? { password: INLINE_PASSWORD_SCHEMA } : {}),
    ...props,
  });

  /**
   * How a schema says "a credential is mandatory".
   *
   * Without the opt-in there is one way to supply one, so `password_source` is
   * simply required. With it there are two, and listing `password_source` as
   * required anyway would advertise an inline mode no schema-valid client could
   * actually use on its own: it would have to send a redundant source alongside.
   * `anyOf` states what the dispatch already accepts.
   */
  const needsCredential = (...base: string[]) =>
    allowInline
      ? {
          required: base,
          anyOf: [{ required: ['password_source'] }, { required: ['password'] }],
        }
      : { required: [...base, 'password_source'] };

  return [
    {
      name: 'stegoshard_estimate',
      description:
        'How many carrier images a file would need. Read-only: reads the file size, writes nothing, needs no password.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['input'],
        properties: {
          input: { type: 'string', description: 'Path to the file, inside a --root directory.' },
          paper: { type: 'boolean', default: false },
          codec: { type: 'string', enum: ['color', 'qr'], default: 'color' },
        },
      },
    },
    {
      name: 'stegoshard_save',
      description:
        'Encrypt one or more files into StegoShard carriers. Writes new files into out_dir and refuses to overwrite. The duress and non-possession access modes are not available over MCP; use the command line for those.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        ...needsCredential('inputs', 'out_dir'),
        properties: secret({
          inputs: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 64 },
          out_dir: { type: 'string' },
          paper: { type: 'boolean', default: false },
          zip: { type: 'boolean', default: false },
          binary: { type: 'boolean', default: false },
          disguise: {
            type: 'boolean',
            default: false,
            description: 'Requires binary. Writes a decoy SQLite database instead of a .ssbn file.',
          },
          codec: { type: 'string', enum: ['color', 'qr'], default: 'color' },
          key_mode: { type: 'string', enum: ['embedded', 'keyfile', 'stego'], default: 'embedded' },
          cover: { type: 'string', description: 'Required when key_mode is stego.' },
          allow_weak_password: { type: 'boolean', default: false },
        }),
      },
    },
    {
      name: 'stegoshard_restore',
      description:
        'Recover a file from StegoShard carriers. WARNING: this writes the decrypted plaintext into out_dir, where this agent can read it.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        ...needsCredential('inputs', 'out_dir'),
        properties: secret({
          inputs: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 256 },
          out_dir: { type: 'string' },
          key_file: {
            type: 'string',
            description: 'A .key file, or the cover photo a stego key hides in.',
          },
          share_files: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 255,
            description: 'Threshold share files for a non-possession vault (SPEC §10.6).',
          },
        }),
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Argument validation
//
// Explicit, because hand-rolling the transport means there is no schema
// validator behind it. Each helper refuses with -32602 Invalid params, which is
// what a JSON-RPC peer expects for a malformed call.
// ---------------------------------------------------------------------------

function bad(message: string): never {
  throw new RpcError(RPC.INVALID_PARAMS, message);
}

function asObject(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    bad('arguments must be an object');
  }
  return params as Record<string, unknown>;
}

function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v === '') bad(`"${key}" must be a non-empty string`);
  return v;
}

function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v === '') bad(`"${key}" must be a non-empty string`);
  return v;
}

function optBool(args: Record<string, unknown>, key: string): boolean {
  const v = args[key];
  if (v === undefined) return false;
  if (typeof v !== 'boolean') bad(`"${key}" must be a boolean`);
  return v;
}

function reqStringArray(args: Record<string, unknown>, key: string, max: number): string[] {
  const v = args[key];
  if (!Array.isArray(v) || v.length === 0) bad(`"${key}" must be a non-empty array of strings`);
  if (v.length > max) bad(`"${key}" accepts at most ${max} entries`);
  return v.map((entry, i) => {
    if (typeof entry !== 'string' || entry === '') bad(`"${key}[${i}]" must be a non-empty string`);
    return entry;
  });
}

function optStringArray(
  args: Record<string, unknown>,
  key: string,
  max: number,
): string[] | undefined {
  if (args[key] === undefined) return undefined;
  return reqStringArray(args, key, max);
}

function optEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    bad(`"${key}" must be one of: ${allowed.join(', ')}`);
  }
  return v as T;
}

function passwordSourceOf(args: Record<string, unknown>): PasswordSource | undefined {
  const v = args.password_source;
  if (v === undefined) return undefined;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    bad('"password_source" must be an object with either "env" or "file"');
  }
  const source = v as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== 1 || (keys[0] !== 'env' && keys[0] !== 'file')) {
    bad('"password_source" must have exactly one of "env" or "file"');
  }
  const only = source[keys[0]!];
  if (typeof only !== 'string' || only === '') bad(`"password_source.${keys[0]}" must be a string`);
  return { [keys[0]!]: only } as PasswordSource;
}

/**
 * Reject an access mode before anything else looks at the request.
 *
 * `additionalProperties: false` in the schema already says these are not
 * accepted, but a schema is advice. Naming the refusal explicitly is also better
 * for the agent than "unknown property": it says the capability exists and where
 * to find it.
 */
const REFUSED_KEYS: Record<string, string> = {
  mode: 'access modes',
  decoy: 'duress mode',
  duress_password: 'duress mode',
  duress_password_file: 'duress mode',
  threshold: 'non-possession mode',
};

function refuseAccessModes(args: Record<string, unknown>): void {
  for (const key of Object.keys(args)) {
    const feature = REFUSED_KEYS[key];
    if (!feature) continue;
    throw new PolicyError(
      'MODE_NOT_AVAILABLE',
      `${feature} are not available over MCP: the second credential and the threshold shares would both land in this transcript, which is the one place they must not be. Use the command line.`,
      { argument: key },
    );
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface ToolOutcome {
  result: Record<string, unknown>;
}

export async function callTool(
  policy: Policy,
  name: string,
  rawArgs: unknown,
): Promise<ToolOutcome> {
  const args = asObject(rawArgs ?? {});
  refuseAccessModes(args);

  const inline = args.password === undefined ? undefined : String(args.password);
  const inRoot = (key: string, value: string) => resolveInRoot(policy, key, value);

  switch (name) {
    case 'stegoshard_estimate': {
      const input = inRoot('input', reqString(args, 'input'));
      const res = await estimate(
        input,
        optBool(args, 'paper'),
        optEnum(args, 'codec', ['color', 'qr'] as const) ?? 'color',
      );
      return { result: estimateResultJson(res) };
    }

    case 'stegoshard_save': {
      const inputs = reqStringArray(args, 'inputs', 64).map((p) => inRoot('inputs', p));
      const outDir = inRoot('out_dir', reqString(args, 'out_dir'));
      const password = readPassword(policy, passwordSourceOf(args), inline);
      const cover = optString(args, 'cover');
      const binary = optBool(args, 'binary');
      const disguise = optBool(args, 'disguise');
      if (disguise && !binary) bad('"disguise" requires "binary"');

      const res = await save({
        inputs,
        outDir,
        password,
        paper: optBool(args, 'paper'),
        zip: optBool(args, 'zip'),
        ...(binary ? { binary: disguise ? ('disguised' as const) : ('branded' as const) } : {}),
        keyMode: optEnum(args, 'key_mode', ['embedded', 'keyfile', 'stego'] as const) ?? 'embedded',
        ...(optEnum(args, 'codec', ['color', 'qr'] as const)
          ? { codec: optEnum(args, 'codec', ['color', 'qr'] as const) }
          : {}),
        ...(cover ? { cover: inRoot('cover', cover) } : {}),
        // `force` and `allowCoverReuse` are deliberately never set: see the header.
      });
      return { result: saveResultJson(res) };
    }

    case 'stegoshard_restore': {
      const inputs = reqStringArray(args, 'inputs', 256).map((p) => inRoot('inputs', p));
      const outDir = inRoot('out_dir', reqString(args, 'out_dir'));
      const password = readPassword(policy, passwordSourceOf(args), inline);
      const keyFile = optString(args, 'key_file');
      const shares = optStringArray(args, 'share_files', 255);

      const res = await restore({
        inputs,
        outDir,
        password,
        ...(keyFile ? { keyPath: inRoot('key_file', keyFile) } : {}),
        ...(shares ? { sharePaths: shares.map((p) => inRoot('share_files', p)) } : {}),
      });
      return { result: restoreResultJson(res) };
    }

    default:
      throw new RpcError(RPC.METHOD_NOT_FOUND, `unknown tool: ${name}`);
  }
}

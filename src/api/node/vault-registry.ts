/**
 * The known-vaults registry: local state that makes a rollback visible.
 *
 * WHAT THIS BUYS, AND WHAT IT DOES NOT. An AEAD tag authenticates a message; it
 * cannot authenticate the *absence of a newer* message. Nothing inside a
 * container distinguishes it from an older, entirely legitimate export of the
 * same vault, so detecting a rollback needs state the container does not carry.
 * This file is that state.
 *
 * It catches a silent replacement: a botched sync, a stale USB stick, or an
 * adversary with write access to the vault who puts back a copy from before your
 * last edit. It catches nothing at all against an adversary who can also write
 * here — they lower the sequence, or delete the file, and the check reports an
 * unknown vault or stays quiet. The registry does not create trust; it moves it
 * from the vault file to a local JSON file, and the situations where those two
 * differ are real but narrower than the feature invites you to assume.
 *
 * THE COST, STATED PLAINLY. This is a durable, cleartext list of vault
 * identifiers and access times in the user's home directory. Against the
 * coercive adversary in docs/THREAT-MODEL.md it is the most damaging artifact
 * the tool can produce: it does not say where a vault is or what is in it, but
 * it proves how many exist and when they were touched, which is precisely what
 * deniability rests on denying. It is opt-in, off by default, and the CLI
 * refuses to combine it with any deniable destination — see `--track` in
 * docs/CLI.md. It is also the first persistent state the command line has ever
 * kept, which is a real change to "leaves nothing behind but the files you asked
 * for" and is documented as one.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** The schema tag written into the file, so a future shape change is legible. */
export const REGISTRY_SCHEMA = 'stegoshard.known-vaults/1';

export interface RegistryEntry {
  /** Highest sequence seen for this vault. */
  sequence: number;
  /** ISO-8601, UTC. */
  firstSeen: string;
  lastSeen: string;
  /** Optional, only when the user passed one. Never derived from a filename. */
  label?: string;
}

export interface Registry {
  schema: string;
  vaults: Record<string, RegistryEntry>;
}

/** What a restore's identity check concluded. */
export type RegistryVerdict =
  /** No identity in the envelope: an untracked export. Nothing to say. */
  | { kind: 'untracked' }
  /** First time this vault has been seen, and the registry was empty. */
  | { kind: 'first' }
  /** Sequence matches or advances what was recorded. */
  | { kind: 'current'; sequence: number }
  /** Recorded elsewhere but not here: informational, not an alarm. */
  | { kind: 'unknown'; vaultId: string }
  /** Older than what was recorded. The one finding worth interrupting for. */
  | { kind: 'rollback'; vaultId: string; got: number; recorded: number };

const EMPTY: Registry = { schema: REGISTRY_SCHEMA, vaults: {} };

/**
 * Where the registry lives, by precedence: an explicit path, `STEGOSHARD_HOME`,
 * then the platform's state directory.
 *
 * Deliberately NOT `~/.stegoshard/`. A dotfile in the most-inspected directory
 * on the machine is the wrong home for a file whose entire problem is that it is
 * a trace.
 */
export function registryPath(
  explicit?: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (explicit) return explicit;
  if (env.STEGOSHARD_HOME) return join(env.STEGOSHARD_HOME, 'known-vaults.json');
  const home = homedir() || tmpdir();
  if (platform() === 'win32') {
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'StegoShard', FILE);
  }
  if (platform() === 'darwin') {
    return join(home, 'Library', 'Application Support', 'StegoShard', FILE);
  }
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'stegoshard', FILE);
}

const FILE = 'known-vaults.json';

/** Lowercase hex, the key shape used in the file. */
export function vaultIdHex(vaultId: Uint8Array): string {
  let s = '';
  for (const b of vaultId) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * Is this a usable entry? Checked per entry rather than trusting the file's
 * outer shape, because the fields are arithmetic inputs. A `sequence` of `"5"`
 * survives a shape-only check and then makes `recordExport` compute `"5" + 1`,
 * which reaches `buildPayload` as `"51"` and hard-fails every subsequent save of
 * that vault. A hand-edit or a sync artifact should cost the rollback check, not
 * the ability to save.
 */
function isEntry(value: unknown): value is RegistryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Partial<RegistryEntry>;
  return (
    Number.isInteger(e.sequence) &&
    (e.sequence as number) >= 1 &&
    (e.sequence as number) <= 0xffffffff &&
    typeof e.firstSeen === 'string' &&
    typeof e.lastSeen === 'string' &&
    (e.label === undefined || typeof e.label === 'string')
  );
}

/**
 * Read the registry. A missing file is an empty registry; a corrupt one is
 * reported rather than thrown, because a damaged registry must never stop a
 * restore — losing the ability to detect a rollback is bad, losing the secret
 * is worse.
 *
 * `corrupt` is the caller's cue that the returned (empty) registry is not
 * evidence of anything. A caller that writes must not treat it as a starting
 * point, or the write destroys records it merely failed to read.
 */
export function readRegistry(path: string): { registry: Registry; corrupt: boolean } {
  if (!existsSync(path)) return { registry: { ...EMPTY, vaults: {} }, corrupt: false };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Registry).vaults !== 'object' ||
      (parsed as Registry).vaults === null ||
      Array.isArray((parsed as Registry).vaults)
    ) {
      return { registry: { ...EMPTY, vaults: {} }, corrupt: true };
    }
    const registry = parsed as Registry;
    for (const [key, entry] of Object.entries(registry.vaults)) {
      if (!/^[0-9a-f]{32}$/.test(key) || !isEntry(entry)) {
        return { registry: { ...EMPTY, vaults: {} }, corrupt: true };
      }
    }
    return {
      registry: { schema: registry.schema ?? REGISTRY_SCHEMA, vaults: registry.vaults },
      corrupt: false,
    };
  } catch {
    return { registry: { ...EMPTY, vaults: {} }, corrupt: true };
  }
}

/**
 * Write the registry atomically, `0600` inside a `0700` directory.
 *
 * A symlink at the target is refused rather than followed: this file is written
 * with the user's privileges into a predictable path, and following a link there
 * is how a local attacker turns a benign write into an arbitrary one.
 */
export function writeRegistry(path: string, registry: Registry): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // A pre-existing directory the user owns differently is their business.
  }
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`registry: refusing to write through a symlink at ${path}`);
  }
  // pid *and* timestamp, so a second write in the same process cannot collide
  // with a temporary a previous one left behind and fail on the 'wx'.
  const tmp = `${path}.${process.pid.toString(36)}${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    if (platform() === 'win32' && existsSync(path)) unlinkSync(path);
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    throw e;
  }
}

const now = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Find the vault a label names, if the registry has seen it.
 *
 * The label is how a person says "this save is another version of *that* vault".
 * Nothing in a fresh export can say so on its own: two saves of the same file
 * from the same keystore are, to the tool, unrelated artifacts. Without a name
 * to tie them together every tracked export would mint a new id and carry
 * sequence 1 forever, which looks like a guarantee and is not one.
 */
export function findByLabel(registry: Registry, label: string): string | undefined {
  for (const [key, entry] of Object.entries(registry.vaults)) {
    if (entry.label === label) return key;
  }
  return undefined;
}

/** Parse a 32-character lowercase-hex vault id back into bytes. */
export function parseVaultId(hex: string): Uint8Array {
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`registry: malformed vault id ${hex}`);
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}

/**
 * Record an export of the vault a label names, minting one on first use.
 *
 * Returns the identity the envelope should carry. The registry and the artifact
 * therefore agree by construction: the sequence written into the file is the
 * one that was just reserved here.
 */
export function recordLabelledExport(
  registry: Registry,
  label: string,
  mintId: () => Uint8Array,
): { registry: Registry; vaultId: Uint8Array; sequence: number } {
  const known = findByLabel(registry, label);
  const vaultId = known ? parseVaultId(known) : mintId();
  const out = recordExport(registry, vaultId, label);
  return { registry: out.registry, vaultId, sequence: out.sequence };
}

/**
 * Record an export and return the sequence it should carry.
 *
 * A vault the registry has not seen starts at 1; a known one advances by one.
 * The caller writes the returned sequence into the envelope, so the file and the
 * artifact agree by construction.
 *
 * CONCURRENCY. Two simultaneous tracked saves can each read the same sequence
 * and write the same next one, so one increment is lost and two artifacts share
 * a number. The atomic write prevents a corrupt file, not a lost update. That is
 * a known limit, not a solved problem: a rollback between two exports that share
 * a sequence reads as "current". Saving the same vault from two processes at
 * once is not a workflow this is built for.
 */
export function recordExport(
  registry: Registry,
  vaultId: Uint8Array,
  label?: string | undefined,
): { registry: Registry; sequence: number } {
  const key = vaultIdHex(vaultId);
  const stamp = now();
  const prior = registry.vaults[key];
  const sequence = prior ? prior.sequence + 1 : 1;
  const entry: RegistryEntry = {
    sequence,
    firstSeen: prior?.firstSeen ?? stamp,
    lastSeen: stamp,
    ...(label ? { label } : prior?.label ? { label: prior.label } : {}),
  };
  return { registry: { ...registry, vaults: { ...registry.vaults, [key]: entry } }, sequence };
}

/**
 * Check a restored identity against the registry, and return both the verdict
 * and the registry as it should now be recorded.
 *
 * A newer sequence updates the record; an older one does NOT. Refusing to record
 * a regression is what keeps the check meaningful after the first rollback: if
 * restoring an old copy silently reset the high-water mark, every subsequent
 * restore of that same old copy would look current.
 */
export function checkRestore(
  registry: Registry,
  identity: { vaultId: Uint8Array; sequence: number } | undefined,
): { verdict: RegistryVerdict; registry: Registry } {
  if (!identity) return { verdict: { kind: 'untracked' }, registry };
  const key = vaultIdHex(identity.vaultId);
  const prior = registry.vaults[key];
  const stamp = now();

  if (!prior) {
    const known = Object.keys(registry.vaults).length > 0;
    const entry: RegistryEntry = {
      sequence: identity.sequence,
      firstSeen: stamp,
      lastSeen: stamp,
    };
    const next = { ...registry, vaults: { ...registry.vaults, [key]: entry } };
    return {
      verdict: known ? { kind: 'unknown', vaultId: key } : { kind: 'first' },
      registry: next,
    };
  }

  if (identity.sequence < prior.sequence) {
    return {
      verdict: {
        kind: 'rollback',
        vaultId: key,
        got: identity.sequence,
        recorded: prior.sequence,
      },
      registry,
    };
  }

  const entry: RegistryEntry = { ...prior, sequence: identity.sequence, lastSeen: stamp };
  return {
    verdict: { kind: 'current', sequence: identity.sequence },
    registry: { ...registry, vaults: { ...registry.vaults, [key]: entry } },
  };
}

/**
 * The short human form printed on every save and restore that carries an
 * identity: `vault 3f8a1c02 · export #4`.
 *
 * This is the part worth relying on, and it needs no file at all. A person who
 * reads "export #4" when they last wrote #5 has detected the rollback with no
 * durable trace anywhere — the same role a recovery sheet plays for resilient
 * storage, and without the registry's cost.
 */
export function identityLine(vaultId: Uint8Array, sequence: number): string {
  return `vault ${vaultIdHex(vaultId).slice(0, 8)} · export #${sequence}`;
}

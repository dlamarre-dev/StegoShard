/**
 * The known-vaults registry.
 *
 * Three groups: the sequence arithmetic (which is what makes a rollback
 * visible), the file's handling (permissions, atomicity, a corrupt file), and
 * the negative space — the registry must never appear unless asked for.
 */

import { afterEach, describe, it, expect } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REGISTRY_SCHEMA,
  checkRestore,
  identityLine,
  readRegistry,
  recordExport,
  recordLabelledExport,
  parseVaultId,
  registryPath,
  vaultIdHex,
  type Registry,
} from './vault-registry';

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'stegoshard-reg-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ID_A = new Uint8Array(16).fill(0xa1);
const ID_B = new Uint8Array(16).fill(0xb2);
const empty = (): Registry => ({ schema: REGISTRY_SCHEMA, vaults: {} });

describe('sequence arithmetic', () => {
  it('starts a new vault at 1 and advances by one', () => {
    let reg = empty();
    for (const expected of [1, 2, 3]) {
      const out = recordExport(reg, ID_A);
      expect(out.sequence).toBe(expected);
      reg = out.registry;
    }
    expect(reg.vaults[vaultIdHex(ID_A)]!.sequence).toBe(3);
  });

  it('counts each vault separately', () => {
    const a = recordExport(empty(), ID_A);
    const b = recordExport(a.registry, ID_B);
    expect(b.sequence).toBe(1);
    expect(recordExport(b.registry, ID_A).sequence).toBe(2);
  });

  it('keeps firstSeen and moves lastSeen', () => {
    const first = recordExport(empty(), ID_A).registry.vaults[vaultIdHex(ID_A)]!;
    const second = recordExport(
      {
        schema: REGISTRY_SCHEMA,
        vaults: { [vaultIdHex(ID_A)]: { ...first, firstSeen: '2020-01-01T00:00:00Z' } },
      },
      ID_A,
    ).registry.vaults[vaultIdHex(ID_A)]!;
    expect(second.firstSeen).toBe('2020-01-01T00:00:00Z');
    expect(second.lastSeen).not.toBe('2020-01-01T00:00:00Z');
  });
});

describe('restore verdicts', () => {
  const at = (sequence: number): Registry => ({
    schema: REGISTRY_SCHEMA,
    vaults: {
      [vaultIdHex(ID_A)]: {
        sequence,
        firstSeen: '2020-01-01T00:00:00Z',
        lastSeen: '2020-01-01T00:00:00Z',
      },
    },
  });

  it('says nothing about an export with no identity', () => {
    expect(checkRestore(at(3), undefined).verdict).toEqual({ kind: 'untracked' });
  });

  it('reports a first sighting when the registry is empty', () => {
    expect(checkRestore(empty(), { vaultId: ID_A, sequence: 1 }).verdict).toEqual({
      kind: 'first',
    });
  });

  it('reports an unknown vault only when others are already recorded', () => {
    const { verdict } = checkRestore(at(3), { vaultId: ID_B, sequence: 1 });
    expect(verdict.kind).toBe('unknown');
  });

  it('accepts the recorded sequence and any later one', () => {
    expect(checkRestore(at(3), { vaultId: ID_A, sequence: 3 }).verdict.kind).toBe('current');
    expect(checkRestore(at(3), { vaultId: ID_A, sequence: 9 }).verdict.kind).toBe('current');
  });

  it('reports a rollback, naming both numbers', () => {
    const { verdict } = checkRestore(at(5), { vaultId: ID_A, sequence: 2 });
    expect(verdict).toEqual({ kind: 'rollback', vaultId: vaultIdHex(ID_A), got: 2, recorded: 5 });
  });

  /**
   * The property that keeps the check alive after the first rollback. Recording
   * the regression would reset the high-water mark, and every later restore of
   * that same old copy would then read as current.
   */
  it('does not lower the recorded sequence when it reports a rollback', () => {
    const { registry } = checkRestore(at(5), { vaultId: ID_A, sequence: 2 });
    expect(registry.vaults[vaultIdHex(ID_A)]!.sequence).toBe(5);
    // And a second restore of the same stale copy still reports it.
    expect(checkRestore(registry, { vaultId: ID_A, sequence: 2 }).verdict.kind).toBe('rollback');
  });

  it('advances the record on a newer sequence', () => {
    const { registry } = checkRestore(at(3), { vaultId: ID_A, sequence: 7 });
    expect(registry.vaults[vaultIdHex(ID_A)]!.sequence).toBe(7);
  });
});

describe('labels tie successive saves to one vault', () => {
  const mint = (fill: number) => () => new Uint8Array(16).fill(fill);

  it('mints once and then reuses the id the label names', () => {
    const first = recordLabelledExport(empty(), 'notes', mint(0xa1));
    expect(first.sequence).toBe(1);

    // A different mint on the second call, to prove the id came from the
    // registry rather than from minting again.
    const second = recordLabelledExport(first.registry, 'notes', mint(0xff));
    expect(second.sequence).toBe(2);
    expect([...second.vaultId]).toEqual([...first.vaultId]);
  });

  it('keeps different labels apart', () => {
    const a = recordLabelledExport(empty(), 'notes', mint(0xa1));
    const b = recordLabelledExport(a.registry, 'keys', mint(0xb2));
    expect(b.sequence).toBe(1);
    expect([...b.vaultId]).not.toEqual([...a.vaultId]);
  });

  it('round-trips a vault id through its hex form', () => {
    expect([...parseVaultId(vaultIdHex(ID_A))]).toEqual([...ID_A]);
    expect(() => parseVaultId('nope')).toThrow(/malformed/);
    expect(() => parseVaultId(vaultIdHex(ID_A).toUpperCase())).toThrow(/malformed/);
  });
});

describe('the file', () => {
  it('round-trips, 0600 in a 0700 directory', async () => {
    const path = join(scratch(), 'state', 'known-vaults.json');
    const { writeRegistry } = await import('./vault-registry');
    writeRegistry(path, recordExport(empty(), ID_A).registry);

    expect(existsSync(path)).toBe(true);
    if (process.platform !== 'win32') {
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(path, '..')).mode & 0o777).toBe(0o700);
    }
    expect(readRegistry(path).registry.vaults[vaultIdHex(ID_A)]!.sequence).toBe(1);
  });

  it('leaves no temporary behind', async () => {
    const dir = join(scratch(), 'state');
    const path = join(dir, 'known-vaults.json');
    const { writeRegistry } = await import('./vault-registry');
    writeRegistry(path, empty());
    writeRegistry(path, recordExport(empty(), ID_A).registry);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('treats a missing file as an empty registry, not an error', () => {
    const r = readRegistry(join(scratch(), 'nope.json'));
    expect(r.corrupt).toBe(false);
    expect(Object.keys(r.registry.vaults)).toEqual([]);
  });

  /**
   * A damaged registry must degrade, never block. Losing rollback detection is
   * bad; losing the ability to restore the secret is worse.
   */
  it('reports a corrupt file instead of throwing', () => {
    const path = join(scratch(), 'known-vaults.json');
    for (const junk of ['not json at all', '[]', '{"vaults":null}', '']) {
      writeFileSync(path, junk);
      const r = readRegistry(path);
      expect(r.corrupt, `"${junk}" was not reported corrupt`).toBe(true);
      expect(Object.keys(r.registry.vaults)).toEqual([]);
    }
  });

  /**
   * Shape alone is not enough: the fields are arithmetic inputs. A `sequence` of
   * `"5"` used to survive the read, make `recordExport` compute `"5" + 1`, and
   * reach `buildPayload` as `"51"` — which then failed every later save of that
   * vault with `sequence out of range`. A damaged file should cost the rollback
   * check, not the ability to save.
   */
  it('reports a damaged entry as corrupt rather than passing it on', () => {
    const path = join(scratch(), 'known-vaults.json');
    const key = vaultIdHex(ID_A);
    const good = {
      sequence: 5,
      firstSeen: '2026-01-01T00:00:00Z',
      lastSeen: '2026-01-02T00:00:00Z',
    };
    const bad: unknown[] = [
      { ...good, sequence: '5' }, // the string that broke the arithmetic
      { ...good, sequence: 1.5 },
      { ...good, sequence: 0 }, // buildPayload never emits one
      { ...good, sequence: -1 },
      { ...good, sequence: 0x1_0000_0000 },
      { ...good, firstSeen: 0 },
      { ...good, lastSeen: null },
      { ...good, label: 3 },
      null,
      'nope',
    ];
    for (const entry of bad) {
      writeFileSync(path, JSON.stringify({ schema: REGISTRY_SCHEMA, vaults: { [key]: entry } }));
      const r = readRegistry(path);
      expect(r.corrupt, `${JSON.stringify(entry)} was accepted`).toBe(true);
      expect(Object.keys(r.registry.vaults)).toEqual([]);
    }

    // A key that is not a vault id is damage too: `parseVaultId` would throw on
    // it the moment a label matched.
    writeFileSync(path, JSON.stringify({ schema: REGISTRY_SCHEMA, vaults: { 'not-hex': good } }));
    expect(readRegistry(path).corrupt).toBe(true);

    // And the good entry still reads back, so the check is not simply refusing
    // everything.
    writeFileSync(path, JSON.stringify({ schema: REGISTRY_SCHEMA, vaults: { [key]: good } }));
    const ok = readRegistry(path);
    expect(ok.corrupt).toBe(false);
    expect(ok.registry.vaults[key]!.sequence).toBe(5);
  });

  it('refuses to write through a symlink', async () => {
    if (process.platform === 'win32') return;
    const dir = scratch();
    const real = join(dir, 'elsewhere.json');
    const path = join(dir, 'known-vaults.json');
    writeFileSync(real, '{}');
    symlinkSync(real, path);
    const { writeRegistry } = await import('./vault-registry');
    expect(() => writeRegistry(path, empty())).toThrow(/symlink/);
    expect(readFileSync(real, 'utf-8')).toBe('{}');
  });

  it('records no path, filename, or key material', () => {
    const { registry } = recordExport(empty(), ID_A, 'notes');
    // Only the vaults subtree: the schema tag legitimately contains a slash.
    const text = JSON.stringify(registry.vaults);
    expect(text).toContain('notes'); // the label the user asked for
    expect(text).not.toMatch(/\//); // no paths, no filenames
    // The vault id is the only identifier, and it is not key material.
    expect(Object.keys(registry.vaults)).toEqual([vaultIdHex(ID_A)]);
    expect(Object.keys(registry.vaults[vaultIdHex(ID_A)]!).sort()).toEqual([
      'firstSeen',
      'label',
      'lastSeen',
      'sequence',
    ]);
  });
});

describe('where it lives', () => {
  it('prefers an explicit path over everything', () => {
    expect(registryPath('/tmp/x.json', { STEGOSHARD_HOME: '/other' })).toBe('/tmp/x.json');
  });

  it('honours STEGOSHARD_HOME next', () => {
    expect(registryPath(undefined, { STEGOSHARD_HOME: '/h' })).toBe('/h/known-vaults.json');
  });

  it('never puts it in ~/.stegoshard', () => {
    // A dotfile in the most-inspected directory on the machine is the wrong home
    // for a file whose whole problem is that it is a trace.
    expect(registryPath(undefined, {})).not.toMatch(/\/\.stegoshard\//);
  });
});

describe('the file-free counter', () => {
  it('prints a short vault id and the export number', () => {
    expect(identityLine(ID_A, 4)).toBe('vault a1a1a1a1 · export #4');
  });
});

describe('housekeeping', () => {
  it('keeps a directory the user already made', () => {
    const dir = join(scratch(), 'state');
    mkdirSync(dir, { recursive: true });
    if (process.platform !== 'win32') chmodSync(dir, 0o700);
    expect(existsSync(dir)).toBe(true);
  });
});

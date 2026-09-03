/**
 * The public API surface, guarded at the value level.
 *
 * `docs/api/*.api.md` already pins the *types*, verified by `npm run api:check`.
 * This is the second layer, and it catches what a declaration rollup cannot: a
 * runtime export that the type checker never sees, and an accidental `export *`
 * regression that would widen the surface by two hundred names at once.
 *
 * `surface.txt` is committed. A diff there is the point: widening the API should
 * be a line in a review, not something that happens.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import * as api from '../../src/api/index';
import * as nodeApi from '../../src/api/node';
import * as core from '../../src/core/index';

const SURFACE = join(import.meta.dirname, 'surface.txt');

/** The committed record: one `entry:name` line per export, sorted. */
function committed(): string[] {
  return readFileSync(SURFACE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

function actual(): string[] {
  return [
    ...Object.keys(api).map((n) => `stegoshard:${n}`),
    ...Object.keys(nodeApi).map((n) => `stegoshard/node:${n}`),
  ].sort();
}

describe('the published surface', () => {
  it('matches the committed record exactly', () => {
    // Rendered as one string so a failure shows a readable diff rather than two
    // arrays of a hundred entries each.
    expect(actual().join('\n')).toBe(committed().join('\n'));
  });

  it('is far narrower than the internal barrel', () => {
    // The whole argument for a curated facade: `src/core/index.ts` re-exports
    // everything, including the Galois field and the SPEC §10 slot layer.
    expect(Object.keys(core).length).toBeGreaterThan(200);
    expect(Object.keys(api).length).toBeLessThan(Object.keys(core).length / 2);
  });

  it('keeps the two entry points disjoint', () => {
    const shared = Object.keys(api).filter((n) => n in nodeApi);
    expect(shared, 'an entry point must not re-export the other').toEqual([]);
  });
});

describe('what must never be published', () => {
  /**
   * Names whose presence would mean an internal leaked out. Not an exhaustive
   * list of internals, a tripwire: every one of these is reachable from the core
   * barrel today, so an accidental `export *` from `../core` fails here loudly
   * instead of quietly freezing the erasure coding, the field arithmetic, the
   * region geometry or the §10 slot layer as public API.
   */
  const FORBIDDEN = [
    // Galois field and erasure coding.
    'gfAdd',
    'gfMul',
    'gfDiv',
    'gfInv',
    'rsEncode',
    'rsReconstructData',
    'buildCauchyMatrix',
    'buildEncodingMatrix',
    'invertMatrix',
    'splitIntoShards',
    'encodeShards',
    'decodeBlob',
    'parityCount',
    // Low-level crypto: publishing these invites misuse.
    'deriveKEK',
    'deriveKekBytes',
    'hkdf',
    'aeadSeal',
    'aeadOpen',
    'wrapDEK',
    'unwrapDEK',
    'generateDEK',
    'deriveContentKey',
    'secureShuffle',
    // SPEC §10 geometry. Exporting it would freeze the access structures' shape.
    'buildSlotArray',
    'openSlotArray',
    'tryOpenSlot',
    'unlockSlotArray',
    'slotKekRaw',
    'slotKekCandidates',
    'deriveSlotKek',
    'gateKek',
    'deriveRegionKey',
    'padRegionPlaintext',
    'parseRegionPlaintext',
    'pickBucket',
    // The JPEG coefficient model. `decode`/`encode` as bare names are the single
    // clearest reason the internal barrel is unpublishable.
    'decode',
    'encode',
    'eligibleCoefficients',
    'applyScanToggles',
    // Wire-format internals.
    'buildVaultBlob',
    'decodeVaultBlob',
    'buildSegmentedBlob',
    'decodeSegmentedBlob',
    'packSqlite',
    'unpackSqlite',
    'buildPayload',
    'parsePayload',
    'encodeHeader',
    'encodeImagePayload',
    'decodeImagePayload',
  ];

  for (const name of FORBIDDEN) {
    it(`does not export ${name}`, () => {
      expect(name in api, `${name} leaked into stegoshard`).toBe(false);
      expect(name in nodeApi, `${name} leaked into stegoshard/node`).toBe(false);
    });
  }

  // Mutable module state must not travel: a consumer could reassign the bytes
  // every vault is identified by.
  it('exports no format magic or salt', () => {
    for (const name of Object.keys(api)) {
      expect(name, `${name} looks like raw format state`).not.toMatch(/MAGIC$|_SALT$/);
    }
  });
});

describe('invariants the surface itself enforces', () => {
  // Post-save verification is not negotiable. `save()` always round-trips what it
  // wrote before returning; an option to skip it would be an option to ship a
  // vault nobody has shown is recoverable.
  it('offers no way to skip verification', () => {
    for (const name of [...Object.keys(api), ...Object.keys(nodeApi)]) {
      expect(name).not.toMatch(/^(skipVerif|noVerif|unsafe|unchecked)/i);
    }
    // The verify functions are exported, though: a consumer building its own
    // pipeline out of exportVault has to be able to run the same check.
    expect(api).toHaveProperty('verifyImageExport');
    expect(api).toHaveProperty('verifyBinaryExport');
    expect(api).toHaveProperty('verifyDisguisedExport');
    expect(api).toHaveProperty('verifyGalleryExport');
  });

  // Only the self-verifying container builders are public; the blob-level ones
  // underneath need §10 knowledge to use correctly.
  it('exposes the access structures only through their container builders', () => {
    expect(api).toHaveProperty('buildDuressDbContainer');
    expect(api).toHaveProperty('buildNonPossessionDbContainer');
    for (const name of [
      'buildDuressVaultBlob',
      'buildNonPossessionVaultBlob',
      'buildDuressSegmentedBlob',
      'buildNonPossessionSegmentedBlob',
      'verifyDbRegion',
    ]) {
      expect(name in api, `${name} is blob-level and must stay internal`).toBe(false);
    }
  });
});

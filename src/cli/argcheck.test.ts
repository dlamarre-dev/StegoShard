/**
 * The argument-shape validators, which reject flag combinations by name.
 *
 * These assertions used to live in the save/restore round-trip suite. They moved
 * out with the validators themselves when the orchestration layer left
 * `src/cli`: they are about `--codec` and `--entropy-file`, which exist only for
 * the command line, so they belong beside the layer that parses them rather than
 * beside the layer that does the work.
 */

import { describe, it, expect } from 'vitest';
import { codecArgError, entropyArgError } from './argcheck';

describe('--codec / --paper validation', () => {
  it('accepts plain --paper, and only rejects an explicit --codec color with it', () => {
    // Regression: the codec default is 'color', so validating the *resolved*
    // value instead of what the user typed broke `save --paper` outright.
    expect(codecArgError(undefined, true)).toBeNull();
    expect(codecArgError(undefined, false)).toBeNull();
    expect(codecArgError('qr', true)).toBeNull();
    expect(codecArgError('color', false)).toBeNull();
    expect(codecArgError('color', true)).toMatch(/--paper/);
    expect(codecArgError('rainbow', false)).toMatch(/invalid --codec/);
  });
});

describe('--entropy* validation', () => {
  it('rejects unusable combinations, accepts a single source', () => {
    expect(entropyArgError({})).toBeNull();
    expect(entropyArgError({ text: 'dice' })).toBeNull();
    expect(entropyArgError({ file: 'dice.txt' })).toBeNull();
    expect(entropyArgError({ prompt: true })).toBeNull();
    expect(entropyArgError({ text: 'dice', file: 'dice.txt' })).toMatch(/mutually exclusive/);
    expect(entropyArgError({ file: 'dice.txt', prompt: true })).toMatch(/mutually exclusive/);
    expect(entropyArgError({ text: '' })).toMatch(/empty/);
    // The env var is an ambient fallback a typed flag simply outranks, so it is
    // deliberately not part of the exclusivity check.
    expect(entropyArgError({ text: 'dice', prompt: false })).toBeNull();
  });
});

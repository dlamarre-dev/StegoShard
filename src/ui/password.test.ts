import { describe, it, expect } from 'vitest';
import {
  GENERATED_PASSPHRASE_BITS,
  extraEntropyBits,
  generatePassphrase,
  passwordStrength,
} from './password';

describe('generatePassphrase', () => {
  it('has the documented shape and entropy', () => {
    const p = generatePassphrase();
    expect(p).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/,
    );
    expect(GENERATED_PASSPHRASE_BITS).toBe(100);
    // No confusable characters (I, L, O, U) leak into the alphabet.
    expect(p.replace(/-/g, '')).not.toMatch(/[ILOU]/);
  });

  it('is drawn fresh each call (no repeats across a large sample)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generatePassphrase());
    expect(seen.size).toBe(500);
  });
});

describe('passwordStrength', () => {
  it('scores an empty password as zero', () => {
    expect(passwordStrength('')).toEqual({ bits: 0, score: 0 });
  });

  it('rates longer, more diverse passwords higher', () => {
    const weak = passwordStrength('password');
    const strong = passwordStrength('Tr0ub4dour&3-Xk9!qZ');
    expect(strong.bits).toBeGreaterThan(weak.bits);
    expect(strong.score).toBeGreaterThanOrEqual(weak.score);
  });

  it('damps repeated-character runs below an equal-length diverse string', () => {
    const run = passwordStrength('aaaaaaaaaaaa');
    const diverse = passwordStrength('ax9Kd2mQ7rLp');
    expect(run.bits).toBeLessThan(diverse.bits);
  });

  it('rates a generated passphrase as strong', () => {
    expect(passwordStrength(generatePassphrase()).score).toBeGreaterThanOrEqual(3);
  });
});

describe('extraEntropyBits', () => {
  it('is zero for an empty string', () => {
    expect(extraEntropyBits('')).toBe(0);
  });

  it('collapses a held-down key to nothing', () => {
    // The degenerate input the "type randomly" field invites: passwordStrength
    // alone would call this ~144 bits.
    const held = 'a'.repeat(144);
    expect(passwordStrength(held).bits).toBeGreaterThan(100);
    expect(extraEntropyBits(held)).toBe(0);
  });

  it('barely dents genuinely varied typing', () => {
    const mashed = 'sdfkj29Aw;lkjq3rp98uSDFlkj2#4rkjhsdf9';
    expect(extraEntropyBits(mashed)).toBeGreaterThan(passwordStrength(mashed).bits * 0.8);
  });

  it('scores a page of dice rolls on its real length, not its small alphabet', () => {
    const dice = '4 1 6 2 5 3 6 6 2 1 4 3 5 2 1 3 6 4 2 5 1 1 4 6 3 2 5 4'.repeat(3);
    expect(extraEntropyBits(dice)).toBeGreaterThan(100);
  });

  it('rewards more varied input over a repetitive one of the same length', () => {
    expect(extraEntropyBits('4 1 6 2 5 3 6 6 2 1 4 3 5 2 1')).toBeGreaterThan(
      extraEntropyBits('111111111111111'),
    );
  });
});

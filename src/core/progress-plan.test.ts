/**
 * The weighted progress model: plans, the tracker's arithmetic, and calibration.
 *
 * Every test drives the tracker with a fake clock, so the pacing is exact and
 * nothing here sleeps.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALIBRATION,
  ProgressTracker,
  type Stage,
  estimateMs,
  parseCalibration,
  planSave,
  updateCalibration,
} from './progress-plan';
import type { Progress } from './progress';

/** A clock the test moves by hand. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const stage = (phase: Progress['phase'], units: number): Stage => ({
  phase,
  label: 'encrypting',
  cost: 'cryptoPerMB',
  units,
  baseMs: 0,
});

describe('ProgressTracker', () => {
  it('gives each stage a share proportional to its estimate', () => {
    const c = clock();
    // 1 MB and 3 MB of the same cost: a quarter and three quarters.
    const t = new ProgressTracker(
      [stage('encrypt', 1), stage('decrypt', 3)],
      DEFAULT_CALIBRATION,
      c.now,
    );
    expect(t.onEvent({ phase: 'encrypt', done: 1, total: 1 }).fraction).toBeCloseTo(0.25);
    expect(t.onEvent({ phase: 'decrypt', done: 1, total: 2 }).fraction).toBeCloseTo(0.625);
    expect(t.onEvent({ phase: 'decrypt', done: 2, total: 2 }).finished).toBe(true);
  });

  it('never goes backwards, whatever order the events come in', () => {
    const c = clock();
    const t = new ProgressTracker(
      [stage('encrypt', 1), stage('decrypt', 1), stage('render', 1)],
      DEFAULT_CALIBRATION,
      c.now,
    );
    const events: Progress[] = [
      { phase: 'encrypt', done: 5, total: 10 },
      { phase: 'encrypt', done: 2, total: 10 }, // a late, smaller count
      { phase: 'compress', done: 1, total: 1 }, // matches nothing
      { phase: 'decrypt', done: 3, total: 10 },
      { phase: 'encrypt', done: 9, total: 10 }, // a stage already left behind
      { phase: 'render', done: 1, total: 4 },
    ];
    let last = 0;
    for (const e of events) {
      c.advance(10);
      const f = t.onEvent(e).fraction;
      expect(f).toBeGreaterThanOrEqual(last);
      last = f;
    }
  });

  // The bug this model exists to fix: a verification pass re-running the decrypt
  // path used to refill the bar from zero.
  it('does not reset when a second pass starts', () => {
    const c = clock();
    const t = new ProgressTracker(
      [stage('encrypt', 1), stage('decrypt', 1)],
      DEFAULT_CALIBRATION,
      c.now,
    );
    t.onEvent({ phase: 'encrypt', done: 10, total: 10 });
    expect(t.onEvent({ phase: 'decrypt', done: 0, total: 10 }).fraction).toBeCloseTo(0.5);
  });

  it('counts a stage with no events as done when a later one begins', () => {
    const c = clock();
    const t = new ProgressTracker(
      [stage('derive', 1), stage('compress', 1), stage('encrypt', 1)],
      DEFAULT_CALIBRATION,
      c.now,
    );
    const v = t.onEvent({ phase: 'compress', done: 0, total: 1 });
    expect(v.fraction).toBeCloseTo(1 / 3);
    expect(t.skipped()).toBe(1);
  });

  it('creeps toward the end of an opaque stage without ever reaching it', () => {
    const c = clock();
    const t = new ProgressTracker(
      [stage('derive', 1), stage('encrypt', 1)],
      DEFAULT_CALIBRATION,
      c.now,
    );
    const v = t.onEvent({ phase: 'derive', done: 0, total: 1 });
    expect(v.fraction).toBe(0);
    expect(v.target).toBeLessThan(0.5);
    expect(v.target).toBeGreaterThan(0.45);
    expect(v.targetMs).toBeCloseTo(estimateMs(stage('derive', 1), DEFAULT_CALIBRATION));
  });

  it('creeps toward the end of the unit in progress on a counted stage', () => {
    const c = clock();
    const t = new ProgressTracker([stage('render', 1)], DEFAULT_CALIBRATION, c.now);
    const v = t.onEvent({ phase: 'render', done: 1, total: 4 });
    expect(v.fraction).toBeCloseTo(0.25);
    expect(v.target).toBeGreaterThan(0.25);
    expect(v.target).toBeLessThan(0.5);
  });

  /**
   * A device three times slower than the defaults: once the first stage has
   * taken three times its estimate, everything after it is re-paced, and the
   * share of the bar still ahead is spread over the new estimates.
   */
  it('re-paces the stages ahead from how long the finished ones really took', () => {
    const c = clock();
    const stages = [stage('encrypt', 1), stage('decrypt', 1)];
    const est = estimateMs(stages[0]!, DEFAULT_CALIBRATION);
    const t = new ProgressTracker(stages, DEFAULT_CALIBRATION, c.now);
    c.advance(est * 3);
    t.onEvent({ phase: 'encrypt', done: 1, total: 1 });
    const v = t.onEvent({ phase: 'decrypt', done: 0, total: 0 });
    expect(v.fraction).toBeCloseTo(0.5);
    expect(v.targetMs).toBeCloseTo(est * 3);
  });

  it('fills the bar on complete(), and measures only real stages', () => {
    const c = clock();
    const stages: Stage[] = [
      { phase: 'derive', label: 'deriving', cost: 'argon2', units: 1024, baseMs: 0 },
      stage('encrypt', 1),
    ];
    const t = new ProgressTracker(stages, DEFAULT_CALIBRATION, c.now);
    t.onEvent({ phase: 'derive', done: 0, total: 1 });
    c.advance(2048);
    t.onEvent({ phase: 'derive', done: 1, total: 1 });
    expect(t.complete().fraction).toBe(1);
    expect(t.samples()).toEqual([{ cost: 'argon2', msPerUnit: 2 }]);
  });
});

describe('planSave', () => {
  it('scales the Argon2 stages with the derivation parameters', () => {
    const light = planSave({
      surface: 'cli',
      dest: 'binary',
      keyMode: 'embedded',
      secretBytes: 1000,
      mintsKey: true,
      argon2: { iterations: 1, memoryKiB: 1024, parallelism: 1 },
    });
    const heavy = planSave({
      surface: 'cli',
      dest: 'binary',
      keyMode: 'embedded',
      secretBytes: 1000,
      mintsKey: true,
    });
    expect(light[0]!.units).toBe(1);
    expect(heavy[0]!.units).toBe(1024);
  });

  it('lists a gallery in the order the browser runs it', () => {
    const phases = planSave({
      surface: 'web',
      dest: 'gallery',
      keyMode: 'stego',
      secretBytes: 100,
      coverBytes: [1e6, 1e6],
      stegoCoverBytes: 1e6,
    }).map((s) => `${s.phase}:${s.label}`);
    expect(phases).toEqual([
      'compress:compressing',
      'reencode:preparingPhotos',
      'prepare:preparingPhotos',
      'derive:hiding',
      'derive:hiding',
      'embed:hiding',
      'derive:hidingKey',
      'derive:verifying',
      'extract:verifying',
      'derive:verifying',
      'derive:verifying',
      'deliver:delivering',
    ]);
  });

  it('puts the extension stego check and the web key first', () => {
    const ext = planSave({
      surface: 'extension',
      dest: 'disk',
      keyMode: 'stego',
      secretBytes: 100,
      checksStegoPassword: true,
    });
    expect(ext[0]!.label).toBe('checkingPassword');
    const web = planSave({
      surface: 'web',
      dest: 'paper',
      keyMode: 'embedded',
      secretBytes: 100,
      mintsKey: true,
    });
    expect(web[0]!.label).toBe('deriving');
  });
});

describe('calibration', () => {
  it('moves toward a measured cost, a step at a time', () => {
    const next = updateCalibration(DEFAULT_CALIBRATION, [{ cost: 'argon2', msPerUnit: 1.5 }], 0.5);
    expect(next.argon2).toBeCloseTo((DEFAULT_CALIBRATION.argon2 + 1.5) / 2);
  });

  it('clamps an outlier to five times the current value', () => {
    const next = updateCalibration(DEFAULT_CALIBRATION, [{ cost: 'argon2', msPerUnit: 1e6 }], 1);
    expect(next.argon2).toBeCloseTo(DEFAULT_CALIBRATION.argon2 * 5);
  });

  /**
   * A small save's stages are almost all fixed overhead: a few kilobytes are a
   * sliver of a megabyte, and the elapsed time divided by that sliver reads as a
   * rate hundreds of times too slow. Learned from, it ratcheted the stored rate
   * upward by about 2.2x on every small save, without bound.
   */
  it('does not learn a rate from a stage that is mostly fixed overhead', () => {
    let t = 0;
    const tiny: Stage = {
      phase: 'encrypt',
      label: 'encrypting',
      cost: 'cryptoPerMB',
      units: 5 / 1024, // 5 KB
      baseMs: 20,
    };
    const tracker = new ProgressTracker([tiny], DEFAULT_CALIBRATION, () => t);
    tracker.onEvent({ phase: 'encrypt', done: 0, total: 1 });
    t = 200;
    tracker.onEvent({ phase: 'encrypt', done: 1, total: 1 });
    expect(tracker.samples()).toEqual([]);
  });

  it('never drifts more than twenty times from the default, however many bad samples', () => {
    let c = DEFAULT_CALIBRATION;
    for (let i = 0; i < 50; i++)
      c = updateCalibration(c, [{ cost: 'cryptoPerMB', msPerUnit: 1e9 }]);
    expect(c.cryptoPerMB).toBeCloseTo(DEFAULT_CALIBRATION.cryptoPerMB * 20);
    for (let i = 0; i < 50; i++) c = updateCalibration(c, [{ cost: 'cryptoPerMB', msPerUnit: 0 }]);
    expect(c.cryptoPerMB).toBeCloseTo(DEFAULT_CALIBRATION.cryptoPerMB / 20);
  });

  it('reads back only what it wrote, falling back field by field', () => {
    expect(parseCalibration(null)).toBeNull();
    expect(parseCalibration({ v: 2, argon2: 1 })).toBeNull();
    const back = parseCalibration({ v: 1, argon2: 1.25, gzipPerMB: -3, embedPerMB: 'x' });
    expect(back?.argon2).toBe(1.25);
    expect(back?.gzipPerMB).toBe(DEFAULT_CALIBRATION.gzipPerMB);
    expect(back?.embedPerMB).toBe(DEFAULT_CALIBRATION.embedPerMB);
  });
});

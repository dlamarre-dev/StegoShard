/**
 * Every CLI save path, replayed into its own progress plan.
 *
 * The plan (`savePlan`, `gallerySavePlan`) lists the stages in the order the code
 * runs them. If the two drift apart, an event arrives for a stage further along
 * than the tracker expects, it skips ahead, and the bar jumps. So each path is run
 * for real, its events recorded, and the plan has to reach its end skipping only
 * the stages that are known to report nothing (the derivation `makeKey` runs
 * before the first event, and the slot key the `.db` path derives the same way).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { encode as encodePng } from 'fast-png';
import {
  DEFAULT_CALIBRATION,
  ProgressTracker,
  resetStegoCoverGuard,
  type Progress,
  type Stage,
} from '../../core';
import {
  gallerySavePlan,
  restorePlan,
  runGalleryRestore,
  runGallerySave,
  runRestore,
  runSave,
  savePlan,
  type GallerySaveOptions,
  type RestoreOptions,
  type SaveOptions,
} from './commands';

const SLOW = { timeout: 180_000 };
const PW = 'a long unrelated passphrase for these tests';

beforeEach(resetStegoCoverGuard);

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ss-progress-'));

function secretIn(dir: string): string {
  const p = join(dir, 's.txt');
  writeFileSync(p, 'a secret that is reported on\n'.repeat(20));
  return p;
}

function noisyPng(path: string, side: number, seed: number): void {
  const data = new Uint8Array(side * side * 4);
  let s = seed >>> 0;
  for (let i = 0; i < side * side; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i * 4] = s >>> 24;
    data[i * 4 + 1] = (s >>> 16) & 0xff;
    data[i * 4 + 2] = (s >>> 8) & 0xff;
    data[i * 4 + 3] = 255;
  }
  writeFileSync(path, encodePng({ width: side, height: side, data, channels: 4, depth: 8 }));
}

/** Replay `events` into `plan`; return how many stages ended with no event. */
function replay(plan: Stage[], events: Progress[]): { skipped: number; finished: boolean } {
  const tracker = new ProgressTracker(plan, DEFAULT_CALIBRATION, () => 0);
  let last = 0;
  for (const e of events) {
    const f = tracker.onEvent(e).fraction;
    expect(f).toBeGreaterThanOrEqual(last);
    last = f;
  }
  return { skipped: tracker.skipped(), finished: tracker.view().finished };
}

describe('CLI save paths match their progress plans', () => {
  const cases: [string, Partial<SaveOptions>, number][] = [
    // The vault key `makeKey` derives before the first event: one silent stage.
    ['image set', {}, 1],
    ['paper', { paper: true }, 1],
    ['branded .ssbn', { binary: 'branded' }, 1],
    // The .db slot key is derived before the first event, and its self-check
    // opens the region with the DEK it already holds, so no unlock is reported.
    ['disguised .db', { binary: 'disguised' }, 2],
  ];
  it.each(cases)('%s', SLOW, async (_name, extra, silent) => {
    const dir = tmp();
    const opts: SaveOptions = {
      inputs: [secretIn(dir)],
      outDir: join(dir, 'out'),
      password: PW,
      paper: false,
      zip: true,
      keyMode: 'embedded',
      ...extra,
    };
    const events: Progress[] = [];
    await runSave(opts, (p) => {
      events.push(p);
    });
    const { skipped, finished } = replay(savePlan(opts), events);
    expect(finished).toBe(true);
    expect(skipped).toBe(silent);
  });

  it('gallery, with a key photo', SLOW, async () => {
    const dir = tmp();
    const covers = join(dir, 'covers');
    mkdirSync(covers);
    for (let i = 0; i < 12; i++) noisyPng(join(covers, `c${i}.png`), 768, i + 1);
    const keyCover = join(dir, 'key.png');
    noisyPng(keyCover, 768, 99);
    const opts: GallerySaveOptions = {
      secretFile: secretIn(dir),
      covers: [covers],
      outDir: join(dir, 'album'),
      password: PW,
      keyMode: 'stego',
      keyCover,
    };
    const events: Progress[] = [];
    await runGallerySave(opts, (p) => {
      events.push(p);
    });
    const { skipped, finished } = replay(gallerySavePlan(opts), events);
    expect(finished).toBe(true);
    expect(skipped).toBe(0);
  });
});

/** The stego key photo a save wrote, found by purpose. */
const keyPhotoOf = (manifest: readonly { name: string; purpose: string }[]): string =>
  manifest.find((m) => m.purpose === 'stegoCover')!.name;

describe('CLI restore paths match their progress plans', () => {
  const cases: [string, Partial<SaveOptions>, 'explicit' | 'among' | 'none'][] = [
    ['image set', {}, 'none'],
    ['image set, key photo given with --key', { keyMode: 'stego' }, 'explicit'],
    ['paper', { paper: true }, 'none'],
    ['branded .ssbn', { binary: 'branded' }, 'none'],
    ['branded .ssbn, key photo among the inputs', { binary: 'branded', keyMode: 'stego' }, 'among'],
    ['disguised .db', { binary: 'disguised' }, 'none'],
  ];
  it.each(cases)('%s', SLOW, async (_name, extra, key) => {
    const dir = tmp();
    const cover = join(dir, 'cover.png');
    noisyPng(cover, 256, 5);
    const save = await runSave({
      inputs: [secretIn(dir)],
      outDir: join(dir, 'out'),
      password: PW,
      paper: false,
      zip: false,
      keyMode: 'embedded',
      ...(extra.keyMode === 'stego' ? { cover } : {}),
      ...extra,
    });
    const keyPhoto = key === 'none' ? undefined : keyPhotoOf(save.manifest);
    const opts: RestoreOptions = {
      inputs: key === 'explicit' ? save.files.filter((f) => f !== keyPhoto) : save.files,
      outDir: join(dir, 'restored'),
      password: PW,
      ...(key === 'explicit' ? { keyPath: keyPhoto } : {}),
    };
    const events: Progress[] = [];
    await runRestore(opts, (p) => {
      events.push(p);
    });
    const { skipped, finished } = replay(restorePlan(opts), events);
    expect(finished).toBe(true);
    expect(skipped).toBe(0);
  });

  it.each([false, true])('gallery (key photo given with --key: %s)', SLOW, async (stego) => {
    const dir = tmp();
    const covers = join(dir, 'covers');
    mkdirSync(covers);
    for (let i = 0; i < 12; i++) noisyPng(join(covers, `c${i}.png`), 768, i + 21);
    const keyCover = join(dir, 'key.png');
    noisyPng(keyCover, 768, 77);
    const save = await runGallerySave({
      secretFile: secretIn(dir),
      covers: [covers],
      outDir: join(dir, 'album'),
      password: PW,
      keyMode: stego ? 'stego' : 'embedded',
      ...(stego ? { keyCover } : {}),
    });
    const keyPhoto = stego ? keyPhotoOf(save.manifest) : undefined;
    const opts: RestoreOptions = {
      inputs: save.files.filter((f) => f !== keyPhoto),
      outDir: join(dir, 'restored'),
      password: PW,
      ...(keyPhoto ? { keyPath: keyPhoto } : {}),
    };
    const events: Progress[] = [];
    await runGalleryRestore(opts, (p) => {
      events.push(p);
    });
    const { skipped, finished } = replay(restorePlan(opts, true), events);
    expect(finished).toBe(true);
    expect(skipped).toBe(0);
  });
});

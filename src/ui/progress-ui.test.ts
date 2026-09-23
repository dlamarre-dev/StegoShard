/**
 * The progress bar, against stand-in elements.
 *
 * The suite has no DOM, and the bar needs very little of one: `hidden`, a class
 * list, attributes, an inline `transform`, and `animate`. Stand-ins record what
 * the bar did with each, which is also exactly what these tests assert.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CALIBRATION, type CostSample, type Stage } from '@core';
import { makeProgressUI } from './progress-ui';
import { localCalibrationStore, type CalibrationStore } from './progress-calibration';

interface Fake {
  hidden: boolean;
  textContent: string;
  style: { transform: string };
  attrs: Map<string, string>;
  classes: Set<string>;
  animations: { frames: { transform: string }[]; options: { duration: number } }[];
}

function fake(): Fake & HTMLElement {
  const f: Fake = {
    hidden: true,
    textContent: '',
    style: { transform: '' },
    attrs: new Map(),
    classes: new Set(),
    animations: [],
  };
  const el = {
    ...f,
    classList: {
      add: (c: string) => f.classes.add(c),
      remove: (c: string) => f.classes.delete(c),
      toggle: (c: string, on?: boolean) => (on ? f.classes.add(c) : f.classes.delete(c)),
    },
    setAttribute: (k: string, v: string) => f.attrs.set(k, v),
    removeAttribute: (k: string) => f.attrs.delete(k),
    getAnimations: () => [],
    animate: (frames: { transform: string }[], options: { duration: number }) => {
      f.animations.push({ frames, options });
      return { cancel: () => {} };
    },
  };
  // One object, so `hidden`/`textContent`/`style` writes land where the test reads.
  return Object.assign(el, {
    attrs: f.attrs,
    classes: f.classes,
    animations: f.animations,
  }) as never;
}

const msg = (key: string): string => key;

const stages: Stage[] = [
  { phase: 'derive', label: 'deriving', cost: 'argon2', units: 1024, baseMs: 0 },
  { phase: 'encrypt', label: 'encrypting', cost: 'cryptoPerMB', units: 1, baseMs: 0 },
];

function memoryStore(): CalibrationStore & { learned: CostSample[][] } {
  const learned: CostSample[][] = [];
  return { load: () => DEFAULT_CALIBRATION, learn: (s) => void learned.push([...s]), learned };
}

describe('makeProgressUI with a plan', () => {
  it('is visible, labelled and animating before begin() resolves', async () => {
    const [bar, fill, status] = [fake(), fake(), fake()];
    const ui = makeProgressUI(bar, fill, status, msg, { store: memoryStore(), now: () => 0 });
    const shown = ui.begin(stages);
    // Synchronously: the bar is up before anything slow can run.
    expect(bar.hidden).toBe(false);
    expect(status.textContent).toBe('statusDeriving');
    expect(bar.attrs.get('aria-valuenow')).toBe('0');
    expect(fill.animations).toHaveLength(1);
    await shown;
  });

  it('takes its label from the stage, and never draws backwards', () => {
    const [bar, fill, status] = [fake(), fake(), fake()];
    const ui = makeProgressUI(bar, fill, status, msg, { store: memoryStore(), now: () => 0 });
    void ui.begin(stages);
    ui.onProgress({ phase: 'derive', done: 1, total: 1 });
    expect(status.textContent).toBe('statusEncrypting');
    const after = Number(bar.attrs.get('aria-valuenow'));
    ui.onProgress({ phase: 'derive', done: 0, total: 1 }); // stale: already past it
    expect(Number(bar.attrs.get('aria-valuenow'))).toBe(after);
  });

  it('only steps, with no animation, under reduced motion', () => {
    const [bar, fill, status] = [fake(), fake(), fake()];
    const ui = makeProgressUI(bar, fill, status, msg, {
      store: memoryStore(),
      now: () => 0,
      reducedMotion: true,
    });
    void ui.begin(stages);
    ui.onProgress({ phase: 'derive', done: 1, total: 1 });
    expect(fill.animations).toHaveLength(0);
    expect(fill.style.transform).toMatch(/^scaleX\(0\.\d+\)$/);
  });

  it('records timings only for a save that succeeded', () => {
    const store = memoryStore();
    const [bar, fill, status] = [fake(), fake(), fake()];
    let t = 0;
    const ui = makeProgressUI(bar, fill, status, msg, { store, now: () => t });
    void ui.begin(stages);
    ui.onProgress({ phase: 'derive', done: 0, total: 1 });
    t = 3000;
    ui.onProgress({ phase: 'derive', done: 1, total: 1 });
    ui.done(false);
    expect(store.learned).toHaveLength(0);
    expect(bar.hidden).toBe(true);

    void ui.begin(stages);
    ui.onProgress({ phase: 'derive', done: 0, total: 1 });
    t = 6000;
    ui.onProgress({ phase: 'derive', done: 1, total: 1 });
    ui.done(true);
    expect(store.learned).toHaveLength(1);
    expect(store.learned[0]![0]!.cost).toBe('argon2');
  });
});

describe('makeProgressUI without a plan', () => {
  it('falls back to a percentage per phase, and a sweep for an indeterminate one', () => {
    const [bar, fill, status] = [fake(), fake(), fake()];
    const ui = makeProgressUI(bar, fill, status, msg, { store: memoryStore() });
    ui.onProgress({ phase: 'decrypt', done: 1, total: 4 });
    expect(bar.hidden).toBe(false);
    expect(fill.style.transform).toBe('scaleX(0.2500)');
    expect(status.textContent).toBe('statusDecrypting');
    ui.onProgress({ phase: 'unlock', done: 0, total: 0 });
    expect(fill.classes.has('progress-bar--indeterminate')).toBe(true);
  });
});

describe('localCalibrationStore', () => {
  function memoryStorage(): Storage {
    const m = new Map<string, string>();
    return {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, v),
      removeItem: (k) => void m.delete(k),
      clear: () => m.clear(),
      key: () => null,
      get length() {
        return m.size;
      },
    };
  }

  it('starts from the defaults and keeps what it learns', () => {
    const store = localCalibrationStore(memoryStorage());
    expect(store.load()).toEqual(DEFAULT_CALIBRATION);
    store.learn([{ cost: 'argon2', msPerUnit: 1 }]);
    expect(store.load().argon2).toBeLessThan(DEFAULT_CALIBRATION.argon2);
  });

  it('shrugs off storage that throws or holds junk', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    } as unknown as Storage;
    const store = localCalibrationStore(broken);
    expect(store.load()).toEqual(DEFAULT_CALIBRATION);
    expect(() => store.learn([{ cost: 'argon2', msPerUnit: 1 }])).not.toThrow();

    const junk = memoryStorage();
    junk.setItem('stegoshard.progress', '{not json');
    expect(localCalibrationStore(junk).load()).toEqual(DEFAULT_CALIBRATION);
  });
});

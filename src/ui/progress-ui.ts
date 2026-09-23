/**
 * The progress bar shared by the expert UI, the guided wizard and the web app,
 * so all three show a save the same way.
 *
 * With a plan (`begin(stages)`, see `planSave` in `@core`) it is one bar for the
 * whole operation: each stage owns a share proportional to how long it takes on
 * this device, the bar never goes backwards, and the label names the stage, not
 * the low-level phase. It appears within a frame of `begin`, before any key
 * derivation starts.
 *
 * Between events it keeps moving. The fill is animated toward where the current
 * stage should end with the Web Animations API on `transform`, which the browser
 * runs on its compositor thread: the bar keeps creeping while an Argon2
 * derivation or a pure-JS JPEG encode blocks the page. It approaches the stage's
 * end without reaching it, so it never claims work that is not done; the real
 * event snaps it forward. With reduced motion it only steps.
 *
 * Without a plan (a caller that never calls `begin`), it falls back to the old
 * reading: a percentage per phase, or an indeterminate sweep.
 */

import {
  type OnProgress,
  type Progress,
  ProgressTracker,
  type Stage,
  type StageLabel,
  type TrackerView,
} from '@core';
import type { Msg } from './save-controller';
import { setStatus, show } from './domhelpers';
import { type CalibrationStore, localCalibrationStore } from './progress-calibration';

const PHASE_KEY: Record<Progress['phase'], string> = {
  compress: 'statusCompressing',
  encrypt: 'statusEncrypting',
  decrypt: 'statusDecrypting',
  verify: 'statusVerifying',
  unlock: 'statusUnlocking',
  render: 'statusRendering',
  derive: 'statusDeriving',
  prepare: 'statusPreparingPhotos',
  reencode: 'statusPreparingPhotos',
  embed: 'statusGallerySaving',
  extract: 'statusVerifying',
  deliver: 'statusDelivering',
};

const STAGE_KEY: Record<StageLabel, string> = {
  checkingPassword: 'statusCheckingPassword',
  deriving: 'statusDeriving',
  compressing: 'statusCompressing',
  preparingPhotos: 'statusPreparingPhotos',
  hiding: 'statusGallerySaving',
  hidingKey: 'statusHidingKey',
  encrypting: 'statusEncrypting',
  rendering: 'statusRendering',
  verifying: 'statusVerifying',
  delivering: 'statusDelivering',
};

export interface ProgressUI {
  /**
   * Show the bar for an operation with these stages, and resolve once it has
   * been painted. Call it first, before anything slow.
   */
  begin: (stages: readonly Stage[]) => Promise<void>;
  onProgress: OnProgress;
  /**
   * Hide and reset the bar (call in a `finally`). `ok` records this run's
   * timings, so the next bar is paced for this device.
   */
  done: (ok?: boolean) => void;
}

export interface ProgressUIOptions {
  store?: CalibrationStore;
  now?: () => number;
  /** Defaults to the user's `prefers-reduced-motion` setting. */
  reducedMotion?: boolean;
}

/** Resolve after the browser has had a chance to paint. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    const fallback = setTimeout(resolve, 50); // a hidden page may never fire rAF
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf !== 'function') return;
    raf(() =>
      setTimeout(() => {
        clearTimeout(fallback);
        resolve();
      }, 0),
    );
  });
}

function prefersReducedMotion(): boolean {
  try {
    return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

/** Steepness of the approach curve: 78% of the way at the estimate, all of it at twice. */
const CURVE = 2.5;
const curve = (u: number): number => (1 - Math.exp(-CURVE * u)) / (1 - Math.exp(-CURVE));

export function makeProgressUI(
  bar: HTMLElement,
  fill: HTMLElement,
  status: HTMLElement,
  msg: Msg,
  opts: ProgressUIOptions = {},
): ProgressUI {
  const store = opts.store ?? localCalibrationStore();
  const now = opts.now ?? (() => performance.now());
  const reduced = opts.reducedMotion ?? prefersReducedMotion();
  let tracker: ProgressTracker | undefined;
  let lastLabel: StageLabel | undefined;
  let lastAria = -1;
  // The running animation, described analytically so its current value can be
  // computed without reading styles back.
  let anim: { from: number; to: number; start: number; duration: number } | undefined;

  const valueNow = (): number => {
    if (!anim) return 0;
    const u = anim.duration > 0 ? Math.min(1, (now() - anim.start) / anim.duration) : 1;
    return anim.from + (anim.to - anim.from) * curve(u);
  };

  const setScale = (v: number): void => {
    fill.style.transform = `scaleX(${v.toFixed(4)})`;
  };

  const draw = (view: TrackerView): void => {
    const from = Math.max(view.fraction, Math.min(valueNow(), view.target));
    for (const a of fill.getAnimations?.() ?? []) a.cancel();
    if (reduced || view.target <= from + 1e-4 || typeof fill.animate !== 'function') {
      anim = { from, to: from, start: now(), duration: 0 };
      setScale(from);
    } else {
      const duration = Math.max(250, view.targetMs * 2);
      anim = { from, to: view.target, start: now(), duration };
      const frames = Array.from({ length: 9 }, (_, i) => {
        const u = i / 8;
        return {
          offset: u,
          transform: `scaleX(${(from + (view.target - from) * curve(u)).toFixed(4)})`,
        };
      });
      setScale(from);
      fill.animate(frames, { duration, easing: 'linear', fill: 'forwards' });
    }
    const pct = Math.round(view.fraction * 100);
    if (pct !== lastAria) {
      bar.setAttribute('aria-valuenow', String(pct));
      lastAria = pct;
    }
    if (view.label !== lastLabel) {
      setStatus(status, msg(STAGE_KEY[view.label]));
      lastLabel = view.label;
    }
  };

  const begin = async (stages: readonly Stage[]): Promise<void> => {
    tracker = new ProgressTracker(stages, store.load(), now);
    lastLabel = undefined;
    lastAria = -1;
    fill.classList.remove('progress-bar--indeterminate');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    show(bar, true);
    draw(tracker.view());
    await nextPaint();
  };

  const legacy = (p: Progress): void => {
    show(bar, true);
    if (p.total > 0) {
      const f = Math.min(1, Math.max(0, p.done / p.total));
      fill.classList.remove('progress-bar--indeterminate');
      setScale(f);
      bar.setAttribute('aria-valuenow', String(Math.floor(f * 100)));
    } else {
      fill.classList.add('progress-bar--indeterminate');
      bar.removeAttribute('aria-valuenow');
    }
    setStatus(status, msg(PHASE_KEY[p.phase] ?? 'statusSaving'));
  };

  const onProgress: OnProgress = (p) => {
    if (!tracker) {
      legacy(p);
      return undefined;
    }
    draw(tracker.onEvent(p));
    // The start of a stage or a unit is the moment before a possibly long,
    // blocking computation: give the browser a frame to commit the animation.
    return p.done === 0 ? nextPaint() : undefined;
  };

  const done = (ok = false): void => {
    if (ok && tracker) store.learn(tracker.samples());
    tracker = undefined;
    anim = undefined;
    lastLabel = undefined;
    lastAria = -1;
    for (const a of fill.getAnimations?.() ?? []) a.cancel();
    fill.style.transform = '';
    fill.classList.remove('progress-bar--indeterminate');
    bar.removeAttribute('aria-valuenow');
    show(bar, false);
  };

  return { begin, onProgress, done };
}

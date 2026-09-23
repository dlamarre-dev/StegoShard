/**
 * Where the browser keeps its progress calibration: how long this device takes
 * per Argon2 derivation, per megabyte re-encoded, per image rendered.
 *
 * `localStorage`, because it is a per-viewer convenience and nothing more: it
 * holds durations, never a byte of a secret, a filename or a password, and a
 * missing or unreadable entry costs nothing but a less accurate first bar. Every
 * access is wrapped, since storage can be absent (a private window, blocked site
 * data, a preview) or throw, and the save must not care.
 */

import {
  type Calibration,
  type CostSample,
  DEFAULT_CALIBRATION,
  parseCalibration,
  updateCalibration,
} from '@core';

const KEY = 'stegoshard.progress';

export interface CalibrationStore {
  load(): Calibration;
  /** Fold one run's measured durations in, and persist the result. */
  learn(samples: readonly CostSample[]): void;
}

/** A store over `storage` (the page's `localStorage` by default). */
export function localCalibrationStore(storage?: Storage): CalibrationStore {
  const backing = (): Storage | undefined => {
    try {
      return storage ?? globalThis.localStorage;
    } catch {
      return undefined;
    }
  };
  const load = (): Calibration => {
    try {
      const raw = backing()?.getItem(KEY);
      return (raw && parseCalibration(JSON.parse(raw))) || DEFAULT_CALIBRATION;
    } catch {
      return DEFAULT_CALIBRATION;
    }
  };
  return {
    load,
    learn(samples) {
      if (samples.length === 0) return;
      try {
        backing()?.setItem(KEY, JSON.stringify(updateCalibration(load(), samples)));
      } catch {
        // Full, blocked or absent: the next save simply starts from what it had.
      }
    },
  };
}

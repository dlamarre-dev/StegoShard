/**
 * A small determinate/indeterminate progress bar driven by the core's
 * `onProgress` events (posted from the pipeline worker). Shared by the expert UI,
 * the guided wizard, and the web app so all three render progress the same way.
 *
 * The adjacent `role="status"` label carries a localized phase name; the bar
 * fills to the real percentage for `encrypt`/`decrypt` and shows an indeterminate
 * state for the coarse `compress`/`unlock` phases (total === 0).
 */

import type { OnProgress, Progress } from '@core';
import type { Msg } from './save-controller';
import { setStatus, show } from './domhelpers';

const PHASE_KEY: Record<Progress['phase'], string> = {
  compress: 'statusCompressing',
  encrypt: 'statusEncrypting',
  decrypt: 'statusDecrypting',
  verify: 'statusVerifying',
  unlock: 'statusUnlocking',
  render: 'statusRendering',
};

export interface ProgressUI {
  onProgress: OnProgress;
  /** Hide + reset the bar (call in a `finally`). */
  done: () => void;
}

export function makeProgressUI(
  bar: HTMLElement,
  fill: HTMLElement,
  status: HTMLElement,
  msg: Msg,
): ProgressUI {
  const onProgress: OnProgress = (p) => {
    show(bar, true);
    if (p.total > 0) {
      const pct = Math.min(100, Math.max(0, Math.floor((p.done / p.total) * 100)));
      fill.classList.remove('progress-bar--indeterminate');
      fill.style.width = `${pct}%`;
      bar.setAttribute('aria-valuenow', String(pct));
    } else {
      fill.classList.add('progress-bar--indeterminate');
      fill.style.width = '100%';
      bar.removeAttribute('aria-valuenow');
    }
    setStatus(status, msg(PHASE_KEY[p.phase] ?? 'statusSaving'));
  };
  const done = () => {
    show(bar, false);
    fill.style.width = '0%';
    fill.classList.remove('progress-bar--indeterminate');
    bar.removeAttribute('aria-valuenow');
  };
  return { onProgress, done };
}

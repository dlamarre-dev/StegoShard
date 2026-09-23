import { expect, test } from '@playwright/test';
import { encode as encodePng } from 'fast-png';

/**
 * The save progress bar, watched in a real browser during a gallery save.
 *
 * A gallery save is the slow one: every cover is decoded and re-encoded in pure
 * JavaScript, and four Argon2 derivations run on the page's main thread. It used
 * to show no bar at all. What is checked here is what the user sees:
 *
 * - the bar is on screen almost at once, before any of that work starts;
 * - its value (`aria-valuenow`, the real fraction of the whole save) never goes
 *   backwards and gets past halfway before the result appears;
 * - driving it (the CSSOM and the Web Animations API on `transform`) triggers no
 *   Content Security Policy violation under `style-src 'self'`.
 */

/** A noisy PNG, textured enough to carry a gallery fragment after re-encoding. */
function noisyPng(side: number, seed: number): Buffer {
  const data = new Uint8Array(side * side * 4);
  let s = seed >>> 0;
  for (let i = 0; i < side * side; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i * 4] = s >>> 24;
    data[i * 4 + 1] = (s >>> 16) & 0xff;
    data[i * 4 + 2] = (s >>> 8) & 0xff;
    data[i * 4 + 3] = 255;
  }
  return Buffer.from(encodePng({ width: side, height: side, data, channels: 4, depth: 8 }));
}

test('a gallery save shows its progress bar at once, and it only moves forward', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const cspViolations: string[] = [];
  page.on('console', (m) => {
    if (m.text().includes('Content Security Policy')) cspViolations.push(m.text());
  });

  await page.goto('./');
  await page.locator('#choose-expert').click();
  await page.locator('#save-file').setInputFiles({
    name: 'note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('progress check\n'),
  });
  await page.locator('#save-pw').fill('une phrase de passe assez longue');
  await page.locator('input[name="dest"][value="gallery"]').check({ force: true });
  await page.locator('#gallery-covers').setInputFiles(
    Array.from({ length: 9 }, (_, i) => ({
      name: `IMG_${1000 + i}.png`,
      mimeType: 'image/png',
      buffer: noisyPng(768, i + 1),
    })),
  );

  // Record, inside the page, when the click happened, when the bar appeared, and
  // every value it reported. Observed rather than polled, so a value set and
  // replaced during a blocked stretch is still seen.
  await page.evaluate(() => {
    const w = window as unknown as {
      __progress: { clickAt: number; shownAt: number; values: number[]; violations: string[] };
    };
    w.__progress = { clickAt: -1, shownAt: -1, values: [], violations: [] };
    const bar = document.getElementById('save-progress')!;
    document
      .getElementById('save-btn')!
      .addEventListener('click', () => (w.__progress.clickAt = performance.now()), {
        capture: true,
      });
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__progress.violations.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
    new MutationObserver(() => {
      if (!bar.hidden && w.__progress.shownAt < 0) w.__progress.shownAt = performance.now();
      const v = bar.getAttribute('aria-valuenow');
      if (v !== null) w.__progress.values.push(Number(v));
    }).observe(bar, { attributes: true, attributeFilter: ['hidden', 'aria-valuenow'] });
  });

  await page.locator('#save-btn').click();
  await expect(page.locator('#save-result')).toBeVisible({ timeout: 280_000 });

  const seen = await page.evaluate(
    () =>
      (
        window as unknown as {
          __progress: { clickAt: number; shownAt: number; values: number[]; violations: string[] };
        }
      ).__progress,
  );
  expect(seen.shownAt, 'the bar never appeared').toBeGreaterThan(0);
  expect(seen.shownAt - seen.clickAt, 'the bar appeared late').toBeLessThan(100);
  for (let i = 1; i < seen.values.length; i++) {
    expect(
      seen.values[i]!,
      `went back at step ${i}: ${seen.values.join(',')}`,
    ).toBeGreaterThanOrEqual(seen.values[i - 1]!);
  }
  expect(Math.max(...seen.values)).toBeGreaterThan(50);
  expect(seen.violations).toEqual([]);
  expect(cspViolations).toEqual([]);
});

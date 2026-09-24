import { expect, test } from '@playwright/test';
import { encode as encodePng } from 'fast-png';
import { zipSync } from 'fflate';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * Gallery restore, as the user meets it.
 *
 * The restore card used to show the gallery *save* explanation, ask for "image
 * files, a .zip, or a printed PDF", offer the camera scanner, and then refuse a
 * .zip. It now explains what to drop, asks for photos or a .zip of them, hides
 * the camera, opens the zip, and finds the key photo inside it: every delivered
 * photo is named IMG_nnnn, so nothing marks the key photo out, and zipping the
 * whole delivery is the natural thing to do.
 */

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

const PW = 'une phrase de passe assez longue';

test('a gallery restores from one .zip holding its photos and its key photo', async ({ page }) => {
  test.setTimeout(400_000);
  const dir = mkdtempSync(join(tmpdir(), 'ss-gallery-restore-'));
  await page.goto('./');
  await page.locator('#choose-expert').click();
  await page.locator('#save-file').setInputFiles({
    name: 'note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('gallery restore from a zip\n'),
  });
  await page.locator('#save-pw').fill(PW);
  await page.locator('input[name="dest"][value="gallery"]').check({ force: true });
  await page.locator('#gallery-covers').setInputFiles(
    Array.from({ length: 9 }, (_, i) => ({
      name: `IMG_${1000 + i}.png`,
      mimeType: 'image/png',
      buffer: noisyPng(768, i + 1),
    })),
  );
  await page.locator('input[name="gallery-keymode"][value="stego"]').check({ force: true });
  await page.locator('#gallery-cover').setInputFiles({
    name: 'key.png',
    mimeType: 'image/png',
    buffer: noisyPng(768, 99),
  });
  const saved: string[] = [];
  page.on('download', (d) => {
    const p = join(dir, d.suggestedFilename());
    void d.saveAs(p).then(() => saved.push(p));
  });
  await page.locator('#save-btn').click();
  await expect(page.locator('#save-result')).toBeVisible({ timeout: 300_000 });
  await expect.poll(() => saved.length, { timeout: 30_000 }).toBe(10); // 9 photos + the key photo

  const zip = zipSync(Object.fromEntries(saved.map((p) => [basename(p), readFileSync(p)])));

  await page.goto('./');
  await page.locator('#choose-expert').click();
  await page.locator('input[name="restore-mode"][value="gallery"]').check({ force: true });
  // What the card asks for in gallery mode.
  await expect(page.locator('#restore-gallery-hint')).toBeVisible();
  await expect(page.locator('#restore-gallery-hint')).toContainText(/\.zip/);
  await expect(page.locator('#restore-dz-title')).toContainText(/\.zip/);
  const accept = await page.locator('#restore-files').getAttribute('accept');
  expect(accept).toContain('.zip');
  expect(accept).not.toContain('pdf');
  await expect(page.locator('#camera-btn')).toBeHidden();

  await page.locator('#restore-files').setInputFiles({
    name: 'photos.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zip),
  });
  await page.locator('#restore-pw').fill(PW);

  // The restore bar: up at once, and only ever moving forward. A gallery restore
  // runs two key derivations and reads every photo, and used to show nothing.
  await page.evaluate(() => {
    const w = window as unknown as { __rp: { clickAt: number; shownAt: number; values: number[] } };
    w.__rp = { clickAt: -1, shownAt: -1, values: [] };
    const bar = document.getElementById('restore-progress')!;
    document
      .getElementById('restore-btn')!
      .addEventListener('click', () => (w.__rp.clickAt = performance.now()), { capture: true });
    new MutationObserver(() => {
      if (!bar.hidden && w.__rp.shownAt < 0) w.__rp.shownAt = performance.now();
      const v = bar.getAttribute('aria-valuenow');
      if (v !== null) w.__rp.values.push(Number(v));
    }).observe(bar, { attributes: true, attributeFilter: ['hidden', 'aria-valuenow'] });
  });
  await page.locator('#restore-btn').click();
  await expect(page.locator('#restore-result')).toBeVisible({ timeout: 300_000 });
  await expect(page.locator('#restore-status')).not.toHaveClass(/error/);

  const rp = await page.evaluate(
    () =>
      (window as unknown as { __rp: { clickAt: number; shownAt: number; values: number[] } }).__rp,
  );
  expect(rp.shownAt, 'the restore bar never appeared').toBeGreaterThan(0);
  expect(rp.shownAt - rp.clickAt, 'the restore bar appeared late').toBeLessThan(100);
  for (let i = 1; i < rp.values.length; i++) {
    expect(rp.values[i]!, `went back: ${rp.values.join(',')}`).toBeGreaterThanOrEqual(
      rp.values[i - 1]!,
    );
  }
  expect(Math.max(...rp.values)).toBeGreaterThan(50);
});

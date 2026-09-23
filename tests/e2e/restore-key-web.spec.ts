import { expect, test } from '@playwright/test';
import { encode as encodePng } from 'fast-png';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A branded .ssbn saved with a stego key photo, restored with the key photo
 * picked together with the vault, not in the key field.
 *
 * Delivered photos are all named `IMG_nnnn`, so nothing about the key photo's
 * name marks it out, and picking every file of the save at once is the natural
 * thing to do. QA found that restore failing with "needs its separate .key
 * file": the photo was never looked at as a key.
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

test('a .ssbn restores with its key photo picked among the files', async ({ page }) => {
  test.setTimeout(300_000);
  const dir = mkdtempSync(join(tmpdir(), 'ss-restore-key-'));
  await page.goto('./');
  await page.locator('#choose-expert').click();
  await page.locator('#save-file').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('ssbn with a key photo\n'),
  });
  await page.locator('#save-pw').fill(PW);
  await page.locator('input[name="dest"][value="binary"]').check({ force: true });
  await page.locator('input[name="keymode"][value="stego"]').check({ force: true });
  await page.locator('#cover-file').setInputFiles({
    name: 'holiday.png',
    mimeType: 'image/png',
    buffer: noisyPng(256, 7),
  });
  const saved: string[] = [];
  page.on('download', (d) => {
    const p = join(dir, d.suggestedFilename());
    void d.saveAs(p).then(() => saved.push(p));
  });
  await page.locator('#save-btn').click();
  await expect(page.locator('#save-result')).toBeVisible({ timeout: 200_000 });
  await expect.poll(() => saved.length, { timeout: 30_000 }).toBe(2);
  expect(saved.some((p) => /IMG_\d{4}\.png$/.test(p))).toBe(true);

  await page.goto('./');
  await page.locator('#choose-expert').click();
  await page.locator('#restore-files').setInputFiles(saved); // vault and key photo together
  await page.locator('#restore-pw').fill(PW);
  await page.locator('#restore-btn').click();
  await expect(page.locator('#restore-result')).toBeVisible({ timeout: 200_000 });
  await expect(page.locator('#restore-status')).not.toHaveClass(/error/);
});

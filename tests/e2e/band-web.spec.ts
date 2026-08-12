/**
 * What the caption on a saved image looks like.
 *
 * The composition is unit-tested in `src/core/brand.test.ts`; what only a browser
 * can show is that this surface routes it through the shared renderer. It did not:
 * it drew its own sans-serif strip *above* the mark and left the date and sequence
 * out unless a title had been asked for, so saved images looked nothing like the
 * README samples or the CLI's output.
 *
 * Asserted through the PNG's height, which is the one thing that says where the
 * caption went: a stampable caption costs one text line inside the existing strip,
 * while a title the ASCII font cannot draw (Japanese here) adds a strip of its own.
 */

import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/** Height from the PNG's IHDR, so this needs no image library. */
async function pngHeight(path: string): Promise<number> {
  const bytes = await readFile(path);
  return bytes.readUInt32BE(20);
}

async function saveOne(page: import('@playwright/test').Page, title: string): Promise<number> {
  await page.goto('./');
  await page.locator('#choose-expert').click();
  await page.locator('#save-file').setInputFiles({
    name: 'secret.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('x'.repeat(20_000)),
  });
  await page.locator('#save-pw').fill('une phrase de passe assez longue');
  await page.locator('#as-zip').uncheck(); // one PNG per image, not a bundle
  if (title) {
    await page.locator('#add-band').check();
    await page.locator('#band-title').fill(title);
  }
  const dl = page.waitForEvent('download', { timeout: 120_000 });
  await page.locator('#save-btn').click();
  const saved = await dl;
  return pngHeight((await saved.path())!);
}

test('the caption is stamped inside the brand strip', async ({ page }) => {
  const plain = await saveOne(page, '');
  const labelled = await saveOne(page, 'Test');
  const cjk = await saveOne(page, 'アーカイブ');

  // An unlabelled save still carries the date and the sequence number, so the
  // strip is not empty; a title adds exactly one more line to the same strip.
  const oneLine = labelled - plain;
  expect(oneLine, 'a stampable title costs one line in the existing strip').toBeGreaterThan(0);
  expect(oneLine).toBeLessThan(30);

  // Only a title the shared font cannot draw gets a strip of its own, and it is
  // taller than a line of that font, being real text at 22px.
  expect(cjk - plain, 'an unstampable title adds its own strip').toBe(40);
});

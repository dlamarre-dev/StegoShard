import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/**
 * Multi-file saves (SPEC §4 FLAGS bit 1). The pair that matters is symmetry:
 * whatever goes in must come back out as the same separate files, not as the
 * bundle.zip the envelope actually carries.
 */
test('several files save and restore as several files', async ({ page }) => {
  await page.goto('./');
  await page.locator('#choose-expert').click();

  const files = [
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('premier\n') },
    { name: 'key.pem', mimeType: 'text/plain', buffer: Buffer.from('deuxieme\n') },
    { name: 'photo.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('troisieme\n') },
  ];
  await page.locator('#save-file').setInputFiles(files);
  await page.locator('#save-pw').fill('une phrase de passe assez longue');
  await page.locator('input[name="dest"][value="binary"]').check({ force: true });

  const dl = page.waitForEvent('download', { timeout: 120_000 });
  await page.locator('#save-btn').click();
  const saved = await dl;
  await expect(page.locator('#save-result')).toBeVisible({ timeout: 120_000 });

  // Restore: expect one download per original file.
  const got: Record<string, string> = {};
  page.on('download', async (d) => {
    got[d.suggestedFilename()] = await readFile((await d.path())!, 'utf8');
  });
  await page.locator('#restore-files').setInputFiles({
    name: saved.suggestedFilename(),
    mimeType: 'application/octet-stream',
    buffer: await readFile((await saved.path())!),
  });
  await page.locator('#restore-pw').fill('une phrase de passe assez longue');
  await page.locator('#restore-btn').click();
  await expect(page.locator('#restore-result')).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(2000);
  expect(Object.keys(got).sort()).toEqual(['key.pem', 'notes.txt', 'photo.bin']);
  expect(got['notes.txt']).toBe('premier\n');
  expect(got['photo.bin']).toBe('troisieme\n');
});

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

/**
 * The same symmetry through the guided flow, which used to keep exactly one file.
 *
 * Files are added **one at a time** on purpose: a file input replaces its whole
 * FileList on every pick, and the wizard rebuilds its DOM after each one, so this
 * is the path where a selection silently collapsed to the last file picked.
 */
test('the guided flow accumulates files added one at a time', async ({ page }) => {
  await page.goto('./');
  await page.locator('#choose-guided').click();
  await page.locator('.wiz-option').first().click(); // save

  const picker = page.locator('#wizard-root input[type="file"]').first();
  const contents: Record<string, string> = {
    'un.txt': 'premier\n',
    'deux.txt': 'deuxieme\n',
    'trois.txt': 'troisieme\n',
  };
  let n = 0;
  for (const [name, body] of Object.entries(contents)) {
    await picker.setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(body) });
    // The zone reports a count once it holds more than one file.
    await expect(page.locator('#wizard-root .dz-file')).toHaveText(++n === 1 ? name : String(n));
  }

  const next = page.locator('#wizard-root button', { hasText: /^Next$/ });
  await next.click(); // -> destination
  await page.locator('.wiz-option', { hasText: 'File' }).first().click();
  await next.click(); // -> key handling
  await next.click(); // -> password
  await page
    .locator('#wizard-root input[type="password"]')
    .fill('une phrase de passe assez longue');
  await next.click(); // -> review
  // Every file is named in the review, not just the first.
  await expect(page.locator('#wizard-root')).toContainText('un.txt');
  await expect(page.locator('#wizard-root')).toContainText('trois.txt');

  const dl = page.waitForEvent('download', { timeout: 120_000 });
  // The primary button on the review step runs the save ("Create the file").
  await page.locator('#wizard-root .btn-primary').first().click();
  const saved = await dl;

  // Restore through the expert form: three files in, three files out.
  const got: Record<string, string> = {};
  page.on('download', async (d) => {
    got[d.suggestedFilename()] = await readFile((await d.path())!, 'utf8');
  });
  await page.locator('#workflows-btn').click();
  await page.locator('#choose-expert').click();
  await page.locator('#restore-files').setInputFiles({
    name: saved.suggestedFilename(),
    mimeType: 'application/octet-stream',
    buffer: await readFile((await saved.path())!),
  });
  await page.locator('#restore-pw').fill('une phrase de passe assez longue');
  await page.locator('#restore-btn').click();
  await expect(page.locator('#restore-result')).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(2000);
  expect(Object.keys(got).sort()).toEqual(['deux.txt', 'trois.txt', 'un.txt']);
  expect(got['un.txt']).toBe('premier\n');
  expect(got['trois.txt']).toBe('troisieme\n');
});

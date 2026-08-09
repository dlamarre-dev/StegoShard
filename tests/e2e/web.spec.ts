import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

test('web app stays local, is accessible, and round-trips a file', async ({ page }, testInfo) => {
  const cspViolations: string[] = [];
  const externalRequests: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) cspViolations.push(message.text());
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol === 'http:' && url.hostname !== '127.0.0.1') externalRequests.push(url.href);
    if (url.protocol === 'https:') externalRequests.push(url.href);
  });

  await page.goto('./');
  await expect(page).toHaveTitle('StegoShard — encrypt files into resilient images');
  await expect(page.locator('#build-version')).toContainText(`v${version}`);
  await page.locator('#choose-expert').click();
  await expect(page.locator('#expert-view')).toBeVisible();

  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? ''),
    ),
  ).toEqual([]);

  if (testInfo.project.name === 'web') {
    // Mobile layout. Asserted structurally rather than against a screenshot
    // baseline: a pixel diff cannot survive the font and antialiasing
    // differences between a developer's machine and the Linux CI runner, so it
    // would only ever be a source of false failures.
    const width = 390;
    await page.setViewportSize({ width, height: 844 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the page must not scroll sideways on a phone').toBeLessThanOrEqual(0);

    for (const id of ['#file-drop', '#save-pw', '#save-btn', '#restore-drop', '#restore-btn']) {
      const box = await page.locator(id).boundingBox();
      expect(box, `${id} has no layout box`).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.height, `${id} is collapsed`).toBeGreaterThan(0);
    }
    // The refactor that moved the file inputs out of the drop zones relies on
    // `.dropzone-input` keeping them hidden; a bare file control here means a
    // picker was built without the class.
    await expect(page.locator('#expert-view input[type="file"]:visible')).toHaveCount(0);
  }

  const secret = 'StegoShard browser round-trip\n';
  await page.locator('#save-file').setInputFiles({
    name: 'browser-secret.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(secret),
  });
  await page.locator('#save-pw').fill('Correct-Horse-Battery-Staple-42!');

  const saveDownloadPromise = page.waitForEvent('download', { timeout: 120_000 });
  await page.locator('#save-btn').click();
  const saved = await saveDownloadPromise;
  const savedPath = await saved.path();
  expect(savedPath).not.toBeNull();
  await expect(page.locator('#save-result')).toBeVisible({ timeout: 120_000 });

  await page.locator('#restore-files').setInputFiles({
    name: saved.suggestedFilename(),
    mimeType: 'application/zip',
    buffer: await readFile(savedPath!),
  });
  await page.locator('#restore-pw').fill('Correct-Horse-Battery-Staple-42!');
  const restoreDownloadPromise = page.waitForEvent('download', { timeout: 120_000 });
  await page.locator('#restore-btn').click();
  const restored = await restoreDownloadPromise;
  const restoredPath = await restored.path();
  expect(restoredPath).not.toBeNull();
  await expect(page.locator('#restore-result')).toBeVisible({ timeout: 120_000 });
  expect(await readFile(restoredPath!, 'utf8')).toBe(secret);

  expect(cspViolations).toEqual([]);
  expect(externalRequests).toEqual([]);
});

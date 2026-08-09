import { chromium, expect, test } from '@playwright/test';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

test('packaged Chromium extension starts without network or CSP violations', async () => {
  const extensionPath = resolve('dist-release/chrome');
  await access(resolve(extensionPath, 'manifest.json'));
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    let worker = context.serviceWorkers()[0];
    worker ??= await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).hostname;
    const page = await context.newPage();
    const externalRequests: string[] = [];
    const cspViolations: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(`chrome-extension://${extensionId}/`)) {
        externalRequests.push(request.url());
      }
    });
    page.on('console', (message) => {
      if (message.text().includes('Content Security Policy')) cspViolations.push(message.text());
    });
    await page.goto(`chrome-extension://${extensionId}/ui/app.html`);
    await expect(page).toHaveTitle('StegoShard');
    await expect(page.locator('#no-key')).toBeVisible();
    expect(cspViolations).toEqual([]);
    expect(externalRequests).toEqual([]);
  } finally {
    await context.close();
  }
});

import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const PASSWORD = 'une phrase de passe assez longue';

/** Load the packaged extension the way a user would after unpacking it. */
async function launchExtension(): Promise<BrowserContext> {
  const extensionPath = resolve('dist-release/chrome');
  await access(resolve(extensionPath, 'manifest.json'));
  return chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
}

async function extensionId(context: BrowserContext): Promise<string> {
  let worker = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent('serviceworker');
  return new URL(worker.url()).hostname;
}

test('packaged Chromium extension starts without network or CSP violations', async () => {
  const context = await launchExtension();
  try {
    const id = await extensionId(context);
    const page = await context.newPage();
    const externalRequests: string[] = [];
    const cspViolations: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(`chrome-extension://${id}/`)) {
        externalRequests.push(request.url());
      }
    });
    page.on('console', (message) => {
      if (message.text().includes('Content Security Policy')) cspViolations.push(message.text());
    });
    await page.goto(`chrome-extension://${id}/ui/app.html`);
    await expect(page).toHaveTitle('StegoShard');
    await expect(page.locator('#no-key')).toBeVisible();
    expect(cspViolations).toEqual([]);
    expect(externalRequests).toEqual([]);
  } finally {
    await context.close();
  }
});

/**
 * A real save through the popup, which nothing covered before: the extension had
 * only a load smoke test, so its output was never compared with anything.
 *
 * It renders through the same `@core` brand strip as the web app and the CLI, and
 * the caption used to be the one place the surfaces disagreed (the browser drew
 * its own sans-serif strip above the mark). The height difference between a
 * labelled and an unlabelled save is what says where the caption went: one line
 * inside the existing strip, not a strip of its own.
 */
test('the popup saves images with the caption in the shared brand strip', async () => {
  const context = await launchExtension();
  try {
    const id = await extensionId(context);

    // The popup's save flow needs the managed vault key, created in options.
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/ui/options.html`);
    await options.locator('#new-pw').fill(PASSWORD);
    await options.locator('#confirm-pw').fill(PASSWORD);
    await options.locator('#create-btn').click();
    await expect(options.locator('#manage')).toBeVisible({ timeout: 60_000 });

    const popup = await context.newPage();

    const saveWith = async (title: string): Promise<number> => {
      await popup.goto(`chrome-extension://${id}/ui/app.html`);
      // First run puts the onboarding banner ahead of the workflow chooser.
      if (await popup.locator('#onboarding-dismiss').isVisible()) {
        await popup.locator('#onboarding-dismiss').click();
      }
      await popup.locator('#choose-expert').click();
      await popup.locator('#save-file').setInputFiles({
        name: 'secret.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('x'.repeat(20_000)),
      });
      await popup.locator('#as-zip').uncheck(); // one PNG per image, not a bundle
      if (title) {
        await popup.locator('#add-band').check();
        await popup.locator('#band-title').fill(title);
      }
      const download = popup.waitForEvent('download', { timeout: 120_000 });
      await popup.locator('#save-btn').click();
      const saved = await download;
      // Height from the PNG's IHDR, so this needs no image library.
      return (await readFile((await saved.path())!)).readUInt32BE(20);
    };

    const plain = await saveWith('');
    const labelled = await saveWith('Test');
    const oneLine = labelled - plain;
    expect(oneLine, 'a title costs one line in the strip that is already there').toBeGreaterThan(0);
    expect(oneLine, 'not a second strip of its own').toBeLessThan(30);
  } finally {
    await context.close();
  }
});

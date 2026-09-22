import { expect, test } from '@playwright/test';

/**
 * What the browser actually writes to disk, for a destination whose whole point
 * is to look like nothing in particular.
 *
 * The app used to hand `downloadBlob` a folder to file the save under. No
 * browser creates that folder from an `<a download>` attribute — only
 * `chrome.downloads.download({filename})` does, and this app does not use it —
 * so the separator was sanitised and the folder became a *prefix*. A disguised
 * database landed as `app-data-3f9c1e20_cache.db` and a gallery photo as
 * `18265a84d89ddadf_IMG_2043.jpg`: the set id welded to the front of the two
 * artifacts that exist to carry no association at all.
 *
 * Nothing asserted a delivered filename, on any surface, which is how it
 * shipped. `src/api/node/deniable-names.test.ts` does it for the CLI;
 * `src/ui/download-name.test.ts` pins the attribute itself. This is the one that
 * watches a real browser write real files.
 *
 * The disguised `.db` with a loose key is the cheapest save that delivers *two*
 * files, which is what it takes: a single-file save never passed a folder in the
 * first place, so it could never have shown the bug.
 */
test('a disguised database and its key carry no prefix', async ({ page }) => {
  await page.goto('./');
  await page.locator('#choose-expert').click();

  await page.locator('#save-file').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('deniable naming check\n'),
  });
  await page.locator('#save-pw').fill('une phrase de passe assez longue');
  await page.locator('input[name="dest"][value="sqlite"]').check({ force: true });
  await page.locator('input[name="keymode"][value="keyfile"]').check({ force: true });

  const delivered: string[] = [];
  page.on('download', (d) => void delivered.push(d.suggestedFilename()));

  await page.locator('#save-btn').click();
  await expect(page.locator('#save-result')).toBeVisible({ timeout: 150_000 });
  // The two downloads are fired 150 ms apart, so wait for the second to land.
  await expect.poll(() => delivered.length, { timeout: 30_000 }).toBe(2);

  // What it must be, not merely what it must not be: a rename to some other
  // leaky scheme has to fail here too.
  expect([...delivered].sort()).toEqual(['cache.db', 'settings.db']);
  for (const name of delivered) {
    expect(name).not.toMatch(/stegoshard/i);
    expect(name).not.toMatch(/[0-9a-f]{8}/i);
    expect(name).not.toContain('_');
  }
});

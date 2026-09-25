import { expect, test } from '@playwright/test';

/**
 * A browser that blocks site data makes `localStorage` throw on access rather
 * than return null. Found in review: the codec preference was read bare while
 * the app loaded, so the throw stopped the script and the page never left its
 * empty shell. Every read of storage now falls back, and the app has to come up.
 */
test('the app comes up when the browser blocks site data', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
  });
  await page.goto('./');
  await expect(page.locator('#choose-guided')).toBeVisible();
  await page.locator('#choose-expert').click();
  // Choosing a codec writes the preference; that must not throw either.
  await page.locator('input[name="codec"][value="qr"]').check({ force: true });
  expect(errors).toEqual([]);
});

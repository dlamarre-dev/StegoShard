import { expect, test } from '@playwright/test';

/**
 * The regression this file exists for, reported from the published site: the
 * footer's Privacy and Terms links opened in the *browser's* language, ignoring
 * the language the visitor had just picked in the app. The legal pages consulted
 * only `?lang=` and `navigator.language`, never the stored choice the app writes.
 *
 * Run with a browser locale deliberately unlike the language chosen, so a page
 * that fell back to the browser is visibly wrong rather than accidentally right.
 */

test.use({ locale: 'en-US' });

test('the legal pages follow the language chosen in the app', async ({ page }) => {
  await page.goto('./');
  await page.selectOption('#lang-select', 'ko');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');

  // Followed as a real visitor does, by clicking the footer link.
  await page.getByRole('link', { name: '개인정보처리방침' }).click();
  await expect(page).toHaveURL(/privacy\.html/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(page.locator('#legal-heading')).toHaveText('StegoShard: 개인정보처리방침');
});

test('a choice made on a legal page survives the return to the app', async ({ page }) => {
  await page.goto('./');
  await page.selectOption('#lang-select', 'ko');
  await page.goto('./terms.html');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');

  // Switching here is an explicit choice too, and the app should honour it back.
  await page.selectOption('#lang-select', 'ja');
  await expect(page.locator('#legal-heading')).toHaveText('StegoShard：利用規約');
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
});

test('an explicit ?lang= still wins, so a shared link reads as it was sent', async ({ page }) => {
  await page.goto('./');
  await page.selectOption('#lang-select', 'ko');

  await page.goto('./privacy.html?lang=de');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  // ...and arriving on that link must not rewrite the visitor's own preference.
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
});

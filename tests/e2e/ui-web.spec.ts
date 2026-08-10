import { expect, test } from '@playwright/test';

/**
 * Regressions this file exists for, all found by hand on a phone:
 *  - clicking an option pinned its hint open forever (`:focus-within`);
 *  - a hint on a wrapped row's first option ran off the left edge, and its
 *    twin on the right gave the page ~22px of horizontal scroll;
 *  - the threshold pair accepted k > n and only complained at save time.
 */

const WIDTHS = [320, 360, 390, 414];

test('no horizontal overflow at phone widths, hints included', async ({ page }) => {
  await page.goto('./');
  await page.locator('#choose-expert').click();

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    // Only the options on screen: several segmented groups are hidden until the
    // matching destination is picked, and hovering those would just time out.
    const items = page.locator('#expert-view .seg-item:visible');
    const n = await items.count();
    // Hover every option: a hint is only laid out while shown, so overflow can
    // only be observed with one open.
    for (let i = 0; i < n; i++) {
      await items.nth(i).hover();
      const excess = await page.evaluate(() => {
        const doc = document.documentElement;
        let worst = doc.scrollWidth - doc.clientWidth;
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('.seg-hint'))) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          worst = Math.max(worst, Math.ceil(r.right - doc.clientWidth), Math.ceil(-r.left));
        }
        return worst;
      });
      expect(excess, `option ${i} at ${width}px`).toBeLessThanOrEqual(0);
    }
  }
});

test('at most one hint at a time, and a click pins none', async ({ page }) => {
  await page.goto('./');
  await page.locator('#choose-expert').click();
  await page.setViewportSize({ width: 390, height: 900 });

  const items = page.locator('#expert-view .seg-item');
  await items.nth(0).hover();
  expect(await page.locator('#expert-view .seg-hint:visible').count()).toBe(1);
  await items.nth(2).hover();
  expect(await page.locator('#expert-view .seg-hint:visible').count()).toBe(1);

  // Selecting an option must not leave its hint on screen.
  await page.locator('input[name="dest"][value="sqlite"]').click({ force: true });
  await page.mouse.move(2, 2);
  expect(await page.locator('#expert-view .seg-hint:visible').count()).toBe(0);
});

test('the threshold picker cannot express k > n', async ({ page }) => {
  await page.goto('./');
  await page.locator('#choose-expert').click();
  await page.locator('input[name="dest"][value="sqlite"]').check({ force: true });
  await page.locator('input[name="accessmode"][value="nonpossession"]').check({ force: true });

  const kOptions = () => page.locator('#threshold-k option').allTextContents();
  await page.locator('#threshold-n').selectOption('5');
  expect(await kOptions()).toEqual(['2', '3', '4', '5']);

  // Shrinking n pulls an out-of-range k down with it rather than leaving it invalid.
  await page.locator('#threshold-k').selectOption('5');
  await page.locator('#threshold-n').selectOption('3');
  expect(await kOptions()).toEqual(['2', '3']);
  expect(await page.locator('#threshold-k').inputValue()).toBe('3');
});

test('the entropy field is folded away and grows to at most four lines', async ({ page }) => {
  await page.goto('./');
  await page.locator('#choose-expert').click();
  await expect(page.locator('#entropy-fields')).toBeHidden();

  await page.locator('#entropy-toggle').check();
  await expect(page.locator('#entropy-fields')).toBeVisible();

  const ta = page.locator('#extra-entropy');
  const height = async () => (await ta.boundingBox())!.height;
  await ta.fill('one line');
  const short = await height();
  await ta.fill(Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'));
  const tall = await height();
  expect(tall).toBeGreaterThan(short);
  // Capped, and scrolling past the cap rather than growing without bound.
  expect(tall).toBeLessThan(short * 4);
  expect(
    await ta.evaluate((el: HTMLTextAreaElement) => el.scrollHeight > el.clientHeight + 1),
  ).toBe(true);
});

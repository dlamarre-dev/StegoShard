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

/**
 * Each option in the segmented pickers is a centred column: glyph, label, badge.
 * `.mode-badge` carried a `margin-left` from an era when it followed text inline,
 * which in a centred column is not spacing but displacement, and left every badge
 * sitting 6px right of the label above it. Visible by eye, invisible to every
 * other check we have.
 */
test('each option badge is centred under its label', async ({ page }) => {
  await page.goto('./');
  await page.locator('#choose-expert').click();
  const offsets = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.seg-item'))
      .filter((item) => item.offsetParent && item.querySelector('.mode-badge'))
      .map((item) => {
        const centre = (sel: string): number => {
          const r = item.querySelector(sel)!.getBoundingClientRect();
          return r.left + r.width / 2;
        };
        return {
          label: item.querySelector('.seg-label')!.textContent ?? '',
          off: centre('.mode-badge') - centre('.seg-label'),
        };
      }),
  );
  expect(offsets.length, 'badged options on screen').toBeGreaterThan(1);
  for (const { label, off } of offsets) {
    // Sub-pixel rounding of two odd widths is fine; anything more is a margin.
    expect(Math.abs(off), `${label}: badge is ${off.toFixed(1)}px off centre`).toBeLessThan(1);
  }
});

/**
 * The Overt / Deniable badges label every save destination, at ~9px, and they are
 * the smallest text on the page. Two rounds of contrast bugs landed here: a faded
 * accent inherited from a selected option (3.51:1) and, next door, a faded note.
 *
 * The axe pass in `web.spec.ts` does not reliably catch either, because a badge
 * overlapping its neighbour makes axe give up on resolving the background and
 * file the result as *incomplete* rather than a violation, which differs with
 * fractions of a pixel between machines. The ratio is arithmetic, so compute it
 * instead of hoping the scan resolves it, and check both colour schemes: the two
 * palettes are independent, so passing in one says nothing about the other.
 */
for (const scheme of ['light', 'dark'] as const) {
  test(`the mode badges meet AA contrast in the ${scheme} palette`, async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: scheme });
    const page = await context.newPage();
    await page.goto('./');
    await page.locator('#choose-expert').click();

    const results = await page.evaluate(() => {
      const rgb = (value: string): [number, number, number, number] => {
        const [r = 0, g = 0, b = 0, a = 1] = value.match(/[\d.]+/g)?.map(Number) ?? [];
        return [r, g, b, a];
      };
      const luminance = ([r, g, b]: number[]): number => {
        const lin = [r!, g!, b!].map((c) => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
      };
      const over = (
        top: [number, number, number, number],
        bottom: number[],
        alpha: number,
      ): number[] => top.slice(0, 3).map((c, i) => c * alpha + bottom[i]! * (1 - alpha));

      const out: { label: string; ratio: number; size: number }[] = [];
      for (const badge of Array.from(document.querySelectorAll<HTMLElement>('.mode-badge'))) {
        if (!badge.offsetParent) continue; // hidden with its destination group
        // Nearest ancestor that actually paints a background.
        let base: number[] = [255, 255, 255];
        let opacity = Number(getComputedStyle(badge).opacity);
        for (let node = badge.parentElement; node; node = node.parentElement) {
          const s = getComputedStyle(node);
          opacity *= Number(s.opacity);
          const [r, g, b, a] = rgb(s.backgroundColor);
          if (a > 0) {
            base = [r, g, b];
            break;
          }
        }
        const style = getComputedStyle(badge);
        // The badge's own opacity fades its background *and* its text onto that
        // ancestor, which is exactly how the 3.51:1 regression came about.
        const bg = over(rgb(style.backgroundColor), base, opacity * rgb(style.backgroundColor)[3]);
        const fg = over(rgb(style.color), bg, opacity * rgb(style.color)[3]);
        const [l1, l2] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
        out.push({
          label: `${badge.className} "${badge.textContent}"`,
          ratio: (l1! + 0.05) / (l2! + 0.05),
          size: parseFloat(style.fontSize),
        });
      }
      return out;
    });

    expect(results.length, 'badges on screen').toBeGreaterThan(1);
    for (const { label, ratio, size } of results) {
      // Small text: AA wants 4.5:1. None of these is anywhere near large-text size.
      expect(size).toBeLessThan(18);
      expect(Number(ratio.toFixed(2)), `${scheme}: ${label}`).toBeGreaterThanOrEqual(4.5);
    }
    await context.close();
  });
}

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

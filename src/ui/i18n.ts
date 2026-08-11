import browser from 'webextension-polyfill';

/**
 * Replace the text of every `[data-i18n="key"]` element with its localized
 * message. The browser locale drives selection (plan §7; no manual switcher).
 */
export function localizeDom(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = el.dataset.i18n;
    if (!key) continue;
    const message = browser.i18n.getMessage(key);
    if (message) el.textContent = message;
  }
  // Localize placeholders for inputs marked with data-i18n-placeholder.
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) {
    const key = el.dataset.i18nPlaceholder;
    if (!key) continue;
    const message = browser.i18n.getMessage(key);
    if (message) el.placeholder = message;
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-aria-label]')) {
    const key = el.dataset.i18nAriaLabel;
    if (!key) continue;
    const message = browser.i18n.getMessage(key);
    if (message) el.setAttribute('aria-label', message);
  }
}

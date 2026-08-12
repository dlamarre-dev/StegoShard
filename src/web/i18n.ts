/**
 * Minimal i18n for the web app; reuses the extension's message catalogs
 * (bundled at build time) with a chrome.i18n-style getMessage.
 *
 * The active locale defaults to the browser language (when supported) and can
 * be changed at runtime from the in-page language selector; the choice is
 * persisted so it survives reloads. Switching re-localizes the DOM live, with no
 * page reload, and updates <html lang>.
 */

import en from '../../public/_locales/en/messages.json';
import fr from '../../public/_locales/fr/messages.json';
import de from '../../public/_locales/de/messages.json';
import es from '../../public/_locales/es/messages.json';
import it from '../../public/_locales/it/messages.json';
import pt from '../../public/_locales/pt/messages.json';
import ja from '../../public/_locales/ja/messages.json';
import zhTW from '../../public/_locales/zh_TW/messages.json';
import { friendlyError as friendlyErrorWith } from '../ui/domhelpers';
// One definition, shared with the legal pages and the offline launcher.
import { LOCALES, resolveLocale } from '../ui/locales';

export { LOCALES, resolveLocale };

interface Entry {
  message: string;
  placeholders?: Record<string, { content: string }>;
}
type Catalog = Record<string, Entry>;

const CATALOGS: Record<string, Catalog> = {
  en: en as Catalog,
  fr: fr as Catalog,
  de: de as Catalog,
  es: es as Catalog,
  it: it as Catalog,
  pt: pt as Catalog,
  ja: ja as Catalog,
  zh_TW: zhTW as Catalog,
};

const STORAGE_KEY = 'stegoshard.lang';

function stored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // storage can be blocked; fall back to the browser language
  }
}

let currentCode = resolveLocale(stored(), navigator.language || 'en');
// Always fall back to English for any key missing from the active catalog.
let messages: Catalog = { ...(en as Catalog), ...(CATALOGS[currentCode] ?? {}) };
document.documentElement.lang = LOCALES.find((l) => l.code === currentCode)?.htmlLang ?? 'en';

export function currentLocale(): string {
  return currentCode;
}

export function msg(key: string, subs?: string | string[]): string {
  const entry = messages[key];
  if (!entry) return key;
  const args = subs === undefined ? [] : Array.isArray(subs) ? subs : [subs];
  let text = entry.message;
  if (entry.placeholders) {
    for (const [name, ph] of Object.entries(entry.placeholders)) {
      const idx = Number(String(ph.content).replace('$', '')) - 1;
      text = text.split(`$${name.toUpperCase()}$`).join(args[idx] ?? '');
    }
  }
  return text;
}

export function localizeDom(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = el.dataset.i18n;
    if (key) el.textContent = msg(key);
  }
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) {
    const key = el.dataset.i18nPlaceholder;
    if (key) el.placeholder = msg(key);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-aria-label]')) {
    const key = el.dataset.i18nAriaLabel;
    if (key) el.setAttribute('aria-label', msg(key));
  }
}

/**
 * Switch the active locale: rebuild the catalog, persist the choice, update
 * <html lang>, re-localize the DOM, and notify listeners (so dynamic strings
 * can be re-rendered) via a `localechange` event on window.
 */
export function setLocale(code: string): void {
  if (!CATALOGS[code]) return;
  currentCode = code;
  messages = { ...(en as Catalog), ...(CATALOGS[code] as Catalog) };
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Non-fatal: the switch still applies for this session.
  }
  document.documentElement.lang = LOCALES.find((l) => l.code === code)?.htmlLang ?? 'en';
  localizeDom();
  window.dispatchEvent(new CustomEvent('localechange', { detail: code }));
}

/**
 * Populate and wire an in-page `<select>` language switcher. `onChange` runs
 * after the DOM has been re-localized, so callers can refresh any dynamically
 * built strings.
 */
export function wireLanguageSelect(select: HTMLSelectElement, onChange?: () => void): void {
  select.replaceChildren();
  for (const loc of LOCALES) {
    const opt = document.createElement('option');
    opt.value = loc.code;
    opt.textContent = loc.name;
    opt.selected = loc.code === currentCode;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    setLocale(select.value);
    onChange?.();
  });
}

export function friendlyError(err: unknown): string {
  return friendlyErrorWith(err, msg);
}

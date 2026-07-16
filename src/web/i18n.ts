/**
 * Minimal i18n for the web app — reuses the extension's message catalogs
 * (bundled at build time) with a chrome.i18n-style getMessage.
 *
 * The active locale defaults to the browser language (when supported) and can
 * be changed at runtime from the in-page language selector; the choice is
 * persisted so it survives reloads. Switching re-localizes the DOM live — no
 * page reload — and updates <html lang>.
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

interface Entry {
  message: string;
  placeholders?: Record<string, { content: string }>;
}
type Catalog = Record<string, Entry>;

/** Supported UI locales, in presentation order, with their native names. */
export const LOCALES: Array<{ code: string; name: string; htmlLang: string }> = [
  { code: 'en', name: 'English', htmlLang: 'en' },
  { code: 'fr', name: 'Français', htmlLang: 'fr' },
  { code: 'de', name: 'Deutsch', htmlLang: 'de' },
  { code: 'es', name: 'Español', htmlLang: 'es' },
  { code: 'it', name: 'Italiano', htmlLang: 'it' },
  { code: 'pt', name: 'Português', htmlLang: 'pt' },
  { code: 'ja', name: '日本語', htmlLang: 'ja' },
  { code: 'zh_TW', name: '繁體中文', htmlLang: 'zh-Hant' },
];

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

const STORAGE_KEY = 'imagevault.lang';

/**
 * Resolve a locale code from an explicit choice and the browser language. Any
 * `zh-*` tag maps to Traditional Chinese (the only Chinese UI we ship); other
 * tags key off their two-letter prefix; anything unknown falls back to English.
 */
export function resolveLocale(requested: string | null, navLang: string): string {
  for (const raw of [requested, navLang]) {
    if (!raw) continue;
    const norm = raw.toLowerCase().replace('-', '_');
    if (CATALOGS[norm]) return norm;
    if (norm.startsWith('zh')) return 'zh_TW';
    const prefix = norm.split('_')[0] ?? '';
    const byPrefix = LOCALES.find((l) => l.code === prefix);
    if (byPrefix) return byPrefix.code;
  }
  return 'en';
}

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

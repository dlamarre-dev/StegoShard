/**
 * Minimal i18n for the web app — reuses the extension's message catalogs
 * (bundled at build time) with a chrome.i18n-style getMessage. Picks the locale
 * from the browser, falling back to English for any missing key.
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

// All eight supported catalogs, bundled at build time so the web app matches
// the extension. Chinese maps any zh-* tag to Traditional (the only variant we
// ship); every other locale keys off its two-letter prefix.
const CATALOGS: Record<string, Catalog> = {
  en: en as Catalog,
  fr: fr as Catalog,
  de: de as Catalog,
  es: es as Catalog,
  it: it as Catalog,
  pt: pt as Catalog,
  ja: ja as Catalog,
  zh: zhTW as Catalog,
};

const lang = (navigator.language || 'en').toLowerCase();
const prefix = lang.split('-')[0] ?? 'en';
const chosen: Catalog = CATALOGS[prefix] ?? (en as Catalog);
const MESSAGES: Catalog = { ...(en as Catalog), ...chosen };

export function msg(key: string, subs?: string | string[]): string {
  const entry = MESSAGES[key];
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

export function friendlyError(err: unknown): string {
  return friendlyErrorWith(err, msg);
}

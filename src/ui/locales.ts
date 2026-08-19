/**
 * The UI locales, and how an arbitrary language tag maps to one of them.
 *
 * Extracted because this existed twice already (the web app's `i18n.ts` and the
 * legal renderer, with two slightly different implementations) and the offline
 * launcher needs it a third time: it prints its startup notice in the system
 * language, and it runs under Node, where none of the browser modules load.
 *
 * No DOM, no imports, no globals, so every surface can use it and it is testable
 * on its own.
 */

export interface UiLocale {
  /** Catalog code, as used by `public/_locales/<code>/`. */
  code: string;
  /** Native name, for a language selector. */
  name: string;
  /** BCP-47 tag for `<html lang>`. */
  htmlLang: string;
}

/** Supported UI locales, in presentation order. */
export const LOCALES: readonly UiLocale[] = [
  { code: 'en', name: 'English', htmlLang: 'en' },
  { code: 'fr', name: 'Français', htmlLang: 'fr' },
  { code: 'de', name: 'Deutsch', htmlLang: 'de' },
  { code: 'es', name: 'Español', htmlLang: 'es' },
  { code: 'it', name: 'Italiano', htmlLang: 'it' },
  { code: 'pt', name: 'Português', htmlLang: 'pt' },
  { code: 'ja', name: '日本語', htmlLang: 'ja' },
  { code: 'ko', name: '한국어', htmlLang: 'ko' },
  { code: 'zh_TW', name: '繁體中文', htmlLang: 'zh-Hant' },
];

/** Just the codes, in the same order. */
export const LOCALE_CODES: readonly string[] = LOCALES.map((l) => l.code);

/**
 * Resolve a locale code from an explicit choice and the ambient language.
 *
 * `requested` is whatever the user said (a `?lang=` override, a stored choice, an
 * environment variable); `ambient` is what the platform reports (the browser
 * language, or ICU's default locale under Node). Tags are matched exactly, then
 * by their language prefix, so `fr-CA` and `fr_CA` both give `fr`. Any `zh-*`
 * resolves to Traditional Chinese, the only Chinese UI shipped. Anything
 * unrecognized falls back to English rather than failing.
 */
export function resolveLocale(requested: string | null | undefined, ambient: string): string {
  for (const raw of [requested, ambient]) {
    if (!raw) continue;
    const norm = raw.toLowerCase().replace(/-/g, '_');
    const exact = LOCALES.find((l) => l.code.toLowerCase() === norm);
    if (exact) return exact.code;
    if (norm.startsWith('zh')) return 'zh_TW';
    const byPrefix = LOCALES.find((l) => l.code === norm.split('_')[0]);
    if (byPrefix) return byPrefix.code;
  }
  return 'en';
}

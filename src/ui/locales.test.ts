/**
 * Locale resolution, which three surfaces now share: the web app's i18n, the
 * legal pages, and the offline launcher's terminal notice. It had been copied
 * twice with two slightly different implementations; these are the cases both
 * were relied on for, plus the ones only the launcher meets (an ICU tag like
 * `fr-CA`, and an environment override).
 */

import { describe, expect, it } from 'vitest';
import { LOCALES, LOCALE_CODES, resolveLocale } from './locales';

describe('resolveLocale', () => {
  it('honours an exact request, in either separator or case', () => {
    expect(resolveLocale('de', 'en-US')).toBe('de');
    expect(resolveLocale('zh_TW', 'en-US')).toBe('zh_TW');
    expect(resolveLocale('zh-TW', 'en-US')).toBe('zh_TW');
    expect(resolveLocale('PT', 'en-US')).toBe('pt');
  });

  it('matches a regional tag by its language', () => {
    // What ICU reports as the default locale on a real machine.
    expect(resolveLocale(null, 'fr-CA')).toBe('fr');
    expect(resolveLocale(null, 'pt-BR')).toBe('pt');
    expect(resolveLocale('fr-CA', 'en-US')).toBe('fr');
    expect(resolveLocale(null, 'de_AT.UTF-8')).toBe('de');
    expect(resolveLocale(null, 'ko-KR')).toBe('ko');
    expect(resolveLocale('ko_KR', 'en-US')).toBe('ko');
  });

  it('sends every Chinese tag to the one Chinese UI shipped', () => {
    for (const tag of ['zh', 'zh-Hant', 'zh-Hans', 'zh-CN', 'zh_SG']) {
      expect(resolveLocale(null, tag), tag).toBe('zh_TW');
    }
  });

  it('falls back to the ambient language, then to English', () => {
    expect(resolveLocale(null, 'ja')).toBe('ja');
    expect(resolveLocale('', 'it-IT')).toBe('it');
    expect(resolveLocale(undefined, 'it-IT')).toBe('it');
    // An unsupported request does not stop the ambient tag being used.
    expect(resolveLocale('sv', 'ja')).toBe('ja');
    expect(resolveLocale(null, 'sv-SE')).toBe('en');
    expect(resolveLocale(null, '')).toBe('en');
  });

  it('resolves every code it lists', () => {
    for (const code of LOCALE_CODES) expect(resolveLocale(code, 'en')).toBe(code);
    expect(LOCALE_CODES).toEqual(['en', 'fr', 'de', 'es', 'it', 'pt', 'ja', 'ko', 'zh_TW']);
    // Each entry is complete enough for a selector and for <html lang>.
    for (const locale of LOCALES) {
      expect(locale.name.length, locale.code).toBeGreaterThan(0);
      expect(locale.htmlLang.length, locale.code).toBeGreaterThan(0);
    }
  });
});

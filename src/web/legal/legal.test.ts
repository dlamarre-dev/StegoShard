import { describe, expect, it } from 'vitest';
import { resolveLocale, SUPPORTED_LOCALES } from './render';
import en from './en.json';
import fr from './fr.json';
import de from './de.json';
import es from './es.json';
import itIt from './it.json';
import pt from './pt.json';
import ja from './ja.json';
import zhTW from './zh_TW.json';

const CATALOGS: Record<string, unknown> = {
  en,
  fr,
  de,
  es,
  it: itIt,
  pt,
  ja,
  zh_TW: zhTW,
};

/** A stable description of an object's shape, ignoring string *values*. */
function shape(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(shape).join(',')}]`;
  if (x && typeof x === 'object') {
    return `{${Object.keys(x as object)
      .sort()
      .map((k) => `${k}:${shape((x as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return 's';
}

/** Collect, in document order, every `href` and every `code` literal. */
function collect(x: unknown, hrefs: string[], codes: string[]): void {
  if (Array.isArray(x)) {
    for (const item of x) collect(item, hrefs, codes);
  } else if (x && typeof x === 'object') {
    const obj = x as Record<string, unknown>;
    if (typeof obj.href === 'string') hrefs.push(obj.href);
    if (typeof obj.code === 'string') codes.push(obj.code);
    for (const v of Object.values(obj)) collect(v, hrefs, codes);
  }
}

describe('legal catalogs', () => {
  const enShape = shape(en);
  const enHrefs: string[] = [];
  const enCodes: string[] = [];
  collect(en, enHrefs, enCodes);

  it('ships all eight supported locales', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'fr', 'de', 'es', 'it', 'pt', 'ja', 'zh_TW']);
    for (const code of SUPPORTED_LOCALES) expect(CATALOGS[code]).toBeDefined();
  });

  for (const [code, catalog] of Object.entries(CATALOGS)) {
    describe(code, () => {
      it('matches the English structure exactly', () => {
        expect(shape(catalog)).toBe(enShape);
      });

      it('preserves every href and code literal from English', () => {
        const hrefs: string[] = [];
        const codes: string[] = [];
        collect(catalog, hrefs, codes);
        expect(hrefs).toEqual(enHrefs); // URLs never translated
        expect(codes).toEqual(enCodes); // permission/API names never translated
      });
    });
  }
});

describe('resolveLocale', () => {
  it('honors a valid ?lang override', () => {
    expect(resolveLocale('de', 'en-US')).toBe('de');
    expect(resolveLocale('zh_TW', 'en-US')).toBe('zh_TW');
  });

  it('normalizes override tags to a supported code', () => {
    expect(resolveLocale('fr-CA', 'en-US')).toBe('fr');
    expect(resolveLocale('zh-Hant', 'en-US')).toBe('zh_TW');
    expect(resolveLocale('PT', 'en-US')).toBe('pt');
  });

  it('falls back to the browser language when no override', () => {
    expect(resolveLocale(null, 'ja')).toBe('ja');
    expect(resolveLocale('', 'it-IT')).toBe('it');
    expect(resolveLocale(null, 'zh-TW')).toBe('zh_TW');
  });

  it('falls back to English for anything unrecognized', () => {
    expect(resolveLocale('kl', 'kl')).toBe('en');
    expect(resolveLocale(null, '')).toBe('en');
    expect(resolveLocale(null, 'ru-RU')).toBe('en');
  });
});

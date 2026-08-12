/**
 * The CLI catalogs. TypeScript already guarantees that every locale carries every
 * key (each is declared `CliCatalog`, whose type is the English catalog), so what
 * is left to check is what the type cannot see: that the placeholders survived
 * translation, that nothing was left in English by accident, and that the help
 * text renders in every language.
 *
 * The placeholder check is the one that matters. `{path}`, `{spec}`, `{count}`:
 * drop one in translation and the message silently stops saying which file, which
 * value, how many, in that language only.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { CATALOGS, cliLocale, t, useCatalog, type CliKey } from './index';
import { en } from './en';
import { LOCALE_CODES } from '../../ui/locales';
import { usage } from './usage';
import { displayWidth } from './width';

const KEYS = Object.keys(en) as CliKey[];
const PLACEHOLDER = /\{(\w+)\}/g;
const placeholders = (text: string): string[] =>
  [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!).sort();

afterEach(() => useCatalog(null));

describe('CLI catalogs', () => {
  it('covers every locale the app ships', () => {
    expect(Object.keys(CATALOGS).sort()).toEqual([...LOCALE_CODES].sort());
  });

  it('keeps the same placeholders in every language', () => {
    for (const [code, catalog] of Object.entries(CATALOGS)) {
      for (const key of KEYS) {
        expect(placeholders(catalog[key]), `${code}.${key}`).toEqual(placeholders(en[key]));
      }
    }
  });

  it('leaves no message empty', () => {
    for (const [code, catalog] of Object.entries(CATALOGS)) {
      for (const key of KEYS) expect(catalog[key].trim(), `${code}.${key}`).not.toBe('');
    }
  });

  /**
   * Strings a language legitimately spells the way English does. Listed rather
   * than pattern-matched, so the next identical value has to be justified here
   * instead of quietly passing.
   */
  const SAME_AS_ENGLISH: Record<string, CliKey[]> = {
    // "image(s)" is the same word in French, so the whole value matches.
    fr: ['outSavedImages'],
    // Italian borrows "password"; "parola d'ordine" would read as a translation
    // exercise rather than the word an Italian user expects on screen.
    it: ['labelPassword', 'promptPassword'],
  };

  it('actually translates, rather than copying the English', () => {
    // Not every string can differ: flag names and `{placeholders}` are the same
    // everywhere, and a few values are almost entirely those. Ignore anything
    // whose letters are all part of a flag, and require the rest to move.
    const proseKeys = KEYS.filter((k) =>
      en[k]
        .replace(PLACEHOLDER, '')
        .replace(/--[\w-]+/g, '')
        .match(/[a-z]{4,}/i),
    );
    for (const [code, catalog] of Object.entries(CATALOGS)) {
      if (code === 'en') continue;
      const allowed = SAME_AS_ENGLISH[code] ?? [];
      const copied = proseKeys.filter((k) => catalog[k] === en[k] && !allowed.includes(k));
      expect(copied, `${code} still in English`).toEqual([]);
    }
  });

  it('keeps flag names, environment variables and paths verbatim', () => {
    // A translated `--force` or `STEGOSHARD_PASSWORD` would be unusable advice.
    const literals = [
      '--force',
      '--allow-weak-password',
      'STEGOSHARD_ENTROPY',
      'docs/THREAT-MODEL.md',
    ];
    for (const [code, catalog] of Object.entries(CATALOGS)) {
      const all = KEYS.map((k) => catalog[k]).join('\n');
      const english = KEYS.map((k) => en[k]).join('\n');
      for (const literal of literals) {
        if (english.includes(literal)) expect(all, `${code} lost ${literal}`).toContain(literal);
      }
    }
  });
});

describe('t()', () => {
  it('substitutes what it is given and leaves an unknown placeholder visible', () => {
    useCatalog('en');
    expect(t('errEntropyFile', { path: '/tmp/dice.txt' })).toContain('/tmp/dice.txt');
    // A blank would read as a message that forgot to name the file; a visible
    // `{path}` is a bug report.
    expect(t('errEntropyFile')).toContain('{path}');
  });

  it('answers in the pinned language', () => {
    useCatalog('fr');
    expect(t('errWrongPassword')).toBe('mot de passe incorrect');
    useCatalog('ja');
    expect(t('errWrongPassword')).toBe('パスワードが違います');
    useCatalog('sv'); // unsupported: English, not a crash
    expect(t('errWrongPassword')).toBe('wrong password');
  });
});

describe('cliLocale', () => {
  it('honours STEGOSHARD_LANG over the system', () => {
    expect(cliLocale({ STEGOSHARD_LANG: 'de' })).toBe('de');
    expect(cliLocale({ STEGOSHARD_LANG: 'pt-BR' })).toBe('pt');
    // Unsupported override falls through to the ambient locale, then English.
    expect(LOCALE_CODES).toContain(cliLocale({ STEGOSHARD_LANG: 'sv' }));
  });
});

describe('help text', () => {
  it('renders in every language, with the flags left alone', () => {
    for (const code of LOCALE_CODES) {
      useCatalog(code);
      const text = usage();
      expect(text, code).toContain('stegoshard save <file|dir ...> [options]');
      expect(text, code).toContain('--allow-weak-password');
      expect(text, code).toContain('STEGOSHARD_PASSWORD');
      // The examples are commands, so they are identical everywhere.
      expect(text, code).toContain('stegoshard gallery-restore ./album --out ./restored');
      // Nothing runs off a terminal: the renderer wraps to a fixed width.
      //
      // Measured in cells, not characters. Asserting `.length` here is what let
      // the Japanese help reach 152 cells while this test passed: every character
      // counted as one, but a terminal gives CJK two.
      for (const line of text.split('\n'))
        expect(displayWidth(line), `${code}: ${line}`).toBeLessThanOrEqual(88);
    }
  });

  it('describes every option it lists', () => {
    useCatalog('en');
    const text = usage();
    // A row whose description key was forgotten would render as a bare flag.
    for (const flag of ['--out <dir>', '--codec <codec>', '--share <file>', '--quiet']) {
      const line = text.split('\n').find((l) => l.trim().startsWith(flag));
      expect(line, flag).toBeDefined();
      expect(line!.trim().length, flag).toBeGreaterThan(flag.length + 4);
    }
  });
});

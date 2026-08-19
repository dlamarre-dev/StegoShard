/**
 * The CLI's messages, in the system language.
 *
 * The catalogs are TypeScript rather than JSON so `en` can be the type: every
 * other locale is declared `CliCatalog`, which makes a missing or misnamed key a
 * build error. That matters at this size (over a hundred messages, nine
 * languages); a runtime parity test then checks that the placeholders match too.
 *
 * Detection matches the launcher's (`STEGOSHARD_LANG`, else ICU's default
 * locale), so one command cannot answer in a different language from the next.
 * `STEGOSHARD_LANG=en` is what tests and scripts pin.
 */

import { resolveLocale } from '../../ui/locales';
import { en } from './en';
import { fr } from './fr';
import { de } from './de';
import { es } from './es';
import { it } from './it';
import { pt } from './pt';
import { ja } from './ja';
import { ko } from './ko';
import { zhTW } from './zh_TW';

export type CliCatalog = typeof en;
export type CliKey = keyof CliCatalog;

export const CATALOGS: Record<string, CliCatalog> = { en, fr, de, es, it, pt, ja, ko, zh_TW: zhTW };

/**
 * Which language to speak.
 *
 * `Intl`'s default locale is the only portable source: Windows sets no `LANG`,
 * and ICU there follows the user's regional settings, while on Unix it follows
 * `LC_ALL`/`LANG`.
 */
export function cliLocale(env: NodeJS.ProcessEnv = process.env): string {
  let ambient = 'en';
  try {
    ambient = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    // No ICU data: English it is.
  }
  return resolveLocale(env.STEGOSHARD_LANG, ambient);
}

let active: CliCatalog | null = null;

/** The active catalog, resolved once per process. */
export function catalog(): CliCatalog {
  active ??= CATALOGS[cliLocale()] ?? en;
  return active;
}

/** Testing seam: pin (or clear, with `null`) the catalog for one assertion. */
export function useCatalog(locale: string | null): void {
  active = locale === null ? null : (CATALOGS[locale] ?? en);
}

/**
 * A message, with `{name}` placeholders filled in.
 *
 * An unknown placeholder is left as it is rather than blanked: a visible `{path}`
 * in output is a bug report, while a silently empty one reads as a message that
 * simply forgot to say which file.
 */
export function t(key: CliKey, params: Record<string, string | number> = {}): string {
  const template = catalog()[key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/**
 * Where the visitor's chosen language is kept, and the one name for it.
 *
 * Extracted for the same reason as `ui/locales.ts`: the legal pages need the
 * choice the visitor made in the app, but they are a separate entry point, and
 * importing `web/i18n.ts` to reach it would pull all nine `messages.json`
 * catalogs into a page that renders none of them. A shared constant and two
 * guarded accessors cost nothing instead.
 *
 * Both accessors swallow their errors: `localStorage` throws rather than
 * returning null when a browser blocks site data, and a language preference is
 * never worth failing a page over.
 */

const STORAGE_KEY = 'stegoshard.lang';

/** The stored choice, or null when there is none (or storage is blocked). */
export function storedLocale(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Remember an explicit choice. A no-op when storage is unavailable. */
export function storeLocale(code: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Non-fatal: the switch still applies for this session.
  }
}

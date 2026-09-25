/**
 * Where the web app keeps the visitor's codec choice.
 *
 * The same shape as `lang-store.ts`, for the same reason: `localStorage` throws
 * rather than returning null when a browser blocks site data. Called bare, the
 * read ran while `main.ts` was still loading, so the throw stopped the script
 * before the page was ever shown, over a preference.
 */

import type { CodecChoice } from '../ui/save-controller';

const STORAGE_KEY = 'stegoshard.codec';

/** The stored choice, or `'color'` when there is none (or storage is blocked). */
export function storedCodec(): CodecChoice {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'qr' ? 'qr' : 'color';
  } catch {
    return 'color';
  }
}

/** Remember an explicit choice. A no-op when storage is unavailable. */
export function storeCodec(codec: CodecChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, codec);
  } catch {
    // Non-fatal: the choice still applies for this session.
  }
}

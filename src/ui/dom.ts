import browser from 'webextension-polyfill';
import { friendlyError as friendlyErrorWith } from './domhelpers';

export { el, show, setStatus, pick, errText, wireDropzone } from './domhelpers';

/** Localized message lookup (extension: chrome.i18n). */
export function msg(key: string, subs?: string | string[]): string {
  return browser.i18n.getMessage(key, subs);
}

/** Map a known core error to a localized message. */
export function friendlyError(err: unknown): string {
  return friendlyErrorWith(err, msg);
}

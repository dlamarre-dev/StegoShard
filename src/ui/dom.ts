import browser from 'webextension-polyfill';
import {
  FileTooLargeError,
  MissingKeyError,
  TooManyImagesError,
  WrongPasswordError,
} from '@core';

/** Localized message lookup. */
export function msg(key: string, subs?: string | string[]): string {
  return browser.i18n.getMessage(key, subs);
}

/** Map a known core error to a localized message, falling back to its text. */
export function friendlyError(err: unknown): string {
  if (err instanceof WrongPasswordError) return msg('errWrongPassword');
  if (err instanceof MissingKeyError) return msg('errMissingKey');
  if (err instanceof FileTooLargeError) {
    return msg('errFileTooLarge', [String(Math.ceil(err.size / 1024)), String(Math.floor(err.limit / 1024))]);
  }
  if (err instanceof TooManyImagesError) {
    return msg('errTooManyImages', [String(err.count), String(err.limit)]);
  }
  return errText(err);
}

/** Get a required element by id, or throw. */
export function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

/** Show/hide a section. */
export function show(node: HTMLElement, visible: boolean): void {
  node.hidden = !visible;
}

/** Set a status line, optionally as an error. */
export function setStatus(node: HTMLElement, text: string, error = false): void {
  node.textContent = text;
  node.classList.toggle('error', error);
}

/** Human-readable text for an unknown error. */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

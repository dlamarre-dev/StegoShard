/**
 * Tiny, browser-only DOM helpers shared by the extension app and the web app
 * (no webextension-polyfill import, so both bundles can use them).
 */

import {
  FileTooLargeError,
  GalleryCoverCapacityError,
  GalleryFileTooLargeError,
  GalleryRestoreError,
  GalleryTooFewImagesError,
  MissingKeyError,
  StegoCapacityError,
  StegoCoverFormatError,
  TooManyFilesError,
  TooManyImagesError,
  WrongPasswordError,
} from '@core';

/** Map a known core error to a localized message via the caller's `translate`. */
export function friendlyError(
  err: unknown,
  translate: (key: string, subs?: string | string[]) => string,
): string {
  if (err instanceof WrongPasswordError) return translate('errWrongPassword');
  if (err instanceof MissingKeyError) return translate('errMissingKey');
  if (err instanceof StegoCapacityError) return translate('errCoverTooSmall');
  if (err instanceof StegoCoverFormatError) return translate('errCoverFormat');
  if (err instanceof FileTooLargeError) {
    return translate('errFileTooLarge', [
      String(Math.ceil(err.size / 1024)),
      String(Math.floor(err.limit / 1024)),
    ]);
  }
  if (err instanceof TooManyImagesError) {
    return translate('errTooManyImages', [String(err.count), String(err.limit)]);
  }
  if (err instanceof TooManyFilesError) {
    return translate('errTooManyFiles', [String(err.count), String(err.limit)]);
  }
  if (err instanceof GalleryTooFewImagesError)
    return translate('errGalleryTooFew', String(err.needed));
  if (err instanceof GalleryFileTooLargeError) return translate('errGalleryTooLarge');
  if (err instanceof GalleryCoverCapacityError) {
    return translate('errGalleryCoverTooSmall', err.coverName);
  }
  if (err instanceof GalleryRestoreError) return translate('errGalleryRestore');
  return errText(err);
}

export function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

export function show(node: HTMLElement, visible: boolean): void {
  node.hidden = !visible;
}

export function setStatus(node: HTMLElement, text: string, error = false): void {
  node.textContent = text;
  node.classList.toggle('error', error);
}

/** Reflect picked file(s) in a dropzone: a single filename, or a count when several. */
export function reflectFiles(drop: HTMLElement, chip: HTMLElement, input: HTMLInputElement): void {
  const files = input.files ? Array.from(input.files) : [];
  drop.classList.toggle('has-file', files.length > 0);
  chip.textContent = files.length === 1 ? files[0]!.name : files.length ? String(files.length) : '';
}

/** Value of the checked radio in a group, or a fallback. */
export function pick<T extends string>(name: string, fallback: T): T {
  const checked = document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
  return (checked?.value as T) ?? fallback;
}

/** Human-readable text for an unknown error. */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Turn a container into a drag-and-drop zone bound to a file `<input>`: clicking
 * the zone opens the picker, dropping files assigns them to the input and fires
 * a `change` event so existing handlers run. `onChange` is called after either.
 */
export function wireDropzone(
  zone: HTMLElement,
  input: HTMLInputElement,
  onChange: () => void,
): void {
  zone.addEventListener('click', (e) => {
    if (e.target !== input) input.click();
  });
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragging');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragging');
    if (e.dataTransfer?.files?.length) {
      input.files = e.dataTransfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  input.addEventListener('change', onChange);
}

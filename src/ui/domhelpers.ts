/**
 * Tiny, browser-only DOM helpers shared by the extension app and the web app
 * (no webextension-polyfill import, so both bundles can use them).
 */

import {
  type FilePurpose,
  type ManifestEntry,
  collapseManifest,
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
 * Add a "clear" control to a dropzone, so a wrong pick can be undone without
 * reloading the page.
 *
 * It only shows once the zone holds a selection (`.has-file`, set by the reflect
 * helpers), and clearing fires the same `change` event a real pick would, so
 * every caller's `onChange` runs and the label resets itself. `label` comes from
 * the caller because this module is shared by two surfaces with two different
 * i18n backends; the `data-i18n` attribute lets a later locale switch
 * re-translate the button through `localizeDom`.
 *
 * The button goes *after* the zone, not inside it: the zone is a `role="button"`,
 * whose children are presentational, so a focusable control within it is a real
 * accessibility fault (axe `nested-interactive`) and its Enter/Space would race
 * the zone's own. The zone must therefore already be in a parent when this runs.
 */
function addClearButton(zone: HTMLElement, input: HTMLInputElement, label?: string): void {
  if (zone.nextElementSibling?.classList.contains('dz-clear')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dz-clear';
  btn.dataset.i18n = 'btnClearFiles';
  btn.textContent = label ?? 'Clear';
  btn.addEventListener('click', () => {
    input.value = '';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  zone.insertAdjacentElement('afterend', btn);
}

/**
 * Turn a container into a drag-and-drop zone bound to a file `<input>`: clicking
 * the zone opens the picker, dropping files assigns them to the input and fires
 * a `change` event so existing handlers run. `onChange` is called after either.
 * Every zone also gets a clear button (see `addClearButton`).
 */
export function wireDropzone(
  zone: HTMLElement,
  input: HTMLInputElement,
  onChange: () => void,
  clearLabel?: string,
): void {
  addClearButton(zone, input, clearLabel);
  zone.addEventListener('click', (e) => {
    if (e.target !== input) input.click();
  });
  zone.addEventListener('keydown', (e) => {
    // Only the zone's own Enter/Space opens the picker: the clear button inside
    // it handles its keyboard activation itself.
    if (e.target !== zone) return;
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

/** i18n key naming each file purpose, shared by both surfaces. */
const PURPOSE_KEY: Record<FilePurpose, string> = {
  vault: 'filePurposeVault',
  archive: 'filePurposeArchive',
  document: 'filePurposeDocument',
  photos: 'filePurposePhotos',
  keyfile: 'filePurposeKeyfile',
  stegoCover: 'filePurposeStegoCover',
  share: 'filePurposeShare',
};

/**
 * "Files created" list for the save-result panel.
 *
 * Built here rather than in each surface because the wizard and the expert view
 * must describe the same save identically — and because deniable destinations
 * make this the only place the user learns what `cache.db` and `recovery-1.txt`
 * actually are.
 *
 * Numbered runs collapse to first … last so a 40-image save does not push the
 * rest of the panel off screen.
 */
export function renderManifest(
  manifest: readonly ManifestEntry[],
  translate: (key: string, subs?: string | string[]) => string,
): HTMLElement | null {
  if (manifest.length === 0) return null;
  const box = document.createElement('div');
  box.className = 'result-files';

  const heading = document.createElement('p');
  heading.className = 'result-recovery-heading';
  heading.textContent = translate('filesCreatedHeading');

  const list = document.createElement('ul');
  list.className = 'manifest-list';
  for (const group of collapseManifest(manifest)) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'manifest-name';
    name.textContent = group.count > 1 ? `${group.first} … ${group.last}` : group.first;
    const purpose = document.createElement('span');
    purpose.className = 'manifest-purpose';
    const label = translate(PURPOSE_KEY[group.purpose]);
    purpose.textContent = group.count > 1 ? `${label} (${group.count})` : label;
    li.append(name, purpose);
    list.append(li);
  }
  box.append(heading, list);
  return box;
}

/**
 * Keep an auto-growing textarea in step with its own content.
 *
 * The `.grow-wrap` parent sizes itself from a replicated copy of the text (see
 * ui.css); this only has to keep that copy current. Writing a data attribute
 * rather than `style.height` keeps the field working under a `style-src 'self'`
 * CSP, which forbids the inline styles the usual scrollHeight trick needs.
 */
export function wireAutoGrow(textarea: HTMLTextAreaElement): void {
  const wrap = textarea.closest<HTMLElement>('.grow-wrap');
  if (!wrap) return;
  const sync = (): void => {
    wrap.dataset.replicatedValue = textarea.value;
  };
  textarea.addEventListener('input', sync);
  sync();
}

/** Bounds of the threshold picker. */
export const THRESHOLD_MIN = 2;
export const THRESHOLD_MAX = 10;

/**
 * Wire the k-of-n threshold selects so an invalid pair is unreachable.
 *
 * The old pair of number boxes let k exceed n and reported it only at save time
 * as a bare "missing threshold" — the user had no way to see what was wrong. A
 * picker that cannot express the invalid state needs no error message at all.
 *
 * n is chosen first and bounds k. Both start at 2: k=1 means a single holder
 * opens the vault, and n=1 means you hold it yourself, so neither is a threshold
 * in any useful sense.
 */
export function wireThreshold(
  n: HTMLSelectElement,
  k: HTMLSelectElement,
  onSummary?: (k: number, n: number) => void,
): void {
  const option = (value: number): HTMLOptionElement => {
    const o = document.createElement('option');
    o.value = String(value);
    o.textContent = String(value);
    return o;
  };

  for (let v = THRESHOLD_MIN; v <= THRESHOLD_MAX; v++) n.append(option(v));
  n.value = '3';

  const refreshK = (): void => {
    const total = Number(n.value);
    const wanted = Number(k.value) || THRESHOLD_MIN;
    k.replaceChildren();
    for (let v = THRESHOLD_MIN; v <= total; v++) k.append(option(v));
    // Keep the user's choice when it still fits; otherwise pull it down to n
    // rather than silently resetting to the minimum.
    k.value = String(Math.min(wanted, total));
    onSummary?.(Number(k.value), total);
  };

  n.addEventListener('change', refreshK);
  k.addEventListener('change', () => onSummary?.(Number(k.value), Number(n.value)));
  refreshK();
}

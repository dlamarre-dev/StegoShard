/**
 * Web app entry — a standalone, install-free version of ImageVault's offline
 * core (Disk + Paper). It reuses the exact same core, codec, and disk/paper
 * flows as the extension; it just generates a fresh vault key per save (the
 * wrapped key travels with the images or as a .key file) instead of a managed
 * key store. Everything runs locally in the browser; nothing is uploaded.
 */

import {
  createKeyBlock,
  serializeKeyBlock,
  estimateImages,
  PROFILE_DISK,
  PROFILE_PAPER,
  type KeyMode,
  type VaultKey,
} from '@core';
import { saveFileToDisk, restoreFileFromDisk } from '../ui/disk';
import { localizeDom, msg, friendlyError } from './i18n';

localizeDom();

type Dest = 'disk' | 'paper';

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}
function show(node: HTMLElement, visible: boolean): void {
  node.hidden = !visible;
}
function setStatus(node: HTMLElement, text: string, error = false): void {
  node.textContent = text;
  node.classList.toggle('error', error);
}
function pick<T extends string>(name: string, fallback: T): T {
  return (
    (document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value as T) ??
    fallback
  );
}

const saveFile = el<HTMLInputElement>('save-file');
const savePw = el<HTMLInputElement>('save-pw');
const estimate = el('estimate');
const addBand = el<HTMLInputElement>('add-band');
const bandFields = el('band-fields');
const bandTitle = el<HTMLInputElement>('band-title');
const asZip = el<HTMLInputElement>('as-zip');
const zipField = el('zip-field');
const paperFields = el('paper-fields');
const addInstructions = el<HTMLInputElement>('add-instructions');
const pwHint = el<HTMLInputElement>('pw-hint');
const keyLocation = el<HTMLInputElement>('key-location');
const saveBtn = el<HTMLButtonElement>('save-btn');
const saveStatus = el('save-status');

const restoreFiles = el<HTMLInputElement>('restore-files');
const restoreKey = el<HTMLInputElement>('restore-key');
const restorePw = el<HTMLInputElement>('restore-pw');
const restoreBtn = el<HTMLButtonElement>('restore-btn');
const restoreStatus = el('restore-status');

const selectedDest = () => pick<Dest>('dest', 'disk');
const selectedKeyMode = () => pick<KeyMode>('keymode', 'embedded');

function reflectDestination(): void {
  const paper = selectedDest() === 'paper';
  show(zipField, !paper);
  show(paperFields, paper);
}

async function updateEstimate(): Promise<void> {
  const file = saveFile.files?.[0];
  if (!file) return void (estimate.textContent = '—');
  estimate.textContent = '…';
  try {
    const content = new Uint8Array(await file.arrayBuffer());
    const profile = selectedDest() === 'paper' ? PROFILE_PAPER : PROFILE_DISK;
    const { images } = await estimateImages(file.name, content, {
      keyMode: selectedKeyMode(),
      profile,
    });
    estimate.textContent = String(images);
  } catch {
    estimate.textContent = '—';
  }
}

addBand.addEventListener('change', () => show(bandFields, addBand.checked));
saveFile.addEventListener('change', updateEstimate);
for (const r of document.querySelectorAll('input[name="dest"]')) {
  r.addEventListener('change', () => {
    reflectDestination();
    void updateEstimate();
  });
}
for (const r of document.querySelectorAll('input[name="keymode"]')) {
  r.addEventListener('change', () => void updateEstimate());
}

async function makeKey(password: string): Promise<VaultKey> {
  const { dek, block } = await createKeyBlock(password);
  return { dek, keyBlock: serializeKeyBlock(block) };
}

saveBtn.addEventListener('click', async () => {
  const file = saveFile.files?.[0];
  if (!file) return setStatus(saveStatus, msg('errNoFile'), true);
  if (!savePw.value) return setStatus(saveStatus, msg('errNoPassword'), true);

  const keyMode = selectedKeyMode();
  const dest = selectedDest();
  const date = new Date().toISOString().slice(0, 10);
  const useLabel = addBand.checked;
  const title = useLabel ? bandTitle.value.trim() : '';

  saveBtn.disabled = true;
  setStatus(saveStatus, msg('statusSaving'));
  try {
    const key = await makeKey(savePw.value);
    if (dest === 'paper') {
      // Lazy-load the PDF path (pdf-lib) so it is not in the initial bundle.
      const { saveFileToPaper } = await import('../ui/paper');
      const { imageCount } = await saveFileToPaper(file, key, {
        keyMode,
        title: title || undefined,
        date,
        includeInstructions: addInstructions.checked,
        passwordHint: pwHint.value.trim() || undefined,
        keyLocation: keyLocation.value.trim() || undefined,
      });
      setStatus(saveStatus, msg('statusSavedPdf', String(imageCount)));
    } else {
      const label = useLabel ? { title, date } : undefined;
      const { imageCount } = await saveFileToDisk(file, key, {
        keyMode,
        label,
        asZip: asZip.checked,
      });
      const statusKey = keyMode === 'embedded' ? 'statusSaved' : 'statusSavedKeyfile';
      setStatus(saveStatus, msg(statusKey, String(imageCount)));
    }
  } catch (err) {
    setStatus(saveStatus, friendlyError(err), true);
  } finally {
    saveBtn.disabled = false;
  }
});

restoreBtn.addEventListener('click', async () => {
  const files = restoreFiles.files ? Array.from(restoreFiles.files) : [];
  if (files.length === 0) return setStatus(restoreStatus, msg('errNoImages'), true);
  if (!restorePw.value) return setStatus(restoreStatus, msg('errNoPassword'), true);

  restoreBtn.disabled = true;
  setStatus(restoreStatus, msg('statusRestoring'));
  try {
    const { filename } = await restoreFileFromDisk(files, restorePw.value, restoreKey.files?.[0]);
    setStatus(restoreStatus, msg('statusRestored', filename));
  } catch (err) {
    setStatus(restoreStatus, friendlyError(err), true);
  } finally {
    restoreBtn.disabled = false;
  }
});

reflectDestination();

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
import { el, pick, setStatus, show, wireDropzone } from '../ui/domhelpers';
import { saveFileToDisk, restoreFileFromDisk } from '../ui/disk';
import { localizeDom, msg, friendlyError, wireLanguageSelect } from './i18n';
import { capturedCount, capturedPayloads, clearCaptured, wireCamera } from './camera';

localizeDom();
wireLanguageSelect(el<HTMLSelectElement>('lang-select'), () => {
  // Re-render the strings that were set dynamically (localizeDom only handles
  // static [data-i18n] nodes), so a mid-session switch is fully translated.
  reflectCaptured(capturedCount());
});

type Dest = 'disk' | 'paper';

const saveFile = el<HTMLInputElement>('save-file');
const fileDrop = el('file-drop');
const dzFile = el('dz-file');
const savePw = el<HTMLInputElement>('save-pw');
const estimate = el('estimate');
const stegoFields = el('stego-fields');
const coverDrop = el('cover-drop');
const coverFile = el<HTMLInputElement>('cover-file');
const coverDzFile = el('cover-dz-file');
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
const saveResult = el('save-result');
const saveResultNote = el('save-result-note');

const restoreFiles = el<HTMLInputElement>('restore-files');
const restoreDrop = el('restore-drop');
const restoreDzFile = el('restore-dz-file');
const restoreKey = el<HTMLInputElement>('restore-key');
const keyDrop = el('key-drop');
const keyDzFile = el('key-dz-file');
const cameraCaptured = el('camera-captured');
const restorePw = el<HTMLInputElement>('restore-pw');
const restoreBtn = el<HTMLButtonElement>('restore-btn');
const restoreStatus = el('restore-status');
const restoreResult = el('restore-result');
const restoreResultNote = el('restore-result-note');

const selectedDest = () => pick<Dest>('dest', 'disk');
const selectedKeyMode = () => pick<KeyMode>('keymode', 'embedded');

function reflectFile(drop: HTMLElement, chip: HTMLElement, input: HTMLInputElement): void {
  const file = input.files?.[0];
  drop.classList.toggle('has-file', Boolean(file));
  chip.textContent = file ? file.name : '';
}

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

function reflectKeyMode(): void {
  show(stegoFields, selectedKeyMode() === 'stego');
}

addBand.addEventListener('change', () => show(bandFields, addBand.checked));
for (const r of document.querySelectorAll('input[name="dest"]')) {
  r.addEventListener('change', () => {
    reflectDestination();
    void updateEstimate();
  });
}
for (const r of document.querySelectorAll('input[name="keymode"]')) {
  r.addEventListener('change', () => {
    reflectKeyMode();
    void updateEstimate();
  });
}

wireDropzone(fileDrop, saveFile, () => {
  reflectFile(fileDrop, dzFile, saveFile);
  show(saveResult, false);
  void updateEstimate();
});
wireDropzone(coverDrop, coverFile, () => reflectFile(coverDrop, coverDzFile, coverFile));
wireDropzone(restoreDrop, restoreFiles, () =>
  reflectFile(restoreDrop, restoreDzFile, restoreFiles),
);
wireDropzone(keyDrop, restoreKey, () => reflectFile(keyDrop, keyDzFile, restoreKey));

function reflectCaptured(count: number): void {
  show(cameraCaptured, count > 0);
  cameraCaptured.textContent = count > 0 ? msg('cameraCount', String(count)) : '';
}
wireCamera(
  {
    button: 'camera-btn',
    modal: 'camera-modal',
    video: 'camera-video',
    count: 'camera-count',
    done: 'camera-done',
    close: 'camera-close',
    errorStatus: 'restore-status',
  },
  reflectCaptured,
);

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
  const cover = coverFile.files?.[0];
  if (keyMode === 'stego' && !cover) return setStatus(saveStatus, msg('errNoCover'), true);
  const stego = keyMode === 'stego' && cover ? { cover, password: savePw.value } : undefined;
  const date = new Date().toISOString().slice(0, 10);
  const useLabel = addBand.checked;
  const title = useLabel ? bandTitle.value.trim() : '';

  saveBtn.disabled = true;
  show(saveResult, false);
  setStatus(saveStatus, msg('statusSaving'));
  try {
    const key = await makeKey(savePw.value);
    let note: string;
    if (dest === 'paper') {
      const { saveFileToPaper } = await import('../ui/paper');
      const { imageCount } = await saveFileToPaper(file, key, {
        keyMode,
        title: title || undefined,
        date,
        includeInstructions: addInstructions.checked,
        passwordHint: pwHint.value.trim() || undefined,
        keyLocation: keyLocation.value.trim() || undefined,
        stego,
      });
      note = msg('statusSavedPdf', String(imageCount));
    } else {
      const label = useLabel ? { title, date } : undefined;
      const { imageCount } = await saveFileToDisk(file, key, {
        keyMode,
        label,
        asZip: asZip.checked,
        stego,
      });
      const savedKey =
        keyMode === 'embedded'
          ? 'statusSaved'
          : keyMode === 'stego'
            ? 'statusSavedStego'
            : 'statusSavedKeyfile';
      note = msg(savedKey, String(imageCount));
    }
    setStatus(saveStatus, '');
    saveResultNote.textContent = note;
    show(saveResult, true);
  } catch (err) {
    setStatus(saveStatus, friendlyError(err), true);
  } finally {
    saveBtn.disabled = false;
  }
});

restoreBtn.addEventListener('click', async () => {
  const files = restoreFiles.files ? Array.from(restoreFiles.files) : [];
  if (files.length === 0 && capturedCount() === 0) {
    return setStatus(restoreStatus, msg('errNoImages'), true);
  }
  if (!restorePw.value) return setStatus(restoreStatus, msg('errNoPassword'), true);

  restoreBtn.disabled = true;
  show(restoreResult, false);
  setStatus(restoreStatus, msg('statusRestoring'));
  try {
    const { filename } = await restoreFileFromDisk(
      files,
      restorePw.value,
      restoreKey.files?.[0],
      capturedPayloads(),
    );
    setStatus(restoreStatus, '');
    restoreResultNote.textContent = msg('statusRestored', filename);
    show(restoreResult, true);
    clearCaptured();
    reflectCaptured(0);
  } catch (err) {
    setStatus(restoreStatus, friendlyError(err), true);
  } finally {
    restoreBtn.disabled = false;
  }
});

reflectDestination();
reflectKeyMode();

import browser from 'webextension-polyfill';
import { estimateImages, PROFILE_CLOUD, PROFILE_DISK, PROFILE_PAPER, type KeyMode } from '@core';
import { localizeDom } from './i18n';
import { el, friendlyError, msg, pick, setStatus, show, wireDropzone } from './dom';
import { getSession, isKeySet, lock, unlock } from './keystore';
import { type Destination, getPrefs, savePrefs } from './prefs';
import { restoreFileFromDisk, saveFileToDisk } from './disk';
import { HAS_GOOGLE_PHOTOS } from './config';
import { saveToPhotos } from './google-photos';
import { wireKeyManager } from './keymanager';

localizeDom();

const noKeySection = el('no-key');
const lockedSection = el('locked');
const saveSection = el('save');
const statePill = el('state-pill');

const unlockPw = el<HTMLInputElement>('unlock-pw');
const unlockBtn = el<HTMLButtonElement>('unlock-btn');
const unlockStatus = el('unlock-status');

const saveFile = el<HTMLInputElement>('save-file');
const fileDrop = el('file-drop');
const dzFile = el('dz-file');
const saveBtn = el<HTMLButtonElement>('save-btn');
const saveStatus = el('save-status');
const saveResult = el('save-result');
const saveResultNote = el('save-result-note');
const estimate = el('estimate');
const lockBtn = el<HTMLButtonElement>('lock-btn');
const addBand = el<HTMLInputElement>('add-band');
const addBandLabel = el('add-band-label');
const bandFields = el('band-fields');
const bandTitle = el<HTMLInputElement>('band-title');
const asZip = el<HTMLInputElement>('as-zip');
const zipField = el('zip-field');
const paperFields = el('paper-fields');
const addInstructions = el<HTMLInputElement>('add-instructions');
const pwHint = el<HTMLInputElement>('pw-hint');
const keyLocation = el<HTMLInputElement>('key-location');

const restoreFiles = el<HTMLInputElement>('restore-files');
const restoreDrop = el('restore-drop');
const restoreDzFile = el('restore-dz-file');
const restoreKey = el<HTMLInputElement>('restore-key');
const restorePw = el<HTMLInputElement>('restore-pw');
const restoreBtn = el<HTMLButtonElement>('restore-btn');
const restorePhotosBtn = el<HTMLButtonElement>('restore-photos-btn');
const restoreStatus = el('restore-status');
const restoreResult = el('restore-result');
const restoreResultNote = el('restore-result-note');

const selectedKeyMode = () => pick<KeyMode>('keymode', 'embedded');
const selectedDest = () => pick<Destination>('dest', 'disk');

function setRadio(name: string, value: string): void {
  const radio = document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  if (radio) radio.checked = true;
}

/** Reflect the chosen file in the drop zone (chip + state class). */
function reflectFile(drop: HTMLElement, chip: HTMLElement, input: HTMLInputElement): void {
  const file = input.files?.[0];
  drop.classList.toggle('has-file', Boolean(file));
  chip.textContent = file ? file.name : '';
}

/** Show the option controls that match the chosen destination. */
function reflectDestination(): void {
  const dest = selectedDest();
  show(zipField, dest === 'disk');
  show(paperFields, dest === 'paper');
  show(addBandLabel, dest === 'disk');
  show(bandFields, dest !== 'disk' || addBand.checked);
}

if (HAS_GOOGLE_PHOTOS) {
  show(el('dest-cloud-label'), true);
  show(el('cloud-note'), true);
  show(restorePhotosBtn, true);
}

async function loadPrefs(): Promise<void> {
  const prefs = await getPrefs();
  const destination =
    prefs.destination === 'cloud' && !HAS_GOOGLE_PHOTOS ? 'disk' : prefs.destination;
  setRadio('dest', destination);
  setRadio('keymode', prefs.keyMode);
  addBand.checked = prefs.addBand;
  bandTitle.value = prefs.title;
  asZip.checked = prefs.asZip;
  addInstructions.checked = prefs.includeInstructions;
  reflectDestination();
}

function setPill(state: 'none' | 'locked' | 'unlocked'): void {
  show(statePill, state !== 'none');
  statePill.textContent = state === 'unlocked' ? msg('pillUnlocked') : msg('pillLocked');
  statePill.classList.toggle('pill-ok', state === 'unlocked');
}

async function refreshState(): Promise<void> {
  const [hasKey, session] = await Promise.all([isKeySet(), getSession()]);
  show(noKeySection, !hasKey);
  show(lockedSection, hasKey && !session);
  show(saveSection, hasKey && session !== null);
  setPill(!hasKey ? 'none' : session ? 'unlocked' : 'locked');
}

// Settings open as a centered modal over the dimmed app (native <dialog>).
const settingsModal = el<HTMLDialogElement>('settings-modal');
function openSettings(): void {
  settingsModal.showModal();
}
el<HTMLButtonElement>('open-options').addEventListener('click', openSettings);
el<HTMLButtonElement>('settings-btn').addEventListener('click', openSettings);
el<HTMLButtonElement>('footer-options').addEventListener('click', openSettings);
el<HTMLButtonElement>('settings-close').addEventListener('click', () => settingsModal.close());
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.close();
});
settingsModal.addEventListener('close', () => void refreshState());
wireKeyManager(() => void refreshState());

unlockBtn.addEventListener('click', async () => {
  if (!unlockPw.value) return setStatus(unlockStatus, msg('errNoPassword'), true);
  unlockBtn.disabled = true;
  try {
    await unlock(unlockPw.value);
    unlockPw.value = '';
    setStatus(unlockStatus, '');
    await refreshState();
  } catch (err) {
    setStatus(unlockStatus, friendlyError(err), true);
  } finally {
    unlockBtn.disabled = false;
  }
});
unlockPw.addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') unlockBtn.click();
});

lockBtn.addEventListener('click', async () => {
  await lock();
  await refreshState();
});

addBand.addEventListener('change', () => {
  show(bandFields, addBand.checked);
  void savePrefs({ addBand: addBand.checked });
});
bandTitle.addEventListener('change', () => void savePrefs({ title: bandTitle.value }));
asZip.addEventListener('change', () => void savePrefs({ asZip: asZip.checked }));
addInstructions.addEventListener(
  'change',
  () => void savePrefs({ includeInstructions: addInstructions.checked }),
);

for (const radio of document.querySelectorAll('input[name="dest"]')) {
  radio.addEventListener('change', () => {
    reflectDestination();
    void savePrefs({ destination: selectedDest() });
    void updateEstimate();
  });
}
for (const radio of document.querySelectorAll('input[name="keymode"]')) {
  radio.addEventListener('change', () => {
    void savePrefs({ keyMode: selectedKeyMode() });
    void updateEstimate();
  });
}

async function updateEstimate(): Promise<void> {
  const file = saveFile.files?.[0];
  if (!file) {
    estimate.textContent = '—';
    return;
  }
  estimate.textContent = '…';
  try {
    const content = new Uint8Array(await file.arrayBuffer());
    const dest = selectedDest();
    const profile =
      dest === 'paper' ? PROFILE_PAPER : dest === 'cloud' ? PROFILE_CLOUD : PROFILE_DISK;
    const { images } = await estimateImages(file.name, content, {
      keyMode: selectedKeyMode(),
      profile,
    });
    estimate.textContent = String(images);
  } catch {
    estimate.textContent = '—';
  }
}

wireDropzone(fileDrop, saveFile, () => {
  reflectFile(fileDrop, dzFile, saveFile);
  show(saveResult, false);
  void updateEstimate();
});
wireDropzone(restoreDrop, restoreFiles, () => reflectFile(restoreDrop, restoreDzFile, restoreFiles));

saveBtn.addEventListener('click', async () => {
  const session = await getSession();
  if (!session) return setStatus(saveStatus, msg('errLocked'), true);
  const file = saveFile.files?.[0];
  if (!file) return setStatus(saveStatus, msg('errNoFile'), true);

  const keyMode = selectedKeyMode();
  const dest = selectedDest();
  const date = new Date().toISOString().slice(0, 10);
  const useLabel = addBand.checked;
  const title = useLabel ? bandTitle.value.trim() : '';

  saveBtn.disabled = true;
  show(saveResult, false);
  setStatus(saveStatus, msg('statusSaving'));
  try {
    let note: string;
    if (dest === 'cloud') {
      const { imageCount, albumTitle } = await saveToPhotos(file, session, {
        keyMode,
        title: title || undefined,
        date,
      });
      note = msg('statusSavedCloud', [String(imageCount), albumTitle]);
    } else if (dest === 'paper') {
      const { saveFileToPaper } = await import('./paper');
      const { imageCount } = await saveFileToPaper(file, session, {
        keyMode,
        title: title || undefined,
        date,
        includeInstructions: addInstructions.checked,
        passwordHint: pwHint.value.trim() || undefined,
        keyLocation: keyLocation.value.trim() || undefined,
      });
      note = msg('statusSavedPdf', String(imageCount));
    } else {
      const label = useLabel ? { title, date } : undefined;
      const { imageCount } = await saveFileToDisk(file, session, {
        keyMode,
        label,
        asZip: asZip.checked,
      });
      note = msg(keyMode === 'embedded' ? 'statusSaved' : 'statusSavedKeyfile', String(imageCount));
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
  if (files.length === 0) return setStatus(restoreStatus, msg('errNoImages'), true);
  if (!restorePw.value) return setStatus(restoreStatus, msg('errNoPassword'), true);

  restoreBtn.disabled = true;
  show(restoreResult, false);
  setStatus(restoreStatus, msg('statusRestoring'));
  try {
    const keyFile = restoreKey.files?.[0];
    const { filename } = await restoreFileFromDisk(files, restorePw.value, keyFile);
    setStatus(restoreStatus, '');
    restoreResultNote.textContent = msg('statusRestored', filename);
    show(restoreResult, true);
  } catch (err) {
    setStatus(restoreStatus, friendlyError(err), true);
  } finally {
    restoreBtn.disabled = false;
  }
});

// The Photos picker opens in a new tab, which would dismiss a popup and kill the
// flow — run the whole Photos restore in its own persistent tab.
restorePhotosBtn.addEventListener('click', () => {
  void browser.tabs.create({ url: browser.runtime.getURL('ui/photos.html') });
});

void loadPrefs();
void refreshState();

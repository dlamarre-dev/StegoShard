import browser from 'webextension-polyfill';
import { estimateImages, PROFILE_DISK, PROFILE_PAPER, type KeyMode } from '@core';
import { localizeDom } from './i18n';
import { el, friendlyError, msg, setStatus, show } from './dom';
import { getSession, isKeySet, lock, unlock } from './keystore';
import { type Destination, getPrefs, savePrefs } from './prefs';
import { restoreFileFromDisk, saveFileToDisk } from './disk';
import { saveFileToPaper } from './paper';

localizeDom();

const noKeySection = el('no-key');
const lockedSection = el('locked');
const saveSection = el('save');

const unlockPw = el<HTMLInputElement>('unlock-pw');
const unlockBtn = el<HTMLButtonElement>('unlock-btn');
const unlockStatus = el('unlock-status');

const saveFile = el<HTMLInputElement>('save-file');
const saveBtn = el<HTMLButtonElement>('save-btn');
const saveStatus = el('save-status');
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
const restoreKey = el<HTMLInputElement>('restore-key');
const restorePw = el<HTMLInputElement>('restore-pw');
const restoreBtn = el<HTMLButtonElement>('restore-btn');
const restoreStatus = el('restore-status');

function pick<T extends string>(name: string, fallback: T): T {
  const checked = document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
  return (checked?.value as T) ?? fallback;
}
const selectedKeyMode = () => pick<KeyMode>('keymode', 'embedded');
const selectedDest = () => pick<Destination>('dest', 'disk');

function setRadio(name: string, value: string): void {
  const radio = document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  if (radio) radio.checked = true;
}

/** Show the option controls that match the chosen destination. */
function reflectDestination(): void {
  const paper = selectedDest() === 'paper';
  show(zipField, !paper);
  show(paperFields, paper);
  // The "add readable label" toggle is disk-only; paper pages always have a
  // header, so the title field is always available there.
  show(addBandLabel, !paper);
  show(bandFields, paper || addBand.checked);
}

async function loadPrefs(): Promise<void> {
  const prefs = await getPrefs();
  setRadio('dest', prefs.destination);
  setRadio('keymode', prefs.keyMode);
  addBand.checked = prefs.addBand;
  bandTitle.value = prefs.title;
  asZip.checked = prefs.asZip;
  addInstructions.checked = prefs.includeInstructions;
  show(bandFields, prefs.addBand);
  reflectDestination();
}

async function refreshState(): Promise<void> {
  const [hasKey, session] = await Promise.all([isKeySet(), getSession()]);
  show(noKeySection, !hasKey);
  show(lockedSection, hasKey && !session);
  show(saveSection, hasKey && session !== null);
}

function openOptions(): void {
  void browser.runtime.openOptionsPage();
}
el<HTMLButtonElement>('open-options').addEventListener('click', openOptions);
el<HTMLButtonElement>('footer-options').addEventListener('click', openOptions);

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

saveFile.addEventListener('change', updateEstimate);

saveBtn.addEventListener('click', async () => {
  const session = await getSession();
  if (!session) return setStatus(saveStatus, msg('errLocked'), true);
  const file = saveFile.files?.[0];
  if (!file) return setStatus(saveStatus, msg('errNoFile'), true);

  const keyMode = selectedKeyMode();
  const dest = selectedDest();
  const date = new Date().toISOString().slice(0, 10);
  const title = bandTitle.value.trim();

  saveBtn.disabled = true;
  setStatus(saveStatus, msg('statusSaving'));
  try {
    if (dest === 'paper') {
      const { imageCount } = await saveFileToPaper(file, session, {
        keyMode,
        title: title || undefined,
        date,
        includeInstructions: addInstructions.checked,
        passwordHint: pwHint.value.trim() || undefined,
        keyLocation: keyLocation.value.trim() || undefined,
      });
      setStatus(saveStatus, msg('statusSavedPdf', String(imageCount)));
    } else {
      const label = addBand.checked ? { title, date } : undefined;
      const { imageCount } = await saveFileToDisk(file, session, {
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
    const keyFile = restoreKey.files?.[0];
    const { filename } = await restoreFileFromDisk(files, restorePw.value, keyFile);
    setStatus(restoreStatus, msg('statusRestored', filename));
  } catch (err) {
    setStatus(restoreStatus, friendlyError(err), true);
  } finally {
    restoreBtn.disabled = false;
  }
});

void loadPrefs();
void refreshState();

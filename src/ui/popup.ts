import browser from 'webextension-polyfill';
import { estimateImages, type KeyMode } from '@core';
import { localizeDom } from './i18n';
import { el, friendlyError, msg, setStatus, show } from './dom';
import { currentSession, isKeySet, lock, unlock } from './keystore';
import { restoreFileFromDisk, saveFileToDisk } from './disk';

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
const bandFields = el('band-fields');
const bandTitle = el<HTMLInputElement>('band-title');

const restoreFiles = el<HTMLInputElement>('restore-files');
const restoreKey = el<HTMLInputElement>('restore-key');
const restorePw = el<HTMLInputElement>('restore-pw');
const restoreBtn = el<HTMLButtonElement>('restore-btn');
const restoreStatus = el('restore-status');

function selectedKeyMode(): KeyMode {
  const checked = document.querySelector<HTMLInputElement>('input[name="keymode"]:checked');
  return (checked?.value as KeyMode) ?? 'embedded';
}

/** Reflect the current key/session state in which section is visible. */
async function refreshState(): Promise<void> {
  const hasKey = await isKeySet();
  const unlocked = currentSession() !== null;
  show(noKeySection, !hasKey);
  show(lockedSection, hasKey && !unlocked);
  show(saveSection, hasKey && unlocked);
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
  lock();
  await refreshState();
});

addBand.addEventListener('change', () => show(bandFields, addBand.checked));

async function updateEstimate(): Promise<void> {
  const file = saveFile.files?.[0];
  if (!file) {
    estimate.textContent = '—';
    return;
  }
  estimate.textContent = '…';
  try {
    const content = new Uint8Array(await file.arrayBuffer());
    const { images } = await estimateImages(file.name, content, { keyMode: selectedKeyMode() });
    estimate.textContent = String(images);
  } catch {
    estimate.textContent = '—';
  }
}

saveFile.addEventListener('change', updateEstimate);
for (const radio of document.querySelectorAll('input[name="keymode"]')) {
  radio.addEventListener('change', updateEstimate);
}

saveBtn.addEventListener('click', async () => {
  const session = currentSession();
  if (!session) return setStatus(saveStatus, msg('errLocked'), true);
  const file = saveFile.files?.[0];
  if (!file) return setStatus(saveStatus, msg('errNoFile'), true);

  const keyMode = selectedKeyMode();
  const label = addBand.checked
    ? { title: bandTitle.value.trim(), date: new Date().toISOString().slice(0, 10) }
    : undefined;

  saveBtn.disabled = true;
  setStatus(saveStatus, msg('statusSaving'));
  try {
    const { imageCount } = await saveFileToDisk(file, session, { keyMode, label });
    const key = keyMode === 'embedded' ? 'statusSaved' : 'statusSavedKeyfile';
    setStatus(saveStatus, msg(key, String(imageCount)));
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

void refreshState();

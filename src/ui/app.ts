import browser from 'webextension-polyfill';
import { WARN_FILE_BYTES, type KeyMode } from '@core';
import { type Estimates, computeEstimates, formatSize } from './estimate';
import { localizeDom } from './i18n';
import { el, friendlyError, msg, pick, reflectFiles, setStatus, show, wireDropzone } from './dom';
import { getSession, isKeySet, lock, unlock } from './keystore';
import { type Destination, getPrefs, savePrefs, type Workflow } from './prefs';
import { HAS_GOOGLE_PHOTOS } from './config';
import { wireKeyManager } from './keymanager';
import {
  recoveryGuidance,
  runSave,
  verifyStegoPassword,
  type SaveRequest,
  type StegoInput,
} from './save-controller';
import { runRestore, type RestoreMode } from './restore-controller';
import { createWizard, type Wizard, type WizardEnv } from './wizard';

localizeDom();

const noKeySection = el('no-key');
const lockedSection = el('locked');
const saveSection = el('save');
const statePill = el('state-pill');

const chooserSection = el('chooser');
const expertView = el('expert-view');
const wizardRoot = el('wizard-root');
const workflowsBtn = el<HTMLButtonElement>('workflows-btn');

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
const saveSize = el('save-size');
const noFormat = el('no-format');
const lockBtn = el<HTMLButtonElement>('lock-btn');
const addBand = el<HTMLInputElement>('add-band');
const addBandLabel = el('add-band-label');
const bandFields = el('band-fields');
const bandTitle = el<HTMLInputElement>('band-title');
const asZip = el<HTMLInputElement>('as-zip');
const zipField = el('zip-field');
const sizeWarn = el('size-warn');
const paperFields = el('paper-fields');
const addInstructions = el<HTMLInputElement>('add-instructions');
const pwHint = el<HTMLInputElement>('pw-hint');
const keyLocation = el<HTMLInputElement>('key-location');
const stegoFields = el('stego-fields');
const coverDrop = el('cover-drop');
const coverFile = el<HTMLInputElement>('cover-file');
const coverDzFile = el('cover-dz-file');
const stegoPw = el<HTMLInputElement>('stego-pw');
const estimateLine = el('estimate-line');
const keymodeFields = el('keymode-fields');
const galleryFields = el('gallery-fields');
const galleryCovers = el<HTMLInputElement>('gallery-covers');
const galleryCoversDrop = el('gallery-covers-drop');
const galleryCoversName = el('gallery-covers-name');
const gallerySavePw = el<HTMLInputElement>('gallery-save-pw');
const galleryStegoFields = el('gallery-stego-fields');
const galleryCover = el<HTMLInputElement>('gallery-cover');
const galleryCoverDrop = el('gallery-cover-drop');
const galleryCoverName = el('gallery-cover-name');

const restoreFiles = el<HTMLInputElement>('restore-files');
const restoreDrop = el('restore-drop');
const restoreDzFile = el('restore-dz-file');
const restoreKey = el<HTMLInputElement>('restore-key');
const keyDrop = el('key-drop');
const keyDzFile = el('key-dz-file');
const restorePw = el<HTMLInputElement>('restore-pw');
const restoreBtn = el<HTMLButtonElement>('restore-btn');
const restorePhotosBtn = el<HTMLButtonElement>('restore-photos-btn');
const restoreStatus = el('restore-status');
const restoreResult = el('restore-result');
const restoreResultNote = el('restore-result-note');
const restoreAdvanced = el('restore-advanced');
const restoreGalleryHint = el('restore-gallery-hint');

const selectedKeyMode = () => pick<KeyMode>('keymode', 'embedded');
const selectedGalleryKeyMode = () => pick<KeyMode>('gallery-keymode', 'embedded');
const selectedDest = () => pick<Destination>('dest', 'disk');
const selectedRestoreMode = () => pick<RestoreMode>('restore-mode', 'standard');

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
  // Gallery has its own key mode + password and produces innocuous photos; the
  // label band, zip and image estimate don't apply to it (nor to binary/sqlite).
  const gallery = dest === 'gallery';
  show(galleryFields, gallery);
  show(keymodeFields, !gallery);
  show(estimateLine, !gallery);
  show(zipField, dest === 'disk');
  show(paperFields, dest === 'paper');
  // A label band is only drawn onto images.
  show(addBandLabel, dest === 'disk');
  show(bandFields, dest === 'paper' || dest === 'cloud' || (dest === 'disk' && addBand.checked));
  reflectKeyMode();
  reflectGalleryKeyMode();
}

/** Show the cover-image + password inputs only for the stego key mode. */
function reflectKeyMode(): void {
  show(stegoFields, selectedDest() !== 'gallery' && selectedKeyMode() === 'stego');
}

/** Gallery has its own key mode; show its stego cover picker only for stego. */
function reflectGalleryKeyMode(): void {
  show(galleryStegoFields, selectedDest() === 'gallery' && selectedGalleryKeyMode() === 'stego');
}

/** Both modes can take a key: standard vaults, and keyfile/stego galleries. */
function reflectRestoreMode(): void {
  const gallery = selectedRestoreMode() === 'gallery';
  show(restoreGalleryHint, gallery);
  show(restoreAdvanced, true);
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
  // Highlight the workflow the user last chose as the recommended one.
  show(el('rec-guided'), prefs.workflow === 'guided');
  show(el('rec-expert'), prefs.workflow === 'expert');
  reflectDestination();
  reflectKeyMode();
}

function setPill(state: 'none' | 'locked' | 'unlocked'): void {
  show(statePill, state !== 'none');
  statePill.textContent = state === 'unlocked' ? msg('pillUnlocked') : msg('pillLocked');
  statePill.classList.toggle('pill-ok', state === 'unlocked');
}

// Which workflow view is active once the vault is unlocked.
let view: Workflow | 'chooser' = 'chooser';
let wizard: Wizard | null = null;

const wizardEnv: WizardEnv = {
  msg,
  locale: () => browser.i18n.getUILanguage(),
  saveDestinations: HAS_GOOGLE_PHOTOS
    ? ['disk', 'paper', 'binary', 'sqlite', 'cloud', 'gallery']
    : ['disk', 'paper', 'binary', 'sqlite', 'gallery'],
  getSaveKey: async () => {
    const s = await getSession();
    if (!s) throw new Error(msg('errLocked'));
    return s;
  },
  needsSavePassword: false,
  verifyStegoPassword: async (pw) => {
    const s = await getSession();
    return s ? verifyStegoPassword(s.keyBlock, pw) : false;
  },
  onExit: () => enterChooser(),
};

function enterGuided(): void {
  if (!wizard) wizard = createWizard(wizardRoot, wizardEnv);
  else wizard.reset();
  view = 'guided';
  void savePrefs({ workflow: 'guided' });
  void refreshState();
}
function enterExpert(): void {
  view = 'expert';
  void savePrefs({ workflow: 'expert' });
  void refreshState();
}
function enterChooser(): void {
  view = 'chooser';
  void refreshState();
}

async function refreshState(): Promise<void> {
  const [hasKey, session] = await Promise.all([isKeySet(), getSession()]);
  const unlocked = hasKey && session !== null;
  show(noKeySection, !hasKey);
  show(lockedSection, hasKey && !session);
  show(chooserSection, unlocked && view === 'chooser');
  show(expertView, unlocked && view === 'expert');
  show(saveSection, unlocked);
  show(wizardRoot, unlocked && view === 'guided');
  show(workflowsBtn, unlocked && view !== 'chooser');
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

el<HTMLButtonElement>('choose-guided').addEventListener('click', enterGuided);
el<HTMLButtonElement>('choose-expert').addEventListener('click', enterExpert);
workflowsBtn.addEventListener('click', enterChooser);

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
    renderEstimate();
  });
}
for (const radio of document.querySelectorAll('input[name="keymode"]')) {
  radio.addEventListener('change', () => {
    reflectKeyMode();
    void savePrefs({ keyMode: selectedKeyMode() });
    renderEstimate();
  });
}
for (const radio of document.querySelectorAll('input[name="gallery-keymode"]')) {
  radio.addEventListener('change', reflectGalleryKeyMode);
}

// Cached per-file availability, so switching destination/key mode doesn't recompress.
let estimates: Estimates | null = null;

/** Destination radios that are actually visible (cloud is hidden without Google Photos). */
function destRadios(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[name="dest"]')).filter(
    (r) => !r.closest('label')?.hidden,
  );
}

/** Recompute availability for the dropped file, grey unavailable destinations, and render. */
async function refreshEstimates(): Promise<void> {
  const file = saveFile.files?.[0] ?? null;
  if (!file) {
    estimates = null;
    for (const r of destRadios()) r.disabled = false;
    renderEstimate();
    return;
  }
  const dests = destRadios().map((r) => r.value as Destination);
  let est: Estimates;
  try {
    est = await computeEstimates(file, dests, msg);
  } catch {
    return; // couldn't read the file — leave destinations enabled, no estimate
  }
  if (saveFile.files?.[0] !== file) return; // a newer file superseded this
  estimates = est;
  for (const r of destRadios()) r.disabled = !est[r.value as Destination]?.available;
  // If the chosen destination no longer fits, move to the first that does.
  if (!est[selectedDest()]?.available) {
    const ok = dests.find((d) => est[d]?.available);
    if (ok) {
      setRadio('dest', ok);
      reflectDestination();
    }
  }
  renderEstimate();
}

/** Render the size line, the estimate/no-format line, and the image-count warning. */
function renderEstimate(): void {
  const file = saveFile.files?.[0];
  saveSize.textContent = file ? formatSize(file.size) : '—';
  const anyOk = !estimates || destRadios().some((r) => estimates![r.value as Destination]?.available);
  show(noFormat, Boolean(file) && !anyOk);
  if (file && !anyOk) noFormat.textContent = msg('wizNoFormat');
  // When nothing fits, the no-format error stands in for the estimate line.
  show(estimateLine, selectedDest() !== 'gallery' && anyOk);

  const dest = selectedDest();
  if (!file || dest === 'gallery' || !anyOk) {
    estimate.textContent = '—';
    show(sizeWarn, false);
    return;
  }
  const e = estimates?.[dest];
  estimate.textContent = e?.available ? String(e.count) : '—';
  // Large secrets sprawl into many images; nudge toward the binary option.
  const imageDest = dest === 'disk' || dest === 'paper' || dest === 'cloud';
  if (imageDest && e?.available && file.size > WARN_FILE_BYTES) {
    sizeWarn.textContent = msg('sizeWarnImages', [String(Math.round(file.size / 1024)), String(e.count)]);
    show(sizeWarn, true);
  } else {
    show(sizeWarn, false);
  }
}

wireDropzone(fileDrop, saveFile, () => {
  reflectFile(fileDrop, dzFile, saveFile);
  show(saveResult, false);
  void refreshEstimates();
});
wireDropzone(restoreDrop, restoreFiles, () =>
  reflectFile(restoreDrop, restoreDzFile, restoreFiles),
);
wireDropzone(coverDrop, coverFile, () => reflectFile(coverDrop, coverDzFile, coverFile));
wireDropzone(keyDrop, restoreKey, () => reflectFile(keyDrop, keyDzFile, restoreKey));
wireDropzone(galleryCoversDrop, galleryCovers, () =>
  reflectFiles(galleryCoversDrop, galleryCoversName, galleryCovers),
);
wireDropzone(galleryCoverDrop, galleryCover, () =>
  reflectFile(galleryCoverDrop, galleryCoverName, galleryCover),
);

for (const radio of document.querySelectorAll('input[name="restore-mode"]')) {
  radio.addEventListener('change', reflectRestoreMode);
}
reflectRestoreMode();

/** Run a prepared save request through the shared controller, driving the UI. */
/** Populate the expert save-result recovery checklist ("what to keep to restore"). */
function renderRecovery(guidance: { items: string[]; lossless: boolean }): void {
  const box = el('save-recovery');
  box.replaceChildren();
  const heading = document.createElement('p');
  heading.className = 'result-recovery-heading';
  heading.textContent = msg('recoveryHeading');
  const list = document.createElement('ul');
  list.className = 'recovery-list';
  for (const key of guidance.items) {
    const li = document.createElement('li');
    li.textContent = msg(key);
    list.append(li);
  }
  box.append(heading, list);
  if (guidance.lossless) {
    const warn = document.createElement('p');
    warn.className = 'muted warn';
    warn.textContent = msg('recoveryLossless');
    box.append(warn);
  }
}

async function doSave(req: SaveRequest): Promise<void> {
  saveBtn.disabled = true;
  show(saveResult, false);
  setStatus(saveStatus, msg('statusSaving'));
  try {
    const { note } = await runSave(req, msg);
    setStatus(saveStatus, '');
    saveResultNote.textContent = note;
    renderRecovery(recoveryGuidance(req.dest, req.keyMode ?? 'embedded'));
    show(saveResult, true);
    // Don't leave secrets sitting in the popup's DOM after the operation.
    stegoPw.value = '';
    gallerySavePw.value = '';
  } catch (err) {
    setStatus(saveStatus, friendlyError(err), true);
  } finally {
    saveBtn.disabled = false;
  }
}

saveBtn.addEventListener('click', async () => {
  const dest = selectedDest();
  const file = saveFile.files?.[0];
  if (!file) return setStatus(saveStatus, msg('errNoFile'), true);

  // Gallery is self-contained: its own password seeds its key, so it needs
  // neither the managed session key nor the other destination options.
  if (dest === 'gallery') {
    const covers = galleryCovers.files ? Array.from(galleryCovers.files) : [];
    if (covers.length === 0) return setStatus(saveStatus, msg('errNoCovers'), true);
    if (!gallerySavePw.value) return setStatus(saveStatus, msg('errNoPassword'), true);
    const gKeyMode = selectedGalleryKeyMode();
    let gStego: StegoInput | undefined;
    if (gKeyMode === 'stego') {
      const cover = galleryCover.files?.[0];
      if (!cover) return setStatus(saveStatus, msg('errNoCover'), true);
      // The gallery stego cover is keyed by the gallery password (not the managed key).
      gStego = { cover, password: gallerySavePw.value };
    }
    await doSave({
      dest,
      file,
      covers,
      galleryPassword: gallerySavePw.value,
      keyMode: gKeyMode,
      stego: gStego,
    });
    return;
  }

  const session = await getSession();
  if (!session) return setStatus(saveStatus, msg('errLocked'), true);
  const keyMode = selectedKeyMode();
  const date = new Date().toISOString().slice(0, 10);
  const useLabel = addBand.checked;
  const title = useLabel ? bandTitle.value.trim() : '';

  // Stego hides the *managed* key block in a cover photo. It must be keyed by the
  // vault password (the same one that unwraps the block), so restore — which uses
  // one password for both the stego extraction and the unwrap — works.
  let stego: StegoInput | undefined;
  if (keyMode === 'stego') {
    if (dest === 'cloud') return setStatus(saveStatus, msg('errStegoCloud'), true);
    const cover = coverFile.files?.[0];
    if (!cover) return setStatus(saveStatus, msg('errNoCover'), true);
    if (!stegoPw.value) return setStatus(saveStatus, msg('errNoPassword'), true);
    try {
      if (!(await verifyStegoPassword(session.keyBlock, stegoPw.value))) {
        return setStatus(saveStatus, msg('errWrongPassword'), true);
      }
    } catch (err) {
      return setStatus(saveStatus, friendlyError(err), true);
    }
    stego = { cover, password: stegoPw.value };
  }

  await doSave({
    dest,
    file,
    key: session,
    keyMode,
    label: useLabel ? { title, date } : undefined,
    asZip: asZip.checked,
    includeInstructions: addInstructions.checked,
    passwordHint: pwHint.value.trim() || undefined,
    keyLocation: keyLocation.value.trim() || undefined,
    stego,
    locale: browser.i18n.getUILanguage(),
  });
});

restoreBtn.addEventListener('click', async () => {
  const files = restoreFiles.files ? Array.from(restoreFiles.files) : [];
  if (files.length === 0) return setStatus(restoreStatus, msg('errNoImages'), true);
  if (!restorePw.value) return setStatus(restoreStatus, msg('errNoPassword'), true);

  restoreBtn.disabled = true;
  show(restoreResult, false);
  setStatus(restoreStatus, msg('statusRestoring'));
  try {
    const { note } = await runRestore(
      {
        mode: selectedRestoreMode(),
        files,
        password: restorePw.value,
        keyFile: restoreKey.files?.[0],
      },
      msg,
    );
    setStatus(restoreStatus, '');
    restoreResultNote.textContent = note;
    show(restoreResult, true);
    restorePw.value = ''; // clear the secret from the DOM after use
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

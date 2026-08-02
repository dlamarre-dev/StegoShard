/**
 * Web app entry — a standalone, install-free version of StegoShard's offline
 * core (Disk + Paper + Gallery). It reuses the exact same core, codec, and
 * disk/paper flows as the extension via the shared save/restore controllers; it
 * just generates a fresh vault key per save (the wrapped key travels with the
 * images or as a .key file) instead of a managed key store. Everything runs
 * locally in the browser; nothing is uploaded.
 */

import { createKeyBlock, serializeKeyBlock, type KeyMode, type VaultKey } from '@core';
import { el, pick, reflectFiles, setStatus, show, wireDropzone } from '../ui/domhelpers';
import { type Estimates, computeEstimates, formatSize } from '../ui/estimate';
import { runSave, type AccessMode, type SaveRequest, type StegoInput } from '../ui/save-controller';
import { runRestore, type RestoreMode } from '../ui/restore-controller';
import { makeProgressUI } from '../ui/progress-ui';
import { createWizard, type Wizard, type WizardEnv } from '../ui/wizard';
import { currentLocale, localizeDom, msg, friendlyError, wireLanguageSelect } from './i18n';
import { capturedCount, capturedPayloads, clearCaptured, wireCamera } from './camera';

localizeDom();
wireLanguageSelect(el<HTMLSelectElement>('lang-select'), () => {
  // localizeDom only retranslates static [data-i18n] nodes. Status lines and
  // result panels were filled at action time with the then-current language;
  // clear them so no stale wrong-language text lingers after a switch (the next
  // save/restore re-renders them in the new language). Dynamic labels that
  // should persist (the camera capture count) are re-rendered explicitly.
  setStatus(saveStatus, '');
  setStatus(restoreStatus, '');
  show(saveResult, false);
  show(restoreResult, false);
  reflectCaptured(capturedCount());
  // The wizard renders its labels at navigation time; rebuild it in the new language.
  if (view === 'guided') wizard?.reset();
});

type Dest = 'disk' | 'paper' | 'binary' | 'sqlite' | 'gallery';

const saveFile = el<HTMLInputElement>('save-file');
const fileDrop = el('file-drop');
const dzFile = el('dz-file');
const savePw = el<HTMLInputElement>('save-pw');
const estimate = el('estimate');
const estimateLine = el('estimate-line');
const saveSize = el('save-size');
const noFormat = el('no-format');
const keymodeFields = el('keymode-fields');
const stegoFields = el('stego-fields');
const coverDrop = el('cover-drop');
const coverFile = el<HTMLInputElement>('cover-file');
const coverDzFile = el('cover-dz-file');
const galleryFields = el('gallery-fields');
const galleryCovers = el<HTMLInputElement>('gallery-covers');
const galleryCoversDrop = el('gallery-covers-drop');
const galleryCoversName = el('gallery-covers-name');
const galleryStegoFields = el('gallery-stego-fields');
const galleryCover = el<HTMLInputElement>('gallery-cover');
const galleryCoverDrop = el('gallery-cover-drop');
const galleryCoverName = el('gallery-cover-name');
const modeFields = el('mode-fields');
const modeDuressLabel = el('mode-duress-label');
const duressFields = el('duress-fields');
const duressPw = el<HTMLInputElement>('duress-pw');
const decoyDrop = el('decoy-drop');
const decoyName = el('decoy-name');
const decoyFile = el<HTMLInputElement>('decoy-file');
const thresholdFields = el('threshold-fields');
const thresholdK = el<HTMLInputElement>('threshold-k');
const thresholdN = el<HTMLInputElement>('threshold-n');
const factorDuressHint = el('factor-duress-hint');
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
const saveBtn = el<HTMLButtonElement>('save-btn');
const saveStatus = el('save-status');
const saveProgress = el('save-progress');
const saveProgressBar = el('save-progress-bar');
const saveResult = el('save-result');
const saveResultNote = el('save-result-note');

const restoreFiles = el<HTMLInputElement>('restore-files');
const restoreDrop = el('restore-drop');
const restoreDzFile = el('restore-dz-file');
const restoreKey = el<HTMLInputElement>('restore-key');
const keyDrop = el('key-drop');
const keyDzFile = el('key-dz-file');
const restoreShares = el<HTMLInputElement>('restore-shares');
const sharesDrop = el('shares-drop');
const sharesDzFile = el('shares-dz-file');
const cameraCaptured = el('camera-captured');
const restorePw = el<HTMLInputElement>('restore-pw');
const restoreBtn = el<HTMLButtonElement>('restore-btn');
const restoreStatus = el('restore-status');
const restoreProgress = el('restore-progress');
const restoreProgressBar = el('restore-progress-bar');
const restoreResult = el('restore-result');
const restoreResultNote = el('restore-result-note');
const restoreAdvanced = el('restore-advanced');
const restoreGalleryHint = el('restore-gallery-hint');

const selectedDest = () => pick<Dest>('dest', 'disk');
const selectedKeyMode = () => pick<KeyMode>('keymode', 'embedded');
const selectedGalleryKeyMode = () => pick<KeyMode>('gallery-keymode', 'embedded');
const selectedRestoreMode = () => pick<RestoreMode>('restore-mode', 'standard');
const selectedAccessMode = () => pick<AccessMode>('accessmode', 'plain');

/** Read + validate the k-of-n threshold; null if either field is out of range. */
function readThreshold(): { k: number; n: number } | undefined {
  const k = Number(thresholdK.value);
  const n = Number(thresholdN.value);
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 1 || n < 1 || k > n || n > 255) {
    return undefined;
  }
  return { k, n };
}

function reflectFile(drop: HTMLElement, chip: HTMLElement, input: HTMLInputElement): void {
  const file = input.files?.[0];
  drop.classList.toggle('has-file', Boolean(file));
  chip.textContent = file ? file.name : '';
}

function reflectDestination(): void {
  const dest = selectedDest();
  const gallery = dest === 'gallery';
  // Gallery has its own key mode + password; the band/zip/estimate don't apply
  // to it (nor to binary/sqlite, which are single opaque files).
  show(galleryFields, gallery);
  // The .db path offers key-mode delivery (embedded / keyfile / stego) in every
  // access mode — the factor is an extra layer on top of the mode (§10.3).
  show(keymodeFields, !gallery);
  show(estimateLine, !gallery);
  show(zipField, dest === 'disk');
  show(addBandLabel, dest === 'disk');
  show(bandFields, dest === 'paper' || (dest === 'disk' && addBand.checked));
  show(paperFields, dest === 'paper');
  // §10 access modes live on the deniable paths only (gallery + .db). Duress is
  // .db-only (gallery's winnowing key is password-derived), so hide that radio
  // for gallery and snap a stale duress selection back to plain.
  const modeCapable = gallery || dest === 'sqlite';
  show(modeFields, modeCapable);
  show(modeDuressLabel, dest === 'sqlite');
  if (!modeCapable || (gallery && selectedAccessMode() === 'duress')) {
    const plain = document.querySelector<HTMLInputElement>(
      'input[name="accessmode"][value="plain"]',
    );
    if (plain) plain.checked = true;
  }
  reflectAccessMode();
  reflectKeyMode();
  reflectGalleryKeyMode();
}

/** Reveal the duress / threshold inputs for the selected access mode. */
function reflectAccessMode(): void {
  const mode = selectedAccessMode();
  show(duressFields, mode === 'duress');
  show(thresholdFields, mode === 'nonpossession');
}

// Cached per-file availability, so switching destination doesn't recompress.
let estimates: Estimates | null = null;

const destRadios = (): HTMLInputElement[] =>
  Array.from(document.querySelectorAll<HTMLInputElement>('input[name="dest"]'));

/** Recompute availability for the dropped file, grey unavailable destinations, and render. */
async function refreshEstimates(): Promise<void> {
  const file = saveFile.files?.[0] ?? null;
  if (!file) {
    estimates = null;
    for (const r of destRadios()) r.disabled = false;
    renderEstimate();
    return;
  }
  const dests = destRadios().map((r) => r.value as Dest);
  let est: Estimates;
  try {
    est = await computeEstimates(file, dests, msg);
  } catch {
    return; // couldn't read the file — leave destinations enabled, no estimate
  }
  if (saveFile.files?.[0] !== file) return; // a newer file superseded this
  estimates = est;
  for (const r of destRadios()) r.disabled = !est[r.value as Dest]?.available;
  if (!est[selectedDest()]?.available) {
    const ok = dests.find((d) => est[d]?.available);
    if (ok) {
      const radio = document.querySelector<HTMLInputElement>(`input[name="dest"][value="${ok}"]`);
      if (radio) radio.checked = true;
      reflectDestination();
    }
  }
  renderEstimate();
}

/** Render the size line and the estimate / no-format line. */
function renderEstimate(): void {
  const file = saveFile.files?.[0];
  saveSize.textContent = file ? formatSize(file.size) : '—';
  const anyOk = !estimates || destRadios().some((r) => estimates![r.value as Dest]?.available);
  show(noFormat, Boolean(file) && !anyOk);
  if (file && !anyOk) noFormat.textContent = msg('wizNoFormat');
  // When nothing fits, the no-format error stands in for the estimate line.
  show(estimateLine, selectedDest() !== 'gallery' && anyOk);
  const dest = selectedDest();
  if (!file || dest === 'gallery' || !anyOk) return void (estimate.textContent = '—');
  const e = estimates?.[dest];
  estimate.textContent = e?.available ? String(e.count) : '—';
}

function reflectKeyMode(): void {
  const dest = selectedDest();
  show(stegoFields, dest !== 'gallery' && selectedKeyMode() === 'stego');
  // A duress .db with a key-file/stego factor: that factor protects the REAL file
  // only — the decoy still opens on the duress password alone.
  show(
    factorDuressHint,
    dest === 'sqlite' && selectedAccessMode() === 'duress' && selectedKeyMode() !== 'embedded',
  );
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

addBand.addEventListener('change', () => show(bandFields, addBand.checked));
for (const r of document.querySelectorAll('input[name="dest"]')) {
  r.addEventListener('change', () => {
    reflectDestination();
    renderEstimate();
  });
}
for (const r of document.querySelectorAll('input[name="keymode"]')) {
  r.addEventListener('change', () => {
    reflectKeyMode();
    renderEstimate();
  });
}
for (const r of document.querySelectorAll('input[name="gallery-keymode"]')) {
  r.addEventListener('change', reflectGalleryKeyMode);
}
for (const r of document.querySelectorAll('input[name="accessmode"]')) {
  // On .db, key-mode availability depends on the access mode; recompute the view.
  r.addEventListener('change', reflectDestination);
}
for (const r of document.querySelectorAll('input[name="restore-mode"]')) {
  r.addEventListener('change', reflectRestoreMode);
}

wireDropzone(fileDrop, saveFile, () => {
  reflectFile(fileDrop, dzFile, saveFile);
  show(saveResult, false);
  void refreshEstimates();
});
wireDropzone(coverDrop, coverFile, () => reflectFile(coverDrop, coverDzFile, coverFile));
wireDropzone(galleryCoversDrop, galleryCovers, () =>
  reflectFiles(galleryCoversDrop, galleryCoversName, galleryCovers),
);
wireDropzone(galleryCoverDrop, galleryCover, () =>
  reflectFile(galleryCoverDrop, galleryCoverName, galleryCover),
);
wireDropzone(decoyDrop, decoyFile, () => reflectFile(decoyDrop, decoyName, decoyFile));
wireDropzone(restoreDrop, restoreFiles, () =>
  reflectFile(restoreDrop, restoreDzFile, restoreFiles),
);
wireDropzone(keyDrop, restoreKey, () => reflectFile(keyDrop, keyDzFile, restoreKey));
wireDropzone(sharesDrop, restoreShares, () =>
  reflectFiles(sharesDrop, sharesDzFile, restoreShares),
);

// Subscribers notified whenever the capture count changes (e.g. the wizard).
const cameraCountSubs: ((count: number) => void)[] = [];
function reflectCaptured(count: number): void {
  show(cameraCaptured, count > 0);
  cameraCaptured.textContent = count > 0 ? msg('cameraCount', String(count)) : '';
  for (const sub of cameraCountSubs) sub(count);
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

/** Build a save request (creating a fresh key inside the try) and run it. */
async function doSave(build: () => Promise<SaveRequest>): Promise<void> {
  saveBtn.disabled = true;
  show(saveResult, false);
  const prog = makeProgressUI(saveProgress, saveProgressBar, saveStatus, msg);
  setStatus(saveStatus, msg('statusSaving'));
  try {
    const req = await build();
    req.onProgress = prog.onProgress;
    const { note } = await runSave(req, msg);
    setStatus(saveStatus, '');
    saveResultNote.textContent = note;
    show(saveResult, true);
    savePw.value = ''; // don't leave the secret in the field after use
    duressPw.value = '';
  } catch (err) {
    setStatus(saveStatus, friendlyError(err), true);
  } finally {
    prog.done();
    saveBtn.disabled = false;
  }
}

saveBtn.addEventListener('click', async () => {
  const dest = selectedDest();
  const file = saveFile.files?.[0];
  if (!file) return setStatus(saveStatus, msg('errNoFile'), true);
  if (!savePw.value) return setStatus(saveStatus, msg('errNoPassword'), true);

  if (dest === 'gallery') {
    const covers = galleryCovers.files ? Array.from(galleryCovers.files) : [];
    if (covers.length === 0) return setStatus(saveStatus, msg('errNoCovers'), true);
    const gKeyMode = selectedGalleryKeyMode();
    let gStego: StegoInput | undefined;
    if (gKeyMode === 'stego') {
      const cover = galleryCover.files?.[0];
      if (!cover) return setStatus(saveStatus, msg('errNoCover'), true);
      gStego = { cover, password: savePw.value };
    }
    // Gallery supports plain + non-possession (duress is snapped to plain by the
    // destination guard, so it never reaches here).
    const gMode = selectedAccessMode();
    let gThreshold: { k: number; n: number } | undefined;
    if (gMode === 'nonpossession') {
      const t = readThreshold();
      if (!t) return setStatus(saveStatus, msg('errNoThreshold'), true);
      gThreshold = t;
    }
    await doSave(async () => ({
      dest,
      file,
      covers,
      galleryPassword: savePw.value,
      keyMode: gKeyMode,
      stego: gStego,
      accessMode: gMode === 'duress' ? 'plain' : gMode,
      threshold: gThreshold,
    }));
    return;
  }

  // §10 access mode for the disguised .db path (other dests stay plain).
  const accessMode = dest === 'sqlite' ? selectedAccessMode() : 'plain';
  let duressPassword: string | undefined;
  let decoy: File | undefined;
  let threshold: { k: number; n: number } | undefined;
  if (accessMode === 'duress') {
    const d = decoyFile.files?.[0];
    if (!duressPw.value || !d) return setStatus(saveStatus, msg('errDuressInputs'), true);
    duressPassword = duressPw.value;
    decoy = d;
  } else if (accessMode === 'nonpossession') {
    const t = readThreshold();
    if (!t) return setStatus(saveStatus, msg('errNoThreshold'), true);
    threshold = t;
  }

  // key-file / stego delivery composes with every .db access mode (§10.3).
  const keyMode = selectedKeyMode();
  const cover = coverFile.files?.[0];
  if (keyMode === 'stego' && !cover) return setStatus(saveStatus, msg('errNoCover'), true);
  // On the web the vault key is minted from the save password, so the stego
  // password is that same password (also the .db per-save password on that path).
  const stego: StegoInput | undefined =
    keyMode === 'stego' && cover ? { cover, password: savePw.value } : undefined;
  const date = new Date().toISOString().slice(0, 10);
  const useLabel = addBand.checked;
  const title = useLabel ? bandTitle.value.trim() : '';

  await doSave(async () => ({
    dest,
    file,
    key: await makeKey(savePw.value),
    // The disguised .db path derives its slot KEK from the per-save password.
    password: dest === 'sqlite' ? savePw.value : undefined,
    keyMode,
    accessMode,
    duressPassword,
    decoy,
    threshold,
    label: useLabel ? { title, date } : undefined,
    asZip: asZip.checked,
    includeInstructions: addInstructions.checked,
    passwordHint: pwHint.value.trim() || undefined,
    keyLocation: keyLocation.value.trim() || undefined,
    stego,
    locale: currentLocale(),
  }));
});

restoreBtn.addEventListener('click', async () => {
  const files = restoreFiles.files ? Array.from(restoreFiles.files) : [];
  if (files.length === 0 && capturedCount() === 0) {
    return setStatus(restoreStatus, msg('errNoImages'), true);
  }
  if (!restorePw.value) return setStatus(restoreStatus, msg('errNoPassword'), true);

  restoreBtn.disabled = true;
  show(restoreResult, false);
  const prog = makeProgressUI(restoreProgress, restoreProgressBar, restoreStatus, msg);
  setStatus(restoreStatus, msg('statusRestoring'));
  try {
    const { note } = await runRestore(
      {
        mode: selectedRestoreMode(),
        files,
        password: restorePw.value,
        keyFile: restoreKey.files?.[0],
        shareFiles: restoreShares.files ? Array.from(restoreShares.files) : undefined,
        extraPayloads: capturedPayloads(),
        onProgress: prog.onProgress,
      },
      msg,
    );
    setStatus(restoreStatus, '');
    restoreResultNote.textContent = note;
    show(restoreResult, true);
    restorePw.value = ''; // clear the secret from the field after use
    clearCaptured();
    reflectCaptured(0);
  } catch (err) {
    setStatus(restoreStatus, friendlyError(err), true);
  } finally {
    prog.done();
    restoreBtn.disabled = false;
  }
});

reflectDestination();
reflectKeyMode();
reflectRestoreMode();

// --- Workflow chooser (Guided vs Expert) ------------------------------------

const chooserSection = el('chooser');
const expertView = el('expert-view');
const wizardRoot = el('wizard-root');
const workflowsBtn = el<HTMLButtonElement>('workflows-btn');

type View = 'chooser' | 'guided' | 'expert';
let view: View = 'chooser';
let wizard: Wizard | null = null;

const wizardEnv: WizardEnv = {
  msg,
  locale: currentLocale,
  saveDestinations: ['disk', 'paper', 'binary', 'sqlite', 'gallery'],
  getSaveKey: (pw) => makeKey(pw),
  needsSavePassword: true,
  camera: {
    open: () => el<HTMLButtonElement>('camera-btn').click(),
    capturedCount,
    capturedPayloads,
    clearCaptured,
    onCountChange: (cb) => cameraCountSubs.push(cb),
  },
  onExit: () => {
    view = 'chooser';
    showView();
  },
};

function showView(): void {
  show(chooserSection, view === 'chooser');
  show(expertView, view === 'expert');
  show(wizardRoot, view === 'guided');
  show(workflowsBtn, view !== 'chooser');
}

function rememberWorkflow(w: 'guided' | 'expert'): void {
  try {
    localStorage.setItem('stegoshard.workflow', w);
  } catch {
    // storage may be unavailable (private mode) — the chooser still works.
  }
}

el<HTMLButtonElement>('choose-guided').addEventListener('click', () => {
  if (!wizard) wizard = createWizard(wizardRoot, wizardEnv);
  else wizard.reset();
  view = 'guided';
  rememberWorkflow('guided');
  showView();
});
el<HTMLButtonElement>('choose-expert').addEventListener('click', () => {
  view = 'expert';
  rememberWorkflow('expert');
  showView();
});
workflowsBtn.addEventListener('click', () => {
  view = 'chooser';
  showView();
});

// Highlight the last-used workflow as recommended.
try {
  const last = localStorage.getItem('stegoshard.workflow');
  show(el('rec-guided'), last === 'guided');
  show(el('rec-expert'), last === 'expert');
} catch {
  // ignore — no stored preference
}

showView();

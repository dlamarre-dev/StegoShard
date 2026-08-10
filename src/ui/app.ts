import browser from 'webextension-polyfill';
import { WARN_FILE_BYTES, type KeyMode, type ManifestEntry } from '@core';
import {
  type Estimates,
  envelopeLenForEstimate,
  estimatesFrom,
  firstCodecThatFits,
  formatSize,
} from './estimate';
import { localizeDom } from './i18n';
import {
  el,
  friendlyError,
  msg,
  pick,
  reflectFiles,
  renderManifest,
  setStatus,
  show,
  wireDropzone,
} from './dom';
import { getSession, isKeySet, lock, unlock } from './keystore';
import { type Destination, getPrefs, savePrefs, type Workflow } from './prefs';
import { wireKeyManager } from './keymanager';
import {
  type AccessMode,
  CODEC_CHOICES,
  type CodecChoice,
  codecApplies,
  destKey,
  recoveryGuidance,
  writesOneFile,
  runSave,
  verifyStegoPassword,
  type SaveRequest,
  type StegoInput,
} from './save-controller';
import { runRestore, type RestoreMode } from './restore-controller';
import {
  MIN_PASSWORD_LENGTH,
  extraEntropyBits as extraEntropyBitsOf,
  isStrongNewPassword,
  meetsPasswordFloor,
} from './password';
import { makeProgressUI } from './progress-ui';
import { createWizard, type Wizard, type WizardEnv } from './wizard';

localizeDom();

const noKeySection = el('no-key');
const lockedSection = el('locked');
const saveSection = el('save');
const statePill = el('state-pill');

const chooserSection = el('chooser');
const onboardingSection = el('onboarding');
// Assume seen until prefs load, so the banner never flashes before we know.
let onboardingSeen = true;
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
const saveProgress = el('save-progress');
const saveProgressBar = el('save-progress-bar');
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
const stegoPwField = el('stego-pw-field');
const factorDuressHint = el('factor-duress-hint');
const estimateLine = el('estimate-line');
const extraEntropy = el<HTMLTextAreaElement>('extra-entropy');
const extraEntropyBits = el('extra-entropy-bits');
const keymodeFields = el('keymode-fields');
const codecFields = el('codec-fields');
const galleryFields = el('gallery-fields');
const galleryCovers = el<HTMLInputElement>('gallery-covers');
const galleryCoversDrop = el('gallery-covers-drop');
const galleryCoversName = el('gallery-covers-name');
const gallerySavePw = el<HTMLInputElement>('gallery-save-pw');
const sqliteFields = el('sqlite-fields');
const sqliteSavePw = el<HTMLInputElement>('sqlite-save-pw');
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
const restoreShares = el<HTMLInputElement>('restore-shares');
const sharesDrop = el('shares-drop');
const sharesDzFile = el('shares-dz-file');
const restorePw = el<HTMLInputElement>('restore-pw');
const restoreBtn = el<HTMLButtonElement>('restore-btn');
const restoreStatus = el('restore-status');
const restoreProgress = el('restore-progress');
const restoreProgressBar = el('restore-progress-bar');

/**
 * Gate a newly-created credential.
 *
 * Two tiers: below `MIN_PASSWORD_LENGTH` is a hard floor this refuses outright,
 * because the vault's confidentiality rests entirely on this secret and the
 * attacker grinds it offline. Above the floor but short of `isStrongNewPassword`
 * is advisory — the user may knowingly accept it. A rejection explains itself; a
 * cancelled confirmation stays silent, since the user just made that choice.
 */
const acceptNewPassword = (password: string, status: HTMLElement): boolean => {
  if (!meetsPasswordFloor(password)) {
    setStatus(status, msg('errPasswordTooShort', String(MIN_PASSWORD_LENGTH)), true);
    return false;
  }
  return isStrongNewPassword(password) || confirm(msg('confirmWeakPassword'));
};
const restoreResult = el('restore-result');
const restoreResultNote = el('restore-result-note');
const restoreAdvanced = el('restore-advanced');
const restoreGalleryHint = el('restore-gallery-hint');

const selectedKeyMode = () => pick<KeyMode>('keymode', 'embedded');
const selectedGalleryKeyMode = () => pick<KeyMode>('gallery-keymode', 'embedded');
const selectedDest = () => pick<Destination>('dest', 'disk');
const selectedCodec = () => pick<CodecChoice>('codec', 'color');
const selectedAccessMode = () => pick<AccessMode>('accessmode', 'plain');

/** Read + validate the k-of-n threshold inputs; null if out of range. */
function readThreshold(): { k: number; n: number } | null {
  const k = parseInt(thresholdK.value, 10);
  const n = parseInt(thresholdN.value, 10);
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 1 || n < k || n > 255) return null;
  return { k, n };
}
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
  // The disguised .db path is keyed by its own per-save password (§10), not the
  // managed key; reveal that field and hide the key-mode controls for it.
  const sqlite = dest === 'sqlite';
  show(sqliteFields, sqlite);
  // The .db path offers key-mode delivery (embedded / keyfile / stego) in every
  // access mode — the factor is an extra layer on top of the mode (§10.3).
  show(keymodeFields, !gallery);
  // §10 access mode is offered on the deniable paths; duress is .db-only (§10.11).
  const deniable = gallery || sqlite;
  show(modeFields, deniable);
  show(modeDuressLabel, sqlite);
  // Fall back to plain if the current mode isn't valid for this destination.
  if (
    (!deniable && selectedAccessMode() !== 'plain') ||
    (gallery && selectedAccessMode() === 'duress')
  ) {
    const plain = document.querySelector<HTMLInputElement>(
      'input[name="accessmode"][value="plain"]',
    );
    if (plain) plain.checked = true;
  }
  show(estimateLine, !gallery);
  // The codec choice only exists where we render image symbols.
  show(codecFields, codecApplies(dest));
  reflectWording(dest);
  show(zipField, dest === 'disk');
  show(paperFields, dest === 'paper');
  // A label band is only drawn onto images.
  show(addBandLabel, dest === 'disk');
  show(bandFields, dest === 'paper' || (dest === 'disk' && addBand.checked));
  reflectKeyMode();
  reflectGalleryKeyMode();
  reflectAccessMode();
}

/**
 * Swap the pre-save copy between the image and single-file wordings. The
 * post-save notes already branch per destination; this is the lead-up.
 */
function reflectWording(dest: Destination): void {
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-file]')) {
    const base = node.dataset.i18n;
    const single = node.dataset.i18nFile;
    if (base && single) node.textContent = msg(writesOneFile(dest) ? single : base);
  }
}

/** Show the cover-image + password inputs only for the stego key mode. */
function reflectKeyMode(): void {
  const dest = selectedDest();
  // Stego is available everywhere except gallery (its own key mode). The .db path
  // reuses its per-save password to key the cover, so its separate stego-password
  // field is hidden there (in every access mode).
  const sqlite = dest === 'sqlite';
  const showStego = dest !== 'gallery' && selectedKeyMode() === 'stego';
  show(stegoFields, showStego);
  show(stegoPwField, showStego && !sqlite);
  // For a duress .db with a key-file/stego factor, that factor protects the REAL
  // file only — the decoy still opens on the duress password alone. Flag it so the
  // user isn't surprised the decoy needs no cover.
  show(
    factorDuressHint,
    sqlite && selectedAccessMode() === 'duress' && selectedKeyMode() !== 'embedded',
  );
}

/** Show the duress / threshold inputs for the chosen §10 access mode. */
function reflectAccessMode(): void {
  const mode = selectedAccessMode();
  show(duressFields, mode === 'duress');
  show(thresholdFields, mode === 'nonpossession');
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

async function loadPrefs(): Promise<void> {
  const prefs = await getPrefs();
  onboardingSeen = prefs.seenOnboarding;
  void refreshState();
  setRadio('dest', prefs.destination);
  setRadio('keymode', prefs.keyMode);
  setRadio('codec', prefs.codec);
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
  saveDestinations: ['disk', 'paper', 'binary', 'sqlite', 'gallery'],
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
  // First run: show onboarding in place of the chooser until dismissed.
  const onChooser = unlocked && view === 'chooser';
  const showOnboarding = onChooser && !onboardingSeen;
  show(onboardingSection, showOnboarding);
  show(chooserSection, onChooser && !showOnboarding);
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

el<HTMLButtonElement>('onboarding-dismiss').addEventListener('click', () => {
  onboardingSeen = true;
  void savePrefs({ seenOnboarding: true });
  void refreshState();
});

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
    recomputeEstimates();
  });
}
for (const radio of document.querySelectorAll('input[name="keymode"]')) {
  radio.addEventListener('change', () => {
    reflectKeyMode();
    void savePrefs({ keyMode: selectedKeyMode() });
    recomputeEstimates();
  });
}
for (const radio of document.querySelectorAll('input[name="codec"]')) {
  radio.addEventListener('change', () => {
    void savePrefs({ codec: selectedCodec() });
    recomputeEstimates();
  });
}
for (const radio of document.querySelectorAll('input[name="gallery-keymode"]')) {
  radio.addEventListener('change', reflectGalleryKeyMode);
}
for (const radio of document.querySelectorAll('input[name="accessmode"]')) {
  // Recompute the destination view: on .db, key-mode (embedded/keyfile/stego)
  // availability depends on the access mode, so a full refresh keeps them in sync.
  radio.addEventListener('change', reflectDestination);
}

// Cached per-file availability, so switching destination/codec/key mode doesn't
// recompress. The envelope length is the only expensive part; everything after
// it is arithmetic, so a codec change re-renders instantly.
let estimates: Estimates | null = null;
let envelope: { file: File; len: number } | null = null;

/** Destination radios that are actually visible. */
function destRadios(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[name="dest"]')).filter(
    (r) => !r.closest('.seg-item')?.hasAttribute('hidden'),
  );
}

/**
 * Re-derive the counts from the cached envelope for the current selections, then
 * re-apply the gating.
 *
 * The gating has to run here, not only on file change: the codec and key mode
 * both move the image count, so either can make an option stop fitting. Leaving
 * it out let the user pick a combination the UI still showed as fine, and the
 * save only failed at the end, after the key derivation.
 */
function recomputeEstimates(): void {
  const file = saveFile.files?.[0];
  if (file && envelope?.file === file) {
    estimates = estimatesFrom(
      file.size,
      envelope.len,
      destRadios().map((r) => r.value as Destination),
      msg,
      { keyMode: selectedKeyMode(), codec: selectedCodec() },
    );
    applyAvailability();
  }
  renderEstimate();
}

/** Grey out the destinations and codecs the current file cannot use. */
function applyAvailability(): void {
  const est = estimates;
  if (!est) return;
  for (const r of destRadios()) r.disabled = !est[r.value as Destination]?.available;

  // A codec that would blow the image limit disqualifies the codec, not the
  // destination — so grey the codec and move off it, leaving the destination be.
  const here = est[selectedDest()];
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="codec"]')) {
    radio.disabled = here?.codecFits ? here.codecFits[radio.value as CodecChoice] === false : false;
  }
  const usable = firstCodecThatFits(here, selectedCodec());
  if (usable !== selectedCodec()) setRadio('codec', usable);
}

/** Recompute availability for the dropped file, grey unavailable destinations, and render. */
async function refreshEstimates(): Promise<void> {
  const file = saveFile.files?.[0] ?? null;
  if (!file) {
    estimates = null;
    envelope = null;
    for (const r of destRadios()) r.disabled = false;
    renderEstimate();
    return;
  }
  let len: number;
  try {
    len = await envelopeLenForEstimate(file);
  } catch {
    return; // couldn't read the file — leave destinations enabled, no estimate
  }
  if (saveFile.files?.[0] !== file) return; // a newer file superseded this
  envelope = { file, len };
  recomputeEstimates(); // also applies the gating
  const est = estimates;
  if (!est) return;
  // A newly dropped file carries no prior intent about the destination, so this
  // one may move it; a codec toggle (above) never does.
  if (!est[selectedDest()]?.available) {
    const ok = destRadios()
      .map((r) => r.value as Destination)
      .find((d) => est[d]?.available);
    if (ok) {
      setRadio('dest', ok);
      reflectDestination();
      renderEstimate();
    }
  }
}

/** Render the size line, the estimate/no-format line, and the image-count warning. */
function renderEstimate(): void {
  const file = saveFile.files?.[0];
  saveSize.textContent = file ? formatSize(file.size) : '—';
  const anyOk =
    !estimates || destRadios().some((r) => estimates![r.value as Destination]?.available);
  show(noFormat, Boolean(file) && !anyOk);
  if (file && !anyOk) noFormat.textContent = msg('wizNoFormat');
  // When nothing fits, the no-format error stands in for the estimate line. The
  // binary destinations write exactly one file, so a count there says nothing.
  const dest = selectedDest();
  const counted = dest !== 'gallery' && dest !== 'binary' && dest !== 'sqlite';
  show(estimateLine, counted && anyOk);
  renderCodecCounts();

  if (!file || !counted || !anyOk) {
    estimate.textContent = '—';
    show(sizeWarn, false);
    return;
  }
  const e = estimates?.[dest];
  estimate.textContent = e?.available ? String(e.count) : '—';
  // Large secrets sprawl into many images; nudge toward the binary option.
  const imageDest = dest === 'disk' || dest === 'paper';
  if (imageDest && e?.available && file.size > WARN_FILE_BYTES) {
    sizeWarn.textContent = msg('sizeWarnImages', [
      String(Math.round(file.size / 1024)),
      String(e.count),
    ]);
    show(sizeWarn, true);
  } else {
    show(sizeWarn, false);
  }
}

/**
 * Show an estimate of what the typed extra entropy is worth, without any
 * pass/fail threshold: there is no minimum here, because the CSPRNG is mixed in
 * regardless and a weak string can only fail to help, never hurt.
 */
function renderEntropyBits(): void {
  const text = extraEntropy.value.trim();
  show(extraEntropyBits, text.length > 0);
  extraEntropyBits.textContent = text
    ? msg('extraEntropyBits', String(extraEntropyBitsOf(text)))
    : '';
}

extraEntropy.addEventListener('input', renderEntropyBits);

/** Label each codec option with the file count it would produce. */
function renderCodecCounts(): void {
  const e = estimates?.[selectedDest()];
  for (const codec of CODEC_CHOICES) {
    const slot = document.getElementById(`codec-count-${codec}`);
    if (!slot) continue;
    const n = e?.available ? e.counts?.[codec] : undefined;
    slot.textContent = n === undefined ? '' : msg('codecCount', String(n));
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
wireDropzone(sharesDrop, restoreShares, () =>
  reflectFiles(sharesDrop, sharesDzFile, restoreShares),
);
wireDropzone(galleryCoversDrop, galleryCovers, () =>
  reflectFiles(galleryCoversDrop, galleryCoversName, galleryCovers),
);
wireDropzone(galleryCoverDrop, galleryCover, () =>
  reflectFile(galleryCoverDrop, galleryCoverName, galleryCover),
);
wireDropzone(decoyDrop, decoyFile, () => reflectFile(decoyDrop, decoyName, decoyFile));

for (const radio of document.querySelectorAll('input[name="restore-mode"]')) {
  radio.addEventListener('change', reflectRestoreMode);
}
reflectRestoreMode();

/** Run a prepared save request through the shared controller, driving the UI. */
/**
 * Populate the expert save-result panel: what was written ("files created"),
 * then what to keep to restore. The manifest comes first because it names the
 * files the user is looking at right now — on the deniable destinations those
 * names say nothing on their own.
 */
function renderRecovery(
  guidance: { items: string[]; lossless: boolean },
  manifest: readonly ManifestEntry[] = [],
): void {
  const box = el('save-recovery');
  box.replaceChildren();
  const files = renderManifest(manifest, msg);
  if (files) box.append(files);
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
  const prog = makeProgressUI(saveProgress, saveProgressBar, saveStatus, msg);
  req.onProgress = prog.onProgress;
  setStatus(saveStatus, msg(destKey('statusSaving', req.dest)));
  try {
    const { note, manifest } = await runSave(req, msg);
    setStatus(saveStatus, '');
    saveResultNote.textContent = note;
    renderRecovery(recoveryGuidance(req.dest, req.keyMode ?? 'embedded'), manifest);
    show(saveResult, true);
    // Don't leave secrets sitting in the popup's DOM after the operation.
    stegoPw.value = '';
    gallerySavePw.value = '';
    sqliteSavePw.value = '';
    duressPw.value = '';
    // Also clear the extra entropy: reusing the same string across saves would
    // quietly turn a one-off contribution into a fixed one. Only on success,
    // deliberately — after a failed save the user would otherwise have to type a
    // page of dice rolls again, and keeping it costs nothing: every install
    // draws a fresh session salt, so the next attempt gets a new keystream.
    extraEntropy.value = '';
    renderEntropyBits();
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

  // Gallery is self-contained: its own password seeds its key, so it needs
  // neither the managed session key nor the other destination options.
  if (dest === 'gallery') {
    const covers = galleryCovers.files ? Array.from(galleryCovers.files) : [];
    if (covers.length === 0) return setStatus(saveStatus, msg('errNoCovers'), true);
    if (!gallerySavePw.value) return setStatus(saveStatus, msg('errNoPassword'), true);
    if (!acceptNewPassword(gallerySavePw.value, saveStatus)) return;
    const gKeyMode = selectedGalleryKeyMode();
    let gStego: StegoInput | undefined;
    if (gKeyMode === 'stego') {
      const cover = galleryCover.files?.[0];
      if (!cover) return setStatus(saveStatus, msg('errNoCover'), true);
      // The gallery stego cover is keyed by the gallery password (not the managed key).
      gStego = { cover, password: gallerySavePw.value };
    }
    // Gallery supports plain + non-possession (Mode B); duress is blocked (§10.11).
    const gMode = selectedAccessMode();
    let gThreshold: { k: number; n: number } | undefined;
    if (gMode === 'nonpossession') {
      const t = readThreshold();
      if (!t) return setStatus(saveStatus, msg('errNoThreshold'), true);
      gThreshold = t;
    }
    await doSave({
      dest,
      file,
      covers,
      galleryPassword: gallerySavePw.value,
      keyMode: gKeyMode,
      stego: gStego,
      accessMode: gMode === 'duress' ? 'plain' : gMode,
      threshold: gThreshold,
      userEntropy: extraEntropy.value.trim() || undefined,
    });
    return;
  }

  const session = await getSession();
  if (!session) return setStatus(saveStatus, msg('errLocked'), true);
  // The disguised .db path is keyed by its own per-save password (§10), not the
  // managed key.
  if (dest === 'sqlite' && !sqliteSavePw.value) {
    return setStatus(saveStatus, msg('errNoPassword'), true);
  }
  if (dest === 'sqlite' && !acceptNewPassword(sqliteSavePw.value, saveStatus)) return;
  // §10 access mode + its inputs (the .db path only; other dests stay plain).
  const accessMode = dest === 'sqlite' ? selectedAccessMode() : 'plain';
  // key-file / stego delivery composes with every .db access mode (§10.3).
  const keyMode = selectedKeyMode();
  let duressPassword: string | undefined;
  let decoy: File | undefined;
  let threshold: { k: number; n: number } | undefined;
  if (accessMode === 'duress') {
    const d = decoyFile.files?.[0];
    if (!duressPw.value || !d) return setStatus(saveStatus, msg('errDuressInputs'), true);
    if (!acceptNewPassword(duressPw.value, saveStatus)) return;
    duressPassword = duressPw.value;
    decoy = d;
  } else if (accessMode === 'nonpossession') {
    const t = readThreshold();
    if (!t) return setStatus(saveStatus, msg('errNoThreshold'), true);
    threshold = t;
  }
  const date = new Date().toISOString().slice(0, 10);
  const useLabel = addBand.checked;
  const title = useLabel ? bandTitle.value.trim() : '';

  // Stego hides the external key artifact in a cover photo, keyed by the vault
  // password so restore uses one password for both the stego extraction and the
  // unwrap. On disk/paper/branded that artifact is the managed key block (keyed by
  // a separate stego password, verified against the managed key); on the .db path
  // it is the 32-byte key factor, keyed by the same per-save .db password.
  let stego: StegoInput | undefined;
  if (keyMode === 'stego') {
    const cover = coverFile.files?.[0];
    if (!cover) return setStatus(saveStatus, msg('errNoCover'), true);
    if (dest === 'sqlite') {
      stego = { cover, password: sqliteSavePw.value };
    } else {
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
  }

  await doSave({
    dest,
    file,
    key: session,
    password: dest === 'sqlite' ? sqliteSavePw.value : undefined,
    keyMode,
    codec: selectedCodec(),
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
    userEntropy: extraEntropy.value.trim() || undefined,
    locale: browser.i18n.getUILanguage(),
  });
});

restoreBtn.addEventListener('click', async () => {
  const files = restoreFiles.files ? Array.from(restoreFiles.files) : [];
  if (files.length === 0) return setStatus(restoreStatus, msg('errNoImages'), true);
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
        onProgress: prog.onProgress,
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
    prog.done();
    restoreBtn.disabled = false;
  }
});

void loadPrefs();
void refreshState();

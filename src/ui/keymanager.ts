/**
 * Wires the vault-key management UI (create / change password / export / import
 * / erase). The same markup — identical element IDs — is used both by the
 * standalone options page and by the settings modal inside the app page, so
 * this logic lives here once and is called from both.
 *
 * `onChange` is invoked after any operation that changes key state, so a host
 * (the app page) can refresh its own view.
 */

import { el, friendlyError, msg, setStatus, show } from './dom';
import {
  changePassword,
  eraseKey,
  exportKeyBlock,
  importKeyBlock,
  isKeySet,
  setupKey,
} from './keystore';
import { downloadBlob } from './image-io';

const MIN_PASSWORD = 8;

export function wireKeyManager(onChange: () => void = () => {}): void {
  const keyBodyNew = el('key-body-new');
  const keyBodyExists = el('key-body-exists');
  const createFields = el('create-fields');
  const manage = el('manage');

  async function refreshState(): Promise<void> {
    const hasKey = await isKeySet();
    show(keyBodyNew, !hasKey);
    show(createFields, !hasKey);
    show(keyBodyExists, hasKey);
    show(manage, hasKey);
  }

  /** Validate a new password + confirmation; returns an error message or null. */
  function validateNewPassword(pw: string, confirm: string): string | null {
    if (pw.length < MIN_PASSWORD) return msg('errPasswordTooShort');
    if (pw !== confirm) return msg('errPasswordMismatch');
    return null;
  }

  // --- Create key ------------------------------------------------------------
  const newPw = el<HTMLInputElement>('new-pw');
  const confirmPw = el<HTMLInputElement>('confirm-pw');
  const createBtn = el<HTMLButtonElement>('create-btn');
  const createStatus = el('create-status');

  createBtn.addEventListener('click', async () => {
    const err = validateNewPassword(newPw.value, confirmPw.value);
    if (err) return setStatus(createStatus, err, true);
    createBtn.disabled = true;
    try {
      await setupKey(newPw.value);
      newPw.value = confirmPw.value = '';
      setStatus(createStatus, msg('statusKeyCreated'));
      await refreshState();
      onChange();
    } catch (e) {
      setStatus(createStatus, friendlyError(e), true);
    } finally {
      createBtn.disabled = false;
    }
  });

  // --- Change password -------------------------------------------------------
  const oldPw = el<HTMLInputElement>('old-pw');
  const changeNewPw = el<HTMLInputElement>('change-new-pw');
  const changeConfirmPw = el<HTMLInputElement>('change-confirm-pw');
  const changeBtn = el<HTMLButtonElement>('change-btn');
  const changeStatus = el('change-status');

  changeBtn.addEventListener('click', async () => {
    const err = validateNewPassword(changeNewPw.value, changeConfirmPw.value);
    if (err) return setStatus(changeStatus, err, true);
    changeBtn.disabled = true;
    try {
      await changePassword(oldPw.value, changeNewPw.value);
      oldPw.value = changeNewPw.value = changeConfirmPw.value = '';
      setStatus(changeStatus, msg('statusPwChanged'));
      onChange();
    } catch (e) {
      setStatus(changeStatus, friendlyError(e), true);
    } finally {
      changeBtn.disabled = false;
    }
  });

  // --- Export ----------------------------------------------------------------
  const exportBtn = el<HTMLButtonElement>('export-btn');
  const exportStatus = el('export-status');

  exportBtn.addEventListener('click', async () => {
    try {
      const keyBlock = await exportKeyBlock();
      downloadBlob(new Blob([keyBlock as BufferSource]), 'stegoshard.key');
      setStatus(exportStatus, msg('statusKeyExported'));
    } catch (e) {
      setStatus(exportStatus, friendlyError(e), true);
    }
  });

  // --- Import ----------------------------------------------------------------
  const importKeyInput = el<HTMLInputElement>('import-key');
  const importPw = el<HTMLInputElement>('import-pw');
  const importBtn = el<HTMLButtonElement>('import-btn');
  const importStatus = el('import-status');

  importBtn.addEventListener('click', async () => {
    const file = importKeyInput.files?.[0];
    if (!file) return setStatus(importStatus, msg('labelKeyFile'), true);
    if (!importPw.value) return setStatus(importStatus, msg('errNoPassword'), true);
    importBtn.disabled = true;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await importKeyBlock(bytes, importPw.value);
      importPw.value = '';
      setStatus(importStatus, msg('statusKeyImported'));
      await refreshState();
      onChange();
    } catch (e) {
      setStatus(importStatus, friendlyError(e), true);
    } finally {
      importBtn.disabled = false;
    }
  });

  // --- Erase -----------------------------------------------------------------
  const eraseBtn = el<HTMLButtonElement>('erase-btn');
  const eraseStatus = el('erase-status');

  eraseBtn.addEventListener('click', async () => {
    if (!confirm(msg('confirmErase'))) return;
    try {
      await eraseKey();
      setStatus(eraseStatus, msg('statusKeyErased'));
      await refreshState();
      onChange();
    } catch (e) {
      setStatus(eraseStatus, friendlyError(e), true);
    }
  });

  void refreshState();
}

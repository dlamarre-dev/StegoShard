/**
 * Managed vault key, persisted in the browser (plan §4).
 *
 * At rest, `chrome.storage.local` holds only the *wrapped* DEK block (salt,
 * Argon2id params, IV, wrapped DEK) — useless without the password.
 *
 * Once unlocked, the raw DEK is kept in `chrome.storage.session` — a volatile,
 * in-memory store shared across the extension's pages. This lets the popup stay
 * unlocked across reopens (and survives a service-worker recycle) instead of
 * re-prompting every time, yet it is never written to disk and is cleared when
 * the browser closes or the user locks the vault.
 */

import browser from 'webextension-polyfill';
import {
  createKeyBlock,
  exportDekRaw,
  fromBase64,
  importDek,
  parseKeyBlock,
  rewrapKeyBlock,
  serializeKeyBlock,
  toBase64,
  unlockKeyBlock,
  type VaultKey,
} from '@core';

const LOCAL_KEY = 'stegoshard.keyBlock'; // wrapped DEK, at rest
const SESSION_KEY = 'stegoshard.session'; // unlocked DEK, volatile

async function readStoredBlock(): Promise<Uint8Array | null> {
  const record = await browser.storage.local.get(LOCAL_KEY);
  const value = record[LOCAL_KEY];
  return typeof value === 'string' ? fromBase64(value) : null;
}

async function writeStoredBlock(keyBlock: Uint8Array): Promise<void> {
  await browser.storage.local.set({ [LOCAL_KEY]: toBase64(keyBlock) });
}

async function writeSession(dek: CryptoKey, keyBlock: Uint8Array): Promise<void> {
  const dekRaw = await exportDekRaw(dek);
  await browser.storage.session.set({
    [SESSION_KEY]: { dek: toBase64(dekRaw), keyBlock: toBase64(keyBlock) },
  });
}

/** Whether a vault key has been set up on this device. */
export async function isKeySet(): Promise<boolean> {
  return (await readStoredBlock()) !== null;
}

/** The unlocked key for this session, or null if locked. */
export async function getSession(): Promise<VaultKey | null> {
  const record = await browser.storage.session.get(SESSION_KEY);
  const value = record[SESSION_KEY] as { dek: string; keyBlock: string } | undefined;
  if (!value) return null;
  const dek = await importDek(fromBase64(value.dek));
  return { dek, keyBlock: fromBase64(value.keyBlock) };
}

/** Drop the in-memory session key. */
export async function lock(): Promise<void> {
  await browser.storage.session.remove(SESSION_KEY);
}

/**
 * Create a brand-new vault key protected by `password`. Refuses to clobber an
 * existing key unless `overwrite` is set.
 */
export async function setupKey(password: string, overwrite = false): Promise<void> {
  if (!overwrite && (await isKeySet())) {
    throw new Error('a vault key already exists on this device');
  }
  const { dek, block } = await createKeyBlock(password);
  const keyBlock = serializeKeyBlock(block);
  await writeStoredBlock(keyBlock);
  await writeSession(dek, keyBlock);
}

/** Unlock the stored key with `password`, caching it for this session. */
export async function unlock(password: string): Promise<void> {
  const keyBlock = await readStoredBlock();
  if (!keyBlock) throw new Error('no vault key on this device — set one up first');
  const dek = await unlockKeyBlock(parseKeyBlock(keyBlock), password); // throws WrongPasswordError
  await writeSession(dek, keyBlock);
}

/** Change the password by re-wrapping the same DEK (existing vaults stay valid). */
export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  const stored = await readStoredBlock();
  if (!stored) throw new Error('no vault key on this device');
  const newBlock = await rewrapKeyBlock(parseKeyBlock(stored), oldPassword, newPassword);
  const keyBlock = serializeKeyBlock(newBlock);
  await writeStoredBlock(keyBlock);
  // Keep the session unlocked (the DEK is unchanged) but refresh its key block.
  const dek = await unlockKeyBlock(newBlock, newPassword);
  await writeSession(dek, keyBlock);
}

/** The serialized key block, for saving as a `.key` file (transfer/backup). */
export async function exportKeyBlock(): Promise<Uint8Array> {
  const keyBlock = await readStoredBlock();
  if (!keyBlock) throw new Error('no vault key on this device');
  return keyBlock;
}

/** Import a key block from a `.key` file, verifying the password before storing. */
export async function importKeyBlock(keyBlock: Uint8Array, password: string): Promise<void> {
  const dek = await unlockKeyBlock(parseKeyBlock(keyBlock), password); // validates password
  await writeStoredBlock(keyBlock);
  await writeSession(dek, keyBlock);
}

/** Permanently remove the vault key from this device (irreversible). */
export async function eraseKey(): Promise<void> {
  await browser.storage.local.remove(LOCAL_KEY);
  await lock();
}

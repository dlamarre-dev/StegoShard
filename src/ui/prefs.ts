/**
 * Non-sensitive save preferences, remembered in storage.local so the popup
 * keeps the user's last choices across reopens (plan §4: prefs are non-secret).
 */

import browser from 'webextension-polyfill';
import type { BinaryVariant, KeyMode } from '@core';

const PREFS_KEY = 'stegoshard.prefs';

export type Destination = 'disk' | 'paper' | 'cloud' | 'binary';

export interface Prefs {
  destination: Destination;
  keyMode: KeyMode;
  addBand: boolean;
  title: string;
  asZip: boolean;
  includeInstructions: boolean;
  binaryVariant: BinaryVariant;
}

const DEFAULT_PREFS: Prefs = {
  destination: 'disk',
  keyMode: 'embedded',
  addBand: false,
  title: '',
  asZip: true,
  includeInstructions: false,
  binaryVariant: 'branded',
};

export async function getPrefs(): Promise<Prefs> {
  const record = await browser.storage.local.get(PREFS_KEY);
  const stored = record[PREFS_KEY] as Partial<Prefs> | undefined;
  return { ...DEFAULT_PREFS, ...stored };
}

export async function savePrefs(patch: Partial<Prefs>): Promise<void> {
  const next = { ...(await getPrefs()), ...patch };
  await browser.storage.local.set({ [PREFS_KEY]: next });
}

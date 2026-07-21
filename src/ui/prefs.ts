/**
 * Non-sensitive save preferences, remembered in storage.local so the popup
 * keeps the user's last choices across reopens (plan §4: prefs are non-secret).
 */

import browser from 'webextension-polyfill';
import type { KeyMode } from '@core';

const PREFS_KEY = 'stegoshard.prefs';

// 'binary' = branded .ssbn, 'sqlite' = disguised .db (SPEC §8) — two destinations
// over the one binary container.
export type Destination = 'disk' | 'paper' | 'cloud' | 'binary' | 'sqlite' | 'gallery';

/** Which UI to show at launch — the step-by-step wizard or the dense one-screen UI. */
export type Workflow = 'guided' | 'expert';

export interface Prefs {
  workflow: Workflow;
  destination: Destination;
  keyMode: KeyMode;
  addBand: boolean;
  title: string;
  asZip: boolean;
  includeInstructions: boolean;
}

const DEFAULT_PREFS: Prefs = {
  workflow: 'guided',
  destination: 'disk',
  keyMode: 'embedded',
  addBand: false,
  title: '',
  asZip: true,
  includeInstructions: false,
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

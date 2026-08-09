/**
 * Non-sensitive save preferences, remembered in storage.local so the popup
 * keeps the user's last choices across reopens (plan §4: prefs are non-secret).
 */

import browser from 'webextension-polyfill';
import type { KeyMode } from '@core';
import type { CodecChoice } from './save-controller';

const PREFS_KEY = 'stegoshard.prefs';

// 'binary' = branded .ssbn, 'sqlite' = disguised .db (SPEC §8) — two destinations
// over the one binary container.
export type Destination = 'disk' | 'paper' | 'binary' | 'sqlite' | 'gallery';

/** Which UI to show at launch — the step-by-step wizard or the dense one-screen UI. */
export type Workflow = 'guided' | 'expert';

export interface Prefs {
  workflow: Workflow;
  destination: Destination;
  keyMode: KeyMode;
  /** Image codec for the disk destination (SPEC §2). */
  codec: CodecChoice;
  addBand: boolean;
  title: string;
  asZip: boolean;
  includeInstructions: boolean;
  /** First-run onboarding shown and dismissed. */
  seenOnboarding: boolean;
}

const DEFAULT_PREFS: Prefs = {
  workflow: 'guided',
  destination: 'disk',
  keyMode: 'embedded',
  // Colour is the default on the digital paths: ~3x the bytes per image, so a
  // vault needs about a third as many files. QR stays one click away.
  codec: 'color',
  addBand: false,
  title: '',
  asZip: true,
  includeInstructions: false,
  seenOnboarding: false,
};

export async function getPrefs(): Promise<Prefs> {
  const record = await browser.storage.local.get(PREFS_KEY);
  const raw = record[PREFS_KEY] as
    (Omit<Partial<Prefs>, 'destination'> & { destination?: string }) | undefined;
  const destinations: readonly Destination[] = ['disk', 'paper', 'binary', 'sqlite', 'gallery'];
  // Invalid or deferred pre-1.0 destinations migrate to the offline default.
  const destination = destinations.includes(raw?.destination as Destination)
    ? (raw!.destination as Destination)
    : 'disk';
  return { ...DEFAULT_PREFS, ...raw, destination };
}

export async function savePrefs(patch: Partial<Prefs>): Promise<void> {
  const next = { ...(await getPrefs()), ...patch };
  await browser.storage.local.set({ [PREFS_KEY]: next });
}

/**
 * Service worker (Chrome/Edge) / background script (Firefox).
 *
 * Init phase: orchestration is a stub. What is real here is the WASM/CSP spike
 * — the background context runs it at startup, and it also spins up the
 * offscreen document so the spike runs there too. Both results are logged so
 * the Init success criterion ("WASM validated in MV3") can be confirmed by
 * loading the unpacked build and reading the console.
 */

import browser from 'webextension-polyfill';
import { runWasmSpike } from '../spike/wasm-csp';

const OFFSCREEN_URL = 'offscreen/offscreen.html';

async function ensureOffscreenDocument(): Promise<void> {
  // chrome.offscreen only exists on Chromium. On Firefox this is skipped;
  // canvas work will use a different mechanism (handled in Phase 1).
  const offscreen = typeof chrome !== 'undefined' ? chrome.offscreen : undefined;
  if (!offscreen) {
    console.warn('[imagevault] offscreen API unavailable in this browser');
    return;
  }
  if (await offscreen.hasDocument()) return;
  await offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.BLOBS],
    justification: 'Render and decode images (Canvas) — unavailable in the service worker.',
  });
}

browser.runtime.onInstalled.addListener(() => {
  console.log('[imagevault] installed');
});

// Clicking the toolbar icon opens the full-page app in a tab (no popup).
const APP_URL = 'ui/app.html';
browser.action.onClicked.addListener(() => {
  void browser.tabs.create({ url: browser.runtime.getURL(APP_URL) });
});

// Report spike results coming back from the offscreen document.
browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as { type?: string; payload?: unknown };
  if (msg?.type === 'wasm-spike-result') {
    console.log('[imagevault] spike (offscreen):', msg.payload);
  }
  return undefined;
});

async function main(): Promise<void> {
  const result = await runWasmSpike('service-worker');
  console.log('[imagevault] spike (service-worker):', result);
  await ensureOffscreenDocument();
}

void main();

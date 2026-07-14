/**
 * Single source of truth for the WebExtension manifest.
 *
 * Chrome/Edge and Firefox share a common Manifest V3 base; the few documented
 * divergences (background type, the offscreen API, Gecko settings) are handled
 * per target here so the rest of the codebase stays browser-agnostic.
 */

export type Target = 'chrome' | 'firefox';

// Bumped independently of the npm package version; surfaced in stores.
const VERSION = '0.0.1';

export function buildManifest(target: Target): Record<string, unknown> {
  const base: Record<string, unknown> = {
    manifest_version: 3,
    // Localized via _locales; keep the browser locale as default.
    name: '__MSG_extName__',
    description: '__MSG_extDesc__',
    default_locale: 'en',
    version: VERSION,

    // The offline core needs no network and no host access.
    permissions: ['storage'],

    // No default_popup: clicking the icon opens the full-page app in a tab
    // (handled by action.onClicked in the service worker).
    action: {
      default_title: '__MSG_extName__',
    },
    options_ui: {
      page: 'ui/options.html',
      open_in_tab: true,
    },

    // MV3 requires 'wasm-unsafe-eval' to run the Argon2id / Reed-Solomon WASM.
    // Validated by the Init WASM spike (see docs/SPIKE-wasm-csp.md).
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  };

  if (target === 'firefox') {
    // Firefox MV3 uses an event-page style background (scripts), not a service
    // worker, and has no chrome.offscreen API — canvas work runs elsewhere.
    return {
      ...base,
      background: {
        scripts: ['background.js'],
        type: 'module',
      },
      browser_specific_settings: {
        gecko: {
          id: 'imagevault@dlamarre-dev.github.io',
          strict_min_version: '128.0',
        },
      },
    };
  }

  // Chrome / Edge (Chromium).
  // Google Photos is an optional destination (Phase 4), so its OAuth/identity
  // and host permissions are declared optional and requested at runtime. These
  // live in the Chromium branch only: Firefox rejects `identity` in
  // optional_permissions and its OAuth flow differs — revisited in Phase 4.
  return {
    ...base,
    permissions: [...(base.permissions as string[]), 'offscreen'],
    optional_permissions: ['identity'],
    optional_host_permissions: [
      'https://photoslibrary.googleapis.com/*',
      'https://photospicker.googleapis.com/*',
      'https://*.googleusercontent.com/*',
    ],
    background: {
      service_worker: 'background.js',
      type: 'module',
    },
  };
}

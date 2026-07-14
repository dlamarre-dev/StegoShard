# Store submission guide

How to package and submit ImageVault to the Chrome Web Store, Microsoft Edge
Add-ons, and Firefox Add-ons (AMO). Building and zipping is automated; creating
developer accounts and uploading is manual.

## Build the packages

```bash
npm run package
```

Produces `packages/imagevault-chrome-<version>.zip` (Chrome + Edge) and
`packages/imagevault-firefox-<version>.zip` (source maps excluded). Verify each
by loading it unpacked before uploading.

## Listing copy

- **Name / short description**: localized in `public/_locales/*/messages.json`
  (`extName` ≤ 75 chars, `extDesc` ≤ 132 chars), keyword-oriented per language.
- **Category**: Productivity / Tools.
- **Single purpose**: "Encrypt a file and encode it into robust, error-corrected
  images that can be restored from disk, paper, or Google Photos."
- **Privacy policy URL**: host `docs/PRIVACY.md` (e.g. GitHub Pages) and link it.

## Permission justifications (Chrome Web Store review)

| Permission | Justification |
| ---------- | ------------- |
| `storage` | Store the password-wrapped vault key and non-sensitive preferences locally. |
| `offscreen` | Render/decode QR images on a Canvas, unavailable in the MV3 service worker. |
| `identity` (optional) | Only for the optional Google Photos destination's OAuth sign-in. |
| Google host permissions (optional) | Upload to / download from the user's own Google Photos, only when that destination is used. |
| `'wasm-unsafe-eval'` in CSP | Run the audited Argon2id (hash-wasm) WebAssembly for key derivation. |

Data-use disclosures: **no data collected or sold**; all processing is local;
Google Photos is opt-in and goes to the user's own account (see PRIVACY.md).

## Chrome Web Store

1. Register at the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) (one-time US$5 fee).
2. Upload `imagevault-chrome-<version>.zip`.
3. Fill in listing, screenshots, privacy policy URL, and the permission
   justifications above. Submit for review.

## Microsoft Edge Add-ons

1. Register at [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge) (free).
2. Upload the **same** Chrome zip; complete the listing; submit.

## Firefox Add-ons (AMO)

1. Sign in at [addons.mozilla.org/developers](https://addons.mozilla.org/developers/).
2. Upload `imagevault-firefox-<version>.zip`.
3. AMO reviews source. Because the code is bundled, provide build instructions
   (Node version, `npm ci`, `npm run build:firefox`) and a link to this public
   repo. `browser_specific_settings.gecko` is already set.

## Google OAuth verification (only if shipping Google Photos publicly)

The `photoslibrary.appendonly` scope is **sensitive**. Until Google verifies the
OAuth app, only accounts added as **test users** can use the Google Photos
destination. For a public release, complete Google's OAuth verification
(consent-screen review, possibly a security assessment). Disk and Paper need
none of this — the extension is fully usable without Google Photos configured.

## Before 1.0

- Native proofread of the `ja` and `zh_TW` locales (see LOCALIZATION.md).
- Consider an external review of the cryptographic core.
- Generate localized store screenshots (pipeline still manual).

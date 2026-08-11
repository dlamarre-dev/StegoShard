# Store submission guide

How to package and submit StegoShard to the Chrome Web Store, Microsoft Edge
Add-ons, and Firefox Add-ons (AMO). Building and zipping is automated; creating
developer accounts and uploading is manual.

## Build the packages

```bash
npm run package
```

Produces one zip per target under `packages/`:
`stegoshard-chrome-<version>.zip`, `stegoshard-edge-<version>.zip`, and
`stegoshard-firefox-<version>.zip` (source maps excluded). It also writes the
identical, unzipped contents to `dist-release/<target>/` so you can load exactly
what will be uploaded as an unpacked extension and test it before submitting.
(Chrome and Edge builds are byte-identical Chromium builds.)

## Listing copy

- **Name / short description**: localized in `public/_locales/*/messages.json`
  (`extName` ≤ 75 chars, `extDesc` ≤ 132 chars), keyword-oriented per language.
- **Long description**: ready-to-paste, localized in `docs/store/<code>.md`
  (one per locale; see `docs/store/README.md`).
- **Category**: Productivity / Tools.
- **Single purpose**: "Encrypt a file and store it inside resilient images, a
  printable recovery set, an opaque file, or deniably modified photos."
- **Privacy policy URL**: host `docs/PRIVACY.md` (e.g. GitHub Pages) and link it.

## Permission justifications (Chrome Web Store review)

| Permission                  | Justification                                                               |
| --------------------------- | --------------------------------------------------------------------------- |
| `storage`                   | Store the password-wrapped vault key and non-sensitive preferences locally. |
| `'wasm-unsafe-eval'` in CSP | Run the audited Argon2id (hash-wasm) WebAssembly for key derivation.        |

Data-use disclosures: **no data collected or sold**; all processing is local and
the extension requests no host access (see PRIVACY.md).

## Chrome Web Store

1. Register at the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) (one-time US$5 fee).
2. Upload `stegoshard-chrome-<version>.zip`.
3. Fill in listing, screenshots, privacy policy URL, and the permission
   justifications above. Submit for review.

## Microsoft Edge Add-ons

1. Register at [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge) (free).
2. Upload `stegoshard-edge-<version>.zip` (identical to the Chrome build);
   complete the listing; submit.

## Firefox Add-ons (AMO)

1. Sign in at [addons.mozilla.org/developers](https://addons.mozilla.org/developers/).
2. Upload `stegoshard-firefox-<version>.zip`.
3. AMO reviews source. Because the code is bundled, provide build instructions
   (Node version, `npm ci`, `npm run build:firefox`) and a link to this public
   repo. `browser_specific_settings.gecko` is already set.

## Before 1.0

- Native proofread of the `ja` and `zh_TW` locales (see LOCALIZATION.md), and of
  the repositioned strings (`extName`, `extDesc`, `destSqlite`, `popupTagline`,
  `onboardingOvert`, incl. the "robust" → "resilient" rewording) across all eight
  locales; the two-storage-models wording was drafted, not natively reviewed.
- Close the independent security review and the browser/physical QA checklist.
- Generate localized store screenshots (pipeline still manual).

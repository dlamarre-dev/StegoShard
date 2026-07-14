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

## Google Photos: from "test users only" to everyone

By default the OAuth consent screen is in **Testing** mode, so only Google
accounts you add as **test users** (up to 100) can use the Google Photos
destination — perfect for development, but not for the public. To let *any* user
use it, publish the consent screen and pass **OAuth verification**:

1. **Prerequisites (host them first).** Google requires a public homepage and a
   privacy policy on a domain you control. The GitHub Pages site provides both:
   - Homepage: `https://dlamarre-dev.github.io/ImageVault/`
   - Privacy policy: publish `docs/PRIVACY.md` as a page there and link it.
   - Add that domain under **APIs & Services → OAuth consent screen →
     Authorized domains**, and verify ownership in Google Search Console.
2. **Complete the consent screen**: app name, logo (`public/icons/icon-128.png`),
   support email, homepage, privacy policy URL, and authorized domains.
3. **Justify the scopes**: explain that `photoslibrary.appendonly` uploads the
   user's own encrypted images to their own account, and that
   `photospicker.mediaitems.readonly` reads only images the user picks. Record a
   short **demo video** of the OAuth flow (Google asks for one).
4. **Publish** the consent screen (Testing → In production) and **submit for
   verification**.

`photoslibrary.appendonly` is a **sensitive** scope (not *restricted*), so it
needs Google's consent-screen review but **not** a third-party CASA security
assessment. Review typically takes a few days to a few weeks.

Until verification completes, ship the extension with Google Photos usable by
test users only, or leave the `IMAGEVAULT_GOOGLE_CLIENT_ID` unset in the store
build so the destination is hidden. **Disk and Paper need none of this** — the
extension (and the web app) are fully usable without Google Photos.

## Before 1.0

- Native proofread of the `ja` and `zh_TW` locales (see LOCALIZATION.md).
- Consider an external review of the cryptographic core.
- Generate localized store screenshots (pipeline still manual).

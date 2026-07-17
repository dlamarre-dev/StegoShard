# Store submission guide

How to package and submit StegoShard to the Chrome Web Store, Microsoft Edge
Add-ons, and Firefox Add-ons (AMO). Building and zipping is automated; creating
developer accounts and uploading is manual.

## Build the packages

```bash
npm run package
```

Produces one zip per target under `packages/` —
`stegoshard-chrome-<version>.zip`, `stegoshard-edge-<version>.zip`, and
`stegoshard-firefox-<version>.zip` (source maps excluded). It also writes the
identical, unzipped contents to `dist-release/<target>/` so you can load exactly
what will be uploaded as an unpacked extension and test it before submitting.
(Chrome and Edge builds are byte-identical Chromium builds.)

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

## Google Photos: from "test users only" to everyone

> **Status (deferred): the public launch ships WITHOUT Google Photos.** The
> `npm run package` build uses `--mode store` (empty `STEGOSHARD_GOOGLE_CLIENT_ID`
> via `.env.store`), which hides the Google Photos destination and omits its
> optional permissions from the manifest. Disk, Paper, ZIP, and the web app are
> fully public and need none of this.
>
> **Why deferred:** Google OAuth verification requires the consent-screen
> homepage to be on a domain **registered to you**. The GitHub Pages domain
> (`dlamarre-dev.github.io`) is GitHub's, so Google rejects it
> ("the website ... is not registered to your name") even though Search Console
> verified the URL. Enabling Google Photos publicly therefore needs a
> **custom domain** — worth doing once the project has some traction.
>
> **To resume later (custom-domain path):**
> 1. Buy a domain (or use one you own) and set it as the GitHub Pages **custom
>    domain** (add a `CNAME` file to the deployed site and the DNS records;
>    change the web build's `base` from `/StegoShard/` to `/`).
> 2. Verify it in Search Console as a **Domain** property (DNS TXT record).
> 3. Point the consent-screen homepage/privacy/terms URLs at the custom domain
>    and set it as the **Authorized domain**.
> 4. Rebuild the store package with the real client id (drop `--mode store`, or
>    set `STEGOSHARD_GOOGLE_CLIENT_ID` for that build) and resubmit for
>    verification (steps below).
>
> Meanwhile you can keep using Google Photos yourself: your local `.env` has the
> client id, so a personal `npm run build` includes it and your Google account
> (a test user) works.

The rest of this section is the full verification procedure for when you resume:

By default the OAuth consent screen is in **Testing** mode, so only Google
accounts you add as **test users** (up to 100) can use the Google Photos
destination — perfect for development, but not for the public. To let *any* user
use it, publish the consent screen and pass **OAuth verification**:

1. **Prerequisites (host them first).** Google requires a public homepage, a
   privacy policy, and a terms-of-service page on a domain you control. The
   GitHub Pages site provides all three:
   - Homepage: `https://dlamarre-dev.github.io/StegoShard/`
   - Privacy policy: `https://dlamarre-dev.github.io/StegoShard/privacy.html`
   - Terms of service: `https://dlamarre-dev.github.io/StegoShard/terms.html`
   - Add that domain under **APIs & Services → OAuth consent screen →
     Authorized domains**, and verify ownership in Google Search Console.
2. **Complete the consent screen**: app name, logo (`public/icons/icon-128.png`),
   support email, homepage, privacy policy URL, terms-of-service URL, and
   authorized domains.
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
test users only, or leave the `STEGOSHARD_GOOGLE_CLIENT_ID` unset in the store
build so the destination is hidden. **Disk and Paper need none of this** — the
extension (and the web app) are fully usable without Google Photos.

## Before 1.0

- Native proofread of the `ja` and `zh_TW` locales (see LOCALIZATION.md).
- Consider an external review of the cryptographic core.
- Generate localized store screenshots (pipeline still manual).

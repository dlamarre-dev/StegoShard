# Localization

StegoShard's UI strings live in `public/_locales/<code>/messages.json` and are
resolved with `chrome.i18n` (see `src/ui/i18n.ts`). The browser locale is
followed automatically; there is no in-app language switcher for the main UI
(plan §7). Missing keys fall back to the default locale (`en`), so a partially
translated locale still works. The standalone web app bundles all eight
catalogs at build time and selects one from `navigator.language` (see
`src/web/i18n.ts`), so it stays in sync with the extension.

## Target locales (8)

Default **English (`en`)**, plus EFIGS (fr, it, de, es), generic Portuguese
(`pt`), Japanese (`ja`), and Traditional Chinese (`zh_TW`). All 274 UI message keys
are present in every locale.

## Review status

| Locale         | Status                                                                    |
| -------------- | ------------------------------------------------------------------------- |
| en             | Source of truth.                                                          |
| fr             | Author-reviewed (project language).                                       |
| it, de, es, pt | Translated; recommend a light native proofread before 1.0.                |
| ja, zh_TW      | Translated; **native review required** before store submission (plan §7). |

The store `name` (`extName`, ≤ 75 chars) and `description` (`extDesc`, ≤ 132
chars) are keyword-oriented rather than literal translations. Before publishing,
do a short per-language keyword check (plan §7) and have a native speaker review
the CJK locales.

## Legal pages (Privacy Policy & Terms of Service)

The web app's `privacy.html` and `terms.html` keep fixed URLs (already
registered with search engines) but render in the reader's language. The prose
for all eight locales lives as structured JSON in `src/web/legal/<code>.json`;
`src/web/legal/render.ts` picks the locale (from a `?lang=` override or the
browser, with any `zh-*` mapped to `zh_TW`), builds the page as real DOM nodes,
and shows a visible language selector. `docs/PRIVACY.md` and `docs/TERMS.md`
remain the **English source of truth**; the `en.json` catalog mirrors them.

The 2026-08-09 privacy and hosted-delivery revision was synchronized across all
catalogs as draft copy. Every non-English legal catalog requires native review before
public 1.0.

`src/web/legal/legal.test.ts` guards the catalogs: every locale must match the
English structure exactly and preserve each `href` and `code` literal verbatim
(URLs and permission names are never translated). The **ja and zh_TW** legal
translations, like the UI strings, **need native review** before store
submission.

## Command-line tool

The CLI has its own catalogs in `src/cli/i18n/<code>.ts`: its strings share nothing
with the UI's (`--threshold must look like "2-of-3"` has no place in a browser), and
importing eight ~40KB `messages.json` files would have put 320KB of JSON into a
7KB launcher for a handful of terminal lines.

They are TypeScript, not JSON, so **`en.ts` is the type**: every other locale is
declared `CliCatalog`, which makes a missing or misnamed key a build error. What the
type cannot see, `i18n.test.ts` checks: that `{placeholders}` survived translation,
that nothing was left in English by accident (with a short, justified list of values
a language legitimately spells the English way), and that flag names and
`STEGOSHARD_*` variables were not translated.

`--help` is **data**, not prose. `usage.ts` renders the flag columns from the
descriptions, so alignment is computed once instead of being hand-kept in eight
languages, and no locale can drift out of structure. Adding an option means adding
a row and a description key.

Detection is ICU's default locale, overridable with `STEGOSHARD_LANG`; the test
suite pins `STEGOSHARD_LANG=en` (`vitest.config.ts`) so assertions on CLI text do
not depend on whose machine they run on. See
[CLI.md → Language](CLI.md#language).

The offline web bundle's notes ship in all eight languages too
(`src/web/offline/README.<code>.txt`), since someone who cannot read the English one
is exactly who needs them. The launcher wrappers' "Node.js was not found" message
stays English on purpose: it only appears when there is no Node to translate it.

**Review status:** the CLI catalogs and the bundle READMEs were written the same way
as the UI strings, so the same caveat applies. `ja` and `zh_TW` need a native review
before 1.0; the EFIGS set deserves a light proofread.

## Store screenshots (not yet automated)

The plan calls for store images generated from a single HTML/SVG template whose
captions come from these same locale files, rendered to PNG per locale with a
headless browser (Playwright). That pipeline is **not implemented yet**; a
Phase 6 / release task. Until then, store screenshots are produced manually.

## Adding or updating a locale

1. Copy `public/_locales/en/messages.json` to the new `<code>/` folder.
2. Translate each `message`. **Keep the `$PLACEHOLDER$` tokens** (e.g. `$COUNT$`,
   `$ALBUM$`) and the accompanying `placeholders` object exactly.
3. `description` fields are optional in non-default locales (they are translator
   hints) and are omitted here to keep files compact.
4. Run the build; verify the UI in that locale.

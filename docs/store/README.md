# Store listings — long descriptions (localized)

Ready-to-paste **long descriptions** for the browser-extension store pages
(Chrome Web Store, Microsoft Edge Add-ons, Firefox AMO), one file per supported
locale. Written for a general, non-technical audience: relatable use cases, a
plain feature list, and the repo link at the end.

One description per language is used for **all three stores** (it fits every
limit — see below). Paste the body of each file into the store's "detailed
description" field. The metadata line at the top of each file is an HTML comment
and is **not** part of the copy.

## Files

| Locale | File                   | Review status                                                         |
| ------ | ---------------------- | --------------------------------------------------------------------- |
| en     | [`en.md`](en.md)       | Source of truth                                                       |
| fr     | [`fr.md`](fr.md)       | Author-reviewed (project language)                                    |
| de     | [`de.md`](de.md)       | Translated + copy-edited — native check optional                      |
| es     | [`es.md`](es.md)       | Translated + copy-edited — native check optional                      |
| it     | [`it.md`](it.md)       | Translated + copy-edited — native check optional                      |
| pt     | [`pt.md`](pt.md)       | Translated (generic Portuguese) + copy-edited — native check optional |
| ja     | [`ja.md`](ja.md)       | Native-reviewed                                                       |
| zh_TW  | [`zh_TW.md`](zh_TW.md) | Native-reviewed                                                       |

`en.md` is the source of truth; the other seven mirror its structure. This is the
same 8-locale set as the UI (`docs/LOCALIZATION.md`).

## Name & short description live elsewhere

The store **name** (`extName`, ≤ 75 chars) and **short description**
(`extDesc`, ≤ 132 chars) are already localized in
`public/_locales/<code>/messages.json` — that is their source of truth. Do **not**
duplicate them here; take them from `_locales` at submission time.

## Length limits (for reference)

| Store            | Detailed description | Short description |
| ---------------- | -------------------- | ----------------- |
| Chrome Web Store | 16,000               | 132 (`extDesc`)   |
| Microsoft Edge   | larger               | 200               |
| Firefox AMO      | ~15,000              | 250 (summary)     |

Each long description here targets **≈ 1,500–2,500 characters**, well within every
limit.

## Editing rules

- Keep all locales structurally in sync with `en.md` (same sections, same order).
- **Do not** advertise deferred cloud-service integrations in the public store build
  (`docs/STORE.md`).
- **Do not** overclaim deniability ("undetectable", "invisible to experts"): the
  photo channel is fragile and the decoy `.db` only defeats a casual glance.
- **Do not** imply an external security audit (crypto audit still pending), and
  don't pitch the CLI as a one-click install.
- Frame StegoShard for **small secrets**, not whole-drive backups, and keep the
  "there is no password recovery" reminder.

See `docs/STORE.md` for the full submission guide (packaging, permission
justifications, per-store upload steps).

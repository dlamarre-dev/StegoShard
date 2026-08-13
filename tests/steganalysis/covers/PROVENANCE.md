# Cover photographs

Four CC0 photographs from Wikimedia Commons, used as steganalysis covers.

## Why real photographs, and not the existing fixtures

`scripts/gen-fixtures.ts` builds its covers from an LCG: every pixel is independent
noise. That is unusable here, and measurement showed the failure is worse than the
obvious one.

RS analysis, Sample Pairs and chi-square all work by measuring how far an image's
low-bit plane deviates from what a _natural_ image would show. In pure noise the low
bits are already uniformly random, which is what a fully-saturated carrier looks
like. StegExpose therefore reports the LCG covers as steganographic **before
anything is embedded**:

| cover      | clean | 20% embedded | 60% embedded |
| ---------- | ----- | ------------ | ------------ |
| LCG noise  | 0.667 | 0.784        | 0.977        |
| real photo | 0.031 | 0.196        | 0.455        |

A constant false positive, not a false negative. Either way no measurement taken on
those fixtures would mean anything.

## The set

Chosen for contrasting texture, because detector behaviour varies with it.

| File          | Commons title                                      | Licence | SHA-256 (first 16) |
| ------------- | -------------------------------------------------- | ------- | ------------------ |
| `car.jpg`     | 1998 Pontiac Grand Prix, front left, 4-5-2021      | CC0     | `d93a5c72dd1e1938` |
| `ceiling.jpg` | ! Bright Lights Ceiling !                          | CC0     | `2efee5e3f61c38cb` |
| `church.jpg`  | ! Russisch-Orthodoxe Kirche (Dresden) Zwiebeltürme | CC0     | `d17b37219345169c` |
| `square.jpg`  | !Defurovy Lažany - náměstí                         | CC0     | `979e6929f84f88ee` |

Every licence was read back from the Commons API (`extmetadata.LicenseShortName`)
and confirmed to be exactly `CC0` before the file was committed. CC0 means no
attribution obligation; the provenance is recorded here because a test fixture
whose origin is unknown is a fixture nobody can re-derive.

Retrieved 13 August 2026 at 800px width via the Commons thumbnailer, which is why
the stored files are 960px wide (the thumbnailer rounds up to an available size).

## Full checksums

```
d93a5c72dd1e1938ff5a0171253016a954ab186e67b205a65088da4f61782dd3  car.jpg
2efee5e3f61c38cbd6a0bbb73d292230375ce5dcb77c78e4bfe63d1359d16db9  ceiling.jpg
d17b37219345169c3f0597a1690266f84862a818ff893de6aa65b9516fe7cef1  church.jpg
979e6929f84f88ee6e462ff24333f5465c695de6675273555ed1052cc30ce940  square.jpg
```

## Validating a replacement

A cover only earns its place if the detectors work on it. Before adding one, check
that a naive LSB embed at 40% crosses StegExpose's 0.2 threshold on it, and that the
plaintext control image is found by zsteg. A cover that fails either check makes
every "clean" verdict measured on it worthless, so drop it and record why.

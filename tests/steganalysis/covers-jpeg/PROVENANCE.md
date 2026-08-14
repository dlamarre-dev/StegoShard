# JPEG cover photographs

Five camera originals, contributed by the maintainer and released under **CC0**.

## Why a second cover set

`../covers/` holds four Wikimedia photographs used by the PNG suite (zsteg,
StegExpose), whose thresholds are calibrated against those exact files. This
directory exists because the JPEG suite needs a property those files do not have.

Wikimedia serves resized thumbnails, so its images are **doubly compressed**:
encoded once by the photographer, then re-encoded by the thumbnailer. JPEG
steganalysis is known to be sensitive to that, and it showed: on the Wikimedia set
the Outguess and J-UNIWARD detectors scored untouched covers at 0.6-0.9 with
confidence near 0.5, which is noise.

These five come straight out of the camera pipeline (Pixel HDR+), so they are
compressed exactly once.

## Preparation

Cropped to 1024x768 with `jpegtran -crop`, which is lossless: it keeps the original
DCT coefficients, so the images stay single-compressed. Resizing would have
re-encoded them and reintroduced the problem the set exists to avoid.

`jpegtran -copy none` stripped every metadata marker. The originals carried GPS
coordinates on four of the five, plus camera model and HDR+ build. The Pixel
filenames also encoded capture timestamps, so the files were renamed by content.

## The set

| File           | Content                               | SHA-256 (first 16) |
| -------------- | ------------------------------------- | ------------------ |
| `beach.jpg`    | shoreline at sunrise, smooth gradient | `bf47c02c2eca1a03` |
| `lake.jpg`     | forest and still water at dusk        | `6d609e44e156d1e5` |
| `mountain.jpg` | snowfield, near-uniform               | `95bc3989c9d05c6d` |
| `night.jpg`    | near-black, heavy sensor noise        | `3a8197b802731f28` |
| `park.jpg`     | dense foliage and structures          | `022359b425285830` |

Chosen for contrasting texture, because detector behaviour varies sharply with it.
That choice paid off in an unexpected direction: two of the five turned out to be
unusable, and knowing which is part of the measurement.

## Which covers count, and why

A cover only earns a verdict if the detector can be shown to work on it. Measured
with Aletheia's Steghide detector, the only one that discriminates on this set:

| cover      | clean | outguess control | carries the instrument check         |
| ---------- | ----- | ---------------- | ------------------------------------ |
| `lake`     | 0.0   | 1.0              | yes                                  |
| `beach`    | 0.1   | 0.6              | yes                                  |
| `night`    | 0.0   | 0.8              | **no**, control arrives only locally |
| `park`     | 0.1   | 0.2              | **no**, control not detected         |
| `mountain` | 0.7   | n/a              | **no**, clean cover already flagged  |

`night` needs a further note. The table above was measured locally, where outguess
accepted it. On GitHub runners outguess has **declined it twice**, refusing to fit
the message into the smallest and darkest cover of the set. That is reproducible
rather than incidental, so `night` was removed from the control list: keeping it
there would have meant tolerating a control that never arrives, and the suite would
have run on two of three while reporting three.

It stays in this directory because the instrument check is not its only job. The
differential runs over every cover, and `night` contributes a texture none of the
others has: near-black with heavy sensor noise, where detectors behave differently
from a lit scene. Losing that would narrow the measurement to buy nothing.

`park` cannot demonstrate a positive, so a clean verdict on it means nothing.
`mountain` is a false positive before anything is embedded, much like the LCG
fixtures described in `../covers/PROVENANCE.md`. Both are kept in the set because
the differential comparison still applies to them, but neither may carry an
instrument check.

## Full checksums

```
bf47c02c2eca1a03f09fd7aeb6f4ba1cf25d54a3a34f459de569b25cc77422f3  beach.jpg
6d609e44e156d1e53d50008ec610bfb83fe5a899af7dece00c2738a0399a4277  lake.jpg
95bc3989c9d05c6d495c47da565e53b8c3c7024adb9d4292c25c08a4a9b87790  mountain.jpg
3a8197b802731f287ebdbd0bcdf34adbbd663fd74456aa7812a2d56b789e0a38  night.jpg
022359b4252858304f0ef6e5f2a9612e21e6941c7938ae17d121e8870ace9a78  park.jpg
```

## Adding a replacement

Camera original, never re-saved or exported. Crop losslessly with `jpegtran`, never
resize. Strip metadata with `-copy none` and rename away from any timestamped
filename. Then run the instrument check above: if the outguess control is not
detected on it, or the clean cover is already flagged, record it as non-conclusive
rather than counting it.

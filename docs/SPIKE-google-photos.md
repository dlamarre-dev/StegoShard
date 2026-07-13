# Spike: Google Photos recompression (Phase 4 gate)

**Question:** does the vault survive Google Photos, which re-encodes uploads as
JPEG? The plan requires validating this **before** building the upload/OAuth
path.

## Method

`src/spike/gp-recompression.test.ts` (runs in CI) renders a Cloud-profile QR,
puts it through a JPEG round-trip (jpeg-js) at Google-Photos-like qualities, and
checks the codec still decodes. Google Photos preserves luminance, subsamples
chroma 4:2:0, and downscales only very large images — our QR is black/white
(pure luminance), so chroma loss is irrelevant; the JPEG quality/quantization is
the real threat.

## Verdict

✅ **The Cloud profile (QR ECC level Q, large modules) survives.** It decodes
losslessly after a JPEG round-trip at qualities **92, 85, and 75**. Google Photos
generally recompresses at the higher end of this range, so there is comfortable
margin. This clears the Phase 4 gate: Google Photos is a viable *optional*
destination.

✅ **A classic LSB does not survive JPEG.** Low-bit data is scrambled to roughly
chance level by an 85-quality JPEG. This confirms the plan's pessimistic
assumption (§4): the *invisible* stego profile is **disk-only** (lossless PNG);
"invisible + survives Google Photos" is not achievable with a naive LSB. Stego
remains deferred; if/when it lands, its robust profile would use the Cloud codec
(visible), not LSB.

## Live verification ✅ (2026-07-13)

The full round-trip was confirmed against the real Google Photos API with a
configured OAuth client: a file was uploaded to a dedicated album, then selected
back through the Picker and **restored intact** (Cloud profile). The simulated
verdict holds in practice — Google Photos is a working optional destination.

Implementation notes that mattered:

- OAuth uses `browser.identity.launchWebAuthFlow` (implicit flow, no secret);
  the token is cached in `storage.session`. The `identity` + Google host
  permissions are optional and requested on demand.
- Upload: create a dedicated album → `appendonly` upload each PNG → batch-create
  into the album. Restore: Picker API session → poll → list → download → decode.
- The Photos **restore must run in its own tab** (`ui/photos.html`), not the
  popup: opening the picker dismisses the popup and would kill the flow.
- Uploaded images carry the readable title/date/page band, like disk and paper.

## Caveats

- Google Photos as data storage is **fragile on ToS grounds** and must never be
  the only copy — Disk and Paper do not depend on it (plan §11).
- The OAuth client id lives in a gitignored `.env` (see `.env.example`), injected
  at build time; the destination is hidden when it is not configured.
- **Google app verification** for the sensitive `photoslibrary.appendonly` scope
  is still required before *non-test* users can use it (test users work without
  it). This is a store/release concern for Phase 6.

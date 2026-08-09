# Release QA protocol

Record the release version, commit, tester, date, hardware/software versions, source
fixture SHA-256, restored SHA-256, and result for every row. Attach the completed record
to the release. A failure must be fixed or converted into an explicit documented support
limitation before 1.0.

## Automated gates

- Full lint, typecheck, unit/coverage, parser-fuzz smoke, fresh TypeScript→Python
  conformance, dependency audits, package verification, and browser E2E.
- Chrome packaged-extension workflow plus Chromium and Firefox hosted-app workflows.
- No unexpected requests, permissions, source maps, credentials, or deferred OAuth code
  in the exact release artifacts.
- Serious/critical accessibility scan plus a representative mobile screenshot in expert
  mode. The broader interaction and visual-state matrix below remains a manual release
  gate.

## Physical recovery matrix

Use a fixed UTF-8 text fixture and a small binary fixture, publish their SHA-256 hashes,
and create fresh embedded-key Paper output at 100% scale. Run every applicable capture
through both the web app and Python decoder.

| Print/capture path         | Required conditions                                                        | Acceptance                                                |
| -------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------- |
| Laser → iOS camera         | Normal light; low light; moderate perspective skew                         | Hash-identical recovery                                   |
| Laser → Android camera     | Normal light; low light; moderate perspective skew                         | Hash-identical recovery                                   |
| Inkjet → iOS camera        | Normal light; grayscale capture                                            | Hash-identical recovery                                   |
| Inkjet → Android camera    | Normal light; grayscale capture                                            | Hash-identical recovery                                   |
| Laser and inkjet → flatbed | 300 DPI color and grayscale                                                | Hash-identical recovery                                   |
| Digital degradation        | JPEG qualities 90/75, 75% downscale, and loss of up to `m` complete shards | Hash-identical recovery within the declared parity budget |

Print at actual size with browser/printer scaling disabled. “Moderate perspective skew”
means the complete code remains visible and the page corners differ by no more than 10°.
Do not claim recovery from cropped or physically destroyed codes; shard loss, not partial
symbol repair, is the documented resilience mechanism.

## Delayed usability gate

At least two people who did not implement the feature create a recovery set, store it for
seven days, then restore using only the bundled instructions. Both must recover the exact
fixture without developer assistance and correctly identify which password/key/share
artifacts must be retained.

## Manual store matrix

- Load the exact `dist-release` Chrome, Edge, and Firefox artifacts.
- Complete onboarding, generated-password key setup, lock/unlock, save/restore for each
  destination and key mode, wrong-password handling, weak-password acknowledgement,
  oversized-input rejection, and browser restart/session clearing.
- Verify keyboard-only navigation, focus visibility, screen-reader names, localized
  overflow, downloads, and absence of network traffic. Capture the chooser, guided
  save/restore, expert mode, weak-password warning, and representative error states for
  visual review.

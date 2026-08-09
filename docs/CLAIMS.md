# Claims and evidence register

No security or resilience claim should be strengthened in release copy without adding
evidence here. “Pending” claims are design goals, not release guarantees.

| Claim                                                  | Evidence                                                      | Status / limitation                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Core processing is local and makes no network requests | Manifest tests, package scan, CSP `connect-src 'none'`        | Verified for public builds; hosted code delivery remains a trust surface         |
| Confidentiality uses Argon2id and AES-256-GCM          | `SPEC.md` §§5–6, crypto vectors, TS/Python conformance        | Independent audit pending                                                        |
| Malformed input is resource-bounded                    | Parser tests, fuzzing, browser preflight and post-decode caps | Browser limits differ from the 1 GiB CLI binary limit                            |
| Missing image shards can be recovered                  | Reed–Solomon property and pipeline tests                      | Only within the encoded `m` parity budget                                        |
| Generated disk images round-trip losslessly            | Post-save verification and codec tests                        | Does not prove survival through arbitrary third-party processing                 |
| Printed recovery survives supported capture conditions | `docs/QA.md` physical matrix                                  | **Pending physical sign-off; do not advertise as a universal guarantee**         |
| Deniable paths avoid explicit mode/region errors       | Access-structure tests and fixed candidate schedule           | Not a formal timing, forensic-indistinguishability, legal, or coercion guarantee |
| Independent recovery remains possible                  | Python decoder and fresh-fixture CI conformance               | Current format is a pre-1.0 candidate until audit closure                        |
| No analytics, telemetry, or host permissions ship      | Source scan, manifest/package checks, privacy policy          | Downloaded release provenance must still be verified                             |

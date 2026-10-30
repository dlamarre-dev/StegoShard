# Dependency policy

StegoShard ships other people's code inside a cryptographic tool, and it has one
maintainer and no audit budget. That sets the policy: the dependency set that was
reviewed is held still, a security fix is taken quickly and minimally, and every
departure from the reviewed set is written down so the next review only has to look
at the delta.

## Tiers

What counts is what we **distribute**: the union of `.bundled/*.json`, written by
`scripts/bundled-packages.ts`. That includes three `devDependencies` the bundlers
inline, so the `dependencies` field alone is not the answer.

| Tier                    | What                             | Packages                                                                                                                                                                                                                  | Review before an update lands                                |
| ----------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **A — crypto**          | handles keys or secrets          | `hash-wasm` (Argon2id); Python `argon2-cffi`, `cryptography`                                                                                                                                                              | full checklist, known-answer vectors, JS↔Python cross-decode |
| **B — untrusted input** | parses images, archives, QR, PDF | `fflate`, `jsqr`, `pdf-lib`, `@pdf-lib/*`, `qrcode`, `fast-png`, `jpeg-js`, their transitive deps; Python `pillow`, `zxing-cpp`                                                                                           | full checklist, targeted fuzz run                            |
| **C — build chain**     | produces what ships              | `vite` (and `rolldown` under it), `typescript`, `tsx`, `@microsoft/api-extractor`, `webextension-polyfill`, GitHub Actions in the workflows that build or publish (`pages.yml`, `release-cli.yml`, `release-dry-run.yml`) | checklist, diff of the built output                          |
| **D — test and lint**   | never distributed                | vitest, eslint, playwright, stryker, GitHub Actions used only by test jobs (for example `ruby/setup-ruby`), …                                                                                                             | green CI                                                     |

Every shipped npm package is pinned to an exact version in `package.json`, so the
manifest says what the lockfile already enforces.

## Two lanes

### Fast lane: security fixes

Triggered by a Dependabot security PR (the `security` group), a GitHub advisory
alert, or a failing [security watch](../.github/workflows/security-watch.yml), which
re-audits the committed lockfiles daily because CI only runs on pushes.

1. **Triage within 24 hours.** Does the advisory reach code we ship, and is the
   vulnerable path reachable? If not, record it as accepted, with the reason, in
   `ACCEPTED` in `scripts/audit.ts` (npm) or as an `--ignore-vuln` with a comment in
   the workflow (Python). An accepted advisory is not a closed one: the entry is
   reported once it stops matching, and is removed then.
2. **Smallest fix.** The lowest version that fixes it: patch before minor before
   major, never "latest". For a transitive package, an `overrides` entry (npm) or a
   tightened bound in the `.in` file, then recompile the lock (Python).
3. **Review by tier**, with the checklist below cut to what the change touches.
   Cooldown does not apply here.
4. **Targets**, from triage to release:

   | Severity, reaching shipped code  | Target             |
   | -------------------------------- | ------------------ |
   | critical / high                  | 72 hours           |
   | moderate                         | 14 days            |
   | low, or dev-only at any severity | next routine batch |

5. **No upstream fix:** mitigate in our code, or disable the affected feature, and say
   so in a GitHub security advisory. Do not wait silently.
6. Release a patch version with a **Security** entry in `CHANGELOG.md`, and add a row
   to the log below.

### Slow lane: everything else

- **Tiers A, B, C:** no update without a reason: a bug that affects us, an end of
  support, or a prerequisite for a security fix. Dependabot still proposes the
  `shipped` and `build-chain` groups weekly so drift stays visible; a bump with no
  reason is closed, not merged. When updates are taken, they are batched at most quarterly and get the full
  checklist.
- **Tier D:** the weekly grouped PR, merged on green CI.

Dependabot holds a new release back for 7 days (14 for a major) before proposing it.
A compromised publish is usually caught and yanked within that window.

## Review checklist

For a tier A, B or C change, in the pull request:

- [ ] Changelog and any advisory read; the size of the change makes sense for what it
      claims to fix.
- [ ] Package diff read: `npm diff --diff=<pkg>@<old> --diff=<pkg>@<new>`, or the
      wheel/sdist diff for Python. Look for new install scripts, network access,
      `eval` / `Function`, new binaries or WASM blobs, and obfuscated code.
- [ ] Any new transitive package listed and justified; `npm run notices` re-run.
- [ ] Provenance: `npm audit signatures` passes; the publisher is unchanged; the
      release is at least 7 days old unless this is the fast lane.
- [ ] Tier A: `npm run golden:check` and the known-answer vectors pass, the Python
      decoder still decodes the fixtures, and the mutation score on the crypto
      modules has not dropped.
- [ ] Tier B: a targeted fuzz run (`scripts/fuzz.ts`) on the parser that changed.
- [ ] Tier C: the built artifacts diffed against the previous build (size, and
      content where it is not minified).
- [ ] A row added to the log below.

Automated tools (`npm audit`, `pip-audit`, CodeQL, an AI-assisted read of the diff)
are a second pair of eyes. They do not replace reading the diff.

## Audited baseline

The dependency set covered by the last security review. Filled in when the review
completes; until then this section lists the current shipped set as the starting
point.

- **Review:** _not yet performed_
- **Commit:** _—_

| Package               | Version | Tier |
| --------------------- | ------- | ---- |
| hash-wasm             | 4.12.0  | A    |
| fflate                | 0.8.3   | B    |
| jsqr                  | 1.4.0   | B    |
| pdf-lib               | 1.17.1  | B    |
| @pdf-lib/fontkit      | 1.1.1   | B    |
| qrcode                | 1.5.4   | B    |
| fast-png              | 8.0.0   | B    |
| jpeg-js               | 0.4.4   | B    |
| webextension-polyfill | 0.12.0  | C    |
| argon2-cffi (Python)  | 25.1.0  | A    |
| cryptography (Python) | 50.0.0  | A    |
| pillow (Python)       | 13.0.0  | B    |
| zxing-cpp (Python)    | 3.1.1   | B    |

Integrity hashes are in `package-lock.json` and `python/requirements.lock`; the
commit above pins them.

## Change log

Every change to a tier A, B or C package after the baseline.

| Date | Package | From → to | Lane | Reason / advisory | Review done |
| ---- | ------- | --------- | ---- | ----------------- | ----------- |

# Contributing to StegoShard

Thanks for your interest in contributing. StegoShard is a security-sensitive project, so
the contribution process is a little stricter than average, especially for anything
touching cryptography, the image codec, or erasure coding.

## Ground rules

- **Be respectful.** See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- **English only** in code, comments, commit messages, and documentation. UI strings are
  the exception: they live in `_locales/<code>/messages.json` and are localized.
- **Never invent cryptography.** Use WebCrypto (AES-GCM) and an audited Argon2id
  implementation. Changes to the crypto layer get extra scrutiny.
- **No secrets in the repo.** No API keys, OAuth client secrets, tokens, or personal
  data. Keep them in untracked local config.

## Workflow

The `main` branch is protected: **no direct pushes**. All changes land via pull request.

1. Fork and create a feature branch.
2. Make your change, with tests.
3. Ensure the local checks pass (below).
4. Open a PR against `main`. At least one review is required, the branch must be up to
   date, and all required checks must be green. PRs are merged with **squash**.

### Required checks (must pass before merge)

```bash
npm run ci:node
npm run package
npm run build:web
npm run build:cli
npm run build:lib
npm run pack:check
npm run test:e2e
```

These run automatically in CI (GitHub Actions) on every push and PR. CodeQL and
Dependabot also run on the repository.

`ci:node` includes `format:check`, so unformatted code fails the build. Run
`npm run format` to fix it.

### The public API surface

`docs/api/stegoshard.api.md` and `docs/api/stegoshard-node.api.md` record every
export of the published library, with its signature. They are **generated** by
api-extractor and **committed**, and `ci:node` runs `api:check`, which fails when
the live surface and the committed report disagree.

If your change moves the surface, regenerate with `npm run build:types` and commit
the result. Treat the diff as the decision it is: widening the API is a promise
that outlives the pull request, and narrowing it later is a breaking change. The
same reasoning as the golden corpus, one layer up.

`tests/api/surface.txt` is the same guard at the value level, catching a runtime
export the declaration rollup cannot see. It is compared by an ordinary test.

### Third-party notices

`THIRD_PARTY_NOTICES.txt` covers everything we distribute: what npm installs for a
consumer, **and** what each build inlines into an artifact we hand out. The second
half comes from `.bundled/<build>.json`, written by the bundler and committed.

So a change to dependencies, or to what a build bundles, means: run the builds,
then `npm run notices`, and commit both. CI fails if `.bundled/` moves without the
notices following. A package whose licence is not on the approved list, or that
ships no licence text, stops the build; both are decisions to record in
[docs/LICENSING.md](docs/LICENSING.md), not gates to loosen.

### Release dry run

The release workflows only fire on a `v*` tag, so their first real execution
used to be the release itself. `release-dry-run.yml` runs everything they do
except the publishing steps (the version guard, the offline web bundle, the
compiled CLI binaries) plus a check that every pinned action SHA still
resolves upstream. It runs weekly, on demand, and on PRs that touch workflows,
scripts, or the build configs.

It is intentionally **not** a required status check: it is path-filtered, and a
required check that does not run on most PRs blocks them. Run it by hand
(`gh workflow run "Release dry run"`) before tagging a release.

The only release step it cannot cover is publishing itself: the attestation and
the GitHub release upload, which need a real tag and write permissions the dry
run deliberately does not hold.

### Shell scripts

`scripts/*.sh` carry the release logic shared between the release workflows and
the dry run. Prettier cannot parse shell, so they are linted with `shellcheck`
in CI (`npm run lint:shell`). To run it locally, install shellcheck first:
`brew install shellcheck` or `apt install shellcheck`.

> **Repository administrators:** enable branch protection on `main` in the GitHub
> settings: require pull requests, at least one approving review, "up to date before
> merge", and the CI, typecheck, lint, test, and build checks as required status checks.
> These cannot be enforced from the codebase alone.

## Tests

- Written with [Vitest](https://vitest.dev/).
- Coverage thresholds are **per file, not aggregate**, and they are a ratchet: raise
  them as coverage rises, never lower one to make a build pass. Four zones carry their
  own floors, highest first: the core (crypto, codec, erasure coding), the published
  library under `src/api`, the UI modules measurable from node, and the command line.
  `vitest.config.ts` names which file sets each floor, so raising one is a decision
  someone can check rather than a number to guess at.
- A module is excluded only when it is **unreachable from a test**, not when it is
  merely awkward: something needing a DOM, a Worker or browser storage, or a top-level
  script that runs on import (`src/cli/main.ts`, `src/cli/serve-standalone.ts`). Each
  exclusion is listed with its reason, and several are exercised by the Playwright
  suite, which collects no coverage. Anything else belongs above the line with a floor.
- Prefer round-trip and property tests for the pipeline (encode → decode identity,
  reconstruct with up to `m` missing shards, reject a wrong password, etc.).

## Format stability

The current format is a versioned pre-1.0 candidate, not a frozen compatibility promise.
Breaking changes still require a version bump in the header and a spec update, and must
keep the Python reference decoder in sync (it doubles as a conformance test in CI).

Not everything that breaks the format looks like the format. The Argon2id cost
(`DEFAULT_ARGON2`) is not stored in the container on three paths, so changing it is a
breaking change even though no layout moves — and one that fails silently, as a wrong
password rather than a version error. `docs/VERSIONING.md` explains which constants behave
this way; `npm run spec:check` and `npm run golden:check` enforce it.

## Contribution licensing

Contributions are currently accepted under the repository's MIT License. Before doing
non-trivial work, read [docs/LICENSING.md](docs/LICENSING.md): the maintainer is evaluating
the post-beta licensing model, and changes in copyright ownership can constrain future
relicensing or dual licensing. Do not add third-party code without its license text and a
compatibility review.

## Building & releasing

Local builds (see `package.json` scripts):

- `npm run build` (Chrome/Edge), `build:firefox`, `build:web`: extension / web app.
- `npm run build:cli` then `npm run package:cli`: the standalone CLI (`deno compile`).
- `npm run package`: all store builds + packaging (see [docs/STORE.md](docs/STORE.md)).
- `npm run vectors` / `npm run fixtures`: regenerate committed crypto vectors /
  cross-implementation conformance fixtures (only when the format deliberately changes).

Release flow:

1. Land the changes on `main` (CI green: lint, typecheck, coverage, builds,
   Python conformance, QRAMM scan).
2. Update [CHANGELOG.md](CHANGELOG.md) and bump `package.json` `version` (SemVer).
   If the **on-disk format** changed, follow [docs/VERSIONING.md](docs/VERSIONING.md)
   (bump the format constant, sync the Python decoder, regenerate vectors/fixtures).
3. Tag `vX.Y.Z`; the CLI release is packaged by `.github/workflows/release-cli.yml`.
4. Store submissions: [docs/STORE.md](docs/STORE.md).

## Reviewers

`main` is protected and every PR needs a review. Cryptographic or on-format changes
should get a second set of eyes with security experience. **A standing crypto
reviewer is wanted**; open an issue if you can help. Until then, such PRs must cite
the relevant [SPEC.md](SPEC.md) / [docs/CRYPTO-REVIEW.md](docs/CRYPTO-REVIEW.md)
section and keep the conformance + hardening tests green.

## Commit messages

Use clear, imperative English (e.g. "Add Reed-Solomon shard reconstruction"). Keep
unrelated changes in separate PRs.

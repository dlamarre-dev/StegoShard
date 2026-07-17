# Contributing to StegoShard

Thanks for your interest in contributing. StegoShard is a security-sensitive project, so
the contribution process is a little stricter than average — especially for anything
touching cryptography, the image codec, or erasure coding.

## Ground rules

- **Be respectful.** See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- **English only** in code, comments, commit messages, and documentation. UI strings are
  the exception — they live in `_locales/<code>/messages.json` and are localized.
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
npm run lint
npm run typecheck
npm test
npm run build
```

These run automatically in CI (GitHub Actions) on every push and PR. CodeQL and
Dependabot also run on the repository.

> **Repository administrators:** enable branch protection on `main` in the GitHub
> settings — require pull requests, at least one approving review, "up to date before
> merge", and the CI, typecheck, lint, test, and build checks as required status checks.
> These cannot be enforced from the codebase alone.

## Tests

- Written with [Vitest](https://vitest.dev/).
- The core — crypto, codec, erasure coding — carries a high coverage bar (targeting
  ≥ 90% as Phase 1 lands); UI glue is tested pragmatically.
- Prefer round-trip and property tests for the pipeline (encode → decode identity,
  reconstruct with up to `m` missing shards, reject a wrong password, etc.).

## Format stability

Once `SPEC.md` is frozen (Phase 1), the on-image format is a **public, versioned
interface**. Breaking changes require a version bump in the header and a spec update, and
must keep the Python reference decoder in sync (it doubles as a conformance test in CI).

## Commit messages

Use clear, imperative English (e.g. "Add Reed-Solomon shard reconstruction"). Keep
unrelated changes in separate PRs.

## Summary

<!-- What does this PR change and why? -->

## Checklist

- [ ] Code, comments, and commit messages are in English (UI strings excepted; they live in `_locales/`).
- [ ] `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` pass locally.
- [ ] New/changed core logic (crypto, codec, erasure coding) comes with tests.
- [ ] No secrets, keys, tokens, or personal data added to the repo.
- [ ] If the on-image format changed: `SPEC.md` and the Python reference decoder are updated, with a header version bump.
- [ ] If this PR adds or strengthens a security or resilience claim: `docs/CLAIMS.md` carries the new evidence **and** the limitation it does not cover. Claims are not strengthened without evidence.

## Notes for reviewers

<!-- Anything security-relevant, trade-offs, or follow-ups. -->

/**
 * The export number, and the tag printed beside it.
 *
 * An AEAD tag authenticates a message; it cannot authenticate the *absence of a
 * newer* message. Nothing inside a container distinguishes it from an older,
 * entirely legitimate export of the same vault, so detecting a rollback needs a
 * memory the container does not carry.
 *
 * THIS TOOL'S MEMORY IS THE PERSON. They pass `--export-number` when they save,
 * and read it back when they restore. That is the whole mechanism, and the whole
 * of what replaced a local registry of vault identifiers and access times: a file
 * that proved how many vaults existed and when they were touched, which is
 * precisely the claim deniability rests on denying. The registry was built,
 * reviewed, and removed before it ever shipped; docs/THREAT-MODEL.md says so
 * rather than letting the section quietly disappear.
 *
 * What that costs, stated plainly: nothing compares the number for you. Two saves
 * at the same number produce two artifacts that both say `#4`, and an adversary
 * who can rewrite the vault rewrites the number with it. This is a legibility aid
 * with a human in the loop, not an anti-tamper control.
 */

import { randomBytes, toHex } from '@core';

/**
 * A fresh 16-byte tag for one export. **Never reused, never cached, never
 * derived** from the password, the DEK, the filename, a label, or a clock.
 *
 * This is a named function rather than an inline `randomBytes(16)` so that the
 * invariant has exactly one place to live. A stable id is the obvious "fix" for
 * someone who notices the tag changes between two exports of one vault, and it is
 * the specific regression this design exists to prevent: an id that persisted
 * across exports would be a correlation handle proving two artifacts are versions
 * of one thing, readable by anyone who unlocks either. `identity.test.ts` asserts
 * two calls differ, so that "fix" fails a test rather than shipping.
 */
export function mintVaultId(): Uint8Array {
  return randomBytes(16);
}

/**
 * The line printed on every save and restore that carries an identity:
 * `tag 3f8a1c02 · export #4`.
 *
 * It says **tag**, not "vault", and the word is doing work. The eight characters
 * identify this artifact and change on every export, so calling them a vault
 * would invite exactly the misreading that matters — seeing a different tag on
 * export #5 and concluding it is a different vault. Only the number is comparable
 * between exports; the tag distinguishes two artifacts that happen to share one.
 */
export function identityLine(vaultId: Uint8Array, sequence: number): string {
  return `tag ${toHex(vaultId).slice(0, 8)} · export #${sequence}`;
}

/**
 * Argument-shape validators for the command line.
 *
 * These stay in `src/cli` on purpose. They reject combinations of *flags* by
 * name, so their messages must be localized and must talk about `--codec` and
 * `--entropy-file`, neither of which exists for a library or MCP caller. They
 * are the only remaining users of `t()` outside `main.ts`, which is what lets
 * the orchestration layer be locale-free.
 *
 * Each returns the message to print, or null when the arguments are fine.
 */

import { CODEC_CHOICES, type CodecChoice } from '../api/node/commands';
import { t } from './i18n';

/**
 * Reject a `--codec` / `--paper` combination that cannot mean what it says.
 *
 * `requested` is what the user actually typed, not the resolved default: plain
 * `--paper` must keep working, and only an *explicit* `--codec color --paper` is
 * a mistake worth naming.
 */
export function codecArgError(requested: string | undefined, paper: boolean): string | null {
  if (requested !== undefined && !CODEC_CHOICES.includes(requested as CodecChoice)) {
    return t('errCodecInvalid', { value: String(requested) });
  }
  if (requested === 'color' && paper) {
    return t('errCodecColorPaper');
  }
  return null;
}

/** The ways the extra entropy layer can be supplied on the command line. */
export interface EntropySources {
  /** `--entropy <text>` */
  text?: string | undefined;
  /** `--entropy-file <path>` */
  file?: string | undefined;
  /** `--entropy-prompt` */
  prompt?: boolean | undefined;
}
// `STEGOSHARD_ENTROPY` is not listed: like STEGOSHARD_PASSWORD it is an ambient
// fallback that any typed flag simply outranks, so there is no combination of
// sources to reject.

/**
 * Reject an unusable `--entropy*` combination.
 *
 * Two rules. Combining sources is refused because it would be ambiguous which
 * one won, and silently ignoring the other is exactly the kind of surprise a
 * user reaching for this option cannot afford. An explicitly *empty* source is
 * refused for the same reason `resolvePassword` refuses an empty password: the
 * flag would have done nothing at all, and the user would never know.
 */
export function entropyArgError(src: EntropySources): string | null {
  const given = [
    src.text !== undefined && '--entropy',
    src.file !== undefined && '--entropy-file',
    src.prompt === true && '--entropy-prompt',
  ].filter((s): s is string => typeof s === 'string');
  if (given.length > 1) {
    return t('errEntropyExclusive', { flags: given.join(' and ') });
  }
  if (src.text !== undefined && src.text === '') {
    return t('errEntropyFlagEmpty');
  }
  return null;
}

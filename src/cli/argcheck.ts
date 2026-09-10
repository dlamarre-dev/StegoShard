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

/**
 * Reject a `--track` that cannot be honoured, and say which way it fails.
 *
 * Three ways, all reported rather than absorbed:
 *
 *   - A DENIABLE DESTINATION. The registry is a durable list of vault
 *     identifiers and access times in the user's home directory. On the deniable
 *     paths that is the most damaging thing the tool could write: it does not say
 *     where a vault is or what is in it, but it proves how many exist and when
 *     they were touched. Tracking is also structurally impossible there — the
 *     gallery and multi-region builders accept no identity parameter — so this
 *     check exists to say why, not to enforce it.
 *   - A COMMAND THAT NUMBERS NOTHING. Only `save` writes an identity into an
 *     envelope. `restore --track notes` used to be accepted and do nothing.
 *   - AN EMPTY LABEL. `--track ""` is not "no label"; it is a label the registry
 *     cannot match, so the export would be numbered #1 forever.
 *
 * In every case doing nothing quietly would be worse than refusing, because the
 * user would carry on believing the protection was there.
 */
export function trackingArgError(opts: {
  track: boolean;
  label?: string | undefined;
  command?: string | undefined;
  binary?: string | undefined;
  mode?: string | undefined;
}): { message: string; code: 'TRACKING_NOT_DENIABLE' | 'TRACKING_UNAVAILABLE' } | null {
  if (!opts.track) return null;
  const deniable = [
    opts.command === 'gallery-save' && 'gallery-save',
    opts.binary === 'disguised' && '--binary --disguise',
    opts.mode === 'duress' && '--duress',
    opts.mode === 'nonpossession' && '--non-possession',
  ].filter((s): s is string => typeof s === 'string');
  // Deniability first: a user who asked for both has made a mistake about what
  // the tool is for, and the narrower complaints would answer the wrong question.
  if (deniable.length > 0) {
    return {
      message: t('errTrackNotDeniable', { flags: deniable.join(', ') }),
      code: 'TRACKING_NOT_DENIABLE',
    };
  }
  if (opts.command !== undefined && opts.command !== 'save') {
    return {
      message: t('errTrackWrongCommand', { command: opts.command }),
      code: 'TRACKING_UNAVAILABLE',
    };
  }
  if (opts.label === '') {
    return { message: t('errTrackEmpty'), code: 'TRACKING_UNAVAILABLE' };
  }
  return null;
}

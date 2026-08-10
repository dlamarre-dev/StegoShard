/**
 * Guided workflow — a step-by-step wizard that walks a beginner through a save
 * or restore by asking one question at a time and collecting the needed files.
 * It drives the same shared `runSave` / `runRestore` controllers as the dense
 * "expert" UI, so the two never diverge. The DOM is built here (not in the HTML
 * files) so both the extension popup and the web app share one implementation;
 * each supplies its differences through a `WizardEnv`.
 */

import { type KeyMode, type ManifestEntry, type VaultKey } from '@core';
import {
  friendlyError as friendlyErrorWith,
  reflectFiles,
  renderManifest,
  wireDropzone,
} from './domhelpers';
import {
  CODEC_CHOICES,
  type CodecChoice,
  codecApplies,
  destKey,
  recoveryGuidance,
  runSave,
  type SaveDestination,
  type SaveRequest,
  writesOneFile,
} from './save-controller';
import { runRestore, type RestoreMode } from './restore-controller';
import type { Msg } from './save-controller';
import { makeProgressUI } from './progress-ui';
import {
  type DestEstimate,
  type Estimates,
  computeEstimates,
  firstCodecThatFits,
  formatSize,
} from './estimate';
import {
  MIN_PASSWORD_LENGTH,
  generatePassphrase,
  isStrongNewPassword,
  meetsPasswordFloor,
  passwordStrength,
} from './password';

export interface WizardCamera {
  open: () => void;
  capturedCount: () => number;
  capturedPayloads: () => Uint8Array[];
  clearCaptured: () => void;
  /** Subscribe to capture-count changes (fires while the scan modal is open). */
  onCountChange?: (cb: (count: number) => void) => void;
}

export interface WizardEnv {
  msg: Msg;
  locale: () => string;
  /** Save destinations to offer, in display order. */
  saveDestinations: SaveDestination[];
  /**
   * Obtain the vault key for a non-gallery save. The web app mints a fresh key
   * from the typed password; the extension returns its unlocked managed key and
   * ignores the argument.
   */
  getSaveKey: (password: string) => Promise<VaultKey>;
  /**
   * Whether the save flow must ask for a password. The web app always does (it
   * mints the key); the extension does not, since its key is already unlocked —
   * except for stego, which always needs the vault password (handled separately).
   */
  needsSavePassword: boolean;
  /** Extension only: confirm a typed password unlocks the managed key. */
  verifyStegoPassword?: (password: string) => Promise<boolean>;
  /** Web restore only: live camera capture. */
  camera?: WizardCamera;
  /** Leave the wizard — wired to the host's return-to-chooser (Back on step 1). */
  onExit?: () => void;
}

type Action = 'save' | 'restore';

interface State {
  action: Action | null;
  // save
  file: File | null;
  dest: SaveDestination;
  keyMode: KeyMode;
  codec: CodecChoice;
  stegoCover: File | null;
  covers: File[];
  savePassword: string;
  /** Per-destination availability for `file`, and what it was computed from. */
  estimates: Estimates | null;
  estimatesFor: File | null;
  /** The other inputs the counts depend on, so a change invalidates the cache. */
  estimatesKey: string | null;
  // restore
  restoreMode: RestoreMode;
  restoreFiles: File[];
  keyFile: File | null;
  restorePassword: string;
  // navigation
  index: number;
  done: boolean;
}

function initialState(env: WizardEnv): State {
  return {
    action: null,
    file: null,
    dest: env.saveDestinations[0] ?? 'disk',
    keyMode: 'embedded',
    codec: 'color',
    stegoCover: null,
    covers: [],
    savePassword: '',
    estimates: null,
    estimatesFor: null,
    estimatesKey: null,
    restoreMode: 'standard',
    restoreFiles: [],
    keyFile: null,
    restorePassword: '',
    index: 0,
    done: false,
  };
}

/** Minimal hyperscript: `h('div', { class: 'x' }, child, ...)`. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else node.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

const KEY_MODES: KeyMode[] = ['embedded', 'keyfile', 'stego'];

/**
 * Destinations whose goal is deniability — the artifact blends in as ordinary
 * files (photos, or a real SQLite database). The others (disk/paper QR,
 * branded binary) are overt: openly StegoShard by design.
 */
const DENIABLE_DESTS = new Set<SaveDestination>(['gallery', 'sqlite']);

export interface Wizard {
  /** Rebuild from the first step (used when re-entering the guided workflow). */
  reset(): void;
}

/**
 * Mount the wizard into `root`. Returns a handle whose `reset()` returns the
 * flow to its first step. `onExit` is a no-op hook the host can ignore.
 */
export function createWizard(root: HTMLElement, env: WizardEnv): Wizard {
  const { msg } = env;
  let state = initialState(env);
  const friendlyError = (err: unknown) => friendlyErrorWith(err, msg);

  // The camera scans asynchronously; subscribe once so the count on the current
  // restore step updates live as pages are captured (the node is re-created each
  // render, so we track the latest one and ignore updates when it's detached).
  let cameraCountNode: HTMLElement | null = null;
  let cameraSubscribed = false;
  function ensureCameraSub(): void {
    if (cameraSubscribed || !env.camera?.onCountChange) return;
    cameraSubscribed = true;
    env.camera.onCountChange((n) => {
      if (cameraCountNode) cameraCountNode.textContent = n > 0 ? msg('cameraCount', String(n)) : '';
    });
  }

  /** The ordered list of step ids that apply to the current state. */
  function steps(): string[] {
    if (state.action === null) return ['action'];
    if (state.action === 'save') {
      const s = ['action', 'file', 'dest'];
      if (state.dest === 'gallery') s.push('covers');
      // Only the image destinations render a symbol worth choosing a codec for.
      if (codecApplies(state.dest)) s.push('codec');
      // Key handling applies to every destination now (gallery too): embedded,
      // a separate .key, or hidden in a photo.
      s.push('keymode');
      if (state.keyMode === 'stego') s.push('stego');
      if (needsPasswordStep()) s.push('password');
      s.push('run');
      return s;
    }
    // The key step is offered for both modes: standard restores may need a .key
    // or stego cover, and a keyfile/stego gallery needs its external key too.
    const s = ['action', 'restore-mode', 'restore-files', 'keyfile', 'restore-password', 'run'];
    return s;
  }

  function needsPasswordStep(): boolean {
    if (state.dest === 'gallery') return true;
    // The disguised .db path is keyed by a per-save password (§10), not the
    // managed key — collect it on every surface.
    if (state.dest === 'sqlite') return true;
    if (env.needsSavePassword) return true;
    return state.keyMode === 'stego';
  }

  function go(delta: number): void {
    const list = steps();
    state.index = Math.max(0, Math.min(list.length - 1, state.index + delta));
    render();
  }

  function chooseAction(action: Action): void {
    state = { ...initialState(env), action, index: 1 };
    render();
  }

  // --- per-file destination availability + counts (shared with the expert UI) --

  /**
   * Compute which destinations fit and their output counts, caching by every
   * input that moves the numbers.
   *
   * Keying the cache on the file alone was wrong: the key mode changes the image
   * count too, and the key-mode step runs *after* the destination step, so the
   * availability shown at the destination step would never be revisited.
   */
  async function ensureEstimates(): Promise<void> {
    const file = state.file;
    const key = file ? `${state.keyMode}` : null;
    if (!file || (state.estimatesFor === file && state.estimatesKey === key)) return;
    let est: Estimates;
    try {
      est = await computeEstimates(file, env.saveDestinations, msg, {
        keyMode: state.keyMode,
        codec: state.codec,
      });
    } catch {
      // The file could not be read at all. Callers fire this without awaiting,
      // so it has to resolve — record "nothing fits" and let the file step say
      // so rather than leave the wizard spinning on "computing…".
      if (state.file !== file) return;
      state.estimates = {};
      state.estimatesFor = file;
      state.estimatesKey = key;
      render();
      return;
    }
    if (state.file !== file) return; // a newer file superseded this computation
    state.estimates = est;
    state.estimatesFor = file;
    state.estimatesKey = key;
    // If the remembered destination no longer fits, fall back to the first that does.
    if (!est[state.dest]?.available) {
      const firstOk = env.saveDestinations.find((d) => est[d]?.available);
      if (firstOk) state.dest = firstOk;
    }
    render();
  }

  const availableDests = (): SaveDestination[] =>
    env.saveDestinations.filter((d) => state.estimates?.[d]?.available);

  function countNote(dest: SaveDestination, e: DestEstimate): string {
    if (writesOneFile(dest)) return msg('wizOneFile');
    if (dest === 'gallery') return msg('wizGalleryPhotos', String(e.needed ?? e.count));
    // Follow whichever codec this destination would actually use.
    const n = e.counts?.[firstCodecThatFits(e, state.codec)] ?? e.count;
    return msg('wizImagesCount', String(n));
  }

  /** How many files the chosen destination would need under a given codec. */
  function codecNote(codec: CodecChoice): string | undefined {
    const n = state.estimates?.[state.dest]?.counts?.[codec];
    return n === undefined ? undefined : msg('codecCount', String(n));
  }

  // --- option lists (radio-style cards reusing the .segmented look) ----------

  function optionList(
    name: string,
    options: {
      value: string;
      label: string;
      desc: string;
      disabled?: boolean | undefined;
      note?: string | undefined;
      badge?: { text: string; deniable: boolean } | undefined;
    }[],
    current: string,
    onPick: (value: string) => void,
  ): HTMLElement {
    const wrap = h('div', { class: 'wiz-options' });
    for (const opt of options) {
      const input = h('input', {
        type: 'radio',
        name,
        value: opt.value,
        ...(opt.value === current && !opt.disabled ? { checked: '' } : {}),
        ...(opt.disabled ? { disabled: '' } : {}),
      });
      input.addEventListener('change', () => onPick(opt.value));
      wrap.append(
        h(
          'label',
          { class: opt.disabled ? 'wiz-option wiz-option--disabled' : 'wiz-option' },
          input,
          h(
            'span',
            { class: 'wiz-option-label' },
            opt.label,
            opt.badge
              ? h('span', {
                  class: `mode-badge ${opt.badge.deniable ? 'mode-badge--deniable' : 'mode-badge--overt'}`,
                  text: opt.badge.text,
                })
              : null,
          ),
          h('span', { class: 'wiz-option-desc muted', text: opt.desc }),
          opt.note ? h('span', { class: 'wiz-option-note', text: opt.note }) : null,
        ),
      );
    }
    return wrap;
  }

  // --- a dropzone-like file picker (single or multiple) ----------------------

  function filePicker(
    title: string,
    multiple: boolean,
    accept: string | null,
    current: File[],
    onPick: (files: File[]) => void,
  ): HTMLElement {
    const chip = h('span', { class: 'dz-file' });
    const input = h('input', {
      type: 'file',
      class: 'dropzone-input',
      ...(multiple ? { multiple: '' } : {}),
    });
    if (accept) input.setAttribute('accept', accept);
    const zone = h(
      'div',
      { class: 'dropzone dropzone-sm', tabindex: '0', role: 'button' },
      h(
        'span',
        { class: 'dz-prompt' },
        h('span', { class: 'dz-title', text: title }),
        h('br'),
        h('span', { class: 'muted', text: msg('dropPrompt') }),
      ),
      chip,
      input,
    );
    // Reuse the shared dropzone wiring (click / drag / drop → input.files + change).
    wireDropzone(zone, input, () => {
      reflectFiles(zone, chip, input);
      onPick(input.files ? Array.from(input.files) : []);
    });
    // A FileList can't be rebuilt from File[], so only the label is restored on
    // re-render; the picked files themselves live in the wizard's state.
    if (current.length) {
      chip.textContent = current.length === 1 ? current[0]!.name : String(current.length);
      zone.classList.add('has-file');
    }
    return zone;
  }

  const STRENGTH_KEYS = ['pwVeryWeak', 'pwWeak', 'pwFair', 'pwGood', 'pwStrong'];

  function passwordField(
    value: string,
    onInput: (v: string) => void,
    opts: { withMeter?: boolean } = {},
  ): HTMLElement {
    const input = h('input', {
      type: 'password',
      autocomplete: 'new-password',
      placeholder: msg('labelPassword'),
      value,
    });
    if (!opts.withMeter) {
      input.addEventListener('input', () => onInput(input.value));
      return input;
    }

    // Save flow: show a strength estimate and offer a generated passphrase.
    const bar = h('div', { class: 'pw-meter-bar' });
    const meter = h('div', { class: 'pw-meter' }, bar);
    const label = h('p', { class: 'muted pw-meter-label' });
    const refresh = (): void => {
      const s = passwordStrength(input.value);
      // No score class while the field is empty: the bar collapses to width 0.
      bar.className = input.value ? `pw-meter-bar pw-score-${s.score}` : 'pw-meter-bar';
      label.textContent = input.value
        ? `${msg(STRENGTH_KEYS[s.score]!)} · ~${s.bits} ${msg('pwBits')}`
        : '';
    };
    input.addEventListener('input', () => {
      onInput(input.value);
      refresh();
    });
    const gen = h('button', { type: 'button', class: 'wiz-link' }, msg('pwGenerate'));
    gen.addEventListener('click', () => {
      const p = generatePassphrase();
      input.value = p;
      input.type = 'text'; // reveal so the user can record it
      onInput(p);
      refresh();
    });
    refresh();
    return h('div', { class: 'pw-field' }, input, meter, label, gen);
  }

  // --- render one step -------------------------------------------------------

  function stepBody(id: string): { title: string; body: HTMLElement } {
    switch (id) {
      case 'action':
        return {
          title: msg('wizActionTitle'),
          body: optionList(
            'wiz-action',
            [
              { value: 'save', label: msg('wizActionSave'), desc: msg('wizActionSaveDesc') },
              {
                value: 'restore',
                label: msg('wizActionRestore'),
                desc: msg('wizActionRestoreDesc'),
              },
            ],
            state.action ?? '',
            (v) => chooseAction(v as Action),
          ),
        };
      case 'file': {
        const body = h(
          'div',
          {},
          filePicker(msg('dropTitle'), false, null, state.file ? [state.file] : [], (f) => {
            state.file = f[0] ?? null;
            state.estimates = null; // recompute for the new file
            render();
          }),
        );
        if (state.file) {
          if (state.estimatesFor !== state.file) {
            body.append(
              h('p', {
                class: 'muted wiz-fileinfo',
                text: `${formatSize(state.file.size)} · ${msg('wizComputing')}`,
              }),
            );
            void ensureEstimates();
          } else {
            const avail = availableDests();
            if (avail.length === 0) {
              body.append(h('p', { class: 'status error', text: msg('wizNoFormat') }));
            } else {
              body.append(
                h('p', {
                  class: 'muted wiz-fileinfo',
                  text: msg('wizFileInfo', [
                    formatSize(state.file.size),
                    avail.map((d) => destLabel(d)).join(', '),
                  ]),
                }),
              );
            }
          }
        }
        return { title: msg('wizFileTitle'), body };
      }
      case 'dest': {
        const labels: Record<SaveDestination, [string, string]> = {
          disk: [msg('destDisk'), msg('destDiskDesc')],
          paper: [msg('destPaper'), msg('destPaperDesc')],
          binary: [msg('destBinary'), msg('destBinaryDesc')],
          sqlite: [msg('destSqlite'), msg('destSqliteDesc')],
          gallery: [msg('destGallery'), msg('destGalleryDesc')],
        };
        if (state.file) void ensureEstimates();
        const est = state.estimates;
        return {
          title: msg('wizDestTitle'),
          body: optionList(
            'wiz-dest',
            env.saveDestinations.map((d) => {
              const e = est?.[d];
              const deniable = DENIABLE_DESTS.has(d);
              return {
                value: d,
                label: labels[d][0],
                desc: labels[d][1],
                disabled: e ? !e.available : false,
                note: e ? (e.available ? countNote(d, e) : e.reason) : '…',
                badge: {
                  text: msg(deniable ? 'badgeDeniable' : 'badgeOvert'),
                  deniable,
                },
              };
            }),
            state.dest,
            (v) => {
              state.dest = v as SaveDestination;
            },
          ),
        };
      }
      case 'covers': {
        if (state.file) void ensureEstimates();
        const needed = state.estimates?.gallery?.needed;
        return {
          title: msg('galleryCoversTitle'),
          body: h(
            'div',
            {},
            h('p', {
              class: 'muted',
              text: needed ? msg('wizGalleryCovers', String(needed)) : msg('galleryIntro'),
            }),
            filePicker(
              msg('galleryCoversTitle'),
              true,
              'image/png,image/jpeg',
              state.covers,
              (f) => {
                state.covers = f;
              },
            ),
          ),
        };
      }
      case 'codec': {
        // A codec that would blow the image limit is disabled here rather than
        // taking the destination down with it; snap off it if it was remembered.
        const here = state.estimates?.[state.dest];
        state.codec = firstCodecThatFits(here, state.codec);
        return {
          title: msg('codecHeading'),
          body: optionList(
            'wiz-codec',
            CODEC_CHOICES.map((c) => ({
              value: c,
              label: msg(`codec${c[0]!.toUpperCase()}${c.slice(1)}`),
              desc: msg(`codec${c[0]!.toUpperCase()}${c.slice(1)}Desc`),
              // The file count is the whole reason this choice is worth making,
              // so put it on the card rather than making the user infer it.
              note: codecNote(c),
              disabled: here?.codecFits?.[c] === false,
            })),
            state.codec,
            (v) => {
              state.codec = v as CodecChoice;
            },
          ),
        };
      }
      case 'keymode':
        return {
          title: msg('wizKeyTitle'),
          body: optionList(
            'wiz-keymode',
            KEY_MODES.map((k) => ({
              value: k,
              label: msg(`keyMode${k[0]!.toUpperCase()}${k.slice(1)}`),
              desc: msg(`keyMode${k[0]!.toUpperCase()}${k.slice(1)}Desc`),
            })),
            state.keyMode,
            (v) => {
              state.keyMode = v as KeyMode;
            },
          ),
        };
      case 'stego':
        return {
          title: msg('coverTitle'),
          body: h(
            'div',
            {},
            h('p', { class: 'muted warn', text: msg('stegoWarning') }),
            filePicker(
              msg('coverTitle'),
              false,
              'image/png,image/jpeg',
              state.stegoCover ? [state.stegoCover] : [],
              (f) => {
                state.stegoCover = f[0] ?? null;
              },
            ),
          ),
        };
      case 'password':
        return {
          title: msg('wizPasswordTitle'),
          body: h(
            'div',
            {},
            h('p', { class: 'muted', text: msg('wizPasswordDesc') }),
            passwordField(
              state.savePassword,
              (v) => {
                state.savePassword = v;
              },
              { withMeter: true },
            ),
          ),
        };
      case 'restore-mode':
        return {
          title: msg('wizRestoreModeTitle'),
          body: optionList(
            'wiz-restore-mode',
            [
              {
                value: 'standard',
                label: msg('restoreModeStandard'),
                desc: msg('wizRestoreStandardDesc'),
              },
              {
                value: 'gallery',
                label: msg('restoreModeGallery'),
                desc: msg('wizRestoreGalleryDesc'),
              },
            ],
            state.restoreMode,
            (v) => {
              state.restoreMode = v as RestoreMode;
            },
          ),
        };
      case 'restore-files': {
        const title =
          state.restoreMode === 'gallery' ? msg('galleryPhotosTitle') : msg('labelImagesOrZip');
        const accept =
          state.restoreMode === 'gallery'
            ? 'image/png,image/jpeg'
            : 'image/*,.zip,.pdf,application/pdf';
        const body = h(
          'div',
          {},
          filePicker(title, true, accept, state.restoreFiles, (f) => {
            state.restoreFiles = f;
          }),
        );
        if (env.camera && state.restoreMode === 'standard') {
          const count = h('p', { class: 'muted' });
          const n = env.camera.capturedCount();
          count.textContent = n > 0 ? msg('cameraCount', String(n)) : '';
          cameraCountNode = count; // updated live by the count subscription
          ensureCameraSub();
          const btn = h('button', {
            class: 'btn-ghost stack-gap',
            type: 'button',
            text: msg('btnScanCamera'),
          });
          btn.addEventListener('click', () => env.camera!.open());
          body.append(btn, count);
        }
        return { title: msg('wizRestoreFilesTitle'), body };
      }
      case 'keyfile':
        return {
          title: msg('labelKeyFileOrImage'),
          body: h(
            'div',
            {},
            h('p', { class: 'muted', text: msg('keyFileHint') }),
            filePicker(
              msg('labelKeyFileOrImage'),
              false,
              '.key,image/png,image/jpeg',
              state.keyFile ? [state.keyFile] : [],
              (f) => {
                state.keyFile = f[0] ?? null;
              },
            ),
          ),
        };
      case 'restore-password':
        return {
          title: msg('wizPasswordTitle'),
          body: passwordField(state.restorePassword, (v) => {
            state.restorePassword = v;
          }),
        };
      case 'run':
        return { title: msg('wizReviewTitle'), body: reviewBody() };
      default:
        return { title: '', body: h('div', {}) };
    }
  }

  function reviewBody(): HTMLElement {
    const lines: string[] = [];
    if (state.action === 'save') {
      lines.push(`${msg('wizReviewFile')}: ${state.file?.name ?? '—'}`);
      lines.push(`${msg('destHeading')}: ${destLabel(state.dest)}`);
      if (state.dest === 'gallery')
        lines.push(`${msg('galleryCoversTitle')}: ${state.covers.length}`);
      else lines.push(`${msg('keyModeHeading')}: ${keyModeLabel(state.keyMode)}`);
      if (codecApplies(state.dest)) {
        lines.push(`${msg('codecHeading')}: ${codecLabel(state.codec)}`);
      }
    } else {
      lines.push(
        `${msg('restoreModeStandard')}/${msg('restoreModeGallery')}: ${state.restoreMode}`,
      );
      const n = state.restoreFiles.length + (env.camera?.capturedCount() ?? 0);
      lines.push(`${msg('labelImagesOrZip')}: ${n}`);
    }
    // The status line is rendered by render() below the body — none is needed here.
    return h('div', {}, ...lines.map((l) => h('p', { class: 'muted', text: l })));
  }

  function destLabel(d: SaveDestination): string {
    return msg(`dest${d[0]!.toUpperCase()}${d.slice(1)}`);
  }
  function keyModeLabel(k: KeyMode): string {
    return msg(`keyMode${k[0]!.toUpperCase()}${k.slice(1)}`);
  }
  function codecLabel(c: CodecChoice): string {
    return msg(`codec${c[0]!.toUpperCase()}${c.slice(1)}`);
  }

  // --- run the actual save / restore -----------------------------------------

  async function buildSaveRequest(): Promise<SaveRequest> {
    // The stego cover (when chosen) is keyed by the same password the user typed.
    const stego =
      state.keyMode === 'stego' && state.stegoCover
        ? { cover: state.stegoCover, password: state.savePassword }
        : undefined;
    if (state.dest === 'gallery') {
      return {
        dest: 'gallery',
        files: [state.file!],
        covers: state.covers,
        galleryPassword: state.savePassword,
        keyMode: state.keyMode,
        stego,
      };
    }
    const key = await env.getSaveKey(state.savePassword);
    return {
      dest: state.dest,
      files: [state.file!],
      key,
      // The disguised .db path derives its slot KEK from this per-save password.
      password: state.dest === 'sqlite' ? state.savePassword : undefined,
      keyMode: state.keyMode,
      codec: state.codec,
      // Guided uses friendly defaults for the advanced knobs the expert UI exposes.
      asZip: state.dest === 'disk' ? true : undefined,
      includeInstructions: state.dest === 'paper',
      stego,
      locale: env.locale(),
    };
  }

  function validate(): string | null {
    const list = steps();
    const id = list[state.index];
    if (id === 'file') {
      if (!state.file) return msg('errNoFile');
      // Block only once estimates are in and nothing fits (they compute fast).
      if (state.estimatesFor === state.file && availableDests().length === 0) {
        return msg('wizNoFormat');
      }
    }
    if (id === 'covers') {
      if (state.covers.length === 0) return msg('errNoCovers');
      const needed = state.estimates?.gallery?.needed;
      if (needed && state.covers.length < needed) return msg('wizGalleryNeed', String(needed));
    }
    if (id === 'stego' && !state.stegoCover) return msg('errNoCover');
    if (id === 'password' && !state.savePassword) return msg('errNoPassword');
    if (id === 'restore-files') {
      const n = state.restoreFiles.length + (env.camera?.capturedCount() ?? 0);
      if (n === 0) return msg('errNoImages');
    }
    if (id === 'restore-password' && !state.restorePassword) return msg('errNoPassword');
    return null;
  }

  async function run(runBtn: HTMLButtonElement, status: HTMLElement): Promise<void> {
    runBtn.disabled = true;
    status.classList.remove('error');
    status.textContent = msg(
      state.action === 'save' ? destKey('statusSaving', state.dest) : 'statusRestoring',
    );
    const { bar, fill } = ensureProgress(status);
    const prog = makeProgressUI(bar, fill, status, msg);
    try {
      if (state.action === 'save') {
        const createsPassword =
          env.needsSavePassword || state.dest === 'gallery' || state.dest === 'sqlite';
        // The hard floor first: it is not waivable, so it must not be routed
        // through the confirm dialog that waives the advisory tier below.
        if (createsPassword && !meetsPasswordFloor(state.savePassword)) {
          runBtn.disabled = false;
          prog.done();
          status.classList.add('error');
          status.textContent = msg('errPasswordTooShort', String(MIN_PASSWORD_LENGTH));
          return;
        }
        if (
          createsPassword &&
          !isStrongNewPassword(state.savePassword) &&
          !confirm(msg('confirmWeakPassword'))
        ) {
          runBtn.disabled = false;
          prog.done();
          // The "saving…" line above was set before this check — leaving it up
          // would read as a run that silently stalled.
          status.textContent = '';
          return;
        }
        // Extension stego: confirm the password unlocks the managed key first.
        if (
          state.dest !== 'gallery' &&
          state.keyMode === 'stego' &&
          env.verifyStegoPassword &&
          !(await env.verifyStegoPassword(state.savePassword))
        ) {
          throw new Error(msg('errWrongPassword'));
        }
        const req = await buildSaveRequest();
        req.onProgress = prog.onProgress;
        const { note, manifest } = await runSave(req, msg);
        prog.done();
        showDone(note, manifest);
      } else {
        const { note } = await runRestore(
          {
            mode: state.restoreMode,
            files: state.restoreFiles,
            password: state.restorePassword,
            keyFile: state.keyFile ?? undefined,
            extraPayloads: env.camera?.capturedPayloads() ?? [],
            onProgress: prog.onProgress,
          },
          msg,
        );
        prog.done();
        env.camera?.clearCaptured();
        showDone(note);
      }
    } catch (err) {
      prog.done();
      status.textContent = friendlyError(err);
      status.classList.add('error');
      runBtn.disabled = false;
    }
  }

  /** Insert (once) a progress bar right after the run status line. */
  function ensureProgress(status: HTMLElement): { bar: HTMLElement; fill: HTMLElement } {
    const sibling = status.nextElementSibling;
    if (sibling instanceof HTMLElement && sibling.classList.contains('progress')) {
      return { bar: sibling, fill: sibling.firstElementChild as HTMLElement };
    }
    const bar = document.createElement('div');
    bar.className = 'progress';
    bar.setAttribute('role', 'progressbar');
    bar.hidden = true;
    const fill = document.createElement('div');
    fill.className = 'progress-bar';
    bar.appendChild(fill);
    status.after(bar);
    return { bar, fill };
  }

  function showDone(note: string, manifest: readonly ManifestEntry[] = []): void {
    state.done = true;
    // Don't keep the plaintext password alive in the closure after completion.
    state.savePassword = '';
    state.restorePassword = '';
    const guidance =
      state.action === 'save' && state.dest
        ? recoveryGuidance(state.dest, state.keyMode ?? 'embedded')
        : null;
    root.replaceChildren(
      h(
        'section',
        { class: 'card wiz' },
        h(
          'div',
          { class: 'result' },
          h('p', {
            class: 'result-title',
            text: msg(state.action === 'save' ? 'savedTitle' : 'restoredTitle'),
          }),
          h('p', { class: 'result-note', text: note }),
          // What was written, before what to keep: on the deniable destinations
          // these filenames are the only thing identifying the downloads.
          renderManifest(manifest, msg),
          guidance
            ? h(
                'div',
                { class: 'result-recovery' },
                h('p', { class: 'result-recovery-heading', text: msg('recoveryHeading') }),
                h(
                  'ul',
                  { class: 'recovery-list' },
                  ...guidance.items.map((k) => h('li', { text: msg(k) })),
                ),
                guidance.lossless
                  ? h('p', { class: 'muted warn', text: msg('recoveryLossless') })
                  : null,
              )
            : null,
        ),
        h('button', {
          class: 'btn-primary btn-lg',
          type: 'button',
          text: msg('wizStartOver'),
          onclick: () => {
            state = initialState(env);
            render();
          },
        }),
      ),
    );
  }

  function render(): void {
    if (state.done) return;
    const list = steps();
    const id = list[state.index]!;
    const { title, body } = stepBody(id);
    const isRun = id === 'run';
    const stepNo = state.index + 1;

    const status = h('p', { class: 'status', role: 'status' });
    const back = h('button', {
      class: 'btn-secondary',
      type: 'button',
      text: msg('wizBack'),
      // On the first step, Back leaves the wizard (returns to the chooser) if the
      // host wired onExit; otherwise it's disabled.
      ...(state.index === 0 && !env.onExit ? { disabled: '' } : {}),
      onclick: () => (state.index === 0 ? env.onExit?.() : go(-1)),
    });

    let nextBtn: HTMLButtonElement;
    if (isRun) {
      nextBtn = h('button', {
        class: 'btn-primary btn-lg',
        type: 'button',
        text: msg(state.action === 'save' ? destKey('wizRunSave', state.dest) : 'wizRunRestore'),
      });
      nextBtn.addEventListener('click', () => void run(nextBtn, status));
    } else {
      nextBtn = h('button', {
        class: 'btn-primary btn-lg',
        type: 'button',
        text: msg('wizNext'),
        onclick: () => {
          const err = validate();
          if (err) {
            status.textContent = err;
            status.classList.add('error');
            return;
          }
          go(1);
        },
      });
    }

    root.replaceChildren(
      h(
        'section',
        { class: 'card wiz' },
        h('p', {
          class: 'wiz-step muted',
          text: msg('wizStep', [String(stepNo), String(list.length)]),
        }),
        h('h2', { class: 'wiz-title', text: title }),
        body,
        status,
        h('div', { class: 'wiz-nav' }, back, nextBtn),
      ),
    );
  }

  render();
  return {
    reset(): void {
      state = initialState(env);
      render();
    },
  };
}

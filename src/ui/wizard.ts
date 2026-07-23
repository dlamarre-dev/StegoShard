/**
 * Guided workflow — a step-by-step wizard that walks a beginner through a save
 * or restore by asking one question at a time and collecting the needed files.
 * It drives the same shared `runSave` / `runRestore` controllers as the dense
 * "expert" UI, so the two never diverge. The DOM is built here (not in the HTML
 * files) so both the extension popup and the web app share one implementation;
 * each supplies its differences through a `WizardEnv`.
 */

import { type KeyMode, type VaultKey } from '@core';
import { friendlyError as friendlyErrorWith, reflectFiles, wireDropzone } from './domhelpers';
import {
  recoveryGuidance,
  runSave,
  type SaveDestination,
  type SaveRequest,
} from './save-controller';
import { runRestore, type RestoreMode } from './restore-controller';
import type { Msg } from './save-controller';
import { type DestEstimate, type Estimates, computeEstimates, formatSize } from './estimate';
import { generatePassphrase, passwordStrength } from './password';

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
  stegoCover: File | null;
  covers: File[];
  savePassword: string;
  /** Per-destination availability for `file`, and which file it was computed for. */
  estimates: Estimates | null;
  estimatesFor: File | null;
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
    stegoCover: null,
    covers: [],
    savePassword: '',
    estimates: null,
    estimatesFor: null,
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
 * files (photos, or a real SQLite database). The others (disk/paper/cloud QR,
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

  /** Compute (once per file) which destinations fit and their output counts. */
  async function ensureEstimates(): Promise<void> {
    const file = state.file;
    if (!file || state.estimatesFor === file) return;
    const est = await computeEstimates(file, env.saveDestinations, msg);
    if (state.file !== file) return; // a newer file superseded this computation
    state.estimates = est;
    state.estimatesFor = file;
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
    if (dest === 'binary' || dest === 'sqlite') return msg('wizOneFile');
    if (dest === 'gallery') return msg('wizGalleryPhotos', String(e.needed ?? e.count));
    return msg('wizImagesCount', String(e.count));
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
    const input = h('input', { type: 'file', ...(multiple ? { multiple: '' } : {}) });
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
      bar.className = `pw-meter-bar pw-score-${s.score}`;
      bar.style.width = `${input.value ? Math.max(8, s.score * 25) : 0}%`;
      label.textContent = input.value ? `${msg(STRENGTH_KEYS[s.score]!)} · ~${s.bits} ${msg('pwBits')}` : '';
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
              { value: 'restore', label: msg('wizActionRestore'), desc: msg('wizActionRestoreDesc') },
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
          cloud: [msg('destCloud'), msg('destCloudDesc')],
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
            filePicker(msg('galleryCoversTitle'), true, 'image/png,image/jpeg', state.covers, (f) => {
              state.covers = f;
            }),
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
              { value: 'standard', label: msg('restoreModeStandard'), desc: msg('wizRestoreStandardDesc') },
              { value: 'gallery', label: msg('restoreModeGallery'), desc: msg('wizRestoreGalleryDesc') },
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
          state.restoreMode === 'gallery' ? 'image/png,image/jpeg' : 'image/*,.zip,.pdf,application/pdf';
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
      if (state.dest === 'gallery') lines.push(`${msg('galleryCoversTitle')}: ${state.covers.length}`);
      else lines.push(`${msg('keyModeHeading')}: ${keyModeLabel(state.keyMode)}`);
    } else {
      lines.push(`${msg('restoreModeStandard')}/${msg('restoreModeGallery')}: ${state.restoreMode}`);
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
        file: state.file!,
        covers: state.covers,
        galleryPassword: state.savePassword,
        keyMode: state.keyMode,
        stego,
      };
    }
    const key = await env.getSaveKey(state.savePassword);
    return {
      dest: state.dest,
      file: state.file!,
      key,
      keyMode: state.keyMode,
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
    status.textContent = msg(state.action === 'save' ? 'statusSaving' : 'statusRestoring');
    try {
      if (state.action === 'save') {
        // Stego hides the key in a cover photo, which the cloud flow can't carry
        // (it only uploads the QR images) — mirror the expert UI's guard.
        if (state.dest === 'cloud' && state.keyMode === 'stego') {
          throw new Error(msg('errStegoCloud'));
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
        const { note } = await runSave(await buildSaveRequest(), msg);
        showDone(note);
      } else {
        const { note } = await runRestore(
          {
            mode: state.restoreMode,
            files: state.restoreFiles,
            password: state.restorePassword,
            keyFile: state.keyFile ?? undefined,
            extraPayloads: env.camera?.capturedPayloads() ?? [],
          },
          msg,
        );
        env.camera?.clearCaptured();
        showDone(note);
      }
    } catch (err) {
      status.textContent = friendlyError(err);
      status.classList.add('error');
      runBtn.disabled = false;
    }
  }

  function showDone(note: string): void {
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
                guidance.lossless ? h('p', { class: 'muted warn', text: msg('recoveryLossless') }) : null,
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
        text: msg(state.action === 'save' ? 'wizRunSave' : 'wizRunRestore'),
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
        h('p', { class: 'wiz-step muted', text: msg('wizStep', [String(stepNo), String(list.length)]) }),
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

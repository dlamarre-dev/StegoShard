/**
 * One progress bar for a whole operation, weighted by how long each part takes.
 *
 * WHY THIS EXISTS
 * The core reports progress one phase at a time (`progress.ts`), each from 0 to
 * its own total. Drawn directly, that is a bar that fills during encryption,
 * empties, fills again during verification, and sits still through every
 * Argon2 derivation, which is most of the wall-clock time of a gallery save and
 * reports nothing at all. A user watching it reasonably concludes it froze.
 *
 * This module is the missing half: a **plan** that lists, for each kind of
 * save, the stages in the order the code runs them and what each costs, and a
 * **tracker** that turns the phase events into one fraction of the total time.
 * Each stage gets a share of the bar proportional to its estimated duration, so
 * 50% means about half the waiting is over.
 *
 * ESTIMATES
 * Costs are per-device, so they come from a `Calibration`: milliseconds per
 * Argon2 MiB·iteration, per megabyte re-encoded, per image rendered, and so on.
 * A UI keeps one per browser and refines it after every save; the CLI starts
 * from the defaults. Either way the tracker corrects itself as it goes: when a
 * stage ends, the ratio of real to estimated time so far rescales everything
 * still ahead, so a device three times slower than the defaults is paced right
 * from the first Argon2 onward.
 *
 * Pure and DOM-free: the UI and the CLI draw what `ProgressTracker` returns.
 */

import type { Argon2Params } from './crypto';
import type { Progress } from './progress';

/** What a stage's duration scales with. */
export type CostKey =
  /** Per MiB·iteration of an Argon2id derivation (memory × passes). */
  | 'argon2'
  | 'reencodePerMB'
  | 'screenPerMB'
  | 'embedPerMB'
  | 'extractPerMB'
  | 'renderPerImage'
  | 'paperPerPage'
  | 'cryptoPerMB'
  | 'gzipPerMB'
  | 'deliverPerFile';

/** Milliseconds per unit of each cost, for one device. */
export type Calibration = { v: 1 } & Record<CostKey, number>;

/**
 * First-run costs, before a device has been measured.
 *
 * Deliberately on the slow side. An estimate that is too long shows a bar that
 * catches up at the end; one that is too short shows a bar that stalls near
 * 97% of a stage, which reads as frozen, the very impression this is here to
 * prevent. The tracker's in-run correction narrows either error after the first
 * stage ends.
 */
export const DEFAULT_CALIBRATION: Calibration = {
  v: 1,
  // ~2.5 s for the default 256 MiB × 4 passes.
  argon2: 2.5,
  reencodePerMB: 600,
  screenPerMB: 150,
  embedPerMB: 250,
  extractPerMB: 150,
  renderPerImage: 90,
  paperPerPage: 300,
  cryptoPerMB: 12,
  gzipPerMB: 25,
  deliverPerFile: 160,
};

/** What the status line says during a stage. The UI and CLI localize these. */
export type StageLabel =
  | 'checkingPassword'
  | 'deriving'
  | 'compressing'
  | 'preparingPhotos'
  | 'hiding'
  | 'hidingKey'
  | 'encrypting'
  | 'rendering'
  | 'verifying'
  | 'delivering'
  | 'unlocking'
  | 'reading'
  | 'decrypting';

/** One step of an operation, in the order the code runs it. */
export interface Stage {
  /** The event phase that reports this stage. */
  phase: Progress['phase'];
  label: StageLabel;
  cost: CostKey;
  /** How many units of `cost` this stage takes. */
  units: number;
  /** A fixed overhead on top, in milliseconds. */
  baseMs: number;
}

/** Everything a plan needs to know about a save, read before it starts. */
export interface SavePlanInput {
  surface: 'extension' | 'web' | 'cli';
  dest: 'gallery' | 'disk' | 'paper' | 'binary' | 'sqlite';
  keyMode: 'embedded' | 'keyfile' | 'stego';
  accessMode?: 'plain' | 'duress' | 'nonpossession' | undefined;
  /** Size of the secret, in bytes. */
  secretBytes: number;
  /** Size of each gallery cover, in bytes. File size stands in for pixels. */
  coverBytes?: readonly number[] | undefined;
  /** Size of the stego key cover, in bytes. */
  stegoCoverBytes?: number | undefined;
  /** How many images or pages the save will produce, when known in advance. */
  imageCount?: number | undefined;
  /** The image set is delivered as one `.zip` rather than one file per image. */
  asZip?: boolean | undefined;
  /** CLI `--preserve-container`: covers are not re-encoded. */
  preserveContainer?: boolean | undefined;
  /** The web app derives a fresh vault key before saving to a non-gallery destination. */
  mintsKey?: boolean | undefined;
  /** The extension checks the stego password (one derivation) before saving. */
  checksStegoPassword?: boolean | undefined;
  argon2?: Argon2Params | undefined;
}

const MB = 1024 * 1024;
const DEFAULT_KDF: Argon2Params = { iterations: 4, memoryKiB: 256 * 1024, parallelism: 1 };

function stage(
  phase: Progress['phase'],
  label: StageLabel,
  cost: CostKey,
  units: number,
  baseMs = 0,
): Stage {
  return { phase, label, cost, units: Math.max(0, units), baseMs };
}

/**
 * The stages of one save, in the order the code runs them.
 *
 * Each entry has to match what the save really emits, in order, or the tracker
 * will skip ahead: `progress-plan.test.ts` and the per-surface tests hold every
 * mode to its plan by replaying the real event stream.
 */
export function planSave(i: SavePlanInput): Stage[] {
  const kdf = i.argon2 ?? DEFAULT_KDF;
  const argon = (label: StageLabel, extraMs = 0): Stage =>
    stage('derive', label, 'argon2', (kdf.memoryKiB / 1024) * kdf.iterations, extraMs);
  const secretMB = i.secretBytes / MB;
  const covers = i.coverBytes ?? [];
  const coverMB = covers.reduce((a, b) => a + b, 0) / MB;
  const stegoMB = (i.stegoCoverBytes ?? 0) / MB;
  const stego = i.keyMode === 'stego';
  const out: Stage[] = [];

  if (i.checksStegoPassword && stego) out.push(argon('checkingPassword'));
  // The vault key is derived from the password before anything is reported: by
  // the web app for every destination but the gallery, and by the CLI for images,
  // paper and the branded container. The caller says which (`mintsKey`).
  if (i.mintsKey && i.dest !== 'gallery') out.push(argon('deriving'));

  // The stego key photo: embedded (one derivation), and verified (another)
  // everywhere except paper, which does not verify it.
  const stegoEmbed = (): Stage =>
    argon('hidingKey', i.dest === 'gallery' ? stegoMB * DEFAULT_CALIBRATION.reencodePerMB : 0);

  switch (i.dest) {
    case 'gallery': {
      const n = covers.length;
      if (i.surface !== 'cli')
        out.push(stage('compress', 'compressing', 'gzipPerMB', secretMB, 30));
      if (!i.preserveContainer)
        out.push(stage('reencode', 'preparingPhotos', 'reencodePerMB', coverMB, 20 * n));
      out.push(stage('prepare', 'preparingPhotos', 'screenPerMB', coverMB, 5 * n));
      out.push(argon('hiding')); // the vault's slot key
      out.push(argon('hiding')); // the winnowing key
      out.push(stage('embed', 'hiding', 'embedPerMB', coverMB, 10 * n));
      // The browser makes the key photo before verifying; the CLI after.
      if (stego && i.surface !== 'cli') out.push(stegoEmbed());
      out.push(argon('verifying'));
      out.push(stage('extract', 'verifying', 'extractPerMB', coverMB, 5 * n));
      out.push(argon('verifying'));
      if (stego && i.surface !== 'cli') out.push(argon('verifying'));
      if (stego && i.surface === 'cli') out.push(stegoEmbed());
      if (i.surface !== 'cli') {
        const files = n + (i.keyMode === 'embedded' ? 0 : 1);
        out.push(stage('deliver', 'delivering', 'deliverPerFile', files));
      }
      return out;
    }
    case 'disk':
    case 'paper': {
      const images = Math.max(1, i.imageCount ?? 1);
      const render =
        i.dest === 'disk'
          ? stage('render', 'rendering', 'renderPerImage', images)
          : // One step per page, plus the document's own serialization.
            stage('render', 'rendering', 'paperPerPage', images + 1, 400);
      const verify = stage('verify', 'verifying', 'cryptoPerMB', secretMB, 40);
      out.push(stage('encrypt', 'encrypting', 'gzipPerMB', secretMB, 40));
      if (i.surface === 'cli') {
        // The CLI verifies first, makes the key photo, then renders.
        out.push(verify);
        if (stego) out.push(stegoEmbed());
        out.push(render);
        return out;
      }
      if (i.dest === 'disk') {
        out.push(render);
        if (stego) out.push(stegoEmbed());
        out.push(verify);
        if (stego) out.push(argon('verifying'));
        const files = (i.asZip ? 1 : images) + (i.keyMode === 'embedded' ? 0 : 1);
        out.push(stage('deliver', 'delivering', 'deliverPerFile', files));
      } else {
        out.push(verify);
        out.push(render);
        // Paper does not verify the key photo, and downloads directly.
        if (stego) out.push(stegoEmbed());
      }
      return out;
    }
    case 'binary':
    case 'sqlite': {
      const mode = i.accessMode ?? 'plain';
      const slotKeys = i.dest === 'sqlite' ? (mode === 'duress' ? 2 : 1) : 0;
      // The slot keys are derived before the first event arrives; these stages
      // have no events of their own and end when the next one begins.
      for (let k = 0; k < slotKeys; k++) out.push(argon('encrypting'));
      if (i.dest === 'sqlite' && mode !== 'plain') {
        // The access modes run on the page and report only their encryption;
        // their compression and self-check are silent.
        out.push(stage('encrypt', 'encrypting', 'cryptoPerMB', secretMB * 2, 60));
        out.push(stage('verify', 'verifying', 'cryptoPerMB', secretMB * 2, 60));
      } else {
        out.push(stage('compress', 'compressing', 'gzipPerMB', secretMB, 20));
        out.push(stage('encrypt', 'encrypting', 'cryptoPerMB', secretMB, 20));
        if (i.dest === 'sqlite')
          out.push(stage('unlock', 'verifying', 'argon2', argon('verifying').units));
        out.push(stage('decrypt', 'verifying', 'cryptoPerMB', secretMB, 20));
      }
      if (stego) {
        out.push(stegoEmbed());
        // The browser proves the key photo opens; the CLI does not re-check it.
        if (i.surface !== 'cli') out.push(argon('verifying'));
      }
      if (i.surface !== 'cli') {
        const shares = mode === 'nonpossession' ? 3 : 0;
        out.push(
          stage(
            'deliver',
            'delivering',
            'deliverPerFile',
            1 + shares + (i.keyMode === 'embedded' ? 0 : 1),
          ),
        );
      }
      return out;
    }
  }
}

/** Everything a plan needs to know about a restore, read before it starts. */
export interface RestorePlanInput {
  surface: 'extension' | 'web' | 'cli';
  /**
   * What is being restored: a gallery's photos, an image set (loose or zipped
   * images), a printed PDF, a branded `.ssbn` or a disguised `.db`.
   */
  kind: 'gallery' | 'images' | 'pdf' | 'binary' | 'sqlite';
  /** Total size of the inputs, in bytes. */
  inputBytes: number;
  /** How many photos or images, when known (loose files; a zip counts as one). */
  imageCount?: number | undefined;
  /** A key photo is given explicitly: extracting it is one derivation. */
  keyPhoto?: boolean | undefined;
  /** Files beside a container, with no key given, are searched for its key photo. */
  searchesKeyPhoto?: boolean | undefined;
  argon2?: Argon2Params | undefined;
}

/**
 * The stages of one restore, in the order the code runs them. Same contract as
 * `planSave`: every entry has to match what the restore really emits.
 *
 * A key that turns out to be missing sends a gallery or an image set back
 * through a search and a second decode. That path is not in the plan; on it
 * the bar holds near its last stage until the restore completes.
 */
export function planRestore(i: RestorePlanInput): Stage[] {
  const kdf = i.argon2 ?? DEFAULT_KDF;
  const kdfUnits = (kdf.memoryKiB / 1024) * kdf.iterations;
  const argon = (phase: Progress['phase'] = 'derive'): Stage =>
    stage(phase, 'unlocking', 'argon2', kdfUnits);
  const mb = i.inputBytes / MB;
  const count = Math.max(1, i.imageCount ?? 1);
  const out: Stage[] = [];

  if (i.keyPhoto || i.searchesKeyPhoto) out.push(argon());
  switch (i.kind) {
    case 'gallery':
      out.push(argon()); // the winnowing key
      out.push(stage('extract', 'reading', 'extractPerMB', mb, 5 * count));
      out.push(argon()); // the vault's slot key
      break;
    case 'images':
    case 'pdf':
      out.push(stage('extract', 'reading', 'extractPerMB', mb, 40 * count));
      out.push(argon()); // the key block
      break;
    case 'binary':
    case 'sqlite':
      out.push(argon('unlock'));
      out.push(stage('decrypt', 'decrypting', 'cryptoPerMB', mb, 20));
      break;
  }
  if (i.surface !== 'cli') out.push(stage('deliver', 'delivering', 'deliverPerFile', 1));
  return out;
}

/** Estimated duration of one stage on a device, in milliseconds. */
export function estimateMs(s: Stage, c: Calibration): number {
  return s.baseMs + s.units * c[s.cost];
}

/** The display state after an event: what to draw now, and what to animate toward. */
export interface TrackerView {
  /** Fraction of the whole operation truly done, never decreasing. 0..1. */
  fraction: number;
  /** Where the bar may creep toward while nothing is reported. Never reached early. */
  target: number;
  /** How long reaching `target` is expected to take, in milliseconds. */
  targetMs: number;
  label: StageLabel;
  /** True once the last stage has ended. */
  finished: boolean;
}

/** One measured duration, for refining a `Calibration`. */
export interface CostSample {
  cost: CostKey;
  msPerUnit: number;
}

/** How close to a stage's end the bar may creep before the stage reports it. */
const CREEP = 0.97;
/** A stage whose per-unit work is estimated below this is not learned from. */
const MIN_LEARN_MS = 100;
/**
 * How far a learned cost may drift from its default, either way. A phone several
 * times slower than a desktop is well inside it; a runaway estimate is not.
 */
const CALIBRATION_RANGE = 20;
/** Bounds on the in-run pace correction. */
const PACE_MIN = 1 / 3;
const PACE_MAX = 3;

/**
 * Turns phase events into one monotonic fraction of the total time.
 *
 * The cursor only moves forward. An event for the current stage's phase updates
 * it; an event for a later stage's phase means every stage before that one is
 * over (some stages have no events of their own, like the derivation a worker
 * runs before its first message), and they are counted as done. An event that
 * matches nothing ahead is ignored.
 */
export class ProgressTracker {
  private readonly stages: Stage[];
  private readonly base: number[];
  private est: number[];
  private offset: number[];
  private weight: number[];
  private cursor = 0;
  private shown = 0;
  private stageStart: number;
  private lastDone = 0;
  private lastTotal = 0;
  private realSpent = 0;
  private estSpent = 0;
  private readonly measured: CostSample[] = [];
  private skippedCount = 0;

  constructor(
    stages: readonly Stage[],
    private readonly calibration: Calibration,
    private readonly now: () => number,
  ) {
    this.stages = stages.filter((s) => estimateMs(s, calibration) > 0);
    this.base = this.stages.map((s) => estimateMs(s, calibration));
    this.est = [...this.base];
    this.offset = [];
    this.weight = [];
    this.spread(0, 0);
    this.stageStart = now();
  }

  /** Assign stages `from..` their share of the bar that remains above `at`. */
  private spread(from: number, at: number): void {
    const rest = this.est.slice(from).reduce((a, b) => a + b, 0);
    let o = at;
    for (let i = from; i < this.stages.length; i++) {
      const w = rest > 0 ? ((1 - at) * this.est[i]!) / rest : 0;
      this.offset[i] = o;
      this.weight[i] = w;
      o += w;
    }
  }

  /** Close the current stage, measure it, and re-pace everything after it. */
  private finishStage(measure: boolean): void {
    const s = this.stages[this.cursor]!;
    const elapsed = Math.max(0, this.now() - this.stageStart);
    if (measure) {
      // Learned from only when the per-unit work is the bulk of the stage. For a
      // few kilobytes of secret the units are a sliver, the elapsed time is all
      // fixed overhead (and the UI's own frame waits), and dividing it by that
      // sliver reads as a rate hundreds of times too slow; learning from it
      // would ratchet the calibration upward on every small save.
      const variable = s.units * this.calibration[s.cost];
      if (s.units > 0 && variable >= Math.max(s.baseMs, MIN_LEARN_MS)) {
        const perUnit = Math.max(0, elapsed - s.baseMs) / s.units;
        this.measured.push({ cost: s.cost, msPerUnit: perUnit });
      }
      this.realSpent += elapsed;
      this.estSpent += this.est[this.cursor]!;
    }
    this.shown = Math.max(this.shown, this.offset[this.cursor]! + this.weight[this.cursor]!);
    this.cursor++;
    this.stageStart = this.now();
    this.lastDone = 0;
    this.lastTotal = 0;
    if (this.estSpent > 0) {
      const pace = Math.min(PACE_MAX, Math.max(PACE_MIN, this.realSpent / this.estSpent));
      for (let i = this.cursor; i < this.stages.length; i++) this.est[i] = this.base[i]! * pace;
    }
    this.spread(this.cursor, this.shown);
  }

  /** Feed one core event; returns what to draw. */
  onEvent(p: Progress): TrackerView {
    let j = -1;
    for (let i = this.cursor; i < this.stages.length; i++) {
      if (this.stages[i]!.phase === p.phase) {
        j = i;
        break;
      }
    }
    if (j < 0) return this.view();
    // Stages with no events of their own ended when a later one began.
    while (this.cursor < j) {
      this.skippedCount++;
      this.finishStage(false);
    }
    if (p.total > 0 && p.done >= p.total) {
      this.finishStage(true);
      return this.view();
    }
    this.lastDone = Math.max(0, p.done);
    this.lastTotal = Math.max(0, p.total);
    const f = this.lastTotal > 0 ? this.lastDone / this.lastTotal : 0;
    this.shown = Math.max(this.shown, this.offset[j]! + this.weight[j]! * f);
    return this.view();
  }

  /** The current display state, without new information. */
  view(): TrackerView {
    if (this.cursor >= this.stages.length) {
      const last = this.stages[this.stages.length - 1];
      return {
        fraction: 1,
        target: 1,
        targetMs: 0,
        label: last?.label ?? 'delivering',
        finished: true,
      };
    }
    const s = this.stages[this.cursor]!;
    const o = this.offset[this.cursor]!;
    const w = this.weight[this.cursor]!;
    const est = this.est[this.cursor]!;
    let target: number;
    let targetMs: number;
    if (this.lastTotal > 1) {
      // Counted: creep toward the end of the unit in progress.
      target = o + w * Math.min(CREEP, (this.lastDone + CREEP) / this.lastTotal);
      targetMs = est / this.lastTotal;
    } else {
      // Opaque, or not started: creep toward the stage's end over its estimate.
      target = o + w * CREEP;
      targetMs = Math.max(0, est - (this.now() - this.stageStart));
    }
    return {
      fraction: this.shown,
      target: Math.max(this.shown, target),
      targetMs,
      label: s.label,
      finished: false,
    };
  }

  /** Mark the operation done: the bar is full. */
  complete(): TrackerView {
    while (this.cursor < this.stages.length) this.finishStage(false);
    this.shown = 1;
    return this.view();
  }

  /**
   * How many stages ended without an event of their own. Some are meant to (a
   * derivation a worker runs before its first message); in a test that replays
   * a real event stream, anything more means the plan and the code disagree.
   */
  skipped(): number {
    return this.skippedCount;
  }

  /** Durations measured during this run, for `updateCalibration`. */
  samples(): readonly CostSample[] {
    return this.measured;
  }
}

/**
 * Fold measured durations into a calibration: an exponential moving average,
 * with each sample clamped to between a fifth and five times the current value
 * so that one save run in a background tab, or on a machine busy with something
 * else, cannot drag the estimates far in one go. The result stays within
 * `CALIBRATION_RANGE` of the default, so no sequence of bad samples can walk it
 * off without bound.
 */
export function updateCalibration(
  c: Calibration,
  samples: readonly CostSample[],
  alpha = 0.3,
): Calibration {
  const next: Calibration = { ...c };
  for (const s of samples) {
    const cur = next[s.cost];
    if (!Number.isFinite(s.msPerUnit) || s.msPerUnit < 0 || cur <= 0) continue;
    const clamped = Math.min(cur * 5, Math.max(cur / 5, s.msPerUnit));
    const base = DEFAULT_CALIBRATION[s.cost];
    const moved = cur + alpha * (clamped - cur);
    next[s.cost] = Math.min(base * CALIBRATION_RANGE, Math.max(base / CALIBRATION_RANGE, moved));
  }
  return next;
}

/** A calibration read back from storage, or null when it is not one. */
export function parseCalibration(value: unknown): Calibration | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.v !== 1) return null;
  const out: Calibration = { ...DEFAULT_CALIBRATION };
  for (const key of Object.keys(DEFAULT_CALIBRATION) as (keyof Calibration)[]) {
    if (key === 'v') continue;
    const n = v[key];
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[key] = n;
  }
  return out;
}

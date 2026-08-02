const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const CLEAR_LINE = '\r\x1b[2K';
const ICONS = {
  pending: '•',
  done: '✓',
  failed: '✗',
  skipped: '–',
} as const;

export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface Step {
  readonly label: string;
}

export interface StepListOptions {
  stream: NodeJS.WritableStream;
  intervalMs?: number;
  debug?: boolean;
}

/**
 * Run one checklist step to completion: mark it running, run the work, then
 * mark it done — or skipped when `skippedWhen` says the step did not apply.
 * Any error marks the step failed and propagates to the caller.
 */
export async function runStep<T>(
  list: StepList,
  step: Step,
  run: () => Promise<T>,
  skippedWhen?: (value: T) => boolean,
): Promise<T> {
  const startedAt = performance.now();
  list.markRunning(step);
  try {
    const value = await run();
    if (skippedWhen !== undefined && skippedWhen(value)) {
      list.markSkipped(step);
      debugStep(list, step, 'skipped', startedAt);
    } else {
      list.markDone(step);
      debugStep(list, step, 'done', startedAt);
    }
    return value;
  } catch (err) {
    list.markFailed(step);
    debugStep(list, step, 'failed', startedAt);
    throw err;
  }
}

function debugStep(list: StepList, step: Step, state: string, startedAt: number): void {
  if (list.debug) {
    list.log(`[debug] step "${step.label}" ${state} in ${Math.round(performance.now() - startedAt)}ms`);
  }
}

interface StepEntry {
  label: string;
  state: StepState;
}

/**
 * A persistent checklist of named steps rendered on a single stream. The full
 * list is shown up front (the caller adds every planned step before any runs)
 * and each step is ticked off as it finishes, so a long operation like
 * `sander create` shows exactly what is still pending instead of a lone
 * spinning message.
 *
 * On a TTY the list is redrawn in place: the step currently running spins, and
 * a finished step keeps its final icon on screen. `log()` prints a message
 * above the list without corrupting it, so mid-flight warnings stay visible.
 * On a non-TTY the list is printed one line per step as each step reaches its
 * final state (`finish()` prints whatever is still pending), so redirected
 * output is still a complete checklist.
 */
export class StepList {
  private readonly stream: NodeJS.WritableStream;
  private readonly intervalMs: number;
  private readonly entries: StepEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private rendered = false;
  readonly debug: boolean;

  constructor(opts: StepListOptions) {
    this.stream = opts.stream;
    this.intervalMs = opts.intervalMs ?? 80;
    this.debug = opts.debug ?? false;
  }

  get enabled(): boolean {
    return (this.stream as { isTTY?: boolean }).isTTY === true;
  }

  add(label: string): Step {
    const entry: StepEntry = { label, state: 'pending' };
    this.entries.push(entry);
    return entry;
  }

  markRunning(step: Step): void {
    this.transition(step, 'running');
  }

  markDone(step: Step): void {
    this.transition(step, 'done');
  }

  markFailed(step: Step): void {
    this.transition(step, 'failed');
  }

  markSkipped(step: Step): void {
    this.transition(step, 'skipped');
  }

  /** Print a message (a warning, an "Aviso", ...) without disturbing the list. */
  log(message: string): void {
    if (!this.enabled) {
      this.stream.write(`${message}\n`);
      return;
    }
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clearRendered();
    this.stream.write(`${message}\n`);
    this.rendered = false;
    this.render();
    this.syncTimer();
  }

  /** Leave the list in its final state; on a non-TTY, print pending steps. */
  finish(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.enabled) {
      for (const entry of this.entries) {
        if (entry.state === 'pending') {
          this.stream.write(`${ICONS.pending} ${entry.label}\n`);
        }
      }
      return;
    }
    this.render();
  }

  private transition(step: Step, state: StepState): void {
    const entry = this.entries.find((candidate) => candidate === step);
    if (entry === undefined) {
      return;
    }
    entry.state = state;
    if (!this.enabled) {
      if (state === 'done' || state === 'failed' || state === 'skipped') {
        this.stream.write(`${this.iconFor(entry, this.frame)} ${entry.label}\n`);
      }
      return;
    }
    this.render();
    this.syncTimer();
  }

  private iconFor(entry: StepEntry, frame: number): string {
    switch (entry.state) {
      case 'running':
        return FRAMES[frame % FRAMES.length]!;
      case 'done':
        return ICONS.done;
      case 'failed':
        return ICONS.failed;
      case 'skipped':
        return ICONS.skipped;
      default:
        return ICONS.pending;
    }
  }

  private render(): void {
    if (!this.enabled || this.entries.length === 0) {
      return;
    }
    if (this.rendered) {
      this.stream.write(`\x1b[${this.entries.length}A`);
    }
    for (const entry of this.entries) {
      this.stream.write(`${CLEAR_LINE}${this.iconFor(entry, this.frame)} ${entry.label}\n`);
    }
    this.rendered = true;
    this.frame++;
  }

  private clearRendered(): void {
    if (!this.rendered || !this.enabled) {
      return;
    }
    this.stream.write(`\x1b[${this.entries.length}A`);
    for (let i = 0; i < this.entries.length; i++) {
      this.stream.write(CLEAR_LINE);
      if (i < this.entries.length - 1) {
        this.stream.write('\n');
      }
    }
    this.rendered = false;
  }

  private syncTimer(): void {
    const hasRunning = this.entries.some((entry) => entry.state === 'running');
    if (hasRunning && this.timer === null) {
      this.timer = setInterval(() => this.render(), this.intervalMs);
    } else if (!hasRunning && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

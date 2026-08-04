import * as fs from 'node:fs';
import type { CommandRunner } from '../process/run';
import type { Provider } from '../provider/provider';
import { runSyncCycle } from './cycle';
import type { PlanSummary } from './plan';
import { isProcessAlive, readPid, watcherLogPath, writePid } from './watcher-state';

// Foreground polling watcher for `sander sync <id> --watch`. The first sync
// runs immediately at startup, then every `intervalMs` (2 s by default) in both
// directions. Every cycle appends its result (including conflicts) to the
// watcher log under the configDir, outside the worktree. Robustness: a down box
// (exec/pull failures) skips and logs the cycle without aborting the loop; the
// sandbox can be re-created or restarted and the watcher keeps polling.

export const DEFAULT_SYNC_INTERVAL_MS = 2000;

export interface WatchOptions {
  configDir: string;
  id: string;
  hostWorktree: string;
  provider: Provider;
  gitRunner?: CommandRunner;
  intervalMs?: number;
  warn?: (message: string) => void;
}

export interface WatchHandle {
  readonly started: boolean;
  readonly done: Promise<void>;
  stop(): void;
}

export function watchSync(opts: WatchOptions): WatchHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;

  // Refuse a second watcher while another process is live for the same id
  // (same pattern as the supervisor): the pidfile is the source of truth. A
  // stale pidfile with a dead pid never blocks a new watcher.
  const existing = readPid(opts.configDir, opts.id);
  if (existing !== undefined && existing !== process.pid && isProcessAlive(existing)) {
    opts.warn?.(`Aviso: ya hay un watcher de sync corriendo para "${opts.id}" (pid ${existing}); no se inicia otro.\n`);
    return {
      started: false,
      done: Promise.resolve(),
      stop(): void {},
    };
  }

  writePid(opts.configDir, opts.id, process.pid);

  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const log = (line: string): void => {
    if (stopped || !owned()) {
      return;
    }
    fs.appendFileSync(watcherLogPath(opts.configDir, opts.id), `${new Date().toISOString()} ${line}\n`, 'utf8');
  };

  const owned = (): boolean => readPid(opts.configDir, opts.id) === process.pid;

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    resolveDone();
  };

  const cycle = async (): Promise<void> => {
    if (stopped || running) {
      return;
    }
    // The pidfile disappeared (--stop cleaned it) or another watcher owns the
    // id now: this watcher is no longer the owner and exits gracefully. This
    // is also what lets the CLI tests stop the foreground loop deterministically.
    if (!owned()) {
      stop();
      return;
    }
    running = true;
    try {
      const io = {
        id: opts.id,
        hostWorktree: opts.hostWorktree,
        provider: opts.provider,
        gitRunner: opts.gitRunner,
        warn: (message: string) => log(`aviso: ${message.trim()}`),
      };
      let summary: PlanSummary;
      try {
        summary = await runSyncCycle(io);
      } catch (err) {
        if (!owned()) {
          stop();
          return;
        }
        log(`ciclo omitido: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (!owned()) {
        stop();
        return;
      }
      log(
        `sincronizado: ${summary.boxToHost} copiados box→host, ${summary.hostToBox} copiados host→box, ` +
          `${summary.conflicts} conflictos.`,
      );
    } finally {
      running = false;
    }
  };

  log(`watcher de sync iniciado (pid ${process.pid}); intervalo ${intervalMs} ms.`);

  // First sync immediately, then poll every interval.
  void cycle();
  timer = setInterval(() => {
    void cycle();
  }, intervalMs);

  return {
    started: true,
    done,
    stop,
  };
}

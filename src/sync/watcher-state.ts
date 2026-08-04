import * as fs from 'node:fs';
import * as path from 'node:path';

// Watcher state lives OUTSIDE the worktree, derived deterministically from the
// configDir: <configDir>/sync/<id>.pid and <configDir>/sync/<id>.log. Keeping
// it out of the worktree means a watcher never syncs its own runtime state. No
// registry schema change: the sandbox id identifies everything.

export const WATCHER_STATE_DIR = 'sync';

export interface StopWatcherResult {
  readonly status: 'stopped' | 'no-watcher';
  readonly pid: number | undefined;
}

export function watcherStateDir(configDir: string): string {
  return path.join(configDir, WATCHER_STATE_DIR);
}

export function watcherPidPath(configDir: string, id: string): string {
  return path.join(watcherStateDir(configDir), `${id}.pid`);
}

export function watcherLogPath(configDir: string, id: string): string {
  return path.join(watcherStateDir(configDir), `${id}.log`);
}

export function writePid(configDir: string, id: string, pid: number): void {
  fs.mkdirSync(watcherStateDir(configDir), { recursive: true });
  fs.writeFileSync(watcherPidPath(configDir, id), `${pid}\n`, 'utf8');
}

export function readPid(configDir: string, id: string): number | undefined {
  try {
    const raw = fs.readFileSync(watcherPidPath(configDir, id), 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      return undefined;
    }
    return pid;
  } catch {
    return undefined;
  }
}

export function removeState(configDir: string, id: string): void {
  fs.rmSync(watcherPidPath(configDir, id), { force: true });
  fs.rmSync(watcherLogPath(configDir, id), { force: true });
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Kills the watcher recorded in the pidfile (SIGTERM) and removes its pid and
 * log. Idempotent and never throws: with no watcher running (no pidfile, a
 * stale/dead pid, or a recycled innocent pid) it removes the stale state and
 * warns through the optional callback instead of failing.
 */
export function stopWatcher(id: string, configDir: string, warn?: (message: string) => void): StopWatcherResult {
  const pid = readPid(configDir, id);
  if (pid === undefined || !isProcessAlive(pid)) {
    removeState(configDir, id);
    warn?.(`Aviso: no hay watcher de sync corriendo para "${id}"; no se detiene nada.\n`);
    return { status: 'no-watcher', pid: undefined };
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // The process died between the liveness check and the kill; the end state
    // (no live watcher, state cleaned) is the same.
  }
  removeState(configDir, id);
  return { status: 'stopped', pid };
}

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  isProcessAlive,
  readPid,
  removeState,
  stopWatcher,
  watcherLogPath,
  watcherPidPath,
  watcherStateDir,
  writePid,
} from './watcher-state';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sander-watcher-state-'));
}

function waitForExit(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    proc.once('close', () => resolve());
  });
}

describe('watcher-state', () => {
  it('derives deterministic pid/log paths under the configDir, outside the worktree', () => {
    const configDir = '/tmp/sander-config';
    expect(watcherStateDir(configDir)).toBe(path.join(configDir, 'sync'));
    expect(watcherPidPath(configDir, 'demo')).toBe(path.join(configDir, 'sync', 'demo.pid'));
    expect(watcherLogPath(configDir, 'demo')).toBe(path.join(configDir, 'sync', 'demo.log'));
    expect(watcherPidPath(configDir, 'demo')).not.toContain('.git');
  });

  it('writes and reads back the pid', () => {
    const configDir = tmpDir();
    writePid(configDir, 'demo', 4242);
    expect(readPid(configDir, 'demo')).toBe(4242);
    expect(fs.readFileSync(path.join(configDir, 'sync', 'demo.pid'), 'utf8')).toContain('4242');
  });

  it('returns undefined for a missing or invalid pidfile', () => {
    const configDir = tmpDir();
    expect(readPid(configDir, 'demo')).toBeUndefined();
    fs.mkdirSync(path.join(configDir, 'sync'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'sync', 'demo.pid'), 'not-a-pid\n');
    expect(readPid(configDir, 'demo')).toBeUndefined();
  });

  it('removes pid and log together', () => {
    const configDir = tmpDir();
    writePid(configDir, 'demo', 4242);
    fs.writeFileSync(path.join(configDir, 'sync', 'demo.log'), 'line\n');
    removeState(configDir, 'demo');
    expect(fs.existsSync(path.join(configDir, 'sync', 'demo.pid'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'sync', 'demo.log'))).toBe(false);
  });

  it('reports whether a pid belongs to a live process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(99999999)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
  });

  it('kills a real watcher pid and cleans pid/log', async () => {
    const configDir = tmpDir();
    const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = proc.pid!;
    writePid(configDir, 'demo', pid);
    fs.writeFileSync(path.join(configDir, 'sync', 'demo.log'), 'old log\n');

    const result = stopWatcher('demo', configDir);

    expect(result.status).toBe('stopped');
    expect(result.pid).toBe(pid);
    await waitForExit(proc);
    expect(isProcessAlive(pid)).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'sync', 'demo.pid'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'sync', 'demo.log'))).toBe(false);
  });

  it('warns (no throw) and cleans stale state when no watcher is running', async () => {
    const configDir = tmpDir();
    const warnings: string[] = [];
    expect(stopWatcher('demo', configDir, (m) => warnings.push(m)).status).toBe('no-watcher');
    expect(warnings[0]).toContain('no hay watcher de sync');

    // A stale pidfile with a dead pid is cleaned up too, never trusted.
    const proc = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await waitForExit(proc);
    writePid(configDir, 'demo', proc.pid!);
    fs.writeFileSync(path.join(configDir, 'sync', 'demo.log'), 'stale log\n');
    const warnings2: string[] = [];
    const result = stopWatcher('demo', configDir, (m) => warnings2.push(m));
    expect(result.status).toBe('no-watcher');
    expect(warnings2[0]).toContain('no hay watcher de sync');
    expect(fs.existsSync(path.join(configDir, 'sync', 'demo.pid'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'sync', 'demo.log'))).toBe(false);
  });

  it('is idempotent: stopping twice never throws', () => {
    const configDir = tmpDir();
    expect(() => stopWatcher('demo', configDir)).not.toThrow();
    expect(() => stopWatcher('demo', configDir)).not.toThrow();
  });
});

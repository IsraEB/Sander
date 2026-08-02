import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'sander.js');

function runSander(args: string[], env: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: REPO_ROOT,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('sander binary (black box)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sander-bin-home-'));
  const env = { HOME: home, SANDER_CONFIG_DIR: home };

  it('prints help and exits 0', () => {
    const r = runSander(['--help'], env);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('sander');
    expect(r.stdout).toContain('list');
  });

  it('rejects an unknown command with exit 1', () => {
    const r = runSander(['frobnicate'], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown command');
  });

  it('lists an empty registry with exit 0', () => {
    const r = runSander(['list'], env);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No sandboxes found');
  });

  it('enforces the id rule on the real binary', () => {
    const r = runSander(['logs'], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('missing sandbox id');
  });

  it('reports unknown sandboxes on exec', () => {
    const r = runSander(['exec', 'abc', 'ls'], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('sandbox not found: abc');
  });

  it('reports unknown sandboxes on run', () => {
    const r = runSander(['run', 'abc', 'do the work'], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('sandbox not found: abc');
  });

  it('reports unknown sandboxes on attach', () => {
    const r = runSander(['attach', 'abc'], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('sandbox not found: abc');
  });

  it('requires a prompt on run', () => {
    const r = runSander(['run', 'abc'], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('missing prompt');
  });
});

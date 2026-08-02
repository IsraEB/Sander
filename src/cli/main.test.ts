import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { CaptureStream } from '../../test/helpers/capture-stream';
import { FakeProvider } from '../provider/fake';
import { FakeHarnessFactory } from '../harness/fake';
import { FakeWorktree } from '../worktree/fake';
import { runCli } from './main';
import type { CliDeps } from './deps';
import { emptyRegistry, saveRegistry, upsertBox } from '../registry/registry';
import type { Sandbox } from '../registry/registry';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sander-cli-test-'));
}

function makeDeps(configDir: string): { deps: CliDeps; harnessFactory: FakeHarnessFactory; stdout: CaptureStream; stderr: CaptureStream } {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const provider = new FakeProvider();
  const harnessFactory = new FakeHarnessFactory();
  return {
    deps: { configDir, stdout, stderr, stdin: new PassThrough(), createProvider: () => provider, harnessFactory, worktree: new FakeWorktree() },
    harnessFactory,
    stdout,
    stderr,
  };
}

function makeBox(id: string, overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    id,
    provider: 'docker',
    harness: 'opencode',
    status: 'running',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    projectRoot: '/tmp/project',
    ...overrides,
  };
}

describe('runCli', () => {
  it('prints help and exits 0 with no arguments', async () => {
    const { deps, stdout } = makeDeps(tmpDir());
    const code = await runCli([], deps);
    expect(code).toBe(0);
    expect(stdout.text()).toContain('sander');
    expect(stdout.text()).toContain('list');
    expect(stdout.text()).toContain('setup');
  });

  it('prints help for -h and --help', async () => {
    for (const flag of ['-h', '--help']) {
      const { deps, stdout } = makeDeps(tmpDir());
      const code = await runCli([flag], deps);
      expect(code).toBe(0);
      expect(stdout.text()).toContain('Usage:');
    }
  });

  it('prints command help for sander help <command>', async () => {
    const { deps, stdout } = makeDeps(tmpDir());
    const code = await runCli(['help', 'exec'], deps);
    expect(code).toBe(0);
    expect(stdout.text()).toContain('sander exec');
  });

  it('rejects an unknown command with exit 1', async () => {
    const { deps, stderr } = makeDeps(tmpDir());
    const code = await runCli(['frobnicate'], deps);
    expect(code).toBe(1);
    expect(stderr.text()).toContain('unknown command');
  });

  it('lists an empty registry with exit 0', async () => {
    const { deps, stdout } = makeDeps(tmpDir());
    const code = await runCli(['list'], deps);
    expect(code).toBe(0);
    expect(stdout.text()).toContain('No sandboxes found');
  });

  it('lists registered sandboxes', async () => {
    const dir = tmpDir();
    const registry = emptyRegistry();
    upsertBox(registry, makeBox('abc'));
    upsertBox(registry, makeBox('zzz', { harness: 'claude', status: 'stopped' }));
    saveRegistry(dir, registry);

    const { deps, stdout } = makeDeps(dir);
    const code = await runCli(['list'], deps);
    expect(code).toBe(0);
    expect(stdout.text()).toContain('abc');
    expect(stdout.text()).toContain('zzz');
    expect(stdout.text()).toContain('opencode');
    expect(stdout.text()).toContain('claude');
    expect(stdout.text()).toContain('stopped');
  });

  it('reflects the registry across working directories', async () => {
    const dir = tmpDir();
    const registry = emptyRegistry();
    upsertBox(registry, makeBox('persisted'));
    saveRegistry(dir, registry);

    const cwdDir = tmpDir();
    const { deps, stdout } = makeDeps(dir);
    process.chdir(cwdDir);
    try {
      const code = await runCli(['list'], deps);
      expect(code).toBe(0);
      expect(stdout.text()).toContain('persisted');
    } finally {
      process.chdir(dir);
    }
  });

  it('enforces the shared id rule', async () => {
    const dir = tmpDir();
    for (const command of ['run', 'exec', 'attach', 'stop', 'start', 'rm', 'logs']) {
      const { deps, stderr } = makeDeps(dir);
      const code = await runCli([command], deps);
      expect(code).toBe(1);
      expect(stderr.text()).toContain('missing sandbox id');
    }
  });

  it('accepts positional ids on exec', async () => {
    const { deps, stderr } = makeDeps(tmpDir());
    const code = await runCli(['exec', 'abc', 'ls'], deps);
    expect(code).toBe(1);
    expect(stderr.text()).toContain('sandbox not found: abc');
  });

  it('reports unknown sandboxes on run', async () => {
    const { deps, stderr } = makeDeps(tmpDir());
    const code = await runCli(['run', 'abc', 'do the work'], deps);
    expect(code).toBe(1);
    expect(stderr.text()).toContain('sandbox not found: abc');
  });

  it('reports unknown sandboxes on attach', async () => {
    const { deps, stderr } = makeDeps(tmpDir());
    const code = await runCli(['attach', 'abc'], deps);
    expect(code).toBe(1);
    expect(stderr.text()).toContain('sandbox not found: abc');
  });

  it('accepts --sandbox ids on logs', async () => {
    const { deps, stderr } = makeDeps(tmpDir());
    const code = await runCli(['logs', '--sandbox', 'abc'], deps);
    expect(code).toBe(1);
    expect(stderr.text()).toContain('sandbox not found: abc');
  });
});

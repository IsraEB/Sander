import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CaptureStream } from '../../../test/helpers/capture-stream';
import { FakeProvider } from '../../provider/fake';
import type { ProviderOp } from '../../provider/fake';
import { FakeHarnessFactory } from '../../harness/fake';
import { FakeWorktree } from '../../worktree/fake';
import { runCli } from '../main';
import type { CliDeps } from '../deps';
import type { CommandRunner } from '../../process/run';
import { emptyRegistry, saveRegistry, upsertBox } from '../../registry/registry';
import type { Sandbox } from '../../registry/registry';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sander-sync-test-'));
}

interface Ctx {
  deps: CliDeps;
  provider: FakeProvider;
  stdout: CaptureStream;
  stderr: CaptureStream;
}

function makeCtx(configDir: string): Ctx {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const provider = new FakeProvider();
  return {
    deps: {
      configDir,
      stdout,
      stderr,
      createProvider: () => provider,
      harnessFactory: new FakeHarnessFactory(),
      worktree: new FakeWorktree(),
      gitRunner: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    },
    provider,
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
    branch: id,
    worktreePath: '/tmp/project-sander-demo',
    ...overrides,
  };
}

function register(ctx: Ctx, box: Sandbox): void {
  const registry = emptyRegistry();
  upsertBox(registry, box);
  saveRegistry(ctx.deps.configDir, registry);
}

// The host-side git status is a seam (gitRunner); the fake returns the given
// porcelain output for any `status` invocation against the worktree.
function setHostStatus(ctx: Ctx, stdout: string): void {
  ctx.deps.gitRunner = ((args: string[]) => {
    if (args[2] === 'status') {
      return { exitCode: 0, stdout, stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }) as CommandRunner;
}

// The box-side behavior is a seam (provider.exec): the fake answers git status
// with the given porcelain output and `cat` with the simulated in-box files.
function simBox(ctx: Ctx, sim: { status: string; files?: Record<string, string> }): void {
  ctx.provider.execHook = (id, command) => {
    const joined = command.join(' ');
    if (joined === 'git -C /workspace status --porcelain -uall') {
      return { exitCode: 0, stdout: sim.status, stderr: '' };
    }
    if (command[0] === 'cat' && command[1] !== undefined && sim.files?.[command[1]] !== undefined) {
      return { exitCode: 0, stdout: sim.files![command[1]]!, stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

function execOps(ctx: Ctx): Array<Extract<ProviderOp, { op: 'exec' }>> {
  return ctx.provider.ops.filter((op): op is Extract<ProviderOp, { op: 'exec' }> => op.op === 'exec');
}

function pullOps(ctx: Ctx): Array<Extract<ProviderOp, { op: 'pull' }>> {
  return ctx.provider.ops.filter((op): op is Extract<ProviderOp, { op: 'pull' }> => op.op === 'pull');
}

function copyOps(ctx: Ctx): Array<Extract<ProviderOp, { op: 'copy' }>> {
  return ctx.provider.ops.filter((op): op is Extract<ProviderOp, { op: 'copy' }> => op.op === 'copy');
}

describe('sander sync', () => {
  it('pulls a box-only change into the host worktree and reports it in the summary', async () => {
    const configDir = tmpDir();
    const worktree = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { worktreePath: worktree }));
    setHostStatus(ctx, '');
    simBox(ctx, { status: ' M src/index.ts\n' });

    const code = await runCli(['sync', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(execOps(ctx)[0]?.command).toEqual(['git', '-C', '/workspace', 'status', '--porcelain', '-uall']);
    expect(pullOps(ctx)).toContainEqual({
      op: 'pull',
      id: 'demo',
      source: '/workspace/src/index.ts',
      destination: path.join(worktree, 'src', 'index.ts'),
    });
    expect(copyOps(ctx)).toHaveLength(0);
    expect(ctx.stdout.text()).toContain('1 copiados box→host');
    expect(ctx.stdout.text()).toContain('0 copiados host→box');
    expect(ctx.stdout.text()).toContain('0 conflictos');
  });

  it('copies a host-only change into the box with --yes in the same cycle', async () => {
    const configDir = tmpDir();
    const worktree = tmpDir();
    fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'src', 'index.ts'), 'host content');
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { worktreePath: worktree }));
    setHostStatus(ctx, ' M src/index.ts\n');
    simBox(ctx, { status: '' });

    const code = await runCli(['sync', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(copyOps(ctx)).toContainEqual({
      op: 'copy',
      id: 'demo',
      source: path.join(worktree, 'src', 'index.ts'),
      destination: '/workspace/src/index.ts',
      yes: true,
    });
    expect(pullOps(ctx)).toHaveLength(0);
    expect(ctx.stdout.text()).toContain('0 copiados box→host');
    expect(ctx.stdout.text()).toContain('1 copiados host→box');
  });

  it('treats untracked paths like modified paths in both directions', async () => {
    const configDir = tmpDir();
    const worktree = tmpDir();
    fs.writeFileSync(path.join(worktree, 'new-host.txt'), 'host new');
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { worktreePath: worktree }));
    setHostStatus(ctx, '?? new-host.txt\n');
    simBox(ctx, { status: '?? new-box.txt\n' });

    const code = await runCli(['sync', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(copyOps(ctx)).toContainEqual({
      op: 'copy',
      id: 'demo',
      source: path.join(worktree, 'new-host.txt'),
      destination: '/workspace/new-host.txt',
      yes: true,
    });
    expect(pullOps(ctx)).toContainEqual({
      op: 'pull',
      id: 'demo',
      source: '/workspace/new-box.txt',
      destination: path.join(worktree, 'new-box.txt'),
    });
    expect(ctx.stdout.text()).toContain('1 copiados box→host');
    expect(ctx.stdout.text()).toContain('1 copiados host→box');
  });

  it('does not transfer anything when both sides changed identically', async () => {
    const configDir = tmpDir();
    const worktree = tmpDir();
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'same content');
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { worktreePath: worktree }));
    setHostStatus(ctx, ' M a.txt\n');
    simBox(ctx, { status: ' M a.txt\n', files: { '/workspace/a.txt': 'same content' } });

    const code = await runCli(['sync', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(pullOps(ctx)).toHaveLength(0);
    expect(copyOps(ctx)).toHaveLength(0);
    // The identical-content proof still reads the box file.
    expect(execOps(ctx)).toContainEqual({
      op: 'exec',
      id: 'demo',
      command: ['cat', '/workspace/a.txt'],
      cwd: undefined,
    });
    expect(ctx.stdout.text()).toContain('0 copiados box→host');
    expect(ctx.stdout.text()).toContain('0 copiados host→box');
    expect(ctx.stdout.text()).toContain('0 conflictos');
  });

  it('backs up the host version and applies the box version on a conflict', async () => {
    const configDir = tmpDir();
    const worktree = tmpDir();
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'host version');
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { worktreePath: worktree }));
    setHostStatus(ctx, ' M a.txt\n');
    simBox(ctx, { status: ' M a.txt\n', files: { '/workspace/a.txt': 'box version' } });

    const code = await runCli(['sync', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(worktree, '.sander', 'a.txt.sander-host'), 'utf8')).toBe('host version');
    expect(pullOps(ctx)).toContainEqual({
      op: 'pull',
      id: 'demo',
      source: '/workspace/a.txt',
      destination: path.join(worktree, 'a.txt'),
    });
    expect(copyOps(ctx)).toHaveLength(0);
    expect(ctx.stdout.text()).toContain('1 conflictos');
  });

  it('propagates a host deletion to the box with rm', async () => {
    const configDir = tmpDir();
    const worktree = tmpDir();
    fs.writeFileSync(path.join(worktree, 'gone.txt'), 'still on host');
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { worktreePath: worktree }));
    setHostStatus(ctx, ' D gone.txt\n');
    simBox(ctx, { status: '' });

    const code = await runCli(['sync', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(execOps(ctx)).toContainEqual({ op: 'exec', id: 'demo', command: ['rm', '-f', '/workspace/gone.txt'], cwd: undefined });
    expect(pullOps(ctx)).toHaveLength(0);
    expect(copyOps(ctx)).toHaveLength(0);
    expect(ctx.stdout.text()).toContain('0 conflictos');
  });

  it('propagates a box deletion to the host with fs.rmSync', async () => {
    const configDir = tmpDir();
    const worktree = tmpDir();
    fs.writeFileSync(path.join(worktree, 'gone.txt'), 'still on host');
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { worktreePath: worktree }));
    setHostStatus(ctx, '');
    simBox(ctx, { status: ' D gone.txt\n' });

    const code = await runCli(['sync', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(worktree, 'gone.txt'))).toBe(false);
    expect(ctx.provider.ops).toContainEqual({
      op: 'exec',
      id: 'demo',
      command: ['git', '-C', '/workspace', 'status', '--porcelain', '-uall'],
      cwd: undefined,
    });
    expect(ctx.stdout.text()).toContain('0 conflictos');
  });

  it('resolves a host-deletion vs box-modification conflict by restoring the box version', async () => {
    const configDir = tmpDir();
    const worktree = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { worktreePath: worktree }));
    setHostStatus(ctx, ' D a.txt\n');
    simBox(ctx, { status: ' M a.txt\n', files: { '/workspace/a.txt': 'box version' } });

    const code = await runCli(['sync', 'demo'], ctx.deps);

    expect(code).toBe(0);
    // The host file is gone: no backup to preserve, the box version is applied.
    expect(fs.existsSync(path.join(worktree, '.sander', 'a.txt.sander-host'))).toBe(false);
    expect(pullOps(ctx)).toContainEqual({
      op: 'pull',
      id: 'demo',
      source: '/workspace/a.txt',
      destination: path.join(worktree, 'a.txt'),
    });
    expect(ctx.stdout.text()).toContain('1 conflictos');
  });

  it('resolves a host-modification vs box-deletion conflict with a backup and a host rm', async () => {
    const configDir = tmpDir();
    const worktree = tmpDir();
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'host version');
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { worktreePath: worktree }));
    setHostStatus(ctx, ' M a.txt\n');
    simBox(ctx, { status: ' D a.txt\n' });

    const code = await runCli(['sync', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(worktree, '.sander', 'a.txt.sander-host'), 'utf8')).toBe('host version');
    expect(fs.existsSync(path.join(worktree, 'a.txt'))).toBe(false);
    expect(pullOps(ctx)).toHaveLength(0);
    expect(copyOps(ctx)).toHaveLength(0);
    expect(ctx.stdout.text()).toContain('1 conflictos');
  });

  it('executes a mixed plan and reports the per-direction summary counts', async () => {
    const configDir = tmpDir();
    const worktree = tmpDir();
    fs.writeFileSync(path.join(worktree, 'b.txt'), 'b host');
    fs.writeFileSync(path.join(worktree, 'c.txt'), 'c host');
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { worktreePath: worktree }));
    setHostStatus(ctx, ' M b.txt\n?? c.txt\n');
    simBox(ctx, { status: ' M a.txt\n' });

    const code = await runCli(['sync', 'demo'], ctx.deps);

    expect(code).toBe(0);
    const ops = ctx.provider.ops.map((op) => op.op);
    expect(ops).toEqual(['exec', 'pull', 'copy', 'copy']);
    expect(pullOps(ctx)).toContainEqual({ op: 'pull', id: 'demo', source: '/workspace/a.txt', destination: path.join(worktree, 'a.txt') });
    expect(copyOps(ctx)).toContainEqual({ op: 'copy', id: 'demo', source: path.join(worktree, 'b.txt'), destination: '/workspace/b.txt', yes: true });
    expect(copyOps(ctx)).toContainEqual({ op: 'copy', id: 'demo', source: path.join(worktree, 'c.txt'), destination: '/workspace/c.txt', yes: true });
    expect(ctx.stdout.text()).toContain('1 copiados box→host');
    expect(ctx.stdout.text()).toContain('2 copiados host→box');
    expect(ctx.stdout.text()).toContain('0 conflictos');
  });

  it('accepts --sandbox as an alternative to the positional id', async () => {
    const configDir = tmpDir();
    const worktree = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { worktreePath: worktree }));
    setHostStatus(ctx, '');
    simBox(ctx, { status: ' M a.txt\n' });

    const code = await runCli(['sync', '--sandbox', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(pullOps(ctx)).toContainEqual({ op: 'pull', id: 'demo', source: '/workspace/a.txt', destination: path.join(worktree, 'a.txt') });
  });

  it('disables sync with a notice and no transfers when the sandbox has no host worktree', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { worktreePath: undefined }));

    const code = await runCli(['sync', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('sync desactivada');
    expect(ctx.stdout.text()).toContain('no se transfiere nada');
    expect(ctx.provider.ops).toHaveLength(0);
  });

  it('skips the cycle with a notice when the box exec fails', async () => {
    const configDir = tmpDir();
    const worktree = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { worktreePath: worktree }));
    ctx.provider.execResult = { exitCode: 1, stdout: '', stderr: 'box down' };

    const code = await runCli(['sync', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stderr.text()).toContain('Aviso: ciclo de sync omitido');
    expect(ctx.stderr.text()).toContain('box down');
    expect(ctx.provider.ops.filter((op) => op.op === 'pull' || op.op === 'copy')).toHaveLength(0);
  });

  it('skips the cycle with a notice when the box exec throws', async () => {
    const configDir = tmpDir();
    const worktree = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { worktreePath: worktree }));
    ctx.provider.nextError = new Error('connection refused');

    const code = await runCli(['sync', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stderr.text()).toContain('Aviso: ciclo de sync omitido');
    expect(ctx.stderr.text()).toContain('connection refused');
    expect(ctx.provider.ops.filter((op) => op.op === 'pull' || op.op === 'copy')).toHaveLength(0);
  });

  it('keeps exit 0 and reports the rest of the plan when one transfer op fails', async () => {
    const configDir = tmpDir();
    const worktree = tmpDir();
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'a host');
    fs.writeFileSync(path.join(worktree, 'b.txt'), 'b host');
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { worktreePath: worktree }));
    setHostStatus(ctx, ' M a.txt\n M b.txt\n');
    simBox(ctx, { status: '' });
    ctx.provider.copyError = new Error('agentbox cp failed: max bytes');

    const code = await runCli(['sync', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stderr.text()).toContain('Aviso: falló la operación');
    expect(ctx.stderr.text()).toContain('agentbox cp failed: max bytes');
    // The failed copy is never recorded; the second copy still runs.
    expect(copyOps(ctx)).toHaveLength(1);
    expect(copyOps(ctx)[0]?.source).toBe(path.join(worktree, 'b.txt'));
    expect(ctx.stdout.text()).toContain('2 copiados host→box');
  });

  it('errors when the sandbox is not in the registry', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runCli(['sync', 'ghost'], ctx.deps);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('sandbox not found: ghost');
    expect(ctx.provider.ops).toHaveLength(0);
  });

  it('errors on unexpected extra arguments', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { worktreePath: tmpDir() }));

    const code = await runCli(['sync', 'demo', 'extra'], ctx.deps);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('unexpected argument "extra"');
    expect(ctx.provider.ops).toHaveLength(0);
  });

  it('prints sync help for --help', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runCli(['sync', '--help'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('sander sync [<id> | --sandbox <id>]');
    expect(ctx.stdout.text()).toContain('copiados box→host');
    expect(ctx.stdout.text()).toContain('sync desactivada');
  });

  it('registers sync in the root help and in sander help sync', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);

    const root = await runCli(['--help'], ctx.deps);
    expect(root).toBe(0);
    expect(ctx.stdout.text()).toContain('sync');

    ctx.stdout.reset();
    const help = await runCli(['help', 'sync'], ctx.deps);
    expect(help).toBe(0);
    expect(ctx.stdout.text()).toContain('sander sync');
  });
});

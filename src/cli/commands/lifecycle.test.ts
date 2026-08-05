import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { CaptureStream } from '../../../test/helpers/capture-stream';
import { FakeProvider } from '../../provider/fake';
import { FakeHarnessFactory } from '../../harness/fake';
import { FakeWorktree } from '../../worktree/fake';
import { runCli } from '../main';
import type { CliDeps } from '../deps';
import { CliError } from '../errors';
import { resolveProviderName } from '../../provider/providers';
import { emptyRegistry, loadRegistry, saveRegistry, upsertBox } from '../../registry/registry';
import type { Sandbox } from '../../registry/registry';
import { containerNameForSandbox } from '../../names/sandbox-name';
import { GitWorktree, deriveWorktreeRef } from '../../worktree/worktree';
import { isProcessAlive, writePid } from '../../sync/watcher-state';
import { run } from '../../process/run';
import type { CommandRunner } from '../../process/run';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sander-lifecycle-test-'));
}

function waitForExit(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    proc.once('close', () => resolve());
  });
}

interface Ctx {
  deps: CliDeps;
  provider: FakeProvider;
  providers: Map<string, FakeProvider>;
  factoryCalls: string[];
  worktree: FakeWorktree;
  stdout: CaptureStream;
  stderr: CaptureStream;
}

function makeCtx(configDir: string): Ctx {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const providers = new Map<string, FakeProvider>();
  const factoryCalls: string[] = [];
  const createProvider = (name: string): FakeProvider => {
    factoryCalls.push(name);
    const resolved = resolveProviderName(name);
    let provider = providers.get(resolved);
    if (!provider) {
      provider = new FakeProvider();
      providers.set(resolved, provider);
    }
    return provider;
  };
  const provider = new FakeProvider();
  provider.defaultFileState = new Map([['/workspace/.sander/start.sh', true]]);
  providers.set('docker', provider);
  const worktree = new FakeWorktree();
  return {
    deps: { configDir, stdout, stderr, createProvider, harnessFactory: new FakeHarnessFactory(), worktree },
    provider,
    providers,
    factoryCalls,
    worktree,
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

function register(ctx: Ctx, box: Sandbox): void {
  const registry = emptyRegistry();
  upsertBox(registry, box);
  saveRegistry(ctx.deps.configDir, registry);
}

function seedContainer(ctx: Ctx, id: string): void {
  ctx.provider.boxes.set(containerNameForSandbox(id), { id });
}

async function runIn(projectRoot: string, ctx: Ctx, args: string[]): Promise<number> {
  const prev = process.cwd();
  process.chdir(projectRoot);
  try {
    return await runCli(args, ctx.deps);
  } finally {
    process.chdir(prev);
  }
}

function opsOf(ctx: Ctx): string[] {
  return ctx.provider.ops.map((op) => op.op);
}

function opsOfProvider(ctx: Ctx, provider: string): Array<{ op: string; id: string }> {
  const ops = ctx.providers.get(resolveProviderName(provider))?.ops ?? [];
  return ops.map((op) => ({ op: op.op, id: op.id }));
}

function boxStatus(ctx: Ctx, id: string): Sandbox | undefined {
  return loadRegistry(ctx.deps.configDir).boxes[id];
}

const START_LAUNCH = ['sh', '-c', 'nohup sh /workspace/.sander/supervisor.sh start </dev/null >/dev/null 2>&1 &'] as const;

function launchOps(ctx: Ctx): Array<{ op: 'exec'; id: string; command: string[] }> {
  return ctx.provider.ops.filter((op) => op.op === 'exec') as Array<{ op: 'exec'; id: string; command: string[] }>;
}

describe('sander stop', () => {
  it('stops the box and marks the registry status stopped', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));

    const code = await runCli(['stop', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.provider.ops).toEqual([
      { op: 'exec', id: 'demo', command: ['sh', '/workspace/.sander/supervisor.sh', 'stop'] },
      { op: 'stop', id: 'demo' },
    ]);
    expect(boxStatus(ctx, 'demo')?.status).toBe('stopped');
    expect(ctx.stdout.text()).toContain('Stopped sandbox "demo".');
  });

  it('reflects the stopped state in sander list', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    await runCli(['stop', 'demo'], ctx.deps);

    const code = await runCli(['list'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('stopped');
  });

  it('accepts --sandbox as an alternative to the positional id', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));

    const code = await runCli(['stop', '--sandbox', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.provider.ops).toEqual([
      { op: 'exec', id: 'demo', command: ['sh', '/workspace/.sander/supervisor.sh', 'stop'] },
      { op: 'stop', id: 'demo' },
    ]);
    expect(boxStatus(ctx, 'demo')?.status).toBe('stopped');
  });

  it('errors when the sandbox is not in the registry', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runCli(['stop', 'ghost'], ctx.deps);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('sandbox not found: ghost');
    expect(ctx.provider.ops).toHaveLength(0);
  });

  it('errors on unexpected extra arguments', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));

    const code = await runCli(['stop', 'demo', 'extra'], ctx.deps);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('unexpected argument "extra"');
    expect(ctx.provider.ops).toHaveLength(0);
  });

  it('prints stop help for --help', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runCli(['stop', '--help'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('sander stop [<id> | --sandbox <id>]');
  });

  it('operates on a legacy agentbox box through the docker engine', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { provider: 'agentbox' }));

    const code = await runCli(['stop', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.factoryCalls).toEqual(['agentbox']);
    expect(ctx.provider.ops).toEqual([
      { op: 'exec', id: 'demo', command: ['sh', '/workspace/.sander/supervisor.sh', 'stop'] },
      { op: 'stop', id: 'demo' },
    ]);
    expect(boxStatus(ctx, 'demo')?.status).toBe('stopped');
  });

  it('resolves the engine from the box provider via the factory', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { provider: 'vercel' }));

    const code = await runCli(['stop', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.factoryCalls).toEqual(['vercel']);
    expect(opsOfProvider(ctx, 'vercel')).toEqual([
      { op: 'exec', id: 'demo' },
      { op: 'stop', id: 'demo' },
    ]);
    expect(ctx.provider.ops).toEqual([]);
    expect(boxStatus(ctx, 'demo')?.status).toBe('stopped');
  });
});

describe('sander start', () => {
  it('starts the box and marks the registry status running', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { status: 'stopped' }));

    const code = await runCli(['start', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.provider.ops).toEqual([
      { op: 'start', id: 'demo' },
      { op: 'hasExecutable', id: 'demo', path: '/workspace/.sander/start.sh' },
      { op: 'exec', id: 'demo', command: [...START_LAUNCH] },
    ]);
    expect(boxStatus(ctx, 'demo')?.status).toBe('running');
    expect(ctx.stdout.text()).toContain('Started sandbox "demo".');
  });

  it('resumes the same box after stop without recreating it', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { status: 'stopped' }));

    await runCli(['stop', 'demo'], ctx.deps);
    const code = await runCli(['start', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['exec', 'stop', 'start', 'hasExecutable', 'exec']);
    expect(ctx.provider.ops.filter((op) => op.op === 'create')).toHaveLength(0);
    expect(boxStatus(ctx, 'demo')?.status).toBe('running');
  });

  it('reflects the running state in sander list', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { status: 'stopped' }));
    await runCli(['start', 'demo'], ctx.deps);

    const code = await runCli(['list'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('running');
  });

  it('accepts --sandbox as an alternative to the positional id', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { status: 'stopped' }));

    const code = await runCli(['start', '--sandbox', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.provider.ops).toEqual([
      { op: 'start', id: 'demo' },
      { op: 'hasExecutable', id: 'demo', path: '/workspace/.sander/start.sh' },
      { op: 'exec', id: 'demo', command: [...START_LAUNCH] },
    ]);
    expect(boxStatus(ctx, 'demo')?.status).toBe('running');
  });

  it('launches the supervisor without re-running install.sh', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { status: 'stopped' }));

    const code = await runCli(['start', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.provider.ops).toEqual([
      { op: 'start', id: 'demo' },
      { op: 'hasExecutable', id: 'demo', path: '/workspace/.sander/start.sh' },
      { op: 'exec', id: 'demo', command: [...START_LAUNCH] },
    ]);
    expect(launchOps(ctx).some((op) => op.command.join(' ').includes('install.sh'))).toBe(false);
    expect(boxStatus(ctx, 'demo')?.status).toBe('running');
  });

  it('start on a box without start.sh warns and continues without a service', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    ctx.provider.defaultFileState = new Map();
    register(ctx, makeBox('demo', { status: 'stopped' }));

    const code = await runCli(['start', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.provider.ops).toEqual([
      { op: 'start', id: 'demo' },
      { op: 'hasExecutable', id: 'demo', path: '/workspace/.sander/start.sh' },
    ]);
    expect(ctx.stderr.text()).toMatch(/no tiene/);
    expect(ctx.stderr.text()).toMatch(/start\.sh/);
    expect(ctx.stdout.text()).toContain('Started sandbox "demo".');
    expect(boxStatus(ctx, 'demo')?.status).toBe('running');
  });

  it('start continues with a warning when the supervisor launch fails', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { status: 'stopped' }));
    ctx.provider.execHook = (id, command) => {
      if (command.join(' ').includes('supervisor.sh start')) {
        return { exitCode: 1, stdout: '', stderr: 'boom' };
      }
    };

    const code = await runCli(['start', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stderr.text()).toMatch(/no se pudo iniciar el servicio/);
    // The start path never rolls back: the warning must not claim a rollback.
    expect(ctx.stderr.text()).not.toContain('rollback');
    expect(boxStatus(ctx, 'demo')?.status).toBe('running');
    expect(ctx.stdout.text()).toContain('Started sandbox "demo".');
  });

  it('stop continues with provider.stop when the supervisor stop fails', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    ctx.provider.execHook = (id, command) => {
      if (command.join(' ').includes('supervisor.sh stop')) {
        return { exitCode: 127, stdout: '', stderr: 'no such file' };
      }
    };

    const code = await runCli(['stop', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stderr.text()).toMatch(/no se pudo detener el servicio/);
    expect(opsOf(ctx)).toEqual(['exec', 'stop']);
    expect(boxStatus(ctx, 'demo')?.status).toBe('stopped');
    expect(ctx.stdout.text()).toContain('Stopped sandbox "demo".');
  });

  it('errors when the sandbox is not in the registry', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runCli(['start', 'ghost'], ctx.deps);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('sandbox not found: ghost');
    expect(ctx.provider.ops).toHaveLength(0);
  });

  it('prints start help for --help', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runCli(['start', '--help'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('sander start [<id> | --sandbox <id>]');
  });

  it('operates on a legacy agentbox box through the docker engine', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { provider: 'agentbox', status: 'stopped' }));

    const code = await runCli(['start', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.factoryCalls).toEqual(['agentbox']);
    expect(ctx.provider.ops).toEqual([
      { op: 'start', id: 'demo' },
      { op: 'hasExecutable', id: 'demo', path: '/workspace/.sander/start.sh' },
      { op: 'exec', id: 'demo', command: [...START_LAUNCH] },
    ]);
    expect(boxStatus(ctx, 'demo')?.status).toBe('running');
  });
});

describe('sander rm', () => {
  it('removes the box and drops it from the registry', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    seedContainer(ctx, 'demo');

    const code = await runCli(['rm', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['list', 'remove']);
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
    expect(ctx.stdout.text()).toContain('Removed sandbox "demo".');
  });

  it('reflects the removal in sander list', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    seedContainer(ctx, 'demo');
    await runCli(['rm', 'demo'], ctx.deps);

    const code = await runCli(['list'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('No sandboxes found');
  });

  it('accepts --sandbox as an alternative to the positional id', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    seedContainer(ctx, 'demo');

    const code = await runCli(['rm', '--sandbox', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['list', 'remove']);
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
  });

  it('rm on an unregistered id removes the derivable container, worktree and branch', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    const project = tmpDir();
    seedContainer(ctx, 'feature/cool-wizard');

    const code = await runIn(project, ctx, ['rm', 'feature/cool-wizard']);

    expect(code).toBe(0);
    expect(ctx.provider.ops).toEqual([
      { op: 'list' },
      { op: 'remove', id: 'feature/cool-wizard' },
    ]);
    expect(ctx.worktree.ops.map((op) => op.op)).toEqual(['removeWorktree', 'deleteBranchDetaching']);
    const ref = deriveWorktreeRef(project, 'feature/cool-wizard');
    expect(ctx.worktree.ops[0]).toEqual({ op: 'removeWorktree', projectRoot: project, ref });
    expect(ctx.worktree.ops[1]).toEqual({ op: 'deleteBranchDetaching', projectRoot: project, branch: 'feature/cool-wizard' });
    expect(boxStatus(ctx, 'feature/cool-wizard')).toBeUndefined();
    expect(ctx.stderr.text()).not.toContain('sandbox not found');
    expect(ctx.stdout.text()).toContain('Removed sandbox "feature/cool-wizard".');
  });

  it('rm on an unregistered id with nothing to do exits 0', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    const project = tmpDir();

    const code = await runIn(project, ctx, ['rm', 'ghost']);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['list']);
    expect(ctx.worktree.ops.map((op) => op.op)).toEqual(['removeWorktree', 'deleteBranchDetaching']);
    expect(ctx.stderr.text()).not.toContain('error:');
    expect(ctx.stdout.text()).toContain('Removed sandbox');
  });

  it('rm tolerates a provider.remove failure when the container is already gone', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    ctx.provider.removeError = new Error('destroy failed');
    ctx.provider.listResults = [['demo'], []];

    const code = await runCli(['rm', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['list', 'remove', 'list']);
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
    expect(ctx.stderr.text()).not.toContain('no se pudo eliminar el contenedor');
  });

  it('rm fails when the container still exists after a failed remove', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    ctx.provider.removeError = new Error('destroy failed');
    ctx.provider.listResults = [['demo'], ['demo']];

    const code = await runCli(['rm', 'demo'], ctx.deps);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('no se pudo eliminar el contenedor del sandbox "demo"');
  });

  it('rm still attempts removal when the provider cannot be verified and tolerates a success', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    ctx.provider.nextError = new Error('daemon down');

    const code = await runCli(['rm', 'demo'], ctx.deps);

    expect(code).toBe(0);
    // The first list() threw before recording; remove() still ran and succeeded.
    expect(opsOf(ctx)).toEqual(['remove']);
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
    expect(ctx.stdout.text()).toContain('Removed sandbox "demo".');
  });

  it('rm fails when the provider cannot be verified and remove also fails with the container still visible', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    ctx.provider.nextError = new Error('daemon down'); // first list() throws
    ctx.provider.removeError = new Error('destroy failed');
    ctx.provider.listResults = [['demo']]; // re-verification after remove failure

    const code = await runCli(['rm', 'demo'], ctx.deps);

    expect(code).toBe(1);
    expect(opsOf(ctx)).toEqual(['remove', 'list']);
    expect(ctx.stderr.text()).toContain('no se pudo eliminar el contenedor del sandbox "demo"');
  });

  it('rm warns and skips git cleanup when the project is not a git repository', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { branch: 'demo', worktreePath: '/tmp/proj-sander-demo' }));
    seedContainer(ctx, 'demo');
    ctx.worktree.isGitRepoResult = false;

    const code = await runCli(['rm', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.worktree.ops).toEqual([]);
    expect(ctx.stderr.text()).toContain('no es un repositorio git');
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
  });

  it('rm on a registered box whose container is already gone still clears the registry entry', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));

    const code = await runCli(['rm', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['list']);
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
  });

  it('errors on unexpected extra arguments', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));

    const code = await runCli(['rm', 'demo', 'extra'], ctx.deps);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('unexpected argument "extra"');
    expect(ctx.provider.ops).toHaveLength(0);
  });

  it('prints rm help for --help', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runCli(['rm', '--help'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('sander rm [<id> | --sandbox <id>]');
    expect(ctx.stdout.text()).toContain('aliases: destroy, delete, remove');
  });

  it('operates on a legacy agentbox box through the docker engine', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { provider: 'agentbox' }));
    seedContainer(ctx, 'demo');

    const code = await runCli(['rm', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.factoryCalls).toEqual(['agentbox']);
    expect(opsOf(ctx)).toEqual(['list', 'remove']);
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
  });

  it('supports destroy, delete, and remove as aliases of rm', async () => {
    for (const alias of ['destroy', 'delete', 'remove']) {
      const configDir = tmpDir();
      const ctx = makeCtx(configDir);
      register(ctx, makeBox('demo'));
      seedContainer(ctx, 'demo');

      const code = await runCli([alias, 'demo'], ctx.deps);

      expect(code).toBe(0);
      expect(opsOf(ctx)).toEqual(['list', 'remove']);
      expect(boxStatus(ctx, 'demo')).toBeUndefined();
      expect(ctx.stdout.text()).toContain('Removed sandbox "demo".');
    }
  });

  it('shows rm help for destroy, delete, and remove', async () => {
    for (const alias of ['destroy', 'delete', 'remove']) {
      const configDir = tmpDir();
      const ctx = makeCtx(configDir);

      const code = await runCli([alias, '--help'], ctx.deps);

      expect(code).toBe(0);
      expect(ctx.stdout.text()).toContain('sander rm [<id> | --sandbox <id>]');
      expect(ctx.stdout.text()).toContain('aliases: destroy, delete, remove');
    }
  });

  it('removes the worktree and deletes the single sandbox branch', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { branch: 'demo', worktreePath: '/tmp/proj-sander-demo' }));
    seedContainer(ctx, 'demo');

    const code = await runCli(['rm', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['list', 'remove']);
    expect(ctx.worktree.ops.map((op) => op.op)).toEqual(['removeWorktree', 'deleteBranchDetaching']);
    expect(ctx.worktree.ops[1]).toEqual({ op: 'deleteBranchDetaching', projectRoot: '/tmp/project', branch: 'demo' });
    expect(ctx.worktree.ops.some((op) => op.op === 'deleteBranchDetaching' && op.branch === 'sander/demo')).toBe(false);
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
  });

  it('keeps accepting the deprecated --delete-branch as a no-op (branches deleted by default)', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { branch: 'demo', worktreePath: '/tmp/proj-sander-demo' }));
    seedContainer(ctx, 'demo');

    const code = await runCli(['rm', '--delete-branch', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.worktree.ops.map((op) => op.op)).toEqual(['removeWorktree', 'deleteBranchDetaching']);
    expect(ctx.worktree.ops[1]).toEqual({ op: 'deleteBranchDetaching', projectRoot: '/tmp/project', branch: 'demo' });
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
  });

  it('keeps the branch with --dont-delete-branch together with --sandbox', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { branch: 'demo', worktreePath: '/tmp/proj-sander-demo' }));
    seedContainer(ctx, 'demo');

    const code = await runCli(['rm', '--sandbox', 'demo', '--dont-delete-branch'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.worktree.ops.map((op) => op.op)).toEqual(['removeWorktree']);
    expect(ctx.worktree.ops.some((op) => op.op === 'deleteBranch')).toBe(false);
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
  });

  it('does not touch the worktree seam when the box has no registered relation', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));

    const code = await runCli(['rm', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.worktree.ops).toEqual([]);
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
  });

  it('keeps exit 0 and warns when worktree teardown fails', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { branch: 'demo', worktreePath: '/tmp/proj-sander-demo' }));
    seedContainer(ctx, 'demo');
    ctx.worktree.nextError = new Error('dirty tree');

    const code = await runCli(['rm', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.worktree.ops.map((op) => op.op)).toEqual(['deleteBranchDetaching']);
    expect(ctx.stderr.text()).toContain('no se pudo eliminar el worktree de la rama "demo"');
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
  });

  it('deletes the branch by default even when the worktree teardown failed', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { branch: 'demo', worktreePath: '/tmp/proj-sander-demo' }));
    seedContainer(ctx, 'demo');
    ctx.worktree.nextError = new Error('dirty tree');

    const code = await runCli(['rm', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.worktree.ops.map((op) => op.op)).toEqual(['deleteBranchDetaching']);
    expect(ctx.stderr.text()).toContain('no se pudo eliminar el worktree de la rama "demo"');
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
  });

  it('fails and retains the registry entry when branch deletion stays stuck', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { branch: 'demo' }));
    ctx.worktree.nextError = new CliError('no se pudo eliminar la rama "demo": branch locked');

    const code = await runCli(['rm', 'demo'], ctx.deps);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('no se pudo eliminar la rama "demo"');
    expect(boxStatus(ctx, 'demo')).toBeDefined();
    expect(ctx.stdout.text()).not.toContain('Removed sandbox');
  });

  it('supports --dont-delete-branch on the destroy alias', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { branch: 'demo', worktreePath: '/tmp/proj-sander-demo' }));
    seedContainer(ctx, 'demo');

    const code = await runCli(['destroy', '--dont-delete-branch', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.worktree.ops.map((op) => op.op)).toEqual(['removeWorktree']);
    expect(ctx.worktree.ops.some((op) => op.op === 'deleteBranch')).toBe(false);
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
  });

  it('keeps the branch with --dont-delete-branch', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { branch: 'demo', worktreePath: '/tmp/proj-sander-demo' }));
    seedContainer(ctx, 'demo');

    const code = await runCli(['rm', '--dont-delete-branch', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.worktree.ops.map((op) => op.op)).toEqual(['removeWorktree']);
    expect(ctx.worktree.ops.some((op) => op.op === 'deleteBranch')).toBe(false);
    // The opt-out never detaches the branch from a registered worktree either.
    expect(ctx.worktree.ops.some((op) => op.op === 'deleteBranchDetaching')).toBe(false);
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
  });

  it('accepts --no-delete-branch as a synonym', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { branch: 'demo', worktreePath: '/tmp/proj-sander-demo' }));
    seedContainer(ctx, 'demo');

    const code = await runCli(['rm', '--no-delete-branch', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.worktree.ops.map((op) => op.op)).toEqual(['removeWorktree']);
    expect(ctx.worktree.ops.some((op) => op.op === 'deleteBranch')).toBe(false);
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
  });

  it('the opt-out wins over the deprecated --delete-branch', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { branch: 'demo', worktreePath: '/tmp/proj-sander-demo' }));
    seedContainer(ctx, 'demo');

    const code = await runCli(['rm', '--delete-branch', '--dont-delete-branch', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.worktree.ops.map((op) => op.op)).toEqual(['removeWorktree']);
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
  });

  it('rm on a registered box without a container detaches and deletes the branch and clears the registry', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { branch: 'demo', worktreePath: '/tmp/proj-sander-demo' }));

    const code = await runCli(['rm', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['list']);
    expect(ctx.worktree.ops.map((op) => op.op)).toEqual(['removeWorktree', 'deleteBranchDetaching']);
    expect(ctx.worktree.ops[1]).toEqual({ op: 'deleteBranchDetaching', projectRoot: '/tmp/project', branch: 'demo' });
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
  });

  it('rm on the reported bug — unregistered id, container gone, stale in-container worktree registration — deletes the branch', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    ctx.deps.worktree = new GitWorktree();
    const project = tmpDir();
    run('git', ['init', '-q', '-b', 'main', project]);
    run('git', ['-C', project, 'config', 'user.email', 't@t.t']);
    run('git', ['-C', project, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(project, 'f.txt'), 'hi');
    run('git', ['-C', project, 'add', 'f.txt']);
    run('git', ['-C', project, 'commit', '-qm', 'init']);
    run('git', ['-C', project, 'branch', 'feature/cool-wizard', 'HEAD']);
    const staleWt = path.join(tmpDir(), 'in-container-wt');
    run('git', ['-C', project, 'worktree', 'add', '-q', staleWt, 'feature/cool-wizard']);
    // The container is already gone: the worktree directory does not exist on the host.
    fs.rmSync(staleWt, { recursive: true, force: true });

    const code = await runIn(project, ctx, ['rm', 'feature/cool-wizard']);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['list']);
    expect(ctx.stdout.text()).toContain('Removed sandbox');
    expect(run('git', ['-C', project, 'rev-parse', '--verify', '--quiet', 'refs/heads/feature/cool-wizard']).exitCode).not.toBe(0);
    expect(run('git', ['-C', project, 'worktree', 'list']).stdout).not.toContain('in-container-wt');
  });

  it('rm repairs a mode-restricted stale worktree metadata dir and removes it without crashing', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    ctx.deps.worktree = new GitWorktree();
    const project = tmpDir();
    run('git', ['init', '-q', '-b', 'main', project]);
    run('git', ['-C', project, 'config', 'user.email', 't@t.t']);
    run('git', ['-C', project, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(project, 'f.txt'), 'hi');
    run('git', ['-C', project, 'add', 'f.txt']);
    run('git', ['-C', project, 'commit', '-qm', 'init']);
    run('git', ['-C', project, 'branch', 'feature/cool-wizard', 'HEAD']);
    const staleWt = path.join(tmpDir(), 'in-container-wt');
    run('git', ['-C', project, 'worktree', 'add', '-q', staleWt, 'feature/cool-wizard']);
    fs.rmSync(staleWt, { recursive: true, force: true });
    // Mode-restricted but owned by the current user: the repair chmods it and
    // rm removes it — the EACCES crash class is fixed, not papered over.
    const adminDir = path.join(project, '.git', 'worktrees', 'in-container-wt');
    fs.chmodSync(adminDir, 0o555);

    const code = await runIn(project, ctx, ['rm', 'feature/cool-wizard']);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('Removed sandbox');
    expect(run('git', ['-C', project, 'rev-parse', '--verify', '--quiet', 'refs/heads/feature/cool-wizard']).exitCode).not.toBe(0);
    expect(run('git', ['-C', project, 'worktree', 'list']).stdout).not.toContain('in-container-wt');
    expect(fs.existsSync(adminDir)).toBe(false);
    expect(ctx.stderr.text()).not.toContain('error:');
  });

  it('rm emits an Aviso with remediation when deleteBranchDetaching reports leftover metadata and still clears the registry', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { branch: 'demo', worktreePath: '/tmp/proj-sander-demo' }));
    seedContainer(ctx, 'demo');
    ctx.worktree.deleteBranchDetachingResult = {
      leftoverAdminDir: { adminDir: '/proj/.git/worktrees/wt', worktreePath: '/home/vscode/.agentbox-worktrees/wt' },
    };

    const code = await runCli(['rm', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('Removed sandbox "demo".');
    expect(ctx.stderr.text()).toContain('Aviso:');
    expect(ctx.stderr.text()).toContain('/proj/.git/worktrees/wt');
    // The only working remediation after the branch is already gone: the Aviso
    // never suggests a re-run (`sander rm`), which could not clean the leftover.
    expect(ctx.stderr.text()).toContain('sudo rm -rf');
    expect(ctx.stderr.text()).not.toContain('sander rm');
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
  });

  it('rm fails with an actionable error and retains the registry when the stale worktree registration cannot be verified', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    ctx.deps.worktree = new GitWorktree();
    const project = tmpDir();
    run('git', ['init', '-q', '-b', 'main', project]);
    run('git', ['-C', project, 'config', 'user.email', 't@t.t']);
    run('git', ['-C', project, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(project, 'f.txt'), 'hi');
    run('git', ['-C', project, 'add', 'f.txt']);
    run('git', ['-C', project, 'commit', '-qm', 'init']);
    run('git', ['-C', project, 'branch', 'demo', 'HEAD']);
    const staleWt = path.join(tmpDir(), 'wt-demo');
    run('git', ['-C', project, 'worktree', 'add', '-q', staleWt, 'demo']);
    fs.rmSync(staleWt, { recursive: true, force: true });
    // Corrupt the admin gitdir so the scan cannot verify the registration.
    fs.writeFileSync(path.join(project, '.git', 'worktrees', 'wt-demo', 'gitdir'), 'garbage\n');

    register(ctx, makeBox('demo', { projectRoot: project, branch: 'demo', worktreePath: '/tmp/proj-sander-demo' }));
    seedContainer(ctx, 'demo');

    const code = await runIn(project, ctx, ['rm', 'demo']);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('error:');
    expect(ctx.stderr.text()).toContain('no se pudo eliminar la rama "demo"');
    expect(boxStatus(ctx, 'demo')).toBeDefined();
    expect(ctx.stdout.text()).not.toContain('Removed sandbox');
  });

  it('rm stops the watcher by pidfile and removes its pid and log', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    seedContainer(ctx, 'demo');
    const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = proc.pid!;
    writePid(configDir, 'demo', pid);
    fs.writeFileSync(path.join(configDir, 'sync', 'demo.log'), 'old log\n');

    const code = await runCli(['rm', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['list', 'remove']);
    expect(ctx.stderr.text()).toContain('Deteniendo el watcher de sync');
    await waitForExit(proc);
    expect(isProcessAlive(pid)).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'sync', 'demo.pid'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'sync', 'demo.log'))).toBe(false);
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
  });

  it('rm is idempotent when the watcher is already stopped or was never started', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));

    const code = await runCli(['rm', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(configDir, 'sync', 'demo.pid'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'sync', 'demo.log'))).toBe(false);
    expect(ctx.stderr.text()).toContain('no hay watcher de sync');
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
    expect(ctx.stdout.text()).toContain('Removed sandbox "demo".');
  });

  it('rm cleans a stale watcher pidfile and log when the watcher is already dead', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    const proc = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await waitForExit(proc);
    writePid(configDir, 'demo', proc.pid!);
    fs.writeFileSync(path.join(configDir, 'sync', 'demo.log'), 'stale log\n');

    const code = await runCli(['rm', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(configDir, 'sync', 'demo.pid'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'sync', 'demo.log'))).toBe(false);
    expect(boxStatus(ctx, 'demo')).toBeUndefined();
  });

  it('rm stops the watcher for an unregistered id too', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    const project = tmpDir();
    seedContainer(ctx, 'ghost');
    const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = proc.pid!;
    writePid(configDir, 'ghost', pid);
    fs.writeFileSync(path.join(configDir, 'sync', 'ghost.log'), 'old log\n');

    const code = await runIn(project, ctx, ['rm', 'ghost']);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['list', 'remove']);
    await waitForExit(proc);
    expect(isProcessAlive(pid)).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'sync', 'ghost.pid'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'sync', 'ghost.log'))).toBe(false);
  });

  it('rm with an unfixable foreign-uid admin dir falls back to update-ref, emits an Aviso with remediation, and exits 0', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    const project = tmpDir();
    run('git', ['init', '-q', '-b', 'main', project]);
    run('git', ['-C', project, 'config', 'user.email', 't@t.t']);
    run('git', ['-C', project, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(project, 'f.txt'), 'hi');
    run('git', ['-C', project, 'add', 'f.txt']);
    run('git', ['-C', project, 'commit', '-qm', 'init']);
    run('git', ['-C', project, 'branch', 'demo', 'HEAD']);
    const staleWt = path.join(tmpDir(), 'in-container-wt');
    run('git', ['-C', project, 'worktree', 'add', '-q', staleWt, 'demo']);
    // The container is already gone: the worktree directory does not exist on the host.
    fs.rmSync(staleWt, { recursive: true, force: true });
    const adminDir = path.join(project, '.git', 'worktrees', 'in-container-wt');

    // Reproduce the EACCES class: the admin dir is mode-restricted (0o555), so
    // `git worktree remove --force` genuinely fails with "Permission denied"
    // while leaving the gitdir file readable, and the stale registration
    // survives for the metadata cleanup.
    fs.chmodSync(adminDir, 0o555);
    try {
      // chmod always fails as foreign residue ("Operation not permitted"), so the
      // repair is unfixable and the flow falls back to git update-ref -d.
      const chmodRunner: CommandRunner = () => ({
        exitCode: 1,
        stdout: '',
        stderr: `chmod: changing permissions of '${adminDir}': Operation not permitted`,
      });
      ctx.deps.worktree = new GitWorktree({ chmodRunner });

      const code = await runIn(project, ctx, ['rm', 'demo']);

      expect(code).toBe(0);
      expect(ctx.stdout.text()).toContain('Removed sandbox');
      expect(ctx.stderr.text()).toContain('Aviso:');
      expect(ctx.stderr.text()).toContain(adminDir);
      // The Aviso's remediation is the single working command; a re-run via
      // `sander rm` could never clean the leftover because the branch is gone.
      expect(ctx.stderr.text()).toContain('sudo rm -rf');
      expect(ctx.stderr.text()).not.toContain('sander rm');
      // The branch really is deleted (via the real git update-ref last resort).
      expect(run('git', ['-C', project, 'rev-parse', '--verify', '--quiet', 'refs/heads/demo']).exitCode).not.toBe(0);
      // The leftover metadata is still present — the Aviso's remediation is accurate.
      expect(fs.existsSync(adminDir)).toBe(true);
      expect(ctx.stderr.text()).not.toContain('error:');
    } finally {
      // Restore the admin dir so the temp dir remains cleanable.
      fs.chmodSync(adminDir, 0o755);
    }
  });
});

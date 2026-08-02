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
import { resolveProviderName } from '../../provider/providers';
import { emptyRegistry, saveRegistry, upsertBox } from '../../registry/registry';
import type { Sandbox } from '../../registry/registry';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sander-logs-test-'));
}

interface Ctx {
  deps: CliDeps;
  provider: FakeProvider;
  providers: Map<string, FakeProvider>;
  factoryCalls: string[];
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
  providers.set('docker', provider);
  return {
    deps: { configDir, stdout, stderr, createProvider, harnessFactory: new FakeHarnessFactory(), worktree: new FakeWorktree() },
    provider,
    providers,
    factoryCalls,
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

const START_LOG_CAT = ['cat', '/workspace/.sander/start.log'];

function catCalls(ctx: Ctx): Array<Extract<ProviderOp, { op: 'exec' }>> {
  return ctx.provider.ops.filter(
    (op): op is Extract<ProviderOp, { op: 'exec' }> => op.op === 'exec' && op.command[0] === 'cat',
  );
}

describe('sander logs', () => {
  it('prints the sandbox service log without entering it', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    ctx.provider.execHook = (id, command) => {
      if (command[0] === 'cat' && command[1] === START_LOG_CAT[1]) {
        return { exitCode: 0, stdout: 'agent ready\nstep 1 done\n', stderr: '' };
      }
    };

    const code = await runCli(['logs', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(catCalls(ctx)).toEqual([{ op: 'exec', id: 'demo', command: [...START_LOG_CAT] }]);
    expect(ctx.provider.ops.filter((op) => op.op === 'logs')).toHaveLength(0);
    expect(ctx.stdout.text()).toContain('agent ready');
    expect(ctx.stdout.text()).toContain('step 1 done');
  });

  it('accepts --sandbox as an alternative to the positional id', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    ctx.provider.execHook = (id, command) => {
      if (command[0] === 'cat' && command[1] === START_LOG_CAT[1]) {
        return { exitCode: 0, stdout: 'hello\n', stderr: '' };
      }
    };

    const code = await runCli(['logs', '--sandbox', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(catCalls(ctx)).toEqual([{ op: 'exec', id: 'demo', command: [...START_LOG_CAT] }]);
    expect(ctx.stdout.text()).toContain('hello');
  });

  it('prints nothing and exits 0 when there is no service log', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    ctx.provider.execHook = (id, command) => {
      if (command[0] === 'cat' && command[1] === START_LOG_CAT[1]) {
        return { exitCode: 1, stdout: '', stderr: 'No such file or directory' };
      }
    };

    const code = await runCli(['logs', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(catCalls(ctx)).toHaveLength(1);
    expect(ctx.stdout.text()).toBe('');
  });

  it('reads .sander/start.log instead of container logs', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    ctx.provider.logsResult = 'raw container log';
    ctx.provider.execHook = (id, command) => {
      if (command[0] === 'cat' && command[1] === START_LOG_CAT[1]) {
        return { exitCode: 0, stdout: 'service output\n', stderr: '' };
      }
    };

    const code = await runCli(['logs', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.provider.ops.filter((op) => op.op === 'logs')).toHaveLength(0);
    expect(catCalls(ctx)).toEqual([{ op: 'exec', id: 'demo', command: [...START_LOG_CAT] }]);
    expect(ctx.stdout.text()).toContain('service output');
    expect(ctx.stdout.text()).not.toContain('raw container log');
  });

  it('errors when the sandbox is not in the registry', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runCli(['logs', 'ghost'], ctx.deps);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('sandbox not found: ghost');
    expect(catCalls(ctx)).toHaveLength(0);
  });

  it('errors on unexpected extra arguments', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));

    const code = await runCli(['logs', 'demo', 'extra'], ctx.deps);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('unexpected argument "extra"');
    expect(catCalls(ctx)).toHaveLength(0);
  });

  it('errors when no id is given', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runCli(['logs'], ctx.deps);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('missing sandbox id');
    expect(catCalls(ctx)).toHaveLength(0);
  });

  it('resolves the engine from the box provider via the factory', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { provider: 'vercel' }));
    const vercelProvider = new FakeProvider();
    vercelProvider.execHook = (id, command) => {
      if (command[0] === 'cat' && command[1] === START_LOG_CAT[1]) {
        return { exitCode: 0, stdout: 'remote log line\n', stderr: '' };
      }
    };
    ctx.providers.set('vercel', vercelProvider);

    const code = await runCli(['logs', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.factoryCalls).toEqual(['vercel']);
    expect(ctx.providers.get('vercel')!.ops).toEqual([{ op: 'exec', id: 'demo', command: [...START_LOG_CAT] }]);
    expect(ctx.provider.ops).toEqual([]);
    expect(ctx.stdout.text()).toContain('remote log line');
  });

  it('operates on a legacy agentbox box through the docker engine', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { provider: 'agentbox' }));
    ctx.provider.execHook = (id, command) => {
      if (command[0] === 'cat' && command[1] === START_LOG_CAT[1]) {
        return { exitCode: 0, stdout: 'legacy box log\n', stderr: '' };
      }
    };

    const code = await runCli(['logs', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.factoryCalls).toEqual(['agentbox']);
    expect(catCalls(ctx)).toEqual([{ op: 'exec', id: 'demo', command: [...START_LOG_CAT] }]);
    expect(ctx.stdout.text()).toContain('legacy box log');
  });

  it('prints logs help for --help', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runCli(['logs', '--help'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('sander logs [<id> | --sandbox <id>]');
    expect(catCalls(ctx)).toHaveLength(0);
  });
});

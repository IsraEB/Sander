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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sander-exec-test-'));
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

function execCalls(ctx: Ctx): Array<{ op: 'exec'; id: string; command: string[] }> {
  return ctx.provider.ops.filter((op) => op.op === 'exec') as Array<{ op: 'exec'; id: string; command: string[] }>;
}

function opsOfProvider(ctx: Ctx, provider: string): ProviderOp[] {
  return ctx.providers.get(resolveProviderName(provider))?.ops ?? [];
}

describe('sander exec', () => {
  it('runs the raw command tail inside the box and streams its output', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    ctx.provider.execResult = { exitCode: 0, stdout: 'total 4\n', stderr: '' };

    const code = await runCli(['exec', 'demo', 'ls', '-la'], ctx.deps);

    expect(code).toBe(0);
    expect(execCalls(ctx)).toEqual([{ op: 'exec', id: 'demo', command: ['ls', '-la'] }]);
    expect(ctx.stdout.text()).toContain('total 4');
  });

  it('passes the command tail verbatim without option parsing', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));

    const code = await runCli(['exec', 'demo', 'echo', '--sandbox', '--help', '-n'], ctx.deps);

    expect(code).toBe(0);
    expect(execCalls(ctx)).toEqual([{ op: 'exec', id: 'demo', command: ['echo', '--sandbox', '--help', '-n'] }]);
  });

  it('accepts --sandbox as an alternative to the positional id', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));

    const code = await runCli(['exec', '--sandbox', 'demo', 'sh', '-c', 'echo hi'], ctx.deps);

    expect(code).toBe(0);
    expect(execCalls(ctx)).toEqual([{ op: 'exec', id: 'demo', command: ['sh', '-c', 'echo hi'] }]);
  });

  it('propagates the command exit code and writes stderr to the stderr stream', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    ctx.provider.execResult = { exitCode: 2, stdout: '', stderr: 'no such file' };

    const code = await runCli(['exec', 'demo', 'cat', '/missing'], ctx.deps);

    expect(code).toBe(2);
    expect(ctx.stdout.text()).toBe('');
    expect(ctx.stderr.text()).toContain('no such file');
  });

  it('errors when the sandbox is not in the registry', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runCli(['exec', 'ghost', 'ls'], ctx.deps);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('sandbox not found: ghost');
    expect(execCalls(ctx)).toHaveLength(0);
  });

  it('errors when no command is given', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));

    const code = await runCli(['exec', 'demo'], ctx.deps);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('missing command');
    expect(execCalls(ctx)).toHaveLength(0);
  });

  it('errors when no id is given', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runCli(['exec'], ctx.deps);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('missing sandbox id');
    expect(execCalls(ctx)).toHaveLength(0);
  });

  it('resolves the engine from the box provider via the factory', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { provider: 'vercel' }));
    const vercelProvider = new FakeProvider();
    vercelProvider.execResult = { exitCode: 0, stdout: 'remote\n', stderr: '' };
    ctx.providers.set('vercel', vercelProvider);

    const code = await runCli(['exec', 'demo', 'ls'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.factoryCalls).toEqual(['vercel']);
    expect(opsOfProvider(ctx, 'vercel')).toEqual([{ op: 'exec', id: 'demo', command: ['ls'] }]);
    expect(ctx.provider.ops).toEqual([]);
    expect(ctx.stdout.text()).toContain('remote');
  });

  it('operates on a legacy agentbox box through the docker engine', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { provider: 'agentbox' }));

    const code = await runCli(['exec', 'demo', 'ls', '-la'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.factoryCalls).toEqual(['agentbox']);
    expect(execCalls(ctx)).toEqual([{ op: 'exec', id: 'demo', command: ['ls', '-la'] }]);
  });

  it('prints exec help for --help', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runCli(['exec', '--help'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('sander exec [<id> | --sandbox <id>] <command...>');
    expect(execCalls(ctx)).toHaveLength(0);
  });
});

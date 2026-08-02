import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CaptureStream } from '../../../test/helpers/capture-stream';
import { FakeProvider } from '../../provider/fake';
import type { ProviderOp } from '../../provider/fake';
import { FakeHarnessFactory } from '../../harness/fake';
import type { HarnessCall } from '../../harness/fake';
import { FakeWorktree } from '../../worktree/fake';
import { runCli } from '../main';
import type { CliDeps } from '../deps';
import { resolveProviderName } from '../../provider/providers';
import { emptyRegistry, saveRegistry, upsertBox } from '../../registry/registry';
import type { Sandbox } from '../../registry/registry';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sander-run-test-'));
}

interface Ctx {
  deps: CliDeps;
  provider: FakeProvider;
  providers: Map<string, FakeProvider>;
  factoryCalls: string[];
  harnessFactory: FakeHarnessFactory;
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
  const harnessFactory = new FakeHarnessFactory();
  return {
    deps: {
      configDir,
      stdout,
      stderr,
      createProvider,
      harnessFactory,
      worktree: new FakeWorktree(),
    },
    provider,
    providers,
    factoryCalls,
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

function register(ctx: Ctx, box: Sandbox): void {
  const registry = emptyRegistry();
  upsertBox(registry, box);
  saveRegistry(ctx.deps.configDir, registry);
}

function execCalls(ctx: Ctx): ProviderOp[] {
  return ctx.provider.ops.filter((op) => op.op === 'exec');
}

function opsOfProvider(ctx: Ctx, provider: string): ProviderOp[] {
  return ctx.providers.get(resolveProviderName(provider))?.ops ?? [];
}

function headlessCount(ctx: Ctx): number {
  const harness = ctx.harnessFactory.registered('opencode');
  return harness === undefined
    ? 0
    : harness.calls.filter((c: HarnessCall) => c.kind === 'headless').length;
}

describe('sander run', () => {
  it('resolves the box and runs the harness headless inside it via provider.exec', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));

    const code = await runCli(['run', 'demo', 'fix the tests'], ctx.deps);

    expect(code).toBe(0);
    expect(execCalls(ctx)).toEqual([{ op: 'exec', id: 'demo', command: ['opencode', 'fix the tests'] }]);
    expect(headlessCount(ctx)).toBe(0);
    expect(ctx.stdout.text()).toContain('Sandbox "demo" (opencode) finished with exit code 0.');
  });

  it('accepts --sandbox as an alternative to the positional id', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { harness: 'claude' }));

    const code = await runCli(['run', '--sandbox', 'demo', 'go'], ctx.deps);

    expect(code).toBe(0);
    expect(execCalls(ctx)).toEqual([{ op: 'exec', id: 'demo', command: ['claude', 'go'] }]);
    expect(ctx.stdout.text()).toContain('Sandbox "demo" (claude) finished with exit code 0.');
  });

  it('propagates the exec exit code and prints its output', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    ctx.provider.execResult = { exitCode: 3, stdout: 'partial progress', stderr: 'warned' };

    const code = await runCli(['run', 'demo', 'do it'], ctx.deps);

    expect(code).toBe(3);
    expect(ctx.stdout.text()).toContain('Sandbox "demo" (opencode) finished with exit code 3.');
    expect(ctx.stdout.text()).toContain('partial progress');
    expect(ctx.stdout.text()).toContain('warned');
  });

  it('errors when the sandbox is not in the registry', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runCli(['run', 'ghost', 'do it'], ctx.deps);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('sandbox not found: ghost');
    expect(execCalls(ctx)).toHaveLength(0);
  });

  it('errors when no prompt is given', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));

    const code = await runCli(['run', 'demo'], ctx.deps);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('missing prompt');
    expect(execCalls(ctx)).toHaveLength(0);
  });

  it('prints run help for --help', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runCli(['run', '--help'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('sander run [<id> | --sandbox <id>] <prompt>');
    expect(execCalls(ctx)).toHaveLength(0);
  });

  it('resolves the provider engine from the box provider via the factory', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { provider: 'vercel' }));
    const vercelProvider = new FakeProvider();
    vercelProvider.execResult = { exitCode: 0, stdout: 'remote\n', stderr: '' };
    ctx.providers.set('vercel', vercelProvider);

    const code = await runCli(['run', 'demo', 'go'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.factoryCalls).toEqual(['vercel']);
    expect(opsOfProvider(ctx, 'vercel')).toEqual([{ op: 'exec', id: 'demo', command: ['opencode', 'go'] }]);
    expect(ctx.provider.ops).toEqual([]);
    expect(ctx.stdout.text()).toContain('remote');
    expect(ctx.stdout.text()).toContain('Sandbox "demo" (opencode) finished with exit code 0.');
  });

  it('operates on a legacy agentbox box through the docker engine', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { provider: 'agentbox' }));

    const code = await runCli(['run', 'demo', 'go'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.factoryCalls).toEqual(['agentbox']);
    expect(execCalls(ctx)).toEqual([{ op: 'exec', id: 'demo', command: ['opencode', 'go'] }]);
  });

  it('never resolves or prompts for a token on the host: the box env is the credential transport', async () => {
    const configDir = tmpDir();
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ token: 'global-token', env: { FOO: 'bar', EXTRA: 'x' } }),
    );
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { envKeys: ['GITHUB_TOKEN', 'GH_TOKEN', 'FOO'] }));

    const code = await runCli(['run', 'demo', 'push my branch'], ctx.deps);

    expect(code).toBe(0);
    expect(execCalls(ctx)).toEqual([{ op: 'exec', id: 'demo', command: ['opencode', 'push my branch'] }]);
  });

  it('runs inside the box even when the box expects a token: no host token resolution', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { envKeys: ['GITHUB_TOKEN', 'GH_TOKEN'] }));

    const code = await runCli(['run', 'demo', 'push'], ctx.deps);

    expect(code).toBe(0);
    expect(execCalls(ctx)).toEqual([{ op: 'exec', id: 'demo', command: ['opencode', 'push'] }]);
  });

  it('does not prompt for a token when the box does not expect one', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));

    const code = await runCli(['run', 'demo', 'hi'], ctx.deps);

    expect(code).toBe(0);
    expect(execCalls(ctx)).toEqual([{ op: 'exec', id: 'demo', command: ['opencode', 'hi'] }]);
  });
});

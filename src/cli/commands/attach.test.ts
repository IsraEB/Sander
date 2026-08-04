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
import { runAttach } from './attach';
import type { CliDeps } from '../deps';
import { resolveProviderName } from '../../provider/providers';
import { emptyRegistry, saveRegistry, upsertBox } from '../../registry/registry';
import type { Sandbox } from '../../registry/registry';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sander-attach-test-'));
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

function attachOps(ctx: Ctx): Array<{ op: 'attach'; id: string; opts: { tty: boolean } }> {
  return ctx.provider.ops.filter((op) => op.op === 'attach') as Array<{ op: 'attach'; id: string; opts: { tty: boolean } }>;
}

function opsOfProvider(ctx: Ctx, provider: string): ProviderOp[] {
  return ctx.providers.get(resolveProviderName(provider))?.ops ?? [];
}

describe('sander attach', () => {
  it('opens a pass-through session: attach is called with the id and tty passthrough', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));

    const code = await runCli(['attach', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(attachOps(ctx)).toEqual([{ op: 'attach', id: 'demo', opts: { tty: true } }]);
    expect(ctx.stdout.text()).toContain('Sandbox "demo" (opencode) session exited with code 0.');
  });

  it('accepts --sandbox as an alternative to the positional id', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { harness: 'claude' }));

    const code = await runCli(['attach', '--sandbox', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(attachOps(ctx)).toEqual([{ op: 'attach', id: 'demo', opts: { tty: true } }]);
    expect(ctx.stdout.text()).toContain('Sandbox "demo" (claude) session exited with code 0.');
  });

  it('propagates the session exit code', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    ctx.provider.attachResult = 5;

    const code = await runCli(['attach', 'demo'], ctx.deps);

    expect(code).toBe(5);
    expect(ctx.stdout.text()).toContain('session exited with code 5.');
  });

  it('never runs the wizard from attach and probes for a running agent session first', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));

    const code = await runCli(['attach', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.provider.ensureSetupCalls).toEqual([{ interactive: false }]);
    const ops = ctx.provider.ops.map((op) => op.op);
    expect(ops).toEqual(['hasAgentSession', 'attach']);
    expect(attachOps(ctx)).toEqual([{ op: 'attach', id: 'demo', opts: { tty: true } }]);
  });

  it('opens a box shell with a hint when no agent session is running', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { harness: 'claude' }));
    ctx.provider.hasAgentSessionResult = false;
    ctx.provider.shellResult = 7;

    const code = await runCli(['attach', 'demo'], ctx.deps);

    expect(code).toBe(7);
    expect(ctx.provider.ensureSetupCalls).toEqual([{ interactive: false }]);
    expect(ctx.provider.ops).toEqual([
      { op: 'hasAgentSession', id: 'demo' },
      { op: 'shell', id: 'demo' },
    ]);
    expect(ctx.stderr.text()).toContain('no agent session running in "demo"');
    expect(ctx.stderr.text()).toContain('run "claude" in the shell');
    expect(ctx.stdout.text()).toContain('Sandbox "demo" (claude) shell exited with code 7.');
  });

  it('tells the user the box is yolo when attaching', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { yolo: true }));

    const code = await runCli(['attach', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('Sandbox "demo" is yolo: actions auto-approve.');
  });

  it('tells the user the box is not yolo when attaching', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { yolo: false }));

    const code = await runCli(['attach', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('Sandbox "demo" is not yolo: the harness will ask for approval.');
  });

  it('defaults to yolo for a legacy box without the field', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));

    const code = await runCli(['attach', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('Sandbox "demo" is yolo: actions auto-approve.');
  });

  it('informs the yolo mode when falling back to a box shell', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { yolo: false }));
    ctx.provider.hasAgentSessionResult = false;
    ctx.provider.shellResult = 0;

    const code = await runCli(['attach', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('Sandbox "demo" is not yolo: the harness will ask for approval.');
    expect(ctx.stdout.text()).toContain('Sandbox "demo" (opencode) shell exited with code 0.');
  });

  it('never tells the user about the legacy agentbox tool', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('feature/asd-jshdia', { harness: 'claude' }));
    ctx.provider.hasAgentSessionResult = false;
    ctx.provider.shellResult = 0;

    const code = await runCli(['attach', 'feature/asd-jshdia'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stderr.text()).toContain('no agent session running in "feature/asd-jshdia"');
    expect(ctx.stderr.text()).not.toContain('agentbox');
  });

  it('resolves the engine from the box provider via the factory', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { provider: 'vercel' }));

    const code = await runCli(['attach', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.factoryCalls).toEqual(['vercel']);
    expect(opsOfProvider(ctx, 'vercel')).toEqual([
      { op: 'hasAgentSession', id: 'demo' },
      { op: 'attach', id: 'demo', opts: { tty: true } },
    ]);
    expect(ctx.provider.ops).toEqual([]);
  });

  it('operates on a legacy agentbox box through the docker engine', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { provider: 'agentbox' }));

    const code = await runCli(['attach', 'demo'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.factoryCalls).toEqual(['agentbox']);
    // The legacy alias resolved to the docker engine (the shared default fake).
    expect(attachOps(ctx)).toEqual([{ op: 'attach', id: 'demo', opts: { tty: true } }]);
  });

  it('errors when the sandbox is not in the registry', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runCli(['attach', 'ghost'], ctx.deps);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('sandbox not found: ghost');
    expect(attachOps(ctx)).toHaveLength(0);
  });

  it('errors when no id is given', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runCli(['attach'], ctx.deps);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('missing sandbox id');
    expect(attachOps(ctx)).toHaveLength(0);
  });

  it('errors on unexpected extra arguments', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));

    const code = await runCli(['attach', 'demo', 'extra'], ctx.deps);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('unexpected argument "extra"');
    expect(attachOps(ctx)).toHaveLength(0);
  });

  it('prints attach help for --help', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runCli(['attach', '--help'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('sander attach [<id> | --sandbox <id>]');
  });

  it('runAttach with launchHarness launches the box harness when no agent session runs', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    ctx.provider.hasAgentSessionResult = false;
    ctx.provider.shellResult = 7;

    const code = await runAttach(ctx.deps, ['demo'], { launchHarness: true });

    expect(code).toBe(7);
    expect(ctx.provider.ops).toEqual([
      { op: 'hasAgentSession', id: 'demo' },
      { op: 'shell', id: 'demo', command: ['opencode'] },
    ]);
    expect(ctx.stderr.text()).toContain('launching opencode');
    expect(ctx.stdout.text()).toContain('Sandbox "demo" (opencode) session exited with code 7.');
  });

  it('runAttach with launchHarness attaches to the running session instead', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    ctx.provider.attachResult = 4;

    const code = await runAttach(ctx.deps, ['demo'], { launchHarness: true });

    expect(code).toBe(4);
    expect(ctx.provider.ops).toEqual([
      { op: 'hasAgentSession', id: 'demo' },
      { op: 'attach', id: 'demo', opts: { tty: true } },
    ]);
    expect(ctx.provider.ops.filter((op) => op.op === 'shell')).toHaveLength(0);
  });

  it('runAttach with launchHarness uses the box harness for the command', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { harness: 'claude' }));
    ctx.provider.hasAgentSessionResult = false;

    const code = await runAttach(ctx.deps, ['demo'], { launchHarness: true });

    expect(code).toBe(0);
    expect(ctx.provider.ops).toEqual([
      { op: 'hasAgentSession', id: 'demo' },
      { op: 'shell', id: 'demo', command: ['claude'] },
    ]);
    expect(ctx.stderr.text()).toContain('launching claude');
  });
});

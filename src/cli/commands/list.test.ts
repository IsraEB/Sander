import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CaptureStream } from '../../../test/helpers/capture-stream';
import { FakeProvider } from '../../provider/fake';
import { FakeHarnessFactory } from '../../harness/fake';
import { FakeWorktree } from '../../worktree/fake';
import { runCli } from '../main';
import type { CliDeps } from '../deps';
import { resolveProviderName } from '../../provider/providers';
import { emptyRegistry, saveRegistry, upsertBox } from '../../registry/registry';
import type { Sandbox } from '../../registry/registry';
import { containerNameForSandbox, dockerContainerName } from '../../names/sandbox-name';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sander-list-test-'));
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

describe('sander list', () => {
  it('lists an empty registry with exit 0', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runCli(['list'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('No sandboxes found');
  });

  it('shows a PORTS column with the exposed ports', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    const registry = emptyRegistry();
    upsertBox(registry, makeBox('demo'));
    upsertBox(registry, makeBox('web', { harness: 'claude', status: 'stopped' }));
    saveRegistry(configDir, registry);
    ctx.provider.portsByBox.set('demo', [{ host: '8080', container: '80' }, { host: '9000' }]);

    const code = await runCli(['list'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('PORTS');
    expect(ctx.stdout.text()).toContain('8080->80,9000');
    expect(ctx.provider.ops).toEqual([
      { op: 'ports', id: 'demo' },
      { op: 'ports', id: 'web' },
    ]);
  });

  it('renders host-only ports when the container mapping is unknown', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    const registry = emptyRegistry();
    upsertBox(registry, makeBox('demo'));
    saveRegistry(configDir, registry);
    ctx.provider.portsByBox.set('demo', [{ host: '8080' }, { host: '9000' }]);

    const code = await runCli(['list'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('PORTS');
    expect(ctx.stdout.text()).toContain('8080,9000');
  });

  it('renders host-only ports when the container field is undefined (provider shape)', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    const registry = emptyRegistry();
    upsertBox(registry, makeBox('demo'));
    saveRegistry(configDir, registry);
    // normalizePorts emits `container: undefined` (property present, value undefined)
    // rather than omitting the key entirely; rendering must treat it as unknown.
    ctx.provider.portsByBox.set('demo', [{ host: '8080', container: undefined }, { host: '9000', container: undefined }]);

    const code = await runCli(['list'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('PORTS');
    expect(ctx.stdout.text()).toContain('8080,9000');
    expect(ctx.stdout.text()).not.toContain('->');
  });

  it('shows a YOLO column with each box yolo mode', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    const registry = emptyRegistry();
    upsertBox(registry, makeBox('demo', { yolo: true }));
    upsertBox(registry, makeBox('careful', { yolo: false, harness: 'claude' }));
    saveRegistry(configDir, registry);

    const code = await runCli(['list'], ctx.deps);

    expect(code).toBe(0);
    const out = ctx.stdout.text();
    expect(out).toContain('YOLO');
    expect(out.indexOf('HARNESS')).toBeLessThan(out.indexOf('YOLO'));
    expect(out.indexOf('YOLO')).toBeLessThan(out.indexOf('STATUS'));
    expect(out).toMatch(/opencode\s+sí\s+running/);
    expect(out).toMatch(/claude\s+no\s+running/);
  });

  it('shows the yolo default true for legacy boxes without the field', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));

    const code = await runCli(['list'], ctx.deps);

    expect(code).toBe(0);
    const out = ctx.stdout.text();
    expect(out).toContain('YOLO');
    expect(out).toMatch(/opencode\s+sí\s+running/);
  });

  it('renders an em dash for boxes without ports', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));

    const code = await runCli(['list'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('PORTS');
    expect(ctx.stdout.text()).toContain('—');
  });

  it('warns on stderr and degrades to an em dash when reading ports fails', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    register(ctx, makeBox('web'));
    ctx.provider.nextError = new Error('agentbox ls failed');

    const code = await runCli(['list'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stderr.text()).toContain('Aviso: no se pudieron leer los puertos de algún sandbox');
    expect(ctx.stdout.text()).toContain('—');
    expect(ctx.stdout.text()).not.toContain('agentbox ls failed');
  });

  it('omits the REAL CONTAINER column when no box needs mapping', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo'));
    register(ctx, makeBox('web'));

    const code = await runCli(['list'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('ID');
    expect(ctx.stdout.text()).toContain('PROVIDER');
    expect(ctx.stdout.text()).toContain('PORTS');
    expect(ctx.stdout.text()).not.toContain('REAL CONTAINER');
    expect(ctx.stdout.text()).not.toContain('agentbox-');
  });

  it('shows the REAL CONTAINER column for all rows when any box needs mapping', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    const registry = emptyRegistry();
    upsertBox(registry, makeBox('feature/asd-jshdia'));
    upsertBox(registry, makeBox('demo'));
    saveRegistry(configDir, registry);
    ctx.provider.portsByBox.set('feature/asd-jshdia', [{ host: '8080' }]);

    const code = await runCli(['list'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('REAL CONTAINER');
    expect(ctx.stdout.text()).toContain(dockerContainerName(containerNameForSandbox('feature/asd-jshdia')));
    expect(ctx.stdout.text()).toContain(dockerContainerName('demo'));
  });

  it('prefers a persisted containerName over the derived mapping', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    const registry = emptyRegistry();
    upsertBox(registry, makeBox('feature/asd-jshdia', { containerName: 'persisted-name' }));
    upsertBox(registry, makeBox('demo'));
    saveRegistry(configDir, registry);

    const code = await runCli(['list'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('REAL CONTAINER');
    expect(ctx.stdout.text()).toContain('agentbox-persisted-name');
  });

  it('shows docker in the PROVIDER column for a legacy agentbox box', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    register(ctx, makeBox('demo', { provider: 'agentbox' }));

    const code = await runCli(['list'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.factoryCalls).toEqual(['agentbox']);
    expect(ctx.stdout.text()).toContain('demo');
    expect(ctx.stdout.text()).toContain('docker');
    expect(ctx.stdout.text()).not.toContain('agentbox');
  });

  it('resolves the engine per box when reading ports', async () => {
    const configDir = tmpDir();
    const ctx = makeCtx(configDir);
    const registry = emptyRegistry();
    upsertBox(registry, makeBox('demo', { provider: 'vercel' }));
    upsertBox(registry, makeBox('web'));
    saveRegistry(configDir, registry);
    const vercelProvider = new FakeProvider();
    vercelProvider.portsByBox.set('demo', [{ host: '8080', container: '80' }]);
    ctx.providers.set('vercel', vercelProvider);

    const code = await runCli(['list'], ctx.deps);

    expect(code).toBe(0);
    expect(ctx.factoryCalls).toEqual(['vercel', 'docker']);
    expect(ctx.providers.get('vercel')!.ops).toEqual([{ op: 'ports', id: 'demo' }]);
    expect(ctx.provider.ops).toEqual([{ op: 'ports', id: 'web' }]);
    expect(ctx.stdout.text()).toContain('8080->80');
  });
});

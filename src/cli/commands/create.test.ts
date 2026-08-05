import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { CaptureStream } from '../../../test/helpers/capture-stream';
import { FakeProvider } from '../../provider/fake';
import type { ProviderOp } from '../../provider/fake';
import { FakeHarnessFactory } from '../../harness/fake';
import { FakeWorktree } from '../../worktree/fake';
import type { WorktreeRef } from '../../worktree/worktree';
import { supervisorScriptSource } from '../../setup/supervisor';
import { runCli } from '../main';
import type { CliDeps } from '../deps';
import { CliError } from '../errors';
import { resolveRequiredConfig, parseCreateArgs } from './create';
import type { CreateRequest } from '../../provider/provider';
import { loadRegistry } from '../../registry/registry';
import type { Sandbox } from '../../registry/registry';
import { containerNameForSandbox, dockerContainerName } from '../../names/sandbox-name';
import * as gitaccess from '../../provider/gitaccess';
import type { KeySource, SelectorKey } from '../../selector/selector';

// The sync source is the recipe's hostConfigDir (a real host dir like
// ~/.claude). Tests redirect it to a temp dir so they never touch the real
// home; the recipe's boxConfigDir (the real dir the harness reads inside the
// box) stays untouched.
const { mockHostDirs } = vi.hoisted(() => ({ mockHostDirs: new Map<string, string>() }));

vi.mock('../../recipes/recipes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../recipes/recipes')>();
  const unsetHostDir = path.join(os.tmpdir(), 'sander-recipe-host-unset');
  return {
    ...actual,
    getRecipe: (name: string) => {
      const recipe = actual.getRecipe(name);
      if (!recipe) return recipe;
      return { ...recipe, hostConfigDir: mockHostDirs.get(name) ?? unsetHostDir };
    },
  };
});

// create spawns the sync watcher detached by default; the mock keeps the tests
// from launching a real background `sander sync <id> --watch` process while
// still letting us assert the spawn call.
const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({ unref: () => {} })),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sander-create-test-'));
}

function keysSource(keys: SelectorKey[]): KeySource {
  let index = 0;
  return {
    next: async () => (index < keys.length ? keys[index++]! : null),
  };
}

interface Ctx {
  deps: CliDeps;
  provider: FakeProvider;
  harnessFactory: FakeHarnessFactory;
  worktree: FakeWorktree;
  stdout: CaptureStream;
  stderr: CaptureStream;
}

function makeCtx(configDir: string, projectRoot: string, opts: { configured?: boolean } = {}): Ctx {
  if (opts.configured !== false && !fs.existsSync(path.join(configDir, 'config.json'))) {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ provider: 'docker', harness: 'opencode' }),
    );
  }
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const provider = new FakeProvider();
  provider.defaultFileState = new Map([
    ['/workspace/.sander/install.sh', true],
    ['/workspace/.sander/start.sh', true],
  ]);
  const harnessFactory = new FakeHarnessFactory();
  const worktree = new FakeWorktree();
  worktree.createResult = makeWorktree();
  return {
    deps: {
      configDir,
      stdout,
      stderr,
      stdin: new PassThrough(),
      createProvider: () => provider,
      harnessFactory,
      worktree,
    },
    provider,
    harnessFactory,
    worktree,
    stdout,
    stderr,
  };
}

function makeProject(): string {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'README.md'), 'hi');
  return root;
}

function makeHarnessConfig(files: Record<string, string>): string {
  const dir = tmpDir();
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
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

function interactiveOps(ctx: Ctx): ProviderOp[] {
  return ctx.provider.ops.filter((op) => op.op === 'hasAgentSession' || op.op === 'attach' || op.op === 'shell');
}

function makeWorktree(branch = 'demo'): WorktreeRef {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, '.sander'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sander', 'install.sh'), '#!/bin/sh\necho install\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, '.sander', 'start.sh'), '#!/bin/sh\necho start\n', { mode: 0o755 });
  return { branch, worktreePath: root };
}

function execOps(ctx: Ctx): Array<Extract<ProviderOp, { op: 'exec' }>> {
  return ctx.provider.ops.filter((op): op is Extract<ProviderOp, { op: 'exec' }> => op.op === 'exec');
}

function syncExecOp(ctx: Ctx): Extract<ProviderOp, { op: 'exec' }> | undefined {
  return execOps(ctx).find((op) => op.command.join(' ').includes('sander-config'));
}

function yoloReadExec(ctx: Ctx): Extract<ProviderOp, { op: 'exec' }> | undefined {
  return execOps(ctx).find((op) => op.command.join(' ').startsWith('sh -c cat '));
}

function yoloCopyOp(ctx: Ctx): Extract<ProviderOp, { op: 'copy' }> | undefined {
  return ctx.provider.ops.find(
    (op): op is Extract<ProviderOp, { op: 'copy' }> => op.op === 'copy' && op.destination.startsWith('/tmp/sander-yolo/'),
  );
}

function yoloPlaceExec(ctx: Ctx): Extract<ProviderOp, { op: 'exec' }> | undefined {
  return execOps(ctx).find((op) => op.command.join(' ').includes('/tmp/sander-yolo/'));
}

function yoloStagedContent(ctx: Ctx, harness: string, fileName: string): string | undefined {
  return ctx.provider.copiedContents.find((c) => c.destination === `/tmp/sander-yolo/${harness}`)?.files[fileName];
}

function installExecs(ctx: Ctx): Array<Extract<ProviderOp, { op: 'exec' }>> {
  return execOps(ctx).filter((op) => op.command[0] === '/workspace/.sander/install.sh');
}

function supervisorExecs(ctx: Ctx): Array<Extract<ProviderOp, { op: 'exec' }>> {
  return execOps(ctx).filter((op) => op.command.join(' ').includes('supervisor.sh start'));
}

function hasYoloOps(ctx: Ctx): boolean {
  return (
    ctx.provider.ops.some((op) => op.op === 'copy' && op.destination.startsWith('/tmp/sander-yolo/')) ||
    execOps(ctx).some((op) => op.command.join(' ').includes('sander-yolo') || op.command.join(' ').startsWith('sh -c cat '))
  );
}

// Makes the yolo read exec (`cat <boxConfigDir>/<configFileName>`) return the
// given box config content; every other exec falls back to the default result.
function stubBoxConfig(ctx: Ctx, boxPath: string, content: string): void {
  ctx.provider.execHook = (id, command) => {
    if (command.join(' ').startsWith('sh -c cat ') && command.join(' ').includes(boxPath)) {
      return { exitCode: 0, stdout: content, stderr: '' };
    }
    return undefined;
  };
}

function hasExecutableOps(ctx: Ctx): Array<Extract<ProviderOp, { op: 'hasExecutable' }>> {
  return ctx.provider.ops.filter((op): op is Extract<ProviderOp, { op: 'hasExecutable' }> => op.op === 'hasExecutable');
}

describe('sander create', () => {
  beforeEach(() => {
    mockHostDirs.clear();
    spawnMock.mockClear();
  });

  it('creates a box, syncs harness config, and registers it', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules/\n');
    const ctx = makeCtx(configDir, project);
    const cfg = makeHarnessConfig({ 'opencode.json': '{}', 'command/help.md': 'docs' });
    mockHostDirs.set('opencode', cfg);

    const code = await runIn(project, ctx, ['create', '--harness', 'opencode', '--provider', 'docker', '--name', 'demo']);
    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('Created sandbox "demo"');
    expect(ctx.stdout.text()).toContain('synced 2 opencode config file(s) into the box');

    // The config is staged and then placed into the dir opencode reads inside
    // the box (the OPENCODE_CONFIG_DIR volume), not into ~/.config/opencode.
    expect(ctx.provider.ops.find((op) => op.op === 'copy' && op.destination === '/tmp/sander-config/opencode')).toBeDefined();
    const syncExec = syncExecOp(ctx);
    expect(syncExec?.command.join(' ')).toContain('mkdir -p ~/.local/share/opencode/config');
    expect(syncExec?.command.join(' ')).toContain('cp -a /tmp/sander-config/opencode/. ~/.local/share/opencode/config/');
    expect(syncExec?.command.join(' ')).not.toContain('~/.config/opencode');

    expect(opsOf(ctx)).toEqual(['create', 'copy', 'exec', 'exec', 'copy', 'exec', 'hasExecutable', 'hasExecutable', 'exec', 'copy', 'exec']);
    expect(ctx.provider.ops[0]).toMatchObject({ op: 'create', req: { id: 'demo', provider: 'docker', harness: 'opencode', projectRoot: project } });

    const registry = loadRegistry(configDir);
    const box = registry.boxes.demo as Sandbox;
    expect(box).toBeDefined();
    expect(box).toMatchObject({ id: 'demo', provider: 'docker', harness: 'opencode', yolo: true, status: 'running', projectRoot: project });
  });

  it('drives the create in prepare -> provision -> align phases with the sandbox payload', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(0);
    expect(ctx.provider.createPhases.map((phase) => phase.phase)).toEqual(['prepare', 'create', 'finalize']);
    for (const phase of ctx.provider.createPhases) {
      expect(phase.req).toMatchObject({ id: 'demo', provider: 'docker', harness: 'opencode', projectRoot: project });
    }
  });

  it('runs provider setup before creating the box', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(0);
    expect(ctx.provider.ensureSetupCalls).toHaveLength(1);
    expect(opsOf(ctx)[0]).toBe('create');
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  it('continues create with a warning when provider setup fails', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    ctx.provider.ensureSetupError = new Error('boom');

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(0);
    expect(ctx.stderr.text()).toContain('warning: provider setup did not complete (boom)');
    expect(opsOf(ctx)[0]).toBe('create');
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  it('ensures the agentbox base image before creating the box', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(0);
    expect(ctx.provider.ensureSetupCalls).toHaveLength(1);
    expect(ctx.provider.ensureBaseImageCalls).toBe(1);
    expect(opsOf(ctx)[0]).toBe('create');
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  it('continues create with a warning when the base image cannot be prepared', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    ctx.provider.ensureBaseImageError = new Error('docker daemon is not running');

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(0);
    expect(ctx.stderr.text()).toContain('warning: provider base image is not ready');
    expect(ctx.stderr.text()).toContain('docker daemon is not running');
    expect(opsOf(ctx)[0]).toBe('create');
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  it('does not inject harness config files that the project .gitignore excludes', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    fs.writeFileSync(path.join(project, '.gitignore'), '*.json\n');
    const ctx = makeCtx(configDir, project);
    const cfg = makeHarnessConfig({ 'opencode.json': '{}', 'command/help.md': 'docs' });
    mockHostDirs.set('opencode', cfg);

    const code = await runIn(project, ctx, ['create', '--harness', 'opencode', '--provider', 'docker', '--name', 'demo']);
    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('synced 1 opencode config file(s) into the box');
    const copyOp = ctx.provider.ops.find((op) => op.op === 'copy');
    expect(copyOp).toBeDefined();
    expect(copyOp && 'destination' in copyOp ? copyOp.destination : '').toContain('sander-config');
    const syncExec = syncExecOp(ctx);
    expect(syncExec?.command.join(' ')).toContain('~/.local/share/opencode/config');
    expect(ctx.stdout.text()).not.toContain('synced 2');
  });

  it('succeeds with a note when there is no global harness config', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    mockHostDirs.set('opencode', path.join(tmpDir(), 'does-not-exist'));

    const code = await runIn(project, ctx, ['create', '--harness', 'opencode', '--provider', 'docker', '--name', 'demo']);
    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('no global opencode config found');
    expect(opsOf(ctx)).toEqual(['create', 'exec', 'copy', 'exec', 'hasExecutable', 'hasExecutable', 'exec', 'copy', 'exec']);
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  it('succeeds with a note when the global harness config is empty', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    mockHostDirs.set('opencode', makeHarnessConfig({}));

    const code = await runIn(project, ctx, ['create', '--harness', 'opencode', '--provider', 'docker', '--name', 'demo']);
    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('global opencode config is empty');
    expect(opsOf(ctx)).toEqual(['create', 'exec', 'copy', 'exec', 'hasExecutable', 'hasExecutable', 'exec', 'copy', 'exec']);
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  it('succeeds with a note when the global harness config is fully excluded by the project .gitignore', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    fs.writeFileSync(path.join(project, '.gitignore'), '*.json\n');
    const ctx = makeCtx(configDir, project);
    mockHostDirs.set('opencode', makeHarnessConfig({ 'opencode.json': '{}' }));

    const code = await runIn(project, ctx, ['create', '--harness', 'opencode', '--provider', 'docker', '--name', 'demo']);
    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('global opencode config is fully excluded by the project .gitignore');
    expect(opsOf(ctx)).toEqual(['create', 'exec', 'copy', 'exec', 'hasExecutable', 'hasExecutable', 'exec', 'copy', 'exec']);
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  it('syncs from the recipe host config dir, not the harness adapter config dir', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    const recipeHost = makeHarnessConfig({ 'opencode.json': '{}', 'command/help.md': 'docs' });
    mockHostDirs.set('opencode', recipeHost);
    // The adapter's own config dir holds different content and must be ignored
    // for harnesses with a recipe.
    ctx.harnessFactory.get('opencode').config = makeHarnessConfig({ 'other.json': '{}' });

    const code = await runIn(project, ctx, ['create', '--harness', 'opencode', '--provider', 'docker', '--name', 'demo']);
    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('synced 2 opencode config file(s) into the box');
    expect(ctx.stdout.text()).not.toContain('synced 1');
  });

  it('requires --name', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    const code = await runIn(project, ctx, ['create', '--harness', 'opencode']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('missing sandbox id: pass <id> or --name <id>');
  });

  it('creates a box from a positional id', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', 'demo']);

    expect(code).toBe(0);
    expect(createReq(ctx).id).toBe('demo');
    expect(ctx.provider.ops[0]).toMatchObject({ op: 'create', req: { id: 'demo', provider: 'docker', harness: 'opencode' } });
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
    expect(ctx.stdout.text()).toContain('Created sandbox "demo"');
  });

  it('rejects more than one positional id', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', 'demo', 'other']);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('unexpected extra argument');
    expect(ctx.provider.ops).toHaveLength(0);
    expect(loadRegistry(configDir).boxes.demo).toBeUndefined();
  });

  it('rejects a positional id combined with --name', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', 'demo', '--name', 'other']);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('ambiguous sandbox id');
    expect(ctx.provider.ops).toHaveLength(0);
    expect(loadRegistry(configDir).boxes.demo).toBeUndefined();
  });

  it('rejects duplicate sandbox ids', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    await runIn(project, ctx, ['create', '--name', 'demo']);
    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('already exists');
  });

  it('rejects unsupported providers', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    const code = await runIn(project, ctx, ['create', '--name', 'demo', '--provider', 'vps']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('unsupported provider "vps"');
  });

  it('rejects --provider agentbox with an actionable error suggesting docker and creates nothing', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project, { configured: false });

    const code = await runIn(project, ctx, ['create', '--name', 'demo', '--provider', 'agentbox']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('provider "agentbox" is deprecated');
    expect(ctx.stderr.text()).toContain('sander config set provider docker');
    expect(opsOf(ctx)).not.toContain('create');
    expect(loadRegistry(configDir).boxes.demo).toBeUndefined();
    expect(fs.existsSync(path.join(configDir, 'config.json'))).toBe(false);
  });

  it('passes --provider vercel to the engine and stores vercel in the registry', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo', '--provider', 'vercel']);
    expect(code).toBe(0);
    expect(ctx.provider.ops[0]).toMatchObject({ op: 'create', req: { provider: 'vercel', harness: 'opencode' } });
    expect(loadRegistry(configDir).boxes.demo).toMatchObject({ provider: 'vercel' });
    expect(ctx.stdout.text()).toContain('Created sandbox "demo" (provider vercel, harness opencode).');
  });

  it('create with no provider anywhere defaults to docker and stores docker', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project, { configured: false });
    ctx.deps.selectorKeySource = keysSource(['enter', 'enter']);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(0);
    expect(ctx.stderr.text()).toContain('> 1) docker');
    expect(ctx.stderr.text()).toContain('> 1) opencode');
    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'))).toEqual({
      provider: 'docker',
      harness: 'opencode',
    });
    expect(ctx.provider.ops[0]).toMatchObject({ op: 'create', req: { provider: 'docker', harness: 'opencode' } });
    expect(loadRegistry(configDir).boxes.demo).toMatchObject({ provider: 'docker' });
  });

  it('warns and uses docker for legacy config provider agentbox without rewriting the config file', async () => {
    const configDir = tmpDir();
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ provider: 'agentbox', harness: 'opencode' }));
    const project = makeProject();
    const ctx = makeCtx(configDir, project, { configured: false });
    ctx.deps.prompt = () => {
      throw new Error('prompt must not be called when the legacy config provides the required keys');
    };

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(0);
    expect(ctx.stderr.text()).toContain('sander config set provider docker');
    expect(ctx.provider.ops[0]).toMatchObject({ op: 'create', req: { provider: 'docker', harness: 'opencode' } });
    expect(loadRegistry(configDir).boxes.demo).toMatchObject({ provider: 'docker' });
    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'))).toEqual({
      provider: 'agentbox',
      harness: 'opencode',
    });
  });

  it('reports provider failures without registering the box', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    ctx.provider.nextError = new Error('agentbox create failed: boom');
    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('boom');
    // The branch was prepared, but provisioning failed: alignment never runs.
    expect(ctx.provider.createPhases.map((phase) => phase.phase)).toEqual(['prepare', 'create']);
    expect(loadRegistry(configDir).boxes.demo).toBeUndefined();
  });

  it('cleans up the box when config sync fails', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    const cfg = makeHarnessConfig({ 'opencode.json': '{}' });
    mockHostDirs.set('opencode', cfg);
    ctx.provider.execResult = { exitCode: 1, stdout: '', stderr: 'no such file' };

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('failed to place opencode config');
    expect(opsOf(ctx)).toEqual(['create', 'copy', 'exec', 'remove']);
    expect(ctx.worktree.ops.map((op) => op.op)).toEqual(['deleteStaleBranches', 'createWorktreeBranch', 'removeWorktree', 'deleteBranch']);
    expect(loadRegistry(configDir).boxes.demo).toBeUndefined();
  });

  it('mounts and registers the worktree branch relationship', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(0);
    expect(ctx.worktree.ops).toEqual([
      { op: 'deleteStaleBranches', projectRoot: project },
      { op: 'createWorktreeBranch', projectRoot: project, id: 'demo' },
    ]);
    const box = loadRegistry(configDir).boxes.demo as Sandbox;
    expect(box.branch).toBe('demo');
    expect(box.worktreePath).toBe(ctx.worktree.createResult!.worktreePath);
  });

  it('continues with a warning when the project is not a git repository', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    ctx.worktree.createResult = null;

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(0);
    expect(ctx.worktree.ops).toEqual([
      { op: 'deleteStaleBranches', projectRoot: project },
      { op: 'createWorktreeBranch', projectRoot: project, id: 'demo' },
    ]);
    expect(ctx.stderr.text()).toContain('Aviso: el proyecto no es un repositorio git');
    const box = loadRegistry(configDir).boxes.demo as Sandbox;
    expect(box.branch).toBeUndefined();
    expect(box.worktreePath).toBeUndefined();
  });

  it('fails create and cleans up when the worktree branch cannot be created', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    ctx.worktree.nextError = new Error('no se pudo crear el worktree');

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('no se pudo crear el worktree');
    expect(opsOf(ctx)).toEqual(['create', 'remove']);
    expect(ctx.worktree.ops.map((op) => op.op)).toEqual(['deleteStaleBranches', 'removeWorktree', 'deleteBranch']);
    expect(loadRegistry(configDir).boxes.demo).toBeUndefined();
  });

  it('falls back to defaults from the global config', async () => {
    const configDir = tmpDir();
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ harness: 'claude', provider: 'docker' }));
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    mockHostDirs.set('claude', makeHarnessConfig({ 'settings.json': '{}' }));

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(0);
    expect(ctx.provider.ops[0]).toMatchObject({ op: 'create', req: { harness: 'claude' } });
    const syncExec = syncExecOp(ctx);
    expect(syncExec?.command.join(' ')).toContain('~/.claude');
    expect(syncExec?.command.join(' ')).not.toContain('~/.config/claude');
    expect(loadRegistry(configDir).boxes.demo.harness).toBe('claude');
  });

  it('resolves harness and provider from the workspace layer when not set globally or via flags', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    fs.mkdirSync(path.join(project, '.sander'));
    fs.writeFileSync(
      path.join(project, '.sander', 'config.json'),
      JSON.stringify({ provider: 'docker', harness: 'codex' }),
    );
    const ctx = makeCtx(configDir, project, { configured: false });
    ctx.deps.prompt = () => {
      throw new Error('prompt must not be called when the workspace layer configures the required keys');
    };

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(0);
    expect(ctx.provider.ops[0]).toMatchObject({ op: 'create', req: { provider: 'docker', harness: 'codex' } });
    expect(loadRegistry(configDir).boxes.demo.harness).toBe('codex');
  });

  it('lets the --harness/--provider flags override the global and workspace layers', async () => {
    const configDir = tmpDir();
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ provider: 'docker', harness: 'global-harness' }));
    const project = makeProject();
    fs.mkdirSync(path.join(project, '.sander'));
    fs.writeFileSync(
      path.join(project, '.sander', 'config.json'),
      JSON.stringify({ provider: 'docker', harness: 'ws-harness' }),
    );
    const ctx = makeCtx(configDir, project, { configured: false });

    const code = await runIn(project, ctx, ['create', '--harness', 'flag-harness', '--name', 'demo']);
    expect(code).toBe(0);
    expect(ctx.provider.ops[0]).toMatchObject({ op: 'create', req: { provider: 'docker', harness: 'flag-harness' } });
    expect(loadRegistry(configDir).boxes.demo.harness).toBe('flag-harness');
  });

  it('resolves provider from the workspace layer over the global layer', async () => {
    const configDir = tmpDir();
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ provider: 'vercel', harness: 'opencode' }));
    const project = makeProject();
    fs.mkdirSync(path.join(project, '.sander'));
    fs.writeFileSync(
      path.join(project, '.sander', 'config.json'),
      JSON.stringify({ provider: 'docker', harness: 'opencode' }),
    );
    const ctx = makeCtx(configDir, project, { configured: false });
    ctx.deps.prompt = () => {
      throw new Error('prompt must not be called when the workspace layer configures the required keys');
    };

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(0);
    expect(ctx.provider.ops[0]).toMatchObject({ op: 'create', req: { provider: 'docker', harness: 'opencode' } });
    expect(loadRegistry(configDir).boxes.demo.provider).toBe('docker');
  });

  it('resolves harness from the workspace layer over the global layer', async () => {
    const configDir = tmpDir();
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ provider: 'docker', harness: 'claude' }));
    const project = makeProject();
    fs.mkdirSync(path.join(project, '.sander'));
    fs.writeFileSync(
      path.join(project, '.sander', 'config.json'),
      JSON.stringify({ provider: 'docker', harness: 'codex' }),
    );
    const ctx = makeCtx(configDir, project, { configured: false });
    ctx.deps.prompt = () => {
      throw new Error('prompt must not be called when the workspace layer configures the required keys');
    };
    mockHostDirs.set('codex', makeHarnessConfig({ 'codex.json': '{}' }));

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(0);
    expect(ctx.provider.ops[0]).toMatchObject({ op: 'create', req: { provider: 'docker', harness: 'codex' } });
    expect(loadRegistry(configDir).boxes.demo.harness).toBe('codex');
  });

  it('resolves yolo with flag > workspace > global > default true', () => {
    expect(resolveRequiredConfig({}, {}, {}).yolo).toBe(true);
    expect(resolveRequiredConfig({}, { yolo: false }, {}).yolo).toBe(false);
    expect(resolveRequiredConfig({}, {}, { yolo: true }).yolo).toBe(true);
    expect(resolveRequiredConfig({}, { yolo: true }, { yolo: false }).yolo).toBe(false);
    expect(resolveRequiredConfig({}, { yolo: false }, { yolo: true }).yolo).toBe(true);
    expect(resolveRequiredConfig({}, { yolo: true }, { yolo: false }, false).yolo).toBe(false);
    expect(resolveRequiredConfig({}, { yolo: false }, { yolo: true }, true).yolo).toBe(true);
  });

  it('resolves provider and harness with flag > workspace > global > default', () => {
    expect(resolveRequiredConfig({}, {}, {})).toMatchObject({ provider: 'docker', harness: 'opencode' });
    expect(resolveRequiredConfig({}, { harness: 'global-h', provider: 'vercel' }, {})).toMatchObject({
      harness: 'global-h',
      provider: 'vercel',
    });
    expect(resolveRequiredConfig({}, { harness: 'global-h' }, { harness: 'ws-h', provider: 'e2b' })).toMatchObject({
      harness: 'ws-h',
      provider: 'e2b',
    });
    expect(
      resolveRequiredConfig({ harness: 'flag-h', provider: 'daytona' }, { harness: 'global-h' }, { harness: 'ws-h' }),
    ).toMatchObject({ harness: 'flag-h', provider: 'daytona' });
  });

  it('never asks about yolo in the create wizard', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project, { configured: false });
    ctx.deps.selectorKeySource = keysSource(['enter', 'enter']);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(0);
    expect(ctx.stderr.text()).toContain('1) docker');
    expect(ctx.stderr.text()).toContain('1) opencode');
    expect(ctx.stderr.text()).not.toContain('yolo');
    expect(ctx.stderr.text()).not.toContain('Yolo');
  });

  it('asks only for the missing required keys and writes the global config before creating', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project, { configured: false });
    ctx.deps.selectorKeySource = keysSource(['enter', 'enter']);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(0);
    expect(ctx.stderr.text()).toContain('1) docker');
    expect(ctx.stderr.text()).toContain('1) opencode');
    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'))).toEqual({
      provider: 'docker',
      harness: 'opencode',
    });
    expect(ctx.provider.ops[0]).toMatchObject({ op: 'create', req: { provider: 'docker', harness: 'opencode' } });
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  it('create --harness codex with no configured provider asks only for the provider', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project, { configured: false });
    ctx.deps.selectorKeySource = keysSource(['enter']);

    const code = await runIn(project, ctx, ['create', '--harness', 'codex', '--name', 'demo']);
    expect(code).toBe(0);
    // Only the provider question renders; the harness comes from the flag.
    expect(ctx.stderr.text()).toContain('1) docker');
    expect(ctx.stderr.text()).not.toContain('Other…');
    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'))).toEqual({ provider: 'docker' });
    expect(ctx.provider.ops[0]).toMatchObject({ op: 'create', req: { provider: 'docker', harness: 'codex' } });
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  it('applies non-default wizard answers to the current create, not just the saved config', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project, { configured: false });
    // provider: enter -> docker (default); harness: down x2 -> codex (non-default).
    ctx.deps.selectorKeySource = keysSource(['enter', 'down', 'down', 'enter']);
    // The wizard answers a non-default harness ('codex'). docker is the default
    // provider, so its wizard answer equals the default; harness is where the
    // divergence must show up everywhere below.
    mockHostDirs.set('codex', makeHarnessConfig({ 'codex.json': '{}' }));

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'))).toEqual({
      provider: 'docker',
      harness: 'codex',
    });
    // The create request uses the wizard-chosen values...
    expect(ctx.provider.ops[0]).toMatchObject({ op: 'create', req: { provider: 'docker', harness: 'codex' } });
    // ...the harness factory lookup uses the wizard-chosen harness (the default
    // 'opencode' is never fetched)...
    expect(ctx.harnessFactory.registered('codex')).toBeDefined();
    expect(ctx.harnessFactory.registered('opencode')).toBeUndefined();
    // ...the config sync uses the wizard-chosen harness...
    expect(ctx.stdout.text()).toContain('synced 1 codex config file(s) into the box');
    const syncExec = syncExecOp(ctx);
    expect(syncExec?.command.join(' ')).toContain('~/.codex');
    expect(syncExec?.command.join(' ')).not.toContain('~/.config/codex');
    // ...and the registry entry and success message use the wizard-chosen values.
    expect(loadRegistry(configDir).boxes.demo).toMatchObject({ provider: 'docker', harness: 'codex' });
    expect(ctx.stdout.text()).toContain('Created sandbox "demo" (provider docker, harness codex).');
  });

  it('applies a free-text harness chosen via Other… and persists it to the global config', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project, { configured: false });
    // provider: enter -> docker; harness: numeric 4 -> Other…, then typed text.
    ctx.deps.selectorKeySource = keysSource(['enter', '4']);
    ctx.deps.prompt = () => 'my-harness';
    ctx.harnessFactory.get('my-harness').config = makeHarnessConfig({ 'settings.json': '{}' });

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'))).toEqual({
      provider: 'docker',
      harness: 'my-harness',
    });
    expect(ctx.provider.ops[0]).toMatchObject({ op: 'create', req: { provider: 'docker', harness: 'my-harness' } });
    expect(loadRegistry(configDir).boxes.demo).toMatchObject({ harness: 'my-harness' });
    // A harness without a recipe falls back to the adapter config dir as source
    // and the legacy ~/.config/<harness> destination.
    expect(ctx.stdout.text()).toContain('synced 1 my-harness config file(s) into the box');
    const syncExec = syncExecOp(ctx);
    expect(syncExec?.command.join(' ')).toContain('~/.config/my-harness');
    expect(ctx.stdout.text()).toContain('Created sandbox "demo" (provider docker, harness my-harness).');
  });

  it('fails create with an actionable error when the wizard is cancelled and creates nothing', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project, { configured: false });
    ctx.deps.selectorKeySource = keysSource(['esc']);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('wizard cancelled');
    expect(ctx.stderr.text()).toContain('sander config set <key> <value>');
    expect(opsOf(ctx)).not.toContain('create');
    expect(ctx.provider.ensureSetupCalls).toHaveLength(0);
    expect(fs.existsSync(path.join(configDir, 'config.json'))).toBe(false);
    expect(loadRegistry(configDir).boxes.demo).toBeUndefined();
  });

  it('counts the --provider/--harness flags as configured without prompting', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project, { configured: false });
    ctx.deps.prompt = () => {
      throw new Error('prompt must not be called when the flags provide the required keys');
    };

    const code = await runIn(project, ctx, ['create', '--provider', 'docker', '--harness', 'codex', '--name', 'demo']);
    expect(code).toBe(0);
    expect(ctx.provider.ops[0]).toMatchObject({ op: 'create', req: { provider: 'docker', harness: 'codex' } });
    expect(fs.existsSync(path.join(configDir, 'config.json'))).toBe(false);
  });

  it('fails with an actionable error in a non-TTY when required keys are missing and creates nothing', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project, { configured: false });

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('missing required configuration');
    expect(ctx.stderr.text()).toContain('provider');
    expect(ctx.stderr.text()).toContain('harness');
    expect(ctx.stderr.text()).toContain('sander config set <key> <value>');
    expect(ctx.stderr.text()).toContain('--provider docker');
    expect(ctx.stderr.text()).toContain('--harness opencode');
    expect(opsOf(ctx)).not.toContain('create');
    expect(ctx.provider.ensureSetupCalls).toHaveLength(0);
    expect(ctx.provider.ensureBaseImageCalls).toBe(0);
    expect(fs.existsSync(path.join(configDir, 'config.json'))).toBe(false);
    expect(loadRegistry(configDir).boxes.demo).toBeUndefined();
  });

  it('reports only the missing keys in the non-TTY error and still creates nothing', async () => {
    const configDir = tmpDir();
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ provider: 'docker' }));
    const project = makeProject();
    const ctx = makeCtx(configDir, project, { configured: false });

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('missing required configuration: harness');
    expect(ctx.stderr.text()).not.toContain('provider,');
    expect(opsOf(ctx)).not.toContain('create');
    expect(loadRegistry(configDir).boxes.demo).toBeUndefined();
  });

  it('prints create help and exits 0', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    const code = await runIn(project, ctx, ['create', '--help']);
    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('Usage: sander create [<id> | --name <id>]');
  });

  function createReq(ctx: Ctx): CreateRequest {
    const op = ctx.provider.ops.find((o) => o.op === 'create');
    expect(op).toBeDefined();
    return (op as { op: 'create'; req: CreateRequest }).req;
  }

  it('injects the --token flag as GITHUB_TOKEN/GH_TOKEN and overrides config sources', async () => {
    const configDir = tmpDir();
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ token: 'global-token', env: { FOO: 'bar' }, provider: 'docker', harness: 'opencode' }));
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo', '--token', 'flag-token']);
    expect(code).toBe(0);
    expect(createReq(ctx).env).toMatchObject({ GITHUB_TOKEN: 'flag-token', GH_TOKEN: 'flag-token', FOO: 'bar' });
    expect(ctx.stdout.text()).toContain('GitHub token from flag');
    expect(ctx.stdout.text()).toContain('never touch disk');
  });

  it('uses the global config token when no flag is given', async () => {
    const configDir = tmpDir();
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ token: 'global-token', provider: 'docker', harness: 'opencode' }));
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(0);
    expect(createReq(ctx).env).toMatchObject({ GITHUB_TOKEN: 'global-token' });
    expect(ctx.stdout.text()).toContain('GitHub token from global');
  });

  it('uses the workspace config token when no flag or global token is given', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    fs.mkdirSync(path.join(project, '.sander'));
    fs.writeFileSync(path.join(project, '.sander', 'config.json'), JSON.stringify({ token: 'ws-token' }));
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(0);
    expect(createReq(ctx).env).toMatchObject({ GITHUB_TOKEN: 'ws-token' });
    expect(ctx.stdout.text()).toContain('GitHub token from workspace');
  });

  it('merges workspace config env over global config env', async () => {
    const configDir = tmpDir();
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ env: { FOO: 'global', BAR: 'b' }, provider: 'docker', harness: 'opencode' }));
    const project = makeProject();
    fs.mkdirSync(path.join(project, '.sander'));
    fs.writeFileSync(path.join(project, '.sander', 'config.json'), JSON.stringify({ env: { FOO: 'workspace' } }));
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(0);
    expect(createReq(ctx).env).toMatchObject({ FOO: 'workspace', BAR: 'b' });
  });

  it('prints a notice and proceeds without a token when none is specified', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(0);
    expect(createReq(ctx).env).toEqual({});
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
    expect(ctx.stdout.text()).toContain('No GitHub token specified');
    expect(ctx.stdout.text()).not.toContain('never touch disk');
  });

  it('copies .env.sander into the box as .env', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    fs.writeFileSync(path.join(project, '.env.sander'), 'SECRET=box-value\n');
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(0);
    const copyOp = ctx.provider.ops.find((op) => op.op === 'copy' && op.destination === '/workspace/.env');
    expect(copyOp).toBeDefined();
    const source = (copyOp as { op: 'copy'; source: string }).source;
    expect(path.basename(source)).toBe('.env');
    // The staged copy is cleaned up right after the copy: the secret never stays on disk.
    expect(fs.existsSync(source)).toBe(false);
    expect(ctx.stdout.text()).toContain('Copied project .env.sander into the box as /workspace/.env');
  });

  it('records injected env keys in the registry without values', async () => {
    const configDir = tmpDir();
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ token: 'gh-token', provider: 'docker', harness: 'opencode' }));
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);
    expect(code).toBe(0);
    const box = loadRegistry(configDir).boxes.demo as Sandbox;
    expect(box.envKeys).toContain('GITHUB_TOKEN');
    expect(box.envKeys).toContain('GH_TOKEN');
    expect(JSON.stringify(loadRegistry(configDir))).not.toContain('gh-token');
  });

  it('requires --token to have a value', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    const code = await runIn(project, ctx, ['create', '--name', 'demo', '--token']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('--token requires a value');
    expect(ctx.provider.ops).toHaveLength(0);
  });

  it('makes an unwritable .git writable before creating the box', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const git = path.join(project, '.git');
    fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
    fs.chmodSync(git, 0o755);
    fs.chmodSync(path.join(git, 'refs'), 0o755);
    fs.chmodSync(path.join(git, 'refs', 'heads'), 0o755);
    const hostUid = fs.statSync(git).uid;
    const boxUid = hostUid === 1000 ? 2000 : 1000;
    const prev = process.env.AGENTBOX_BOX_UID;
    process.env.AGENTBOX_BOX_UID = String(boxUid);
    try {
      const ctx = makeCtx(configDir, project);
      const code = await runIn(project, ctx, ['create', '--name', 'demo']);
      expect(code).toBe(0);
      expect(ctx.stdout.text()).toContain('now writable by the box user');
      expect(ctx.provider.ops[0]).toMatchObject({ op: 'create' });
      expect(fs.statSync(path.join(git, 'refs', 'heads')).mode & 0o007).not.toBe(0);
    } finally {
      if (prev === undefined) {
        delete process.env.AGENTBOX_BOX_UID;
      } else {
        process.env.AGENTBOX_BOX_UID = prev;
      }
    }
  });

  const canSimulateForeignResidue =
    process.platform === 'linux' &&
    (typeof process.getuid !== 'function' || process.getuid() !== 0) &&
    fs.existsSync('/root') &&
    fs.statSync('/root').uid === 0;

  it.skipIf(!canSimulateForeignResidue)('continues with a warning when .git residue is owned by a previous box uid', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    // A gitdir: pointer to a root-owned, non-writable directory: sander cannot
    // chmod it from the host (EPERM), exactly like files left by a previous box
    // user (uid 1000). The post-create in-box chown re-owns it, so create must
    // warn and continue instead of aborting.
    fs.writeFileSync(path.join(project, '.git'), 'gitdir: /root\n');
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(0);
    expect(ctx.stderr.text()).toContain('warning: some files in /root');
    expect(ctx.stderr.text()).toContain('re-owned inside the box after create');
    expect(ctx.provider.ops[0]).toMatchObject({ op: 'create' });
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  it('still throws when the git fix fails with a non-foreign-residue error', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const git = path.join(project, '.git');
    fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
    fs.chmodSync(git, 0o555);
    fs.chmodSync(path.join(git, 'refs'), 0o555);
    fs.chmodSync(path.join(git, 'refs', 'heads'), 0o555);
    const spy = vi.spyOn(gitaccess, 'fixGitAccess').mockReturnValue({
      ok: false,
      foreignResidue: false,
      detail: 'read-only file system',
    });
    try {
      const ctx = makeCtx(configDir, project);
      const code = await runIn(project, ctx, ['create', '--name', 'demo']);
      expect(code).toBe(1);
      expect(ctx.stderr.text()).toContain('could not make');
      expect(ctx.provider.ops).toHaveLength(0);
      expect(loadRegistry(configDir).boxes.demo).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('accepts git-style names and stores the mapped container name', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    ctx.worktree.createResult = makeWorktree('feature/asd-jshdia');

    const code = await runIn(project, ctx, ['create', '--name', 'feature/asd-jshdia']);

    expect(code).toBe(0);
    expect(ctx.provider.ops[0]).toMatchObject({ op: 'create', req: { id: 'feature/asd-jshdia', provider: 'docker', harness: 'opencode' } });
    expect(ctx.worktree.ops).toEqual([
      { op: 'deleteStaleBranches', projectRoot: project },
      { op: 'createWorktreeBranch', projectRoot: project, id: 'feature/asd-jshdia' },
    ]);
    const box = loadRegistry(configDir).boxes['feature/asd-jshdia'] as Sandbox;
    expect(box).toBeDefined();
    expect(box.containerName).toBe(containerNameForSandbox('feature/asd-jshdia'));
    expect(box.branch).toBe('feature/asd-jshdia');
    expect(ctx.stdout.text()).toContain('Created sandbox "feature/asd-jshdia"');
    expect(ctx.stdout.text()).toContain(`real container ${dockerContainerName(containerNameForSandbox('feature/asd-jshdia'))}`);
  });

  it('keeps the success message unchanged for docker-safe names', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('Created sandbox "demo" (provider docker, harness opencode).');
    expect(ctx.stdout.text()).not.toContain('real container');
    expect(loadRegistry(configDir).boxes.demo.containerName).toBe('demo');
  });

  it('rejects git-invalid sandbox ids', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    for (const bad of ['a..b', 'bad name', '-lead']) {
      const ctx = makeCtx(configDir, project);
      const code = await runIn(project, ctx, ['create', `--name=${bad}`]);
      expect(code).toBe(1);
      expect(ctx.stderr.text()).toContain('invalid sandbox id');
      expect(ctx.provider.ops).toHaveLength(0);
    }
  });

  it('rejects a container-name collision between distinct ids', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    await runIn(project, ctx, ['create', '--name', 'foo/bar']);

    const collisionId = containerNameForSandbox('foo/bar');
    const code = await runIn(project, ctx, ['create', '--name', collisionId]);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('container name');
    expect(ctx.stderr.text()).toContain('already in use by "foo/bar"');
    expect(loadRegistry(configDir).boxes[collisionId]).toBeUndefined();
  });

  it('runs no agent, no install, and no supervisor when no .sander artifacts exist', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    ctx.provider.defaultFileState = new Map();

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['create', 'exec', 'copy', 'exec', 'hasExecutable', 'hasExecutable']);
    expect(installExecs(ctx)).toHaveLength(0);
    expect(supervisorExecs(ctx)).toHaveLength(0);
    expect(ctx.provider.ops.find((op) => op.op === 'copy' && op.destination === '/workspace/.sander/supervisor.sh')).toBeUndefined();
    expect(ctx.stdout.text()).not.toContain('El agente de arranque');
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  it('runs install and the supervisor without an agent when both bootstrap artifacts are present', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['create', 'exec', 'copy', 'exec', 'hasExecutable', 'hasExecutable', 'exec', 'copy', 'exec']);
    expect(execOps(ctx)).toHaveLength(4);
    expect(installExecs(ctx)).toEqual([{ op: 'exec', id: 'demo', command: ['/workspace/.sander/install.sh'], cwd: '/workspace' }]);
    expect(supervisorExecs(ctx)).toHaveLength(1);
    expect(supervisorExecs(ctx)[0]!.command.join(' ')).toContain('supervisor.sh start');
    expect(hasExecutableOps(ctx)).toHaveLength(2);
    expect(ctx.stdout.text()).not.toContain('El agente de arranque');
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  it('runs only install.sh when only install.sh exists and deploys no supervisor', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    ctx.provider.defaultFileState = new Map([['/workspace/.sander/install.sh', true]]);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['create', 'exec', 'copy', 'exec', 'hasExecutable', 'hasExecutable', 'exec']);
    expect(execOps(ctx)).toHaveLength(3);
    expect(installExecs(ctx)).toEqual([{ op: 'exec', id: 'demo', cwd: '/workspace', command: ['/workspace/.sander/install.sh'] }]);
    expect(supervisorExecs(ctx)).toHaveLength(0);
    expect(ctx.provider.ops.find((op) => op.op === 'copy' && op.destination === '/workspace/.sander/supervisor.sh')).toBeUndefined();
    expect(ctx.stdout.text()).not.toContain('El agente de arranque');
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  it('mounts the worktree branch and registers the box without running an agent when no artifacts exist', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    ctx.provider.defaultFileState = new Map();

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['create', 'exec', 'copy', 'exec', 'hasExecutable', 'hasExecutable']);
    expect(installExecs(ctx)).toHaveLength(0);
    expect(supervisorExecs(ctx)).toHaveLength(0);
    expect(ctx.worktree.ops.map((op) => op.op)).toEqual(['deleteStaleBranches', 'createWorktreeBranch']);
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  it('runs .sander/install.sh exactly once inside the box when the artifacts already exist', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(0);
    expect(installExecs(ctx)).toEqual([
      { op: 'exec', id: 'demo', command: ['/workspace/.sander/install.sh'], cwd: '/workspace' },
    ]);
    expect(supervisorExecs(ctx)).toEqual([
      { op: 'exec', id: 'demo', command: ['sh', '-c', 'nohup sh /workspace/.sander/supervisor.sh start </dev/null >/dev/null 2>&1 &'] },
    ]);
    expect(loadRegistry(configDir).boxes.demo).toMatchObject({ status: 'running' });
    expect(ctx.stderr.text()).not.toContain('falló');
  });

  it('fails create with full rollback when install.sh fails', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    ctx.provider.execHook = (id, command) => {
      if (command.length === 1 && command[0] === '/workspace/.sander/install.sh') {
        return { exitCode: 1, stdout: '', stderr: 'npm ERR! code ENOENT' };
      }
    };

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('npm ERR! code ENOENT');
    expect(ctx.stderr.text()).toMatch(/install\.sh/);
    expect(opsOf(ctx).at(-1)).toBe('remove');
    expect(ctx.worktree.ops.map((op) => op.op)).toContain('removeWorktree');
    expect(ctx.worktree.ops.map((op) => op.op)).toContain('deleteBranch');
    expect(loadRegistry(configDir).boxes.demo).toBeUndefined();
  });

  it('runs install.sh before registering the box even when artifacts pre-exist', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['create', 'exec', 'copy', 'exec', 'hasExecutable', 'hasExecutable', 'exec', 'copy', 'exec']);
    expect(installExecs(ctx)).toHaveLength(1);
    expect(installExecs(ctx)[0]).toMatchObject({ command: ['/workspace/.sander/install.sh'], cwd: '/workspace' });
    expect(ctx.worktree.ops.map((op) => op.op)).toEqual(['deleteStaleBranches', 'createWorktreeBranch']);
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  it('continues and registers the box when install.sh exits 0', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    ctx.provider.execHook = (id, command) => {
      if (command.length === 1 && command[0] === '/workspace/.sander/install.sh') {
        return { exitCode: 0, stdout: 'installed deps\n', stderr: '' };
      }
    };

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(0);
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
    expect(ctx.stdout.text()).toContain('Created sandbox "demo"');
    expect(ctx.stderr.text()).not.toContain('falló');
    expect(ctx.stdout.text()).not.toContain('installed deps');
  });

  it('deploys and launches the supervisor after install.sh and before registering the box', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['create', 'exec', 'copy', 'exec', 'hasExecutable', 'hasExecutable', 'exec', 'copy', 'exec']);
    const copyOp = ctx.provider.ops.find((op) => op.op === 'copy' && op.destination === '/workspace/.sander/supervisor.sh');
    expect(copyOp).toBeDefined();
    expect((copyOp as { op: 'copy'; source: string }).source).toBe(supervisorScriptSource());
    const launch = supervisorExecs(ctx)[0];
    expect(launch?.command.join(' ')).toContain('nohup sh /workspace/.sander/supervisor.sh start');
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  it('fails create with full rollback when the supervisor launch fails', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    ctx.provider.execHook = (id, command) => {
      if (command.join(' ').includes('supervisor.sh start')) {
        return { exitCode: 1, stdout: '', stderr: 'boom' };
      }
    };

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toMatch(/supervisor/);
    expect(ctx.stderr.text()).toMatch(/rollback/);
    expect(opsOf(ctx).at(-1)).toBe('remove');
    expect(ctx.worktree.ops.map((op) => op.op)).toContain('removeWorktree');
    expect(ctx.worktree.ops.map((op) => op.op)).toContain('deleteBranch');
    expect(loadRegistry(configDir).boxes.demo).toBeUndefined();
  });

  it('fails create with full rollback when the supervisor copy fails', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    ctx.provider.copyError = new Error('cp failed');

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('cp failed');
    expect(opsOf(ctx).at(-1)).toBe('remove');
    expect(ctx.worktree.ops.map((op) => op.op)).toContain('removeWorktree');
    expect(ctx.worktree.ops.map((op) => op.op)).toContain('deleteBranch');
    expect(loadRegistry(configDir).boxes.demo).toBeUndefined();
  });

  it('create --skip-install skips install.sh but still deploys and launches the supervisor', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo', '--skip-install']);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['create', 'exec', 'copy', 'exec', 'hasExecutable', 'hasExecutable', 'copy', 'exec']);
    expect(installExecs(ctx)).toHaveLength(0);
    expect(supervisorExecs(ctx)).toHaveLength(1);
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  it('create --skip-start runs install.sh but skips the supervisor', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo', '--skip-start']);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['create', 'exec', 'copy', 'exec', 'hasExecutable', 'hasExecutable', 'exec']);
    expect(installExecs(ctx)).toHaveLength(1);
    expect(supervisorExecs(ctx)).toHaveLength(0);
    expect(ctx.provider.ops.find((op) => op.op === 'copy' && op.destination === '/workspace/.sander/supervisor.sh')).toBeUndefined();
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  it('create --skip-setup skips install.sh and the supervisor', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo', '--skip-setup']);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['create', 'exec', 'copy', 'exec', 'hasExecutable', 'hasExecutable']);
    expect(installExecs(ctx)).toHaveLength(0);
    expect(supervisorExecs(ctx)).toHaveLength(0);
    expect(ctx.provider.ops.find((op) => op.op === 'copy' && op.destination === '/workspace/.sander/supervisor.sh')).toBeUndefined();
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  it('create -s is equivalent to --skip-setup', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);

    const code = await runIn(project, ctx, ['create', '--name', 'demo', '-s']);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['create', 'exec', 'copy', 'exec', 'hasExecutable', 'hasExecutable']);
    expect(installExecs(ctx)).toHaveLength(0);
    expect(supervisorExecs(ctx)).toHaveLength(0);
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  it('create with only start.sh present deploys the supervisor without running install.sh', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir, project);
    ctx.provider.defaultFileState = new Map([['/workspace/.sander/start.sh', true]]);

    const code = await runIn(project, ctx, ['create', '--name', 'demo']);

    expect(code).toBe(0);
    expect(opsOf(ctx)).toEqual(['create', 'exec', 'copy', 'exec', 'hasExecutable', 'hasExecutable', 'copy', 'exec']);
    expect(supervisorExecs(ctx)).toHaveLength(1);
    expect(supervisorExecs(ctx)[0]!.command.join(' ')).toContain('supervisor.sh start');
    expect(installExecs(ctx)).toHaveLength(0);
    expect(loadRegistry(configDir).boxes.demo).toBeDefined();
  });

  describe('quick-start flags', () => {
    it('create -x attaches to the new sandbox and propagates the session exit code', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      ctx.provider.attachResult = 3;

      const code = await runIn(project, ctx, ['create', '-x', 'demo']);

      expect(code).toBe(3);
      expect(ctx.stdout.text()).toContain('Created sandbox "demo"');
      expect(ctx.stdout.text()).toContain('Sandbox "demo" (opencode) session exited with code 3.');
      expect(interactiveOps(ctx)).toEqual([
        { op: 'hasAgentSession', id: 'demo' },
        { op: 'attach', id: 'demo', opts: { tty: true } },
      ]);
      expect(loadRegistry(configDir).boxes.demo).toBeDefined();
    });

    it('create --attach is the long form', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      ctx.provider.attachResult = 3;

      const code = await runIn(project, ctx, ['create', '--attach', 'demo']);

      expect(code).toBe(3);
      expect(ctx.stdout.text()).toContain('Sandbox "demo" (opencode) session exited with code 3.');
      expect(interactiveOps(ctx)).toEqual([
        { op: 'hasAgentSession', id: 'demo' },
        { op: 'attach', id: 'demo', opts: { tty: true } },
      ]);
    });

    it('create -y launches the resolved harness when no agent session runs', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      ctx.provider.hasAgentSessionResult = false;
      ctx.provider.shellResult = 7;

      const code = await runIn(project, ctx, ['create', '-y', 'demo']);

      expect(code).toBe(7);
      expect(ctx.stderr.text()).toContain('launching opencode');
      expect(interactiveOps(ctx)).toEqual([
        { op: 'hasAgentSession', id: 'demo' },
        { op: 'shell', id: 'demo', command: ['opencode'] },
      ]);
      expect(loadRegistry(configDir).boxes.demo).toBeDefined();
    });

    it('create --quick-agent is the long form', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      ctx.provider.hasAgentSessionResult = false;
      ctx.provider.shellResult = 7;

      const code = await runIn(project, ctx, ['create', '--quick-agent', 'demo']);

      expect(code).toBe(7);
      expect(ctx.stderr.text()).toContain('launching opencode');
      expect(interactiveOps(ctx)).toEqual([
        { op: 'hasAgentSession', id: 'demo' },
        { op: 'shell', id: 'demo', command: ['opencode'] },
      ]);
    });

    it('create -xy bundles both and the agent wins', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      ctx.provider.hasAgentSessionResult = false;
      ctx.provider.shellResult = 7;

      const code = await runIn(project, ctx, ['create', '-xy', 'demo']);

      expect(code).toBe(7);
      expect(ctx.stderr.text()).toContain('launching opencode');
      expect(interactiveOps(ctx)).toEqual([
        { op: 'hasAgentSession', id: 'demo' },
        { op: 'shell', id: 'demo', command: ['opencode'] },
      ]);
      expect(ctx.provider.ops.some((op) => op.op === 'attach')).toBe(false);
    });

    it('create -yx is order-independent', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      ctx.provider.hasAgentSessionResult = false;
      ctx.provider.shellResult = 7;

      const code = await runIn(project, ctx, ['create', '-yx', 'demo']);

      expect(code).toBe(7);
      expect(ctx.stderr.text()).toContain('launching opencode');
      expect(interactiveOps(ctx)).toEqual([
        { op: 'hasAgentSession', id: 'demo' },
        { op: 'shell', id: 'demo', command: ['opencode'] },
      ]);
      expect(ctx.provider.ops.some((op) => op.op === 'attach')).toBe(false);
    });

    it('create -y attaches instead of launching when an agent session is already running', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);

      const code = await runIn(project, ctx, ['create', '-y', 'demo']);

      expect(code).toBe(0);
      expect(interactiveOps(ctx)).toEqual([
        { op: 'hasAgentSession', id: 'demo' },
        { op: 'attach', id: 'demo', opts: { tty: true } },
      ]);
      expect(ctx.provider.ops.filter((op) => op.op === 'shell')).toHaveLength(0);
    });

    it('create -y launches the resolved harness for non-default harnesses', async () => {
      const configDir = tmpDir();
      fs.writeFileSync(
        path.join(configDir, 'config.json'),
        JSON.stringify({ provider: 'docker', harness: 'claude' }),
      );
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      ctx.provider.hasAgentSessionResult = false;
      ctx.provider.shellResult = 7;

      const code = await runIn(project, ctx, ['create', '-y', 'demo']);

      expect(code).toBe(7);
      expect(ctx.stderr.text()).toContain('launching claude');
      expect(interactiveOps(ctx)).toEqual([
        { op: 'hasAgentSession', id: 'demo' },
        { op: 'shell', id: 'demo', command: ['claude'] },
      ]);
    });

    it('create -p launches the harness and injects the prompt', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      ctx.provider.hasAgentSessionResult = false;

      const code = await runIn(project, ctx, ['create', '-p', 'hola', 'demo']);

      expect(code).toBe(0);
      expect(ctx.stdout.text()).toContain('Created sandbox "demo"');
      expect(ctx.stderr.text()).toContain('launching opencode');
      expect(interactiveOps(ctx)).toEqual([
        { op: 'hasAgentSession', id: 'demo' },
        { op: 'shell', id: 'demo', command: ['opencode'], input: 'hola' },
      ]);
      expect(loadRegistry(configDir).boxes.demo).toBeDefined();
    });

    it('create --prompt is the long form of -p', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      ctx.provider.hasAgentSessionResult = false;

      const code = await runIn(project, ctx, ['create', '--prompt', 'hola', 'demo']);

      expect(code).toBe(0);
      expect(ctx.stderr.text()).toContain('launching opencode');
      expect(interactiveOps(ctx)).toEqual([
        { op: 'hasAgentSession', id: 'demo' },
        { op: 'shell', id: 'demo', command: ['opencode'], input: 'hola' },
      ]);
    });

    it('create -p with --agent combines the prompt and the agent argv', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      ctx.provider.hasAgentSessionResult = false;

      const code = await runIn(project, ctx, ['create', '-p', 'hola', '--agent', 'orquestator', 'demo']);

      expect(code).toBe(0);
      expect(interactiveOps(ctx)).toEqual([
        { op: 'hasAgentSession', id: 'demo' },
        { op: 'shell', id: 'demo', command: ['opencode', '--agent', 'orquestator'], input: 'hola' },
      ]);
    });

    it('create bare --harness attaches and launches the harness', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      ctx.provider.hasAgentSessionResult = false;
      ctx.provider.shellResult = 7;

      const code = await runIn(project, ctx, ['create', 'demo', '--harness']);

      expect(code).toBe(7);
      expect(ctx.stderr.text()).toContain('launching opencode');
      expect(interactiveOps(ctx)).toEqual([
        { op: 'hasAgentSession', id: 'demo' },
        { op: 'shell', id: 'demo', command: ['opencode'] },
      ]);
      expect(loadRegistry(configDir).boxes.demo).toBeDefined();
    });

    it('create bare --harness with --agent runs the harness with the agent argv', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      ctx.provider.hasAgentSessionResult = false;
      ctx.provider.shellResult = 7;

      const code = await runIn(project, ctx, ['create', 'tmp', '--harness', '--agent', 'orquestator']);

      expect(code).toBe(7);
      expect(ctx.stderr.text()).toContain('launching opencode');
      expect(interactiveOps(ctx)).toEqual([
        { op: 'hasAgentSession', id: 'tmp' },
        { op: 'shell', id: 'tmp', command: ['opencode', '--agent', 'orquestator'] },
      ]);
      expect(loadRegistry(configDir).boxes.tmp).toBeDefined();
    });

    it('create bare --harness launches the resolved harness for non-default harnesses', async () => {
      const configDir = tmpDir();
      fs.writeFileSync(
        path.join(configDir, 'config.json'),
        JSON.stringify({ provider: 'docker', harness: 'claude' }),
      );
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      ctx.provider.hasAgentSessionResult = false;
      ctx.provider.shellResult = 7;

      const code = await runIn(project, ctx, ['create', 'tmp', '--harness', '--agent', 'orquestator']);

      expect(code).toBe(7);
      expect(ctx.stderr.text()).toContain('launching claude');
      expect(interactiveOps(ctx)).toEqual([
        { op: 'hasAgentSession', id: 'tmp' },
        { op: 'shell', id: 'tmp', command: ['claude', '--agent', 'orquestator'] },
      ]);
    });

    it('create bare --harness warns and drops --agent for harnesses without support', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      ctx.provider.hasAgentSessionResult = false;
      ctx.harnessFactory.get('opencode').agentArgResult = null;

      const code = await runIn(project, ctx, ['create', 'tmp', '--harness', '--agent', 'orquestator']);

      expect(code).toBe(0);
      expect(ctx.stderr.text()).toContain('does not support --agent');
      expect(interactiveOps(ctx)).toEqual([
        { op: 'hasAgentSession', id: 'tmp' },
        { op: 'shell', id: 'tmp', command: ['opencode'] },
      ]);
    });

    it('create --harness with a value still selects the harness without quick-starting', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      ctx.harnessFactory.get('custom').config = makeHarnessConfig({ 'custom.json': '{}' });

      const code = await runIn(project, ctx, ['create', '--harness', 'custom', 'demo']);

      expect(code).toBe(0);
      expect(ctx.stderr.text()).toContain('no recipe for harness "custom"');
      expect(interactiveOps(ctx)).toHaveLength(0);
      expect(loadRegistry(configDir).boxes.demo).toBeDefined();
      expect((loadRegistry(configDir).boxes.demo as Sandbox).harness).toBe('custom');
    });

    it('create -y with --agent passes the agent argv to the harness launch', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      ctx.provider.hasAgentSessionResult = false;

      const code = await runIn(project, ctx, ['create', '-y', 'demo', '--agent', 'orquestator']);

      expect(code).toBe(0);
      expect(interactiveOps(ctx)).toEqual([
        { op: 'hasAgentSession', id: 'demo' },
        { op: 'shell', id: 'demo', command: ['opencode', '--agent', 'orquestator'] },
      ]);
    });

    it('create --agent without a quick-start warns and does not launch', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);

      const code = await runIn(project, ctx, ['create', '--agent', 'orquestator', 'demo']);

      expect(code).toBe(0);
      expect(ctx.stderr.text()).toContain('has no effect');
      expect(interactiveOps(ctx)).toHaveLength(0);
      expect(loadRegistry(configDir).boxes.demo).toBeDefined();
    });

    it('create -p warns and attaches when an agent session is already running', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);

      const code = await runIn(project, ctx, ['create', '-p', 'hola', 'demo']);

      expect(code).toBe(0);
      expect(ctx.stderr.text()).toContain('--prompt/--agent are ignored');
      expect(interactiveOps(ctx)).toEqual([
        { op: 'hasAgentSession', id: 'demo' },
        { op: 'attach', id: 'demo', opts: { tty: true } },
      ]);
    });

    it('create -p requires a value', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);

      const code = await runIn(project, ctx, ['create', '-p']);

      expect(code).toBe(1);
      expect(ctx.stderr.text()).toContain('--prompt requires a value: pass --prompt <text>');
      expect(ctx.provider.ops).toHaveLength(0);
    });

    it('create --agent requires a value', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);

      const code = await runIn(project, ctx, ['create', '--agent']);

      expect(code).toBe(1);
      expect(ctx.stderr.text()).toContain('--agent requires a value: pass --agent <name>');
      expect(ctx.provider.ops).toHaveLength(0);
    });

    it('quick-start never runs when create fails', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      await runIn(project, ctx, ['create', '--name', 'demo']);

      const code = await runIn(project, ctx, ['create', '-x', 'demo']);

      expect(code).toBe(1);
      expect(ctx.stderr.text()).toContain('already exists');
      expect(interactiveOps(ctx)).toHaveLength(0);
    });

    it('create help documents the quick-start flags', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);

      const code = await runIn(project, ctx, ['create', '--help']);

      expect(code).toBe(0);
      expect(ctx.stdout.text()).toContain('--attach');
      expect(ctx.stdout.text()).toContain('--quick-agent');
      expect(ctx.stdout.text()).toContain('--prompt');
      expect(ctx.stdout.text()).toContain('--agent <name>');
      expect(ctx.stdout.text()).toContain('-xy');
      expect(ctx.stdout.text()).toContain('--harness');
      expect(ctx.stdout.text()).toContain('orquestator');
      expect(ctx.stdout.text()).toContain('Enter');
    });

    it('parseCreateArgs expands bundled shorts into attach/agent/skip-setup', () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);

      const opts = parseCreateArgs(['-sxy', 'demo'], ctx.deps);

      expect(opts).toMatchObject({
        id: 'demo',
        attach: true,
        agent: true,
        skipInstall: true,
        skipStart: true,
      });
    });

    it('parseCreateArgs resolves -p into the prompt and keeps the boolean off', () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);

      const opts = parseCreateArgs(['-p', 'hola', 'demo'], ctx.deps);

      expect(opts).toMatchObject({
        id: 'demo',
        prompt: 'hola',
        agent: false,
        agentName: undefined,
      });
    });

    it('parseCreateArgs resolves --agent <name> with -y into the agent quick-start', () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);

      const opts = parseCreateArgs(['--agent', 'orquestator', '-y', 'demo'], ctx.deps);

      expect(opts).toMatchObject({
        id: 'demo',
        agent: true,
        agentName: 'orquestator',
        prompt: undefined,
        harnessQuickStart: false,
      });
    });

    it('parseCreateArgs resolves bare --harness into the quick-start', () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);

      const opts = parseCreateArgs(['tmp', '--harness', '--agent', 'orquestator'], ctx.deps);

      expect(opts).toMatchObject({
        id: 'tmp',
        agent: false,
        harnessQuickStart: true,
        agentName: 'orquestator',
        prompt: undefined,
      });
    });

    it('parseCreateArgs keeps --harness <name> as harness selection', () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);

      const opts = parseCreateArgs(['--harness', 'codex', 'demo'], ctx.deps);

      expect(opts).toMatchObject({
        id: 'demo',
        harness: 'codex',
        harnessQuickStart: false,
      });
    });

    it('parseCreateArgs resolves bare --harness with -p into prompt quick-start', () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);

      const opts = parseCreateArgs(['demo', '--harness', '-p', 'hola'], ctx.deps);

      expect(opts).toMatchObject({
        id: 'demo',
        harnessQuickStart: true,
        prompt: 'hola',
      });
    });

    it('parseCreateArgs rejects an unbundled -ps token', () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);

      expect(() => parseCreateArgs(['-ps', 'demo'], ctx.deps)).toThrow(CliError);
    });
  });

  describe('yolo mode', () => {
    it('defaults to yolo true, records yolo: true in the registry, and injects the yolo transform via ops on the real box dir', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      mockHostDirs.set('opencode', makeHarnessConfig({ 'opencode.json': '{}' }));
      stubBoxConfig(
        ctx,
        '~/.local/share/opencode/config/opencode.json',
        '{"permission":{"edit":"ask","bash":"ask","webfetch":"deny","*":"ask"}}',
      );

      const code = await runIn(project, ctx, ['create', '--name', 'demo']);
      expect(code).toBe(0);
      expect((loadRegistry(configDir).boxes.demo as Sandbox).yolo).toBe(true);

      // The injection reads, stages, and places the transformed config in the
      // real dir opencode reads inside the box — never ~/.config/opencode.
      expect(yoloReadExec(ctx)?.command.join(' ')).toBe('sh -c cat ~/.local/share/opencode/config/opencode.json');
      expect(yoloCopyOp(ctx)?.destination).toBe('/tmp/sander-yolo/opencode');
      expect(yoloStagedContent(ctx, 'opencode', 'opencode.json')).toBe(
        '{\n  "permission": {\n    "edit": "allow",\n    "bash": "allow",\n    "webfetch": "deny",\n    "*": "allow"\n  }\n}\n',
      );
      const place = yoloPlaceExec(ctx);
      expect(place?.command.join(' ')).toContain('mkdir -p ~/.local/share/opencode/config');
      expect(place?.command.join(' ')).toContain('cp /tmp/sander-yolo/opencode/opencode.json ~/.local/share/opencode/config/opencode.json');
      expect(place?.command.join(' ')).not.toContain('~/.config/opencode');
      expect(ctx.stdout.text()).toContain('Applied yolo mode to the opencode config inside the box.');
    });

    it('--no-yolo forces no-yolo even when the config defaults to yolo, adding the catch-all ask and preserving deny', async () => {
      const configDir = tmpDir();
      fs.writeFileSync(
        path.join(configDir, 'config.json'),
        JSON.stringify({ provider: 'docker', harness: 'opencode', yolo: true }),
      );
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      mockHostDirs.set('opencode', makeHarnessConfig({ 'opencode.json': '{}' }));
      stubBoxConfig(ctx, '~/.local/share/opencode/config/opencode.json', '{"permission":{"edit":"allow","webfetch":"deny"}}');

      const code = await runIn(project, ctx, ['create', '--no-yolo', '--name', 'demo']);
      expect(code).toBe(0);
      expect((loadRegistry(configDir).boxes.demo as Sandbox).yolo).toBe(false);
      expect(yoloStagedContent(ctx, 'opencode', 'opencode.json')).toBe(
        '{\n  "permission": {\n    "edit": "allow",\n    "webfetch": "deny",\n    "*": "ask"\n  }\n}\n',
      );
      expect(ctx.stdout.text()).toContain('Applied no-yolo mode to the opencode config inside the box.');
    });

    it('--yolo re-activates yolo even when the config says yolo false', async () => {
      const configDir = tmpDir();
      fs.writeFileSync(
        path.join(configDir, 'config.json'),
        JSON.stringify({ provider: 'docker', harness: 'opencode', yolo: false }),
      );
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      mockHostDirs.set('opencode', makeHarnessConfig({ 'opencode.json': '{}' }));
      stubBoxConfig(ctx, '~/.local/share/opencode/config/opencode.json', '{"permission":{"edit":"ask"}}');

      const code = await runIn(project, ctx, ['create', '--yolo', '--name', 'demo']);
      expect(code).toBe(0);
      expect((loadRegistry(configDir).boxes.demo as Sandbox).yolo).toBe(true);
      expect(yoloStagedContent(ctx, 'opencode', 'opencode.json')).toBe(
        '{\n  "permission": {\n    "edit": "allow"\n  }\n}\n',
      );
    });

    it('resolves yolo false from the config when no flag is given', async () => {
      const configDir = tmpDir();
      fs.writeFileSync(
        path.join(configDir, 'config.json'),
        JSON.stringify({ provider: 'docker', harness: 'opencode', yolo: false }),
      );
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      mockHostDirs.set('opencode', makeHarnessConfig({ 'opencode.json': '{}' }));
      stubBoxConfig(ctx, '~/.local/share/opencode/config/opencode.json', '{}');

      const code = await runIn(project, ctx, ['create', '--name', 'demo']);
      expect(code).toBe(0);
      expect((loadRegistry(configDir).boxes.demo as Sandbox).yolo).toBe(false);
      expect(yoloStagedContent(ctx, 'opencode', 'opencode.json')).toBe(
        '{\n  "permission": {\n    "*": "ask"\n  }\n}\n',
      );
    });

    it('injects the claude yolo payload (permissions.defaultMode bypassPermissions) preserving allow/deny lists', async () => {
      const configDir = tmpDir();
      fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ provider: 'docker', harness: 'claude' }));
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      mockHostDirs.set('claude', makeHarnessConfig({ 'settings.json': '{}' }));
      stubBoxConfig(
        ctx,
        '~/.claude/settings.json',
        '{"permissions":{"defaultMode":"default","allow":["Bash(npm run build)"],"deny":["Read(~/secrets)"]}}',
      );

      const code = await runIn(project, ctx, ['create', '--name', 'demo']);
      expect(code).toBe(0);
      expect((loadRegistry(configDir).boxes.demo as Sandbox).yolo).toBe(true);
      expect(yoloStagedContent(ctx, 'claude', 'settings.json')).toBe(
        '{\n  "permissions": {\n    "defaultMode": "bypassPermissions",\n    "allow": [\n      "Bash(npm run build)"\n    ],\n    "deny": [\n      "Read(~/secrets)"\n    ]\n  }\n}\n',
      );
    });

    it('injects the claude no-yolo payload (permissions.defaultMode default)', async () => {
      const configDir = tmpDir();
      fs.writeFileSync(
        path.join(configDir, 'config.json'),
        JSON.stringify({ provider: 'docker', harness: 'claude', yolo: false }),
      );
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      mockHostDirs.set('claude', makeHarnessConfig({ 'settings.json': '{}' }));
      stubBoxConfig(ctx, '~/.claude/settings.json', '{"permissions":{"defaultMode":"bypassPermissions"}}');

      const code = await runIn(project, ctx, ['create', '--name', 'demo']);
      expect(code).toBe(0);
      expect((loadRegistry(configDir).boxes.demo as Sandbox).yolo).toBe(false);
      expect(yoloStagedContent(ctx, 'claude', 'settings.json')).toBe(
        '{\n  "permissions": {\n    "defaultMode": "default"\n  }\n}\n',
      );
    });

    it('injects the codex yolo payload (approval_policy never)', async () => {
      const configDir = tmpDir();
      fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ provider: 'docker', harness: 'codex' }));
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      mockHostDirs.set('codex', makeHarnessConfig({ 'config.toml': 'model = "gpt-4o"\n' }));
      stubBoxConfig(ctx, '~/.codex/config.toml', 'model = "gpt-4o"\n');

      const code = await runIn(project, ctx, ['create', '--name', 'demo']);
      expect(code).toBe(0);
      expect((loadRegistry(configDir).boxes.demo as Sandbox).yolo).toBe(true);
      expect(yoloStagedContent(ctx, 'codex', 'config.toml')).toBe('model = "gpt-4o"\napproval_policy = "never"\n');
    });

    it('injects the codex no-yolo payload (approval_policy on-request)', async () => {
      const configDir = tmpDir();
      fs.writeFileSync(
        path.join(configDir, 'config.json'),
        JSON.stringify({ provider: 'docker', harness: 'codex', yolo: false }),
      );
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      mockHostDirs.set('codex', makeHarnessConfig({ 'config.toml': '' }));
      stubBoxConfig(ctx, '~/.codex/config.toml', '');

      const code = await runIn(project, ctx, ['create', '--name', 'demo']);
      expect(code).toBe(0);
      expect((loadRegistry(configDir).boxes.demo as Sandbox).yolo).toBe(false);
      expect(yoloStagedContent(ctx, 'codex', 'config.toml')).toBe('approval_policy = "on-request"\n');
    });

    it('warns and continues without injection for a harness without a recipe', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      ctx.harnessFactory.get('custom').config = makeHarnessConfig({ 'custom.json': '{}' });

      const code = await runIn(project, ctx, ['create', '--harness', 'custom', '--name', 'demo']);
      expect(code).toBe(0);
      expect(ctx.stderr.text()).toContain('no recipe for harness "custom"');
      expect(yoloCopyOp(ctx)).toBeUndefined();
      expect(yoloPlaceExec(ctx)).toBeUndefined();
      expect(loadRegistry(configDir).boxes.demo).toBeDefined();
      expect((loadRegistry(configDir).boxes.demo as Sandbox).yolo).toBe(true);
    });

    it('skips JSONC box config with a warning and does not rewrite it', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      mockHostDirs.set('opencode', makeHarnessConfig({ 'opencode.json': '{}' }));
      stubBoxConfig(
        ctx,
        '~/.local/share/opencode/config/opencode.json',
        '{\n  // yolo only rewrites plain JSON\n  "permission": { "edit": "ask" }\n}\n',
      );

      const code = await runIn(project, ctx, ['create', '--name', 'demo']);
      expect(code).toBe(0);
      expect(ctx.stderr.text()).toContain('warning:');
      expect(ctx.stderr.text()).toContain('JSONC');
      expect(yoloCopyOp(ctx)).toBeUndefined();
      expect(yoloPlaceExec(ctx)).toBeUndefined();
      expect((loadRegistry(configDir).boxes.demo as Sandbox).yolo).toBe(true);
    });

    it('never writes the host harness config', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      const host = makeHarnessConfig({ 'opencode.json': '{"permission":{"edit":"ask","webfetch":"deny"}}' });
      mockHostDirs.set('opencode', host);
      stubBoxConfig(
        ctx,
        '~/.local/share/opencode/config/opencode.json',
        '{"permission":{"edit":"ask","webfetch":"deny"}}',
      );
      const hostBefore = fs.readFileSync(path.join(host, 'opencode.json'), 'utf8');

      const code = await runIn(project, ctx, ['create', '--name', 'demo']);
      expect(code).toBe(0);
      expect(fs.readFileSync(path.join(host, 'opencode.json'), 'utf8')).toBe(hostBefore);
      // The injection staged content only ever targets the box volume path.
      expect(yoloStagedContent(ctx, 'opencode', 'opencode.json')).toBe(
        '{\n  "permission": {\n    "edit": "allow",\n    "webfetch": "deny"\n  }\n}\n',
      );
    });

    it('preserves the existing box config additively when injecting yolo', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      mockHostDirs.set('opencode', makeHarnessConfig({ 'opencode.json': '{}' }));
      stubBoxConfig(
        ctx,
        '~/.local/share/opencode/config/opencode.json',
        '{"model":"gpt-5","theme":"dark","permission":{"edit":"ask","webfetch":"deny"}}',
      );

      const code = await runIn(project, ctx, ['create', '--name', 'demo']);
      expect(code).toBe(0);
      const written = JSON.parse(yoloStagedContent(ctx, 'opencode', 'opencode.json') ?? '{}') as Record<string, unknown>;
      expect(written).toMatchObject({ model: 'gpt-5', theme: 'dark' });
      expect(written.permission).toEqual({ edit: 'allow', webfetch: 'deny' });
    });

    it('creates the initial config content when the box config file is absent', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      mockHostDirs.set('opencode', makeHarnessConfig({ 'opencode.json': '{}' }));

      const code = await runIn(project, ctx, ['create', '--name', 'demo']);
      expect(code).toBe(0);
      expect(yoloStagedContent(ctx, 'opencode', 'opencode.json')).toBe('{}\n');
      expect(ctx.stdout.text()).toContain('Applied yolo mode to the opencode config inside the box.');
    });

    it('does not re-assert yolo on stop/start after create', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      mockHostDirs.set('opencode', makeHarnessConfig({ 'opencode.json': '{}' }));
      stubBoxConfig(ctx, '~/.local/share/opencode/config/opencode.json', '{}');

      const code = await runIn(project, ctx, ['create', '--name', 'demo']);
      expect(code).toBe(0);
      const createdOps = ctx.provider.ops.length;
      expect(yoloCopyOp(ctx)).toBeDefined();

      await runIn(project, ctx, ['stop', 'demo']);
      await runIn(project, ctx, ['start', 'demo']);

      const later = ctx.provider.ops.slice(createdOps);
      expect(later.some((op) => op.op === 'copy' && op.destination.startsWith('/tmp/sander-yolo/'))).toBe(false);
      expect(later.some((op) => op.op === 'exec' && op.command.join(' ').includes('sander-yolo'))).toBe(false);
      expect(later.some((op) => op.op === 'exec' && op.command.join(' ').startsWith('sh -c cat '))).toBe(false);
      expect(loadRegistry(configDir).boxes.demo).toMatchObject({ status: 'running', yolo: true });
    });

    it('documents the yolo flags and the agentbox start re-sync limitation in create help', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      const code = await runIn(project, ctx, ['create', '--help']);
      expect(code).toBe(0);
      expect(ctx.stdout.text()).toContain('--no-yolo');
      expect(ctx.stdout.text()).toContain('--yolo');
      expect(ctx.stdout.text()).toContain('re-syncs');
      expect(ctx.stdout.text()).toContain('agentbox');
    });
  });

  describe('debug mode', () => {
    function withEnv(key: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
      const previous = process.env[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
      return fn().finally(() => {
        if (previous === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous;
        }
      });
    }

    function makeDebugCtx(): { configDir: string; project: string; ctx: Ctx } {
      const configDir = tmpDir();
      const project = makeProject();
      fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules/\n');
      const ctx = makeCtx(configDir, project);
      mockHostDirs.set('opencode', makeHarnessConfig({ 'opencode.json': '{}' }));
      return { configDir, project, ctx };
    }

    it('prints [debug] step duration lines to stderr with --debug', async () => {
      const { project, ctx } = makeDebugCtx();
      const code = await runIn(project, ctx, ['create', '--name', 'demo', '--debug']);
      expect(code).toBe(0);
      expect(ctx.stderr.text()).toMatch(/\[debug\] step "Setting up provider" done in \d+ms/);
      expect(ctx.stderr.text()).toMatch(/\[debug\] step "Creating sandbox "demo"" done in \d+ms/);
      expect(ctx.stderr.text()).toMatch(/\[debug\] step "[^"]+" (done|skipped|failed) in \d+ms/);
    });

    it('prints no [debug] output by default', async () => {
      const { project, ctx } = makeDebugCtx();
      await withEnv('SANDER_DEBUG', undefined, async () => {
        const code = await runIn(project, ctx, ['create', '--name', 'demo']);
        expect(code).toBe(0);
        expect(ctx.stderr.text()).not.toContain('[debug]');
      });
    });

    it('enables debug via SANDER_DEBUG=1', async () => {
      const { project, ctx } = makeDebugCtx();
      await withEnv('SANDER_DEBUG', '1', async () => {
        const code = await runIn(project, ctx, ['create', '--name', 'demo']);
        expect(code).toBe(0);
        expect(ctx.stderr.text()).toMatch(/\[debug\] step "[^"]+" done in \d+ms/);
      });
    });

    it('keeps debug off for empty/0/false SANDER_DEBUG values', async () => {
      for (const value of ['', '0', 'false']) {
        const { project, ctx } = makeDebugCtx();
        await withEnv('SANDER_DEBUG', value, async () => {
          const code = await runIn(project, ctx, ['create', '--name', 'demo']);
          expect(code).toBe(0);
          expect(ctx.stderr.text()).not.toContain('[debug]');
        });
      }
    });
  });

  describe('sync watcher', () => {
    const binPath = path.join(__dirname, '..', '..', '..', 'bin', 'sander.js');

    it('spawns the detached sync watcher and records the checklist step done by default', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);

      const code = await runIn(project, ctx, ['create', '--name', 'demo']);

      expect(code).toBe(0);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledWith(process.execPath, [binPath, 'sync', 'demo', '--watch'], {
        stdio: 'ignore',
        detached: true,
      });
      expect(ctx.stderr.text()).toContain('✓ Activando watcher de git');
      expect(ctx.stderr.text()).not.toContain('sync desactivada');
    });

    it('--no-watch does not spawn the watcher and marks the step skipped with a warning', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);

      const code = await runIn(project, ctx, ['create', '--name', 'demo', '--no-watch']);

      expect(code).toBe(0);
      expect(spawnMock).not.toHaveBeenCalled();
      expect(ctx.stderr.text()).toContain('– Activando watcher de git');
      expect(ctx.stderr.text()).toContain('sync desactivada');
      expect(ctx.stderr.text()).toContain('--no-watch');
    });

    it('skips the step and warns when the project is not a git repository', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);
      ctx.worktree.createResult = null;

      const code = await runIn(project, ctx, ['create', '--name', 'demo']);

      expect(code).toBe(0);
      expect(spawnMock).not.toHaveBeenCalled();
      expect(ctx.stderr.text()).toContain('– Activando watcher de git');
      expect(ctx.stderr.text()).toContain('sync desactivada');
      expect(ctx.stderr.text()).toContain('no es un repositorio git');
    });

    it('--no-watch leaves the provider ops and registry writes unchanged', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);

      const code = await runIn(project, ctx, ['create', '--name', 'demo', '--no-watch']);

      expect(code).toBe(0);
      expect(opsOf(ctx)).toEqual(['create', 'exec', 'copy', 'exec', 'hasExecutable', 'hasExecutable', 'exec', 'copy', 'exec']);
      expect(loadRegistry(configDir).boxes.demo).toMatchObject({
        id: 'demo',
        provider: 'docker',
        harness: 'opencode',
        yolo: true,
        status: 'running',
      });
      expect(ctx.stdout.text()).toContain('Created sandbox "demo"');
    });

    it('documents --no-watch and the untracked-deletions limitation in create help', async () => {
      const configDir = tmpDir();
      const project = makeProject();
      const ctx = makeCtx(configDir, project);

      const code = await runIn(project, ctx, ['create', '--help']);

      expect(code).toBe(0);
      expect(ctx.stdout.text()).toContain('--no-watch');
      expect(ctx.stdout.text()).toContain('untracked');
      expect(ctx.stdout.text()).toContain('Activando watcher de git');
    });
  });
});

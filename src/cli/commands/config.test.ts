import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { CaptureStream } from '../../../test/helpers/capture-stream';
import { FakeProvider } from '../../provider/fake';
import { FakeHarnessFactory } from '../../harness/fake';
import { FakeWorktree } from '../../worktree/fake';
import { runCli } from '../main';
import type { CliDeps } from '../deps';
import type { KeySource, SelectorKey } from '../../selector/selector';
import { configPath } from '../../config/config';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sander-config-cli-test-'));
}

function keysSource(keys: SelectorKey[]): KeySource {
  let index = 0;
  return {
    next: async () => (index < keys.length ? keys[index++]! : null),
  };
}

interface Ctx {
  deps: CliDeps;
  stdout: CaptureStream;
  stderr: CaptureStream;
}

function makeCtx(
  configDir: string,
  prompt?: (question: string) => string | undefined,
  keySource?: KeySource,
): Ctx {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const deps: CliDeps = {
    configDir,
    stdout,
    stderr,
    stdin: new PassThrough(),
    createProvider: () => new FakeProvider(),
    harnessFactory: new FakeHarnessFactory(),
    worktree: new FakeWorktree(),
    prompt,
    selectorKeySource: keySource,
  };
  return { deps, stdout, stderr };
}

function readConfigFile(dir: string): unknown {
  const file = configPath(dir);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function workspaceConfigPath(root: string): string {
  return path.join(root, '.sander', 'config.json');
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

describe('sander config', () => {
  it('sets a harness in the global config and get returns it', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const setCode = await runIn(project, ctx, ['config', 'set', 'harness', 'opencode']);
    expect(setCode).toBe(0);
    expect(ctx.stdout.text()).toContain('Set harness to "opencode" in global config.');
    expect(readConfigFile(configDir)).toEqual({ harness: 'opencode' });

    ctx.stdout.reset();
    const getCode = await runIn(project, ctx, ['config', 'get', 'harness']);
    expect(getCode).toBe(0);
    expect(ctx.stdout.text()).toBe('opencode\n');
  });

  it('persists set immediately: a second CLI call reads the new value', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    await runIn(project, ctx, ['config', 'set', 'harness', 'claude']);
    ctx.stdout.reset();
    const code = await runIn(project, ctx, ['config', 'get', 'harness']);
    expect(code).toBe(0);
    expect(ctx.stdout.text()).toBe('claude\n');
  });

  it('rejects unsupported providers with a clear error listing the allowed values', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', 'set', 'provider', 'vps']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('unsupported provider "vps"');
    expect(ctx.stderr.text()).toContain('"docker"');
    expect(fs.existsSync(configPath(configDir))).toBe(false);
  });

  it('accepts the five real providers and persists each one', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    for (const provider of ['docker', 'daytona', 'hetzner', 'vercel', 'e2b']) {
      ctx.stdout.reset();
      const code = await runIn(project, ctx, ['config', 'set', 'provider', provider]);
      expect(code).toBe(0);
      expect(ctx.stdout.text()).toContain(`Set provider to "${provider}"`);
      expect(readConfigFile(configDir)).toEqual({ provider });
    }
  });

  it('rejects provider agentbox with an actionable error suggesting docker and writes nothing', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', 'set', 'provider', 'agentbox']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('provider "agentbox" is deprecated');
    expect(ctx.stderr.text()).toContain('sander config set provider docker');
    expect(fs.existsSync(configPath(configDir))).toBe(false);
  });

  it('rejects --provider agentbox with an actionable error suggesting docker and writes nothing', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', '--provider', 'agentbox']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('provider "agentbox" is deprecated');
    expect(ctx.stderr.text()).toContain('sander config set provider docker');
    expect(fs.existsSync(configPath(configDir))).toBe(false);
  });

  it('rejects invalid harness names', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    for (const bad of ['-lead', 'has space', 'under_score']) {
      ctx.stderr.reset();
      const code = await runIn(project, ctx, ['config', 'set', 'harness', bad]);
      expect(code).toBe(1);
      expect(ctx.stderr.text()).toContain('invalid harness name');
    }
    expect(fs.existsSync(configPath(configDir))).toBe(false);
  });

  it('accepts safe harness names', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', 'set', 'harness', 'opencode-ai']);
    expect(code).toBe(0);
    expect(readConfigFile(configDir)).toEqual({ harness: 'opencode-ai' });
  });

  it('rejects empty values', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', 'set', 'harness', '']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('empty value');
  });

  it('sets and lists a token', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    await runIn(project, ctx, ['config', 'set', 'token', 'ghp_secret']);
    ctx.stdout.reset();
    const code = await runIn(project, ctx, ['config', 'list']);
    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('token = ghp_secret');
  });

  it('sets yolo as a real boolean and get/list/unset handle it', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const setFalse = await runIn(project, ctx, ['config', 'set', 'yolo', 'false']);
    expect(setFalse).toBe(0);
    expect(readConfigFile(configDir)).toEqual({ yolo: false });

    ctx.stdout.reset();
    const getCode = await runIn(project, ctx, ['config', 'get', 'yolo']);
    expect(getCode).toBe(0);
    expect(ctx.stdout.text()).toBe('false\n');

    ctx.stdout.reset();
    const listCode = await runIn(project, ctx, ['config', 'list']);
    expect(listCode).toBe(0);
    expect(ctx.stdout.text()).toContain('yolo = false');

    ctx.stdout.reset();
    const unsetCode = await runIn(project, ctx, ['config', 'unset', 'yolo']);
    expect(unsetCode).toBe(0);
    expect(ctx.stdout.text()).toContain('Unset yolo in global config.');
    expect(readConfigFile(configDir)).toEqual({});
  });

  it('sets yolo true as a real boolean and persists it', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', 'set', 'yolo', 'true']);
    expect(code).toBe(0);
    expect(readConfigFile(configDir)).toEqual({ yolo: true });

    ctx.stdout.reset();
    const getCode = await runIn(project, ctx, ['config', 'get', 'yolo']);
    expect(getCode).toBe(0);
    expect(ctx.stdout.text()).toBe('true\n');
  });

  it('rejects non-boolean yolo values with an actionable error and writes nothing', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    for (const bad of ['ja', '1', 'TRUE', 'yes']) {
      ctx.stderr.reset();
      const code = await runIn(project, ctx, ['config', 'set', 'yolo', bad]);
      expect(code).toBe(1);
      expect(ctx.stderr.text()).toContain('invalid value for "yolo"');
      expect(ctx.stderr.text()).toContain('sander config set yolo true');
    }
    expect(fs.existsSync(configPath(configDir))).toBe(false);
  });

  it('writes a real boolean yolo via the config --yolo flag', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir, undefined, keysSource(['enter', 'enter']));

    const code = await runIn(project, ctx, ['config', '--yolo', 'false']);
    expect(code).toBe(0);
    expect(readConfigFile(configDir)).toEqual({ yolo: false, provider: 'docker', harness: 'opencode' });
    expect(ctx.stderr.text()).not.toContain('yolo');
  });

  it('rejects a non-boolean value for the config --yolo flag and writes nothing', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', '--yolo', 'ja']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('invalid value for "yolo"');
    expect(fs.existsSync(configPath(configDir))).toBe(false);
  });

  it('persists env.<KEY> in the config and shows it in list and get', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', 'set', 'env.FOO', 'bar']);
    expect(code).toBe(0);
    expect(readConfigFile(configDir)).toEqual({ env: { FOO: 'bar' } });

    ctx.stdout.reset();
    const listCode = await runIn(project, ctx, ['config', 'list']);
    expect(listCode).toBe(0);
    expect(ctx.stdout.text()).toContain('env.FOO = bar');

    ctx.stdout.reset();
    const getCode = await runIn(project, ctx, ['config', 'get', 'env.FOO']);
    expect(getCode).toBe(0);
    expect(ctx.stdout.text()).toBe('bar\n');
  });

  it('merges multiple env vars and keeps the file valid JSON', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    await runIn(project, ctx, ['config', 'set', 'env.FOO', 'one']);
    await runIn(project, ctx, ['config', 'set', 'env.BAR', 'two']);
    await runIn(project, ctx, ['config', 'set', 'harness', 'opencode']);

    expect(readConfigFile(configDir)).toEqual({ env: { FOO: 'one', BAR: 'two' }, harness: 'opencode' });
    expect(JSON.parse(fs.readFileSync(configPath(configDir), 'utf8'))).toEqual(
      JSON.parse(fs.readFileSync(configPath(configDir), 'utf8')),
    );
  });

  it('unsets a top-level key and get/list reflect it', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    await runIn(project, ctx, ['config', 'set', 'harness', 'opencode']);
    const unsetCode = await runIn(project, ctx, ['config', 'unset', 'harness']);
    expect(unsetCode).toBe(0);
    expect(ctx.stdout.text()).toContain('Unset harness in global config.');
    expect(readConfigFile(configDir)).toEqual({});

    ctx.stdout.reset();
    const getCode = await runIn(project, ctx, ['config', 'get', 'harness']);
    expect(getCode).toBe(1);
    expect(ctx.stderr.text()).toContain('config key "harness" is not set');

    ctx.stdout.reset();
    const listCode = await runIn(project, ctx, ['config', 'list']);
    expect(listCode).toBe(0);
    expect(ctx.stdout.text()).not.toContain('harness');
  });

  it('unsets an env.<KEY> and drops the empty env section', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    await runIn(project, ctx, ['config', 'set', 'env.FOO', 'bar']);
    await runIn(project, ctx, ['config', 'set', 'env.BAZ', 'qux']);
    const unsetCode = await runIn(project, ctx, ['config', 'unset', 'env.FOO']);
    expect(unsetCode).toBe(0);
    expect(readConfigFile(configDir)).toEqual({ env: { BAZ: 'qux' } });

    const lastCode = await runIn(project, ctx, ['config', 'unset', 'env.BAZ']);
    expect(lastCode).toBe(0);
    expect(readConfigFile(configDir)).toEqual({});
  });

  it('unsets the whole env section', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    await runIn(project, ctx, ['config', 'set', 'env.FOO', 'bar']);
    const code = await runIn(project, ctx, ['config', 'unset', 'env']);
    expect(code).toBe(0);
    expect(readConfigFile(configDir)).toEqual({});
  });

  it('writes to the workspace layer with --workspace and to global by default, without clobbering', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const globalCode = await runIn(project, ctx, ['config', 'set', 'harness', 'global-harness']);
    expect(globalCode).toBe(0);
    const wsCode = await runIn(project, ctx, ['config', 'set', '--workspace', 'harness', 'ws-harness']);
    expect(wsCode).toBe(0);

    expect(readConfigFile(configDir)).toEqual({ harness: 'global-harness' });
    expect(readConfigFile(path.join(project, '.sander'))).toEqual({ harness: 'ws-harness' });
    expect(fs.existsSync(workspaceConfigPath(project))).toBe(true);

    ctx.stdout.reset();
    const getGlobal = await runIn(project, ctx, ['config', 'get', 'harness']);
    expect(getGlobal).toBe(0);
    expect(ctx.stdout.text()).toBe('global-harness\n');

    ctx.stdout.reset();
    const getWs = await runIn(project, ctx, ['config', 'get', '--workspace', 'harness']);
    expect(getWs).toBe(0);
    expect(ctx.stdout.text()).toBe('ws-harness\n');
  });

  it('explicit --global matches the default scope', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', 'set', '--global', 'harness', 'opencode']);
    expect(code).toBe(0);
    expect(readConfigFile(configDir)).toEqual({ harness: 'opencode' });
    expect(fs.existsSync(workspaceConfigPath(project))).toBe(false);
  });

  it('rejects combining --global and --workspace', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', 'set', '--global', '--workspace', 'harness', 'opencode']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('cannot combine --global and --workspace');
  });

  it('keeps the config file valid JSON after every operation', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);
    const file = configPath(configDir);

    const ops: Array<[string[], number]> = [
      [['config', 'set', 'harness', 'opencode'], 0],
      [['config', 'set', 'provider', 'docker'], 0],
      [['config', 'set', 'token', 't'], 0],
      [['config', 'set', 'env.FOO', 'bar'], 0],
      [['config', 'set', 'env.EMPTY', 'x'], 0],
      [['config', 'unset', 'env.EMPTY'], 0],
      [['config', 'unset', 'token'], 0],
      [['config', 'get', 'harness'], 0],
      [['config', 'list'], 0],
    ];
    for (const [args, expected] of ops) {
      ctx.stderr.reset();
      const code = await runIn(project, ctx, args);
      expect(code).toBe(expected);
      if (expected === 0) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        expect(parsed).toBeDefined();
      }
    }
    expect(readConfigFile(configDir)).toEqual({ harness: 'opencode', provider: 'docker', env: { FOO: 'bar' } });
  });

  it('asks for provider and harness on a bare config call even when configured, keeping current values on Enter', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir, undefined, keysSource(['enter', 'enter']));

    await runIn(project, ctx, ['config', 'set', 'harness', 'codex']);
    await runIn(project, ctx, ['config', 'set', 'provider', 'docker']);
    await runIn(project, ctx, ['config', 'set', 'env.FOO', 'bar']);
    ctx.stdout.reset();
    ctx.stderr.reset();

    const code = await runIn(project, ctx, ['config']);
    expect(code).toBe(0);
    // Both selectors rendered; the cursor starts on the current values.
    expect(ctx.stderr.text()).toContain('> 1) docker');
    expect(ctx.stderr.text()).toContain('> 3) codex');
    expect(ctx.stderr.text()).toContain('2) daytona [requieren setup]');
    expect(ctx.stderr.text()).toContain('4) Other…');
    expect(readConfigFile(configDir)).toEqual({ provider: 'docker', harness: 'codex', env: { FOO: 'bar' } });
    expect(ctx.stdout.text()).toContain('harness = codex');
    expect(ctx.stdout.text()).toContain('provider = docker');
    expect(ctx.stdout.text()).toContain('env.FOO = bar');
  });

  it('never asks about yolo in the bare config wizard', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir, undefined, keysSource(['enter', 'enter']));

    const code = await runIn(project, ctx, ['config']);
    expect(code).toBe(0);
    expect(readConfigFile(configDir)).toEqual({ provider: 'docker', harness: 'opencode' });
    expect(ctx.stderr.text()).not.toContain('yolo');
    expect(ctx.stderr.text()).not.toContain('Yolo');
  });

  it('bare config in a TTY overwrites the current value when a new one is selected', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    // provider: down x3 -> vercel; harness: down -> claude
    const ctx = makeCtx(configDir, undefined, keysSource(['down', 'down', 'down', 'enter', 'down', 'enter']));

    await runIn(project, ctx, ['config', 'set', 'harness', 'opencode']);
    await runIn(project, ctx, ['config', 'set', 'provider', 'docker']);

    const code = await runIn(project, ctx, ['config']);
    expect(code).toBe(0);
    expect(readConfigFile(configDir)).toEqual({ provider: 'vercel', harness: 'claude' });
  });

  it('writes flags to the global config with no prompts when nothing is missing', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir, () => {
      throw new Error('prompt must not be called when all required keys are provided');
    });

    const code = await runIn(project, ctx, ['config', '--harness', 'codex', '--provider', 'docker']);
    expect(code).toBe(0);
    expect(readConfigFile(configDir)).toEqual({ harness: 'codex', provider: 'docker' });
    expect(ctx.stdout.text()).toContain('harness = codex');
    expect(ctx.stdout.text()).toContain('provider = docker');
    expect(ctx.stdout.text()).not.toContain('Provider [');
    expect(ctx.stdout.text()).not.toContain('Harness [');
  });

  it('persists flag writes: a later get sees the oneliner values', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    await runIn(project, ctx, ['config', '--provider', 'docker']);
    ctx.stdout.reset();
    const getCode = await runIn(project, ctx, ['config', 'get', 'provider']);
    expect(getCode).toBe(0);
    expect(ctx.stdout.text()).toBe('docker\n');
  });

  it('--token never triggers questions and is persisted', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir, undefined, keysSource(['enter', 'enter']));

    const code = await runIn(project, ctx, ['config', '--token', 'ghp_secret']);
    expect(code).toBe(0);
    expect(ctx.stderr.text()).not.toContain('Token');
    expect(readConfigFile(configDir)).toEqual({ token: 'ghp_secret', harness: 'opencode', provider: 'docker' });
  });

  it('--token combined with the required flags asks for nothing', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir, () => {
      throw new Error('prompt must not be called');
    });

    const code = await runIn(project, ctx, [
      'config',
      '--token',
      'ghp_secret',
      '--harness',
      'codex',
      '--provider',
      'docker',
    ]);
    expect(code).toBe(0);
    expect(readConfigFile(configDir)).toEqual({ token: 'ghp_secret', harness: 'codex', provider: 'docker' });
  });

  it('bare config sets a token typed into the wizard prompt and persists it', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir, () => 'ghp_secret', keysSource(['enter', 'enter']));

    const code = await runIn(project, ctx, ['config']);
    expect(code).toBe(0);
    expect(readConfigFile(configDir)).toEqual({ provider: 'docker', harness: 'opencode', token: 'ghp_secret' });
  });

  it('bare config keeps an existing token when the wizard prompt is blank', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir, () => '', keysSource(['enter', 'enter']));

    await runIn(project, ctx, ['config', 'set', 'token', 'old']);
    ctx.stderr.reset();
    const code = await runIn(project, ctx, ['config']);
    expect(code).toBe(0);
    expect(readConfigFile(configDir)).toEqual({ provider: 'docker', harness: 'opencode', token: 'old' });
  });

  it('bare config leaves the token unset when blank and none was set', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir, () => '', keysSource(['enter', 'enter']));

    const code = await runIn(project, ctx, ['config']);
    expect(code).toBe(0);
    expect(readConfigFile(configDir)).toEqual({ provider: 'docker', harness: 'opencode' });
  });

  it('--token suppresses the token question even in an interactive wizard', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(
      configDir,
      () => {
        throw new Error('prompt must not be called when --token is passed');
      },
      keysSource(['enter', 'enter']),
    );

    const code = await runIn(project, ctx, ['config', '--token', 'ghp_x']);
    expect(code).toBe(0);
    expect(readConfigFile(configDir)).toEqual({ token: 'ghp_x', harness: 'opencode', provider: 'docker' });
  });

  it('full flags without --token ask the token when the wizard is interactive', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir, () => 'ghp_y', keysSource([]));

    const code = await runIn(project, ctx, ['config', '--provider', 'docker', '--harness', 'codex']);
    expect(code).toBe(0);
    expect(readConfigFile(configDir)).toEqual({ provider: 'docker', harness: 'codex', token: 'ghp_y' });
  });

  it('full flags plus --token run with zero prompts (non-TTY)', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir, () => {
      throw new Error('prompt must not be called when every key is passed as a flag');
    });

    const code = await runIn(project, ctx, ['config', '--provider', 'docker', '--harness', 'codex', '--token', 't']);
    expect(code).toBe(0);
    expect(readConfigFile(configDir)).toEqual({ provider: 'docker', harness: 'codex', token: 't' });
  });

  it('asks only for the missing required keys and persists the answers', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir, undefined, keysSource(['enter']));

    await runIn(project, ctx, ['config', 'set', 'harness', 'codex']);
    ctx.stderr.reset();
    const code = await runIn(project, ctx, ['config', '--harness', 'codex']);
    expect(code).toBe(0);
    // Only the provider question renders; the harness comes from the flag.
    expect(ctx.stderr.text()).toContain('1) docker');
    expect(ctx.stderr.text()).not.toContain('Other…');
    expect(readConfigFile(configDir)).toEqual({ harness: 'codex', provider: 'docker' });
  });

  it('bare config runs the wizard when required keys are missing and prints the result', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    // provider: enter -> docker; harness: down x2 -> codex
    const ctx = makeCtx(configDir, undefined, keysSource(['enter', 'down', 'down', 'enter']));

    const code = await runIn(project, ctx, ['config']);
    expect(code).toBe(0);
    expect(readConfigFile(configDir)).toEqual({ provider: 'docker', harness: 'codex' });
    expect(ctx.stdout.text()).toContain('provider = docker');
    expect(ctx.stdout.text()).toContain('harness = codex');
  });

  it('applies the default provider and harness when Enter confirms the first option', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir, undefined, keysSource(['enter', 'enter']));

    const code = await runIn(project, ctx, ['config']);
    expect(code).toBe(0);
    expect(readConfigFile(configDir)).toEqual({ provider: 'docker', harness: 'opencode' });
  });

  it('offers a closed provider list in the wizard: only the five providers can be chosen', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir, undefined, keysSource(['enter', 'enter']));

    const code = await runIn(project, ctx, ['config']);
    expect(code).toBe(0);
    expect(ctx.stderr.text()).toContain('5) e2b');
    expect(ctx.stderr.text()).not.toContain('agentbox');
    expect(readConfigFile(configDir)).toEqual({ provider: 'docker', harness: 'opencode' });
  });

  it('cancelling the bare config wizard with q fails with an actionable error and writes nothing', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir, undefined, keysSource(['q']));

    const code = await runIn(project, ctx, ['config']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('wizard cancelled');
    expect(ctx.stderr.text()).toContain('sander config set <key> <value>');
    expect(fs.existsSync(configPath(configDir))).toBe(false);
  });

  it('fails with an actionable error in a non-TTY when required keys are missing', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('missing required configuration');
    expect(ctx.stderr.text()).toContain('provider');
    expect(ctx.stderr.text()).toContain('harness');
    expect(ctx.stderr.text()).toContain('sander config set <key> <value>');
    expect(ctx.stderr.text()).toContain('--provider docker');
    expect(ctx.stderr.text()).toContain('--harness opencode');
  });

  it('reports only the missing keys in the non-TTY error', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    await runIn(project, ctx, ['config', 'set', 'provider', 'docker']);
    ctx.stderr.reset();
    const code = await runIn(project, ctx, ['config']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('missing required configuration: harness');
    expect(ctx.stderr.text()).not.toContain('provider,');
  });

  it('fails in a non-TTY even when everything is configured, suggesting list/set', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    await runIn(project, ctx, ['config', 'set', 'provider', 'docker']);
    await runIn(project, ctx, ['config', 'set', 'harness', 'opencode']);
    ctx.stderr.reset();

    const code = await runIn(project, ctx, ['config']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('interactive terminal');
    expect(ctx.stderr.text()).toContain('sander config list');
    expect(ctx.stderr.text()).toContain('sander config set <key> <value>');
    expect(ctx.stderr.text()).not.toContain('missing required configuration');
  });

  it('validates flag values like set does', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const badProvider = await runIn(project, ctx, ['config', '--provider', 'vps']);
    expect(badProvider).toBe(1);
    expect(ctx.stderr.text()).toContain('unsupported provider "vps"');

    ctx.stderr.reset();
    const badHarness = await runIn(project, ctx, ['config', '--harness', 'under_score']);
    expect(badHarness).toBe(1);
    expect(ctx.stderr.text()).toContain('invalid harness name "under_score"');
    expect(fs.existsSync(configPath(configDir))).toBe(false);
  });

  it('requires a value for --token', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', '--token']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('--token requires a value');
  });

  it('prints help and exits 0 for --help and help config', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', '--help']);
    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('sander config');

    ctx.stdout.reset();
    const helpCode = await runIn(project, ctx, ['help', 'config']);
    expect(helpCode).toBe(0);
    expect(ctx.stdout.text()).toContain('sander config');
  });

  it('rejects unknown subcommands', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', 'frobnicate']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('unknown subcommand "frobnicate"');
  });

  it('rejects unknown keys', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', 'set', 'realm', 'x']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('unknown config key "realm"');
    expect(ctx.stderr.text()).toContain('env.<KEY>');
  });

  it('rejects nested keys outside env', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', 'set', 'provider.x', 'agentbox']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('nested keys are only supported as env.<KEY>');
  });

  it('rejects setting the whole env section directly', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', 'set', 'env', 'x']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('use "sander config set env.<KEY> <value>"');
  });

  it('requires a value for set', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', 'set', 'harness']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('missing arguments');
  });

  it('requires a key for unset', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', 'unset']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('missing key');
  });

  it('errors when unsetting a key that is not set', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', 'unset', 'harness']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('config key "harness" is not set');
  });

  it('errors when getting a key that is not set', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', 'get', 'harness']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('config key "harness" is not set');
  });

  it('get with no key prints the whole config like list', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    await runIn(project, ctx, ['config', 'set', 'harness', 'opencode']);
    ctx.stdout.reset();

    const code = await runIn(project, ctx, ['config', 'get']);
    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('harness = opencode');
  });

  it('list with no config prints a friendly empty message', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['config', 'list']);
    expect(code).toBe(0);
    expect(ctx.stdout.text()).toContain('No config set in the global scope.');
  });

  it('rejects extra arguments on set and list', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    const setCode = await runIn(project, ctx, ['config', 'set', 'harness', 'opencode', 'extra']);
    expect(setCode).toBe(1);
    expect(ctx.stderr.text()).toContain('unexpected argument "extra"');

    ctx.stderr.reset();
    const listCode = await runIn(project, ctx, ['config', 'list', 'extra']);
    expect(listCode).toBe(1);
    expect(ctx.stderr.text()).toContain('unexpected argument "extra"');
  });

  it('get on a workspace env key reads the workspace layer', async () => {
    const configDir = tmpDir();
    const project = tmpDir();
    const ctx = makeCtx(configDir);

    await runIn(project, ctx, ['config', 'set', '--workspace', 'env.FOO', 'ws']);
    ctx.stdout.reset();
    const code = await runIn(project, ctx, ['config', 'get', '--workspace', 'env.FOO']);
    expect(code).toBe(0);
    expect(ctx.stdout.text()).toBe('ws\n');
  });
});

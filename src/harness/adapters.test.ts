import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeCodeHarness, OpenCodeHarness } from './adapters';
import { BasicHarness, BasicHarnessFactory } from './basic';
import { CliError } from '../cli/errors';
import type { AsyncCommandRunner, RunResult } from '../process/run';
import type { InteractiveRunner, PtyOptions } from '../process/pty';

function result(overrides: Partial<RunResult> = {}): RunResult {
  return { exitCode: 0, stdout: '', stderr: '', ...overrides };
}

interface RunnerCall {
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

function spyRunner(): { calls: RunnerCall[]; next: RunResult[]; runner: AsyncCommandRunner } {
  const calls: RunnerCall[] = [];
  const next: RunResult[] = [];
  const runner: AsyncCommandRunner = async (args, opts) => {
    calls.push({ args, env: opts?.env, cwd: opts?.cwd });
    return next.shift() ?? result();
  };
  return { calls, next, runner };
}

describe('OpenCodeHarness', () => {
  it('runs opencode with the prompt, its config-dir, and the passed env', async () => {
    const { calls, runner } = spyRunner();
    const harness = new OpenCodeHarness({ runner });

    const res = await harness.headless({ prompt: 'fix the tests', env: { GITHUB_TOKEN: 'ghp-secret' } });

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['run', 'fix the tests']);
    expect(calls[0].env).toMatchObject({
      OPENCODE_CONFIG_DIR: harness.configDir(),
      GITHUB_TOKEN: 'ghp-secret',
    });
    expect(res).toEqual({ exitCode: 0, output: '' });
  });

  it('forwards the cwd option to the runner', async () => {
    const { calls, runner } = spyRunner();
    const harness = new OpenCodeHarness({ runner });

    await harness.headless({ prompt: 'hi', cwd: '/tmp/sander-worktree' });

    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe('/tmp/sander-worktree');
  });

  it('exposes the headless command argv without launching', () => {
    const harness = new OpenCodeHarness();
    expect(harness.headlessCommand('do it')).toEqual(['run', 'do it']);
  });

  it('exposes the --agent argv for an interactive launch', () => {
    const harness = new OpenCodeHarness();
    expect(harness.agentArg('orquestator')).toEqual(['--agent', 'orquestator']);
  });

  it('uses ~/.config/opencode as the config dir', () => {
    const harness = new OpenCodeHarness();
    expect(harness.name).toBe('opencode');
    expect(harness.configDir()).toBe(path.join(os.homedir(), '.config', 'opencode'));
  });

  it('reports the agent output (stdout and stderr) and preserves the exit code', async () => {
    const { next, runner } = spyRunner();
    const harness = new OpenCodeHarness({ runner });

    next.push(result({ exitCode: 0, stdout: 'answer\n' }));
    const ok = await harness.headless({ prompt: 'hi' });
    expect(ok).toEqual({ exitCode: 0, output: 'answer' });

    next.push(result({ exitCode: 1, stderr: 'boom\n' }));
    const failed = await harness.headless({ prompt: 'hi' });
    expect(failed).toEqual({ exitCode: 1, output: 'boom' });
  });

  it('throws a CliError when the agent binary cannot be launched', async () => {
    const { next, runner } = spyRunner();
    next.push(result({ exitCode: -1, stderr: 'ENOENT' }));
    const harness = new OpenCodeHarness({ runner });

    const promise = harness.headless({ prompt: 'hi' });
    await expect(promise).rejects.toThrow(CliError);
    await expect(promise).rejects.toThrow(/failed to launch opencode/);
  });

  it('launches the agent interactively with its config-dir and the passed env', async () => {
    const calls: { args: string[]; opts?: PtyOptions }[] = [];
    const interactive: InteractiveRunner = async (args, opts) => {
      calls.push({ args, opts });
      return 6;
    };
    const harness = new OpenCodeHarness({ interactive });

    const exit = await harness.interactive({ env: { GITHUB_TOKEN: 'ghp-secret' } });

    expect(exit).toBe(6);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([]);
    expect(calls[0].opts?.env).toMatchObject({
      OPENCODE_CONFIG_DIR: harness.configDir(),
      GITHUB_TOKEN: 'ghp-secret',
    });
  });
});

describe('ClaudeCodeHarness', () => {
  it('runs claude with -p and its config-dir', async () => {
    const { calls, runner } = spyRunner();
    const harness = new ClaudeCodeHarness({ runner });

    await harness.headless({ prompt: 'summarize the diff', env: { ANTHROPIC_API_KEY: 'sk-ant-secret' } });

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['-p', 'summarize the diff']);
    expect(calls[0].env).toMatchObject({
      CLAUDE_CONFIG_DIR: harness.configDir(),
      ANTHROPIC_API_KEY: 'sk-ant-secret',
    });
  });

  it('uses ~/.config/claude as the config dir', () => {
    const harness = new ClaudeCodeHarness();
    expect(harness.name).toBe('claude');
    expect(harness.configDir()).toBe(path.join(os.homedir(), '.config', 'claude'));
  });

  it('exposes the claude headless command argv without launching', () => {
    const harness = new ClaudeCodeHarness();
    expect(harness.headlessCommand('do it')).toEqual(['-p', 'do it']);
  });

  it('exposes the --agent argv for an interactive launch', () => {
    const harness = new ClaudeCodeHarness();
    expect(harness.agentArg('orquestator')).toEqual(['--agent', 'orquestator']);
  });

  it('launches claude interactively with its config-dir', async () => {
    const calls: { args: string[]; opts?: PtyOptions }[] = [];
    const interactive: InteractiveRunner = async (args, opts) => {
      calls.push({ args, opts });
      return 0;
    };
    const harness = new ClaudeCodeHarness({ interactive });

    await harness.interactive({});

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([]);
    expect(calls[0].opts?.env).toMatchObject({ CLAUDE_CONFIG_DIR: harness.configDir() });
  });
});

describe('BasicHarnessFactory', () => {
  it('maps opencode and claude to their real adapters', () => {
    const factory = new BasicHarnessFactory();
    expect(factory.get('opencode')).toBeInstanceOf(OpenCodeHarness);
    expect(factory.get('claude')).toBeInstanceOf(ClaudeCodeHarness);
  });

  it('falls back to the generic harness for harnesses without an adapter', async () => {
    const factory = new BasicHarnessFactory();
    const codex = factory.get('codex');
    expect(codex).toBeInstanceOf(BasicHarness);
    expect(codex.configDir()).toBe(path.join(os.homedir(), '.config', 'codex'));
    await expect(codex.headless({ prompt: 'hi' })).rejects.toThrow(/not implemented/);
    expect(() => codex.headlessCommand('hi')).toThrow(/not implemented/);
  });

  it('reports no --agent argv for harnesses without the flag', () => {
    const factory = new BasicHarnessFactory();
    const codex = factory.get('codex');
    expect(codex.agentArg('orquestator')).toBeNull();
  });
});

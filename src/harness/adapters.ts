import * as os from 'node:os';
import * as path from 'node:path';
import { CliError } from '../cli/errors';
import { createAsyncRunner } from '../process/run';
import type { AsyncCommandRunner, RunResult } from '../process/run';
import { createInteractiveRunner } from '../process/pty';
import type { InteractiveRunner } from '../process/pty';
import type { Harness, HeadlessOptions, HeadlessResult, InteractiveOptions } from './harness';

export interface HarnessAdapterOptions {
  runner?: AsyncCommandRunner;
  interactive?: InteractiveRunner;
  bin?: string;
  env?: NodeJS.ProcessEnv;
}

class AgentHarness implements Harness {
  readonly name: string;
  private readonly runner: AsyncCommandRunner;
  private readonly interactiveRunner: InteractiveRunner;
  private readonly bin: string;
  private readonly baseEnv?: NodeJS.ProcessEnv;

  constructor(
    name: string,
    private readonly configEnvVar: string,
    private readonly headlessArgs: (prompt: string) => string[],
    opts: HarnessAdapterOptions = {},
  ) {
    this.name = name;
    this.bin = opts.bin ?? name;
    this.runner = opts.runner ?? createAsyncRunner(this.bin);
    this.interactiveRunner = opts.interactive ?? createInteractiveRunner(this.bin);
    this.baseEnv = opts.env;
  }

  configDir(): string {
    return path.join(os.homedir(), '.config', this.name);
  }

  headlessCommand(prompt: string): string[] {
    return this.headlessArgs(prompt);
  }

  async headless(opts: HeadlessOptions): Promise<HeadlessResult> {
    const result: RunResult = await this.runner(this.headlessCommand(opts.prompt), {
      cwd: opts.cwd,
      env: { ...this.baseEnv, ...opts.env, [this.configEnvVar]: this.configDir() },
    });
    if (result.exitCode === -1) {
      throw new CliError(`failed to launch ${this.bin}: is it installed and on the PATH?`);
    }
    return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}`.trim() };
  }

  async interactive(opts: InteractiveOptions): Promise<number> {
    return this.interactiveRunner([], {
      env: { ...this.baseEnv, ...opts.env, [this.configEnvVar]: this.configDir() },
    });
  }
}

export class OpenCodeHarness extends AgentHarness {
  constructor(opts: HarnessAdapterOptions = {}) {
    super('opencode', 'OPENCODE_CONFIG_DIR', (prompt) => ['run', prompt], opts);
  }
}

export class ClaudeCodeHarness extends AgentHarness {
  constructor(opts: HarnessAdapterOptions = {}) {
    super('claude', 'CLAUDE_CONFIG_DIR', (prompt) => ['-p', prompt], opts);
  }
}

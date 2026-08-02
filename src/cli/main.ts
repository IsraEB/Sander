import { configDir as resolveConfigDir } from '../config/config';
import { CliError } from './errors';
import { runAttach } from './commands/attach';
import { runConfig } from './commands/config';
import { runCreate } from './commands/create';
import { runSetup } from './commands/setup';
import { runExec } from './commands/exec';
import { runRm, runStart, runStop } from './commands/lifecycle';
import { runList } from './commands/list';
import { runLogs } from './commands/logs';
import { runRun } from './commands/run';
import type { CliDeps } from './deps';
import { debugEnv } from './deps';
import { helpForCommand, ROOT_HELP } from './help';
import { BasicHarnessFactory } from '../harness/basic';
import { createProvider } from '../provider/providers';
import { GitWorktree } from '../worktree/worktree';
import { createPrompt } from '../config/wizard';
import { run, runAsync } from '../process/run';

export type Command = (deps: CliDeps, argv: string[]) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  create: runCreate,
  setup: runSetup,
  config: runConfig,
  run: runRun,
  attach: runAttach,
  exec: runExec,
  stop: runStop,
  start: runStart,
  rm: runRm,
  destroy: runRm,
  delete: runRm,
  remove: runRm,
  list: runList,
  logs: runLogs,
};

export function defaultDeps(): CliDeps {
  return {
    configDir: resolveConfigDir(),
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    createProvider,
    harnessFactory: new BasicHarnessFactory(),
    worktree: new GitWorktree(),
    prompt: createPrompt(process.stdin, process.stderr),
    gitRunner: (args, opts) => run('git', args, opts),
    dockerRunner: (args, opts) => runAsync('docker', args, opts),
    debug: debugEnv(),
  };
}

export async function runCli(argv: string[], deps?: CliDeps): Promise<number> {
  const d = deps ?? defaultDeps();
  const [name, ...rest] = argv;

  if (name === undefined || name === '-h' || name === '--help') {
    d.stdout.write(ROOT_HELP);
    return 0;
  }

  if (name === 'help') {
    const target = rest[0];
    d.stdout.write(target ? helpForCommand(target) : ROOT_HELP);
    return 0;
  }

  const command = COMMANDS[name];
  if (!command) {
    d.stderr.write(`error: unknown command "${name}"\nRun "sander --help" for usage.\n`);
    return 1;
  }

  try {
    return await command(d, rest);
  } catch (err) {
    if (err instanceof CliError) {
      d.stderr.write(`error: ${err.message}\n`);
      return err.exitCode;
    }
    d.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

export async function main(argv: string[]): Promise<void> {
  const code = await runCli(argv);
  process.exitCode = code;
}

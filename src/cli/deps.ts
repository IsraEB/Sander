import type { HarnessFactory } from '../harness/harness';
import type { ProviderFactory } from '../provider/providers';
import type { Worktree } from '../worktree/worktree';
import type { AsyncCommandRunner, CommandRunner } from '../process/run';
import type { KeySource } from '../selector/selector';

export interface CliDeps {
  configDir: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream;
  createProvider: ProviderFactory;
  harnessFactory: HarnessFactory;
  worktree: Worktree;
  prompt?: (question: string) => string | undefined;
  promptSecret?: (question: string) => string | undefined;
  selectorKeySource?: KeySource;
  gitRunner?: CommandRunner;
  dockerRunner?: AsyncCommandRunner;
  debug?: boolean;
}

// SANDER_DEBUG enables the debug/timing mode: enabled unless the variable is
// empty, "0" or "false" (case-insensitive); any other value (1, true, ...) is
// on. Never on when the variable is absent.
export function debugEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.SANDER_DEBUG?.trim();
  if (value === undefined || value === '') {
    return false;
  }
  return value !== '0' && value.toLowerCase() !== 'false';
}

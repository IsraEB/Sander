import * as os from 'node:os';
import * as path from 'node:path';
import { CliError } from '../cli/errors';
import { ClaudeCodeHarness, OpenCodeHarness } from './adapters';
import type {
  Harness,
  HarnessFactory,
  HeadlessOptions,
  HeadlessResult,
  InteractiveOptions,
} from './harness';

export class BasicHarness implements Harness {
  constructor(readonly name: string) {}

  configDir(): string {
    return path.join(os.homedir(), '.config', this.name);
  }

  async interactive(_opts: InteractiveOptions): Promise<number> {
    throw new CliError(`harness adapter "${this.name}" is not implemented yet`);
  }

  async headless(_opts: HeadlessOptions): Promise<HeadlessResult> {
    throw new CliError(`harness adapter "${this.name}" is not implemented yet`);
  }

  headlessCommand(_prompt: string): string[] {
    throw new CliError(`harness adapter "${this.name}" is not implemented yet`);
  }
}

export class BasicHarnessFactory implements HarnessFactory {
  get(name: string): Harness {
    switch (name) {
      case 'opencode':
        return new OpenCodeHarness();
      case 'claude':
        return new ClaudeCodeHarness();
      default:
        // Harnesses without a dedicated adapter (e.g. codex) remain usable for
        // create/config sync via the generic harness; headless/interactive
        // report "not implemented yet".
        return new BasicHarness(name);
    }
  }
}

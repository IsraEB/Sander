import type {
  Harness,
  HarnessFactory,
  HeadlessOptions,
  HeadlessResult,
  InteractiveOptions,
} from './harness';

export type HarnessCall =
  | { kind: 'interactive'; name: string; opts: InteractiveOptions }
  | { kind: 'headless'; name: string; opts: HeadlessOptions };

export class FakeHarness implements Harness {
  readonly calls: HarnessCall[] = [];
  headlessResult: HeadlessResult = { exitCode: 0, output: '' };
  headlessHook: ((opts: HeadlessOptions) => void) | null = null;
  interactiveExitCode = 0;
  config = '/tmp/fake-harness-config';

  constructor(readonly name: string) {}

  configDir(): string {
    return this.config;
  }

  async interactive(opts: InteractiveOptions): Promise<number> {
    this.calls.push({ kind: 'interactive', name: this.name, opts });
    return this.interactiveExitCode;
  }

  async headless(opts: HeadlessOptions): Promise<HeadlessResult> {
    this.calls.push({ kind: 'headless', name: this.name, opts });
    if (this.headlessHook !== null) {
      this.headlessHook(opts);
    }
    return this.headlessResult;
  }

  headlessCommand(prompt: string): string[] {
    return [prompt];
  }
}

export class FakeHarnessFactory implements HarnessFactory {
  private readonly harnesses = new Map<string, FakeHarness>();

  get(name: string): FakeHarness {
    let harness = this.harnesses.get(name);
    if (!harness) {
      harness = new FakeHarness(name);
      this.harnesses.set(name, harness);
    }
    return harness;
  }

  registered(name: string): FakeHarness | undefined {
    return this.harnesses.get(name);
  }
}

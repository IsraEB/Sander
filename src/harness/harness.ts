export interface HeadlessOptions {
  prompt: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface HeadlessResult {
  exitCode: number;
  output: string;
}

export interface InteractiveOptions {
  env?: Record<string, string>;
}

export interface Harness {
  name: string;
  configDir(): string;
  interactive(opts: InteractiveOptions): Promise<number>;
  headless(opts: HeadlessOptions): Promise<HeadlessResult>;
  /**
   * The argv (without the binary) for a headless run with this prompt. The
   * host-side `headless()` runs exactly this argv; callers launching the
   * harness inside a box prepend `name` and run it via the provider exec seam.
   */
  headlessCommand(prompt: string): string[];
}

export interface HarnessFactory {
  get(name: string): Harness;
}

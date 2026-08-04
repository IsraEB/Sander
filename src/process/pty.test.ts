import { describe, expect, it } from 'vitest';
import { CliError } from '../cli/errors';
import { createInteractiveRunner, runInteractive } from './pty';

describe('runInteractive', () => {
  it('propagates the child exit code', async () => {
    const code = await runInteractive(process.execPath, ['-e', 'process.exit(7)']);
    expect(code).toBe(7);
  });

  it('passes the env through to the child', async () => {
    const code = await runInteractive(
      process.execPath,
      ['-e', 'process.exit(process.env.SANDER_PTY_TEST === "yes" ? 0 : 1)'],
      { env: { SANDER_PTY_TEST: 'yes' } },
    );
    expect(code).toBe(0);
  });

  it('rejects with a CliError when the binary cannot be launched', async () => {
    const promise = runInteractive('definitely-not-a-real-sander-binary', []);
    await expect(promise).rejects.toThrow(CliError);
    await expect(promise).rejects.toThrow(/failed to launch/);
  });

  it('injects the input into the child stdin before piping through', async () => {
    const code = await runInteractive(
      process.execPath,
      [
        '-e',
        'process.stdin.resume(); let data = ""; process.stdin.on("data", (c) => { data += c; if (data === "hola\\n") process.exit(0); if (data.length > 20) process.exit(1); }); process.stdin.on("end", () => process.exit(data === "hola\\n" ? 0 : 1));',
      ],
      { tty: false, input: 'hola' },
    );
    expect(code).toBe(0);
  });
});

describe('createInteractiveRunner', () => {
  it('binds the bin so callers pass only args', async () => {
    const run = createInteractiveRunner(process.execPath);
    const code = await run(['-e', 'process.exit(3)']);
    expect(code).toBe(3);
  });
});

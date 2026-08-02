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
});

describe('createInteractiveRunner', () => {
  it('binds the bin so callers pass only args', async () => {
    const run = createInteractiveRunner(process.execPath);
    const code = await run(['-e', 'process.exit(3)']);
    expect(code).toBe(3);
  });
});

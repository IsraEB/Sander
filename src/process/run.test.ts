import { describe, expect, it } from 'vitest';
import { createAsyncRunner, createRunner, runAsync } from './run';

describe('runAsync', () => {
  it('captures stdout and the child exit code', async () => {
    const result = await runAsync(process.execPath, ['-e', 'console.log("hello")']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
  });

  it('captures stderr and a non-zero exit code', async () => {
    const result = await runAsync(process.execPath, ['-e', 'console.error("boom"); process.exit(3)']);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('boom');
  });

  it('passes env and cwd through to the child', async () => {
    const result = await runAsync(process.execPath, ['-e', 'console.log(process.env.SANDER_RUN_TEST)'], {
      env: { SANDER_RUN_TEST: 'yes' },
    });
    expect(result.stdout).toContain('yes');
  });

  it('writes the input to the child stdin', async () => {
    const result = await runAsync(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'piped' });
    expect(result.stdout).toContain('piped');
  });

  it('resolves with exitCode -1 when the binary cannot be launched', async () => {
    const result = await runAsync('definitely-not-a-real-sander-binary', []);
    expect(result.exitCode).toBe(-1);
  });

  it('kills the child and reports a timeout when the command exceeds timeoutMs', async () => {
    const startedAt = Date.now();
    const result = await runAsync(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 5000)'], { timeoutMs: 100 });
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('timed out');
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it('does not block the event loop while the child is running', async () => {
    // Regression test for the frozen spinner: spawnSync blocks the event loop
    // so the spinner's setInterval never fires while `agentbox create` runs.
    // runAsync must keep timers (and therefore the spinner) ticking.
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
      await runAsync(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 300)']);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });
});

describe('createAsyncRunner', () => {
  it('binds the bin so callers pass only args', async () => {
    const run = createAsyncRunner(process.execPath);
    const result = await run(['-e', 'process.exit(4)']);
    expect(result.exitCode).toBe(4);
  });
});

describe('createRunner', () => {
  it('returns a synchronous runner bound to the bin', () => {
    const run = createRunner(process.execPath);
    expect(run(['-e', 'process.exit(0)']).exitCode).toBe(0);
  });
});

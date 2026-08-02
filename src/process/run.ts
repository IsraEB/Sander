import { spawn, spawnSync } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (args: string[], opts?: RunOptions) => RunResult;

export type AsyncCommandRunner = (args: string[], opts?: RunOptions) => Promise<RunResult>;

export function run(bin: string, args: string[], opts: RunOptions = {}): RunResult {
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    input: opts.input,
    timeout: opts.timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function createRunner(bin: string): CommandRunner {
  return (args: string[], opts: RunOptions = {}): RunResult => run(bin, args, opts);
}

// Non-blocking variant of `run`: the child runs in the background so the event
// loop (and therefore the spinner's setInterval) keeps ticking while a long
// command such as `agentbox create` is in flight. `spawnSync` would freeze the
// spinner for the whole duration because it blocks the event loop.
export function runAsync(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const maxBuffer = opts.maxBuffer ?? 32 * 1024 * 1024;
    const buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
    let overflowed = false;
    let timedOut = false;
    let settled = false;

    const settle = (exitCode: number, stdout: string, stderr: string): void => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout, stderr });
    };

    const capture = (channel: 'stdout' | 'stderr', chunk: string): void => {
      buffers[channel] += chunk;
      if (buffers[channel].length > maxBuffer) {
        buffers[channel] = buffers[channel].slice(0, maxBuffer);
        overflowed = true;
        child.kill('SIGKILL');
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => capture('stdout', chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => capture('stderr', chunk.toString('utf8')));

    const timer =
      opts.timeoutMs !== undefined && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, opts.timeoutMs)
        : null;

    child.on('error', (err) => {
      if (timer !== null) clearTimeout(timer);
      settle(-1, buffers.stdout, err.message);
    });

    child.on('close', (code) => {
      if (timer !== null) clearTimeout(timer);
      if (overflowed) {
        settle(-1, buffers.stdout, `${buffers.stderr}\nprocess output exceeded maxBuffer (${maxBuffer} bytes)`);
        return;
      }
      if (timedOut) {
        settle(-1, buffers.stdout, `${buffers.stderr}\nprocess timed out after ${opts.timeoutMs}ms`);
        return;
      }
      settle(code ?? -1, buffers.stdout, buffers.stderr);
    });

    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    } else {
      child.stdin?.end();
    }
  });
}

export function createAsyncRunner(bin: string): AsyncCommandRunner {
  return (args: string[], opts: RunOptions = {}): Promise<RunResult> => runAsync(bin, args, opts);
}

export function agentboxBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENTBOX_BIN;
  if (override && override.trim() !== '') {
    return override.trim();
  }
  return 'agentbox';
}

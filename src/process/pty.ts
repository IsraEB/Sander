import { spawn } from 'node:child_process';
import { CliError } from '../cli/errors';

export interface PtyOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  tty?: boolean;
  /** Initial text written to the child's stdin (followed by "\n") before the
   *  parent stdin is piped through. Only meaningful when tty is false (stdio
   *  ['pipe','inherit','inherit']); ignored in tty mode. */
  input?: string;
}

export type InteractiveRunner = (args: string[], opts?: PtyOptions) => Promise<number>;

export function runInteractive(bin: string, args: string[], opts: PtyOptions = {}): Promise<number> {
  const tty = opts.tty ?? true;
  return new Promise<number>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: tty ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    });
    if (!tty && child.stdin) {
      child.stdin.on('error', () => {});
      if (opts.input !== undefined) {
        child.stdin.write(`${opts.input}\n`);
      }
      process.stdin.pipe(child.stdin);
    }
    child.on('error', () => {
      reject(new CliError(`failed to launch ${bin}: is it installed and on the PATH?`));
    });
    child.on('close', (code) => {
      if (!tty && child.stdin && !child.stdin.destroyed) {
        process.stdin.unpipe(child.stdin);
      }
      resolve(code ?? 1);
    });
  });
}

export function createInteractiveRunner(bin: string): InteractiveRunner {
  return (args: string[], opts: PtyOptions = {}): Promise<number> => runInteractive(bin, args, opts);
}

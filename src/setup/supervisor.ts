import * as path from 'node:path';
import { CliError } from '../cli/errors';
import { BOX_WORKTREE } from '../provider/box-user';
import type { Provider } from '../provider/provider';

export const SUPERVISOR_SCRIPT_NAME = 'supervisor.sh';
export const SUPERVISOR_PIDFILE_NAME = 'supervisor.pid';
export const START_LOG_NAME = 'start.log';

/**
 * Host path of the Sander-owned supervisor script shipped with the CLI. From
 * `src/setup/supervisor.ts` (vitest) and `dist/setup/supervisor.js`
 * (production build) it resolves to the same committed `resources/` file.
 */
export function supervisorScriptSource(): string {
  return path.join(__dirname, '..', '..', 'resources', 'supervisor.sh');
}

/** Box path of the service log, used by `sander logs`. */
export function startLogPath(worktreePath: string = BOX_WORKTREE): string {
  return path.posix.join(worktreePath, '.sander', START_LOG_NAME);
}

/**
 * Copies the shipped supervisor script into the box's `.sander/` directory.
 * Must precede `launchSupervisor`. Provider errors propagate unchanged (create
 * rolls back); never prints, never rolls back itself.
 */
export async function deploySupervisor(opts: {
  boxId: string;
  provider: Provider;
  worktreePath?: string;
}): Promise<void> {
  const worktreePath = opts.worktreePath ?? BOX_WORKTREE;
  await opts.provider.copy(
    opts.boxId,
    supervisorScriptSource(),
    path.posix.join(worktreePath, '.sander', SUPERVISOR_SCRIPT_NAME),
  );
}

/**
 * Launches the supervisor detached (nohup + pidfile inside the script) so it
 * runs `.sander/start.sh` and watches the worktree. Rejects with a `CliError`
 * on a non-zero exec; provider errors propagate unchanged. The caller may pass
 * a `rollbackNote` (e.g. from `create`, where a failure does roll back) that is
 * appended to the message; `start` does not pass one, so its warning never
 * claims a rollback occurred.
 */
export async function launchSupervisor(opts: {
  boxId: string;
  provider: Provider;
  worktreePath?: string;
  rollbackNote?: string;
}): Promise<void> {
  const worktreePath = opts.worktreePath ?? BOX_WORKTREE;
  const scriptPath = path.posix.join(worktreePath, '.sander', SUPERVISOR_SCRIPT_NAME);
  const result = await opts.provider.exec(opts.boxId, [
    'sh',
    '-c',
    `nohup sh ${scriptPath} start </dev/null >/dev/null 2>&1 &`,
  ]);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    const note = opts.rollbackNote !== undefined ? `; ${opts.rollbackNote}` : '';
    throw new CliError(
      `no se pudo lanzar el supervisor del servicio ${scriptPath} (exit ${result.exitCode}${detail ? `: ${detail}` : ''})${note}`,
    );
  }
}

/**
 * Terminates the running supervisor (and its service) via the supervisor's
 * `stop` subcommand and pidfile. Idempotent. Rejects with a `CliError` on a
 * non-zero exec; provider errors propagate unchanged (the `stop` command
 * catches and warns).
 */
export async function stopService(opts: {
  boxId: string;
  provider: Provider;
  worktreePath?: string;
}): Promise<void> {
  const worktreePath = opts.worktreePath ?? BOX_WORKTREE;
  const scriptPath = path.posix.join(worktreePath, '.sander', SUPERVISOR_SCRIPT_NAME);
  const result = await opts.provider.exec(opts.boxId, ['sh', scriptPath, 'stop']);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new CliError(`no se pudo detener el servicio del sandbox (exit ${result.exitCode}${detail ? `: ${detail}` : ''})`);
  }
}

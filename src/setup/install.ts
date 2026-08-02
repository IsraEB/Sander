import * as path from 'node:path';
import { CliError } from '../cli/errors';
import { BOX_WORKTREE } from '../provider/box-user';
import type { Provider } from '../provider/provider';

/**
 * Executes the box's `.sander/install.sh` once, inside the box, in the worktree
 * cwd. `create` calls this only when it has probed the artifact itself
 * (`provider.hasExecutable` on `/workspace/.sander/install.sh`) and found it
 * present and executable; the setup agent plays no part in the check. Runs
 * before any supervisor deployment and before the box is registered, and is
 * skippable via `--skip-install`, `--skip-setup`, or `-s`. Only runs in the
 * git-repo branch of `create`: whether the artifacts were just generated or
 * pre-existed, a new box needs its dependencies. Never runs on `sander start`
 * (the start command has no call site). Rejects with a `CliError` on a non-zero
 * exit; never rolls back itself.
 */
export async function runInstallScript(opts: {
  boxId: string;
  provider: Provider;
  worktreePath?: string;
}): Promise<void> {
  const worktreePath = opts.worktreePath ?? BOX_WORKTREE;
  const scriptPath = path.posix.join(worktreePath, '.sander', 'install.sh');
  const result = await opts.provider.exec(opts.boxId, [scriptPath], { cwd: worktreePath });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new CliError(
      `el script de instalación ${scriptPath} falló (exit ${result.exitCode}${detail ? `: ${detail}` : ''}); se hizo rollback completo.`,
    );
  }
}

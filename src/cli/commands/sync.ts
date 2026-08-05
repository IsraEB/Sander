import { CliError } from '../errors';
import { helpForCommand } from '../help';
import { resolveSandboxId } from '../args';
import type { CliDeps } from '../deps';
import { run } from '../../process/run';
import { loadRegistry } from '../../registry/registry';
import { runSyncCycle } from '../../sync/cycle';
import { watchSync } from '../../sync/watch';
import { DEFAULT_SYNC_INTERVAL_MS } from '../../sync/watch';
import { stopWatcher, watcherLogPath, watcherPidPath } from '../../sync/watcher-state';

export async function runSync(deps: CliDeps, argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    deps.stdout.write(helpForCommand('sync'));
    return 0;
  }

  const watch = argv.includes('--watch');
  const stop = argv.includes('--stop');
  const { id, rest } = resolveSandboxId(argv);
  const extra = rest.filter((a) => a !== '--watch' && a !== '--stop');
  if (extra.length > 0) {
    throw new CliError(`unexpected argument "${extra[0]}": sync takes a single sandbox id`);
  }
  if (watch && stop) {
    throw new CliError('--watch y --stop son excluyentes: pasa solo uno');
  }

  const registry = loadRegistry(deps.configDir);
  const box = registry.boxes[id];
  if (!box) {
    throw new CliError(`sandbox not found: ${id}`);
  }

  // --stop only needs the pidfile: it works even for a non-git sandbox (no
  // host worktree), since stopping a watcher has nothing to do with syncing.
  if (stop) {
    const result = stopWatcher(id, deps.configDir, (message) => deps.stderr.write(message));
    if (result.status === 'stopped') {
      deps.stdout.write(`Watcher de sync de "${id}" detenido (pid ${result.pid}).\n`);
    }
    return 0;
  }

  if (box.worktreePath === undefined || box.worktreePath === '') {
    deps.stdout.write(
      `sync desactivada: el sandbox "${id}" no tiene worktree host (proyecto no-git); no se transfiere nada.\n`
    );
    return 0;
  }

  const provider = deps.createProvider(box.provider);
  const gitRunner = deps.gitRunner ?? ((args: string[]) => run('git', args));

  if (watch) {
    const handle = watchSync({
      configDir: deps.configDir,
      id,
      hostWorktree: box.worktreePath,
      provider,
      gitRunner,
      intervalMs: deps.syncIntervalMs,
      warn: (message) => deps.stderr.write(message),
    });
    if (!handle.started) {
      // watchSync already warned that another watcher owns the id.
      return 0;
    }
    deps.stdout.write(
      `Watcher de sync de "${id}" activo (pid ${process.pid}); la primera sync es inmediata y luego cada ` +
        `${deps.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS} ms. Estado y log: ${watcherPidPath(deps.configDir, id)} ` +
        `y ${watcherLogPath(deps.configDir, id)}\n`
    );
    await handle.done;
    return 0;
  }

  try {
    const summary = await runSyncCycle({
      id,
      hostWorktree: box.worktreePath,
      provider,
      gitRunner,
      warn: (message) => deps.stderr.write(message),
    });
    deps.stdout.write(
      `Sincronizado sandbox "${id}": ${summary.boxToHost} copiados box→host, ` +
        `${summary.hostToBox} copiados host→box, ${summary.conflicts} conflictos.\n`
    );
  } catch (err) {
    deps.stderr.write(
      `Aviso: ciclo de sync omitido para "${id}" (${err instanceof Error ? err.message : String(err)}).\n`
    );
  }
  return 0;
}

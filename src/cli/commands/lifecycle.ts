import { runStep, StepList } from '../steps';
import { CliError } from '../errors';
import { helpForCommand } from '../help';
import { popBooleanFlag, resolveSandboxId } from '../args';
import type { CliDeps } from '../deps';
import { loadRegistry, removeBox, saveRegistry, setBoxStatus } from '../../registry/registry';
import { launchSupervisor, stopService } from '../../setup/supervisor';
import { BOX_WORKTREE } from '../../provider/box-user';
import { containerNameForSandbox } from '../../names/sandbox-name';
import { deriveWorktreeRef } from '../../worktree/worktree';
import { stopWatcher } from '../../sync/watcher-state';
import { DEFAULT_PROVIDER } from '../../provider/providers';
import type { Provider } from '../../provider/provider';
import * as path from 'node:path';

export async function runStop(deps: CliDeps, argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    deps.stdout.write(helpForCommand('stop'));
    return 0;
  }

  const { id, rest } = resolveSandboxId(argv);
  if (rest.length > 0) {
    throw new CliError(`unexpected argument "${rest[0]}": stop takes a single sandbox id`);
  }

  const registry = loadRegistry(deps.configDir);
  const box = registry.boxes[id];
  if (!box) {
    throw new CliError(`sandbox not found: ${id}`);
  }
  const provider = deps.createProvider(box.provider);

  try {
    await stopService({ boxId: id, provider });
  } catch (err) {
    deps.stderr.write(`Aviso: no se pudo detener el servicio del sandbox "${id}" (${err instanceof Error ? err.message : String(err)}).\n`);
  }
  await provider.stop(id);
  setBoxStatus(registry, id, 'stopped');
  saveRegistry(deps.configDir, registry);

  deps.stdout.write(`Stopped sandbox "${id}".\n`);
  return 0;
}

export async function runStart(deps: CliDeps, argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    deps.stdout.write(helpForCommand('start'));
    return 0;
  }

  const { id, rest } = resolveSandboxId(argv);
  if (rest.length > 0) {
    throw new CliError(`unexpected argument "${rest[0]}": start takes a single sandbox id`);
  }

  const registry = loadRegistry(deps.configDir);
  const box = registry.boxes[id];
  if (!box) {
    throw new CliError(`sandbox not found: ${id}`);
  }
  const provider = deps.createProvider(box.provider);

  await provider.start(id);
  const startScript = path.posix.join(BOX_WORKTREE, '.sander', 'start.sh');
  if (!(await provider.hasExecutable(id, startScript))) {
    deps.stderr.write(`Aviso: el sandbox "${id}" no tiene ${startScript}; no se inicia ningún servicio.\n`);
  } else {
    try {
      await launchSupervisor({ boxId: id, provider });
    } catch (err) {
      deps.stderr.write(`Aviso: no se pudo iniciar el servicio del sandbox "${id}" (${err instanceof Error ? err.message : String(err)}).\n`);
    }
  }
  setBoxStatus(registry, id, 'running');
  saveRegistry(deps.configDir, registry);

  deps.stdout.write(`Started sandbox "${id}".\n`);
  return 0;
}

export async function runRm(deps: CliDeps, argv: string[]): Promise<number> {
  // El sandbox vive en una rama git del repo del host y borrarla desde el host es
  // muy complicado ("es muy complicado borrar ramas desde el host"), así que sander
  // la borra por defecto al eliminar, cuando aún conoce la relación worktree/rama.
  // --dont-delete-branch (y su sinónimo --no-delete-branch) conserva la rama.
  // --delete-branch se mantiene como no-op deprecado por compatibilidad.
  // rm es idempotente y verifica antes de borrar: para cualquier id (registrado o
  // no) deriva lo que puede (nombre del contenedor, rama, ruta del worktree),
  // verifica cada recurso antes de actuar, limpia lo que exista y tolera el
  // "ya no está". Solo falla si un recurso verificado sigue presente tras un
  // borrado fallido, o si el proveedor es del todo inverificable e irremovible.
  const { argv: argvClean, value: dontDelete } = popBooleanFlag(argv, 'dont-delete-branch');
  const { argv: argvClean2, value: noDelete } = popBooleanFlag(argvClean, 'no-delete-branch');
  const { argv: argvClean3 } = popBooleanFlag(argvClean2, 'delete-branch'); // deprecado: no-op, su valor se ignora
  const keepBranch = dontDelete || noDelete;
  if (argvClean3.includes('-h') || argvClean3.includes('--help')) {
    deps.stdout.write(helpForCommand('rm'));
    return 0;
  }

  const { id, rest } = resolveSandboxId(argvClean3);
  if (rest.length > 0) {
    throw new CliError(`unexpected argument "${rest[0]}": rm takes a single sandbox id`);
  }

  const registry = loadRegistry(deps.configDir);
  const box = registry.boxes[id]; // may be undefined — rm is idempotent, no "sandbox not found"
  const provider = deps.createProvider(box?.provider ?? DEFAULT_PROVIDER);
  const projectRoot = box?.projectRoot ?? process.cwd();

  // The removal plan is shown up front as a checklist and ticked off as each
  // part finishes, so rm is never silent while it cleans up the box.
  const steps = new StepList({ stream: deps.stderr });
  const stepWatcher = steps.add('Deteniendo el watcher de sync');
  const stepContainer = steps.add('Removing the sandbox container');
  const stepWorktree = steps.add('Removing the sandbox worktree');
  const stepBranch = steps.add('Deleting the sandbox git branch');

  try {
    // El watcher de sync es un proceso del host con estado derivado del configDir
    // (<configDir>/sync/<id>.pid/.log), independiente del contenedor y del git: se
    // detiene ANTES de destruir el contenedor para que ningún ciclo de sync se
    // intercale con el desmontaje. stopWatcher es idempotente y nunca lanza: con el
    // watcher ya detenido o inexistente limpia el estado y avisa (el "ya no está"
    // de rm, igual que con el contenedor), sin que rm falle.
    await runStep(steps, stepWatcher, async () => {
      stopWatcher(id, deps.configDir, (message) => steps.log(message.trimEnd()));
    });

    // Contrato: el contenedor se elimina ANTES de los pasos git. agentbox destroy
    // libera la registración del worktree del box en el .git compartido, así que
    // `git branch -D` puede eliminar la rama después. El desacople git solo se
    // ejecuta tras verificar que el contenedor ya no está (o que su borrado
    // terminó): nunca se desacopla una rama que un contenedor vivo pueda tener.
    // Verifica → limpia → (si falla) vuelve a verificar; un contenedor ya ausente
    // se tolera.
    await runStep(steps, stepContainer, () => removeContainerIfPresent(provider, id));

    // Principios 1+2+3 — worktree detach/remove, luego borrado de rama (salvo que
    // se conserve). Los boxes registrados mantienen las reglas de aplicabilidad de
    // hoy (removeWorktree solo cuando rama y worktreePath están registrados;
    // deleteBranch cuando hay rama). Los ids no registrados derivan rama y worktree
    // del id y del cwd, igual que create.
    const hasGitWork = box === undefined || box.branch !== undefined;
    if (hasGitWork) {
      const branch = box?.branch ?? id;
      const worktreePath = box === undefined ? deriveWorktreeRef(projectRoot, id).worktreePath : box.worktreePath;
      if (deps.worktree.isGitRepo(projectRoot)) {
        if (branch !== undefined && worktreePath !== undefined) {
          await runStep(steps, stepWorktree, async () => {
            try {
              deps.worktree.removeWorktree(projectRoot, { branch, worktreePath });
            } catch (err) {
              steps.log(`Aviso: no se pudo eliminar el worktree de la rama "${branch}" (${err instanceof Error ? err.message : String(err)}).`);
            }
          });
        } else {
          steps.markSkipped(stepWorktree);
        }

        // Contrato: la eliminación de la rama asume que agentbox destroy ya liberó la
        // registración del worktree del box en el .git compartido (el worktree vive
        // dentro del contenedor, en /home/vscode/.agentbox-worktrees/<name>). Si esa
        // registración persiste, deleteBranchDetaching desacopla la rama de ese
        // worktree registrado (incluido el de un contenedor ya ausente) antes de
        // borrarla. Solo una rama que sigue sin poder borrarse tras el desacople hace
        // fallar rm. No se elimina el worktree del box desde el host: su ruta es
        // específica del proveedor y vive dentro del contenedor.
        // Principios 1+2+3: desacopla la rama de cualquier worktree registrado
        // (incluido el del contenedor ya ausente, /home/vscode/.agentbox-worktrees/<name>),
        // elimina el worktree y borra la rama. Si tras el desacople la rama sigue sin
        // poder borrarse, lanza CliError: rm falla ("si se cumple todo, no fallar") y el
        // registro se conserva para reintentar. --dont-delete-branch nunca desacopla.
        if (!keepBranch && branch !== undefined) {
          const detachResult = await runStep(steps, stepBranch, () =>
            Promise.resolve(deps.worktree.deleteBranchDetaching(projectRoot, branch)),
          );
          if (detachResult?.leftoverAdminDir) {
            const { adminDir, worktreePath: leftoverPath } = detachResult.leftoverAdminDir;
            steps.log(
              `Aviso: la rama "${branch}" se eliminó, pero quedó metadata del worktree "${leftoverPath}" en "${adminDir}" ` +
                `(pertenece a otro usuario y sander no pudo borrarla). Para limpiarla: sudo rm -rf "${adminDir}".`,
            );
          }
        } else {
          steps.markSkipped(stepBranch);
        }
      } else {
        // En un directorio sin repo la rama y el worktree no pueden existir: la
        // comprobación de repo ES la verificación. Se avisa y se continúa con el
        // contenedor y el registro.
        steps.log(`Aviso: el proyecto "${projectRoot}" no es un repositorio git; no se pudo verificar la rama ni el worktree del sandbox "${id}".`);
        steps.markSkipped(stepWorktree);
        steps.markSkipped(stepBranch);
      }
    } else {
      steps.markSkipped(stepWorktree);
      steps.markSkipped(stepBranch);
    }
  } finally {
    steps.finish();
  }

  removeBox(registry, id);
  saveRegistry(deps.configDir, registry);

  deps.stdout.write(`Removed sandbox "${id}".\n`);
  return 0;
}

// Privado, NO exportado; se prueba a través del seam del comando con FakeProvider.
// Encapsula la decisión verifica → limpia → re-verifica → falla en una sola
// llamada: omite el borrado cuando el contenedor ya no está, y solo falla cuando
// el contenedor sigue presente tras un borrado fallido (o no se puede re-verificar).
async function removeContainerIfPresent(provider: Provider, id: string): Promise<void> {
  const containerName = containerNameForSandbox(id); // debe coincidir con el mapeo interno de provider.remove() (agentbox boxName())
  let present: boolean | null = null; // null = no se puede verificar
  try {
    present = (await provider.list()).includes(containerName);
  } catch {
    present = null; // proveedor no disponible: aun así se intenta borrar abajo
  }
  if (present === false) return; // ya no está — nada que limpiar (la corrección de idempotencia)

  try {
    await provider.remove(id);
  } catch (err) {
    let stillThere = true;
    try {
      stillThere = (await provider.list()).includes(containerName);
    } catch {
      stillThere = true;
    }
    if (stillThere) {
      throw new CliError(`no se pudo eliminar el contenedor del sandbox "${id}" (${err instanceof Error ? err.message : String(err)}); verifica su estado e inténtalo de nuevo`);
    }
    // remove() falló pero el contenedor ya no está — el estado final se alcanzó, se tolera.
  }
}

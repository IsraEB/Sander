import * as fs from 'node:fs';
import * as path from 'node:path';
import { CliError } from '../cli/errors';
import { fixGitAccess, resolveGitDir } from '../provider/gitaccess';
import { createRunner, run } from '../process/run';
import type { CommandRunner, RunResult } from '../process/run';

export interface WorktreeRef {
  branch: string;
  worktreePath: string;
}

export interface DeleteBranchDetachingResult {
  leftoverAdminDir?: { adminDir: string; worktreePath: string };
}

export interface Worktree {
  createWorktreeBranch(projectRoot: string, id: string): WorktreeRef | null;
  removeWorktree(projectRoot: string, ref: WorktreeRef): void;
  deleteBranch(projectRoot: string, branch: string): void;
  /**
   * Delete a branch, detaching it from ANY linked worktree that still registers
   * it (including a worktree whose directory lives inside an already-deleted
   * container and is invisible on the host). Tolerates a missing branch (like
   * deleteBranch). Throws CliError when, after detaching every matching linked
   * worktree, the branch still cannot be deleted. Never runs `git worktree
   * prune`. Never touches the main worktree or a locked worktree. rm-only: NOT
   * used by deleteStaleBranches, which deliberately relies on deleteBranch
   * FAILING for worktree-registered branches.
   *
   * Before removing a stale worktree's admin metadata it repairs the metadata
   * directory's permissions (`chmod -R a+rwX` on the admin dir plus a
   * non-recursive chmod on the worktrees parent) so a mode-restricted but
   * owned-by-us metadata dir can be removed. When the metadata is owned by
   * another user (foreign residue) and cannot be repaired, the branch is
   * deleted via `git update-ref -d` as a guarded last resort and the leftover
   * metadata path is returned in `leftoverAdminDir` so the caller can surface
   * it. The guards are enforced by construction: the entry is never the main
   * worktree, it is never locked, its path is absent on the host, and the
   * container is already gone (runRm ordering).
   */
  deleteBranchDetaching(projectRoot: string, branch: string): DeleteBranchDetachingResult;
  deleteStaleBranches(projectRoot: string): void;
  isGitRepo(projectRoot: string): boolean;
}

function hasDotGit(projectRoot: string): boolean {
  const dotGit = path.join(projectRoot, '.git');
  try {
    const st = fs.statSync(dotGit);
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

function worktreeDirName(id: string): string {
  // The id is a valid git branch name, so "/" is the only path separator it
  // can contain. Flatten it to keep the worktree in a single directory
  // (e.g. "feature/new" -> "feature-new") instead of nesting folders.
  return id.replaceAll('/', '-');
}

export function deriveWorktreeRef(projectRoot: string, id: string): WorktreeRef {
  const branch = id;
  const worktreePath = path.join(path.dirname(projectRoot), `${path.basename(projectRoot)}-sander-${worktreeDirName(id)}`);
  return { branch, worktreePath };
}

/**
 * Parse `git worktree list --porcelain` output. The main worktree is always the
 * first record (documented in git-worktree(1)); each record lists the `worktree`
 * path first and `branch <full-ref>` when the worktree has a branch checked out
 * (present even for prunable worktrees). The `locked` line is captured so a
 * locked matching worktree can be refused before any metadata touch. All other
 * lines (HEAD, detached, bare, prunable) are ignored.
 */
export function parseWorktreeListPorcelain(stdout: string): Array<{ path: string; branch: string | null; locked: boolean }> {
  const entries: Array<{ path: string; branch: string | null; locked: boolean }> = [];
  for (const record of stdout.split('\n\n')) {
    const lines = record.split('\n').map((line) => line.trim());
    const worktreeLine = lines.find((line) => line.startsWith('worktree '));
    if (!worktreeLine) continue;
    const branchLine = lines.find((line) => line.startsWith('branch '));
    entries.push({
      path: worktreeLine.slice('worktree '.length),
      branch: branchLine ? branchLine.slice('branch '.length) : null,
      locked: lines.includes('locked'),
    });
  }
  return entries;
}

type StaleMetadataOutcome =
  | { status: 'removed' }
  | { status: 'unfixable'; adminDir: string; detail: string }
  | { status: 'blocked'; adminDir: string | null; detail: string };

interface RepairOutcome {
  ok: boolean;
  unfixable: boolean;
  detail: string;
}

/**
 * Make one stale worktree admin dir removable: `chmod -R a+rwX` on the admin
 * dir (reusing the gitaccess foreign-residue classification) and a
 * non-recursive `chmod a+rwX` on the worktrees parent so the parent can unlink
 * the admin dir. The parent chmod is deliberately non-recursive: it must not
 * touch the admin dirs of other worktrees.
 */
function repairAdminDirAccess(adminDir: string, adminRoot: string, runner: CommandRunner): RepairOutcome {
  const recursive = fixGitAccess(adminDir, runner);
  if (!recursive.ok) {
    return { ok: false, unfixable: recursive.foreignResidue, detail: recursive.detail };
  }
  const parent = runner(['a+rwX', adminRoot]);
  const parentDetail = (parent.stderr || parent.stdout).trim();
  if (parent.exitCode === 0) {
    return { ok: true, unfixable: false, detail: '' };
  }
  if (/operation not permitted|permission denied/i.test(parentDetail)) {
    return { ok: false, unfixable: true, detail: parentDetail };
  }
  return { ok: false, unfixable: false, detail: parentDetail };
}

function isGitdirAccessError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EACCES' || code === 'EPERM' || code === 'ENOENT';
}

/**
 * git names a worktree's admin dir after the worktree's basename; collisions
 * get a numeric suffix (empirically "wt-demo" -> "wt-demo1", "wt-demo2", ...).
 * A basename match therefore identifies the admin dir of `worktreePath` even
 * when the `gitdir` file cannot be read to verify it by content.
 */
function adminDirNameMatchesWorktree(adminDir: string, worktreePath: string): boolean {
  const worktreeBase = path.basename(worktreePath);
  const adminName = path.basename(adminDir);
  if (adminName === worktreeBase) return true;
  if (!adminName.startsWith(worktreeBase)) return false;
  return /^\d+$/.test(adminName.slice(worktreeBase.length));
}

function removeAdminDir(adminDir: string): StaleMetadataOutcome {
  try {
    fs.rmSync(adminDir, { recursive: true, force: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/EACCES|EPERM|operation not permitted|permission denied/i.test(message)) {
      return { status: 'unfixable', adminDir, detail: message };
    }
    return { status: 'blocked', adminDir, detail: message };
  }
  return { status: 'removed' };
}

function removeRepairedAdminDir(adminDir: string, adminRoot: string, chmodRunner: CommandRunner): StaleMetadataOutcome {
  const repair = repairAdminDirAccess(adminDir, adminRoot, chmodRunner);
  if (!repair.ok) {
    if (repair.unfixable) {
      return { status: 'unfixable', adminDir, detail: repair.detail };
    }
    return { status: 'blocked', adminDir, detail: repair.detail };
  }
  return removeAdminDir(adminDir);
}

/**
 * Locate, permission-repair, and remove one stale worktree admin dir. Never
 * touches a worktree other than the one matching `path.resolve(worktreePath,
 * '.git')`; never runs `git worktree prune`; never throws raw Node errors —
 * every fs call is caught and mapped to a controlled outcome. Repair happens
 * before removal. When the `gitdir` file cannot be read (foreign 0o700 dir,
 * owned-but-unreadable dir, or the file git already deleted during a failed
 * `worktree remove`), the scan falls back to a NAME match — git names the
 * admin dir after the worktree basename — and repairs the candidate before
 * re-reading to verify the content; an unfixable (foreign) candidate carries
 * the real admin dir path so the caller can fall back to `git update-ref -d`
 * and surface the exact leftover.
 */
function removeStaleWorktreeMetadata(projectRoot: string, worktreePath: string, chmodRunner: CommandRunner): StaleMetadataOutcome {
  let gitDir: string | null;
  try {
    gitDir = resolveGitDir(projectRoot);
  } catch {
    gitDir = null;
  }
  if (gitDir === null) {
    return { status: 'blocked', adminDir: null, detail: `no se pudo eliminar el registro del worktree "${worktreePath}"` };
  }
  const adminRoot = path.join(gitDir, 'worktrees');
  let names: string[];
  try {
    names = fs.readdirSync(adminRoot);
  } catch {
    return { status: 'blocked', adminDir: null, detail: `no se pudo eliminar el registro del worktree "${worktreePath}"` };
  }
  const target = path.resolve(worktreePath, '.git');
  for (const name of names) {
    const adminDir = path.join(adminRoot, name);
    let content: string | null = null;
    let readError: unknown = null;
    try {
      content = fs.readFileSync(path.join(adminDir, 'gitdir'), 'utf8').trim();
    } catch (err) {
      readError = err;
    }

    if (content !== null) {
      const registered = path.isAbsolute(content) ? path.resolve(content) : path.resolve(adminDir, content);
      if (path.resolve(registered) !== target) continue;
      return removeRepairedAdminDir(adminDir, adminRoot, chmodRunner);
    }

    // Unreadable or missing `gitdir`: only a name match makes this a candidate.
    if (!isGitdirAccessError(readError) || !adminDirNameMatchesWorktree(adminDir, worktreePath)) continue;

    // Repair first (recursive chmod + parent chmod), then re-read to confirm the
    // registration really is ours before removing anything.
    const repair = repairAdminDirAccess(adminDir, adminRoot, chmodRunner);
    if (!repair.ok) {
      if (repair.unfixable) {
        return { status: 'unfixable', adminDir, detail: repair.detail };
      }
      return { status: 'blocked', adminDir, detail: repair.detail };
    }
    let verified: string;
    try {
      verified = fs.readFileSync(path.join(adminDir, 'gitdir'), 'utf8').trim();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'blocked',
        adminDir,
        detail: `no se pudo verificar el registro del worktree "${worktreePath}" en "${adminDir}": ${message}`,
      };
    }
    const registered = path.isAbsolute(verified) ? path.resolve(verified) : path.resolve(adminDir, verified);
    if (path.resolve(registered) !== target) continue;
    return removeAdminDir(adminDir);
  }
  return { status: 'blocked', adminDir: null, detail: `no se pudo eliminar el registro del worktree "${worktreePath}"` };
}

function blockedCliError(branch: string, outcome: { adminDir: string | null; detail: string }): CliError {
  if (outcome.adminDir) {
    return new CliError(
      `no se pudo eliminar la rama "${branch}": ${outcome.detail} (registro del worktree en "${outcome.adminDir}"). ` +
        `Para limpiarlo: sudo rm -rf "${outcome.adminDir}"`,
    );
  }
  return new CliError(`no se pudo eliminar la rama "${branch}": ${outcome.detail}`);
}

function detail(result: RunResult): string {
  return (result.stderr || result.stdout).trim();
}

export class GitWorktree implements Worktree {
  private readonly runner: CommandRunner;
  private readonly chmodRunner: CommandRunner;

  constructor(opts: { runner?: CommandRunner; chmodRunner?: CommandRunner } = {}) {
    this.runner = opts.runner ?? ((args, opts) => run('git', args, opts));
    this.chmodRunner = opts.chmodRunner ?? createRunner('chmod');
  }

  isGitRepo(projectRoot: string): boolean {
    return hasDotGit(projectRoot);
  }

  createWorktreeBranch(projectRoot: string, id: string): WorktreeRef | null {
    if (!hasDotGit(projectRoot)) {
      return null;
    }
    const ref = deriveWorktreeRef(projectRoot, id);
    const reused = this.runner(['-C', projectRoot, 'worktree', 'add', '--force', ref.worktreePath, ref.branch]);
    if (reused.exitCode === 0) {
      return ref;
    }
    const reusedDetail = detail(reused);
    if (/invalid reference|not a valid branch|unknown branch|no such branch|did not match/i.test(reusedDetail)) {
      // The branch does not exist yet: create it together with the worktree.
      const created = this.runner(['-C', projectRoot, 'worktree', 'add', '-b', ref.branch, ref.worktreePath]);
      if (created.exitCode !== 0) {
        throw new CliError(`no se pudo crear el worktree de la rama "${ref.branch}": ${detail(created)}`);
      }
      return ref;
    }
    throw new CliError(`no se pudo crear el worktree de la rama "${ref.branch}": ${reusedDetail}`);
  }

  removeWorktree(projectRoot: string, ref: WorktreeRef): void {
    const first = this.runner(['-C', projectRoot, 'worktree', 'remove', ref.worktreePath]);
    if (first.exitCode === 0) {
      return;
    }
    if (/not a valid worktree|is not a worktree|is not a working tree|no such|not found/i.test(detail(first))) {
      return;
    }
    const forced = this.runner(['-C', projectRoot, 'worktree', 'remove', '--force', ref.worktreePath]);
    if (forced.exitCode === 0) {
      return;
    }
    throw new CliError(`no se pudo eliminar el worktree de la rama "${ref.branch}": ${detail(forced)}`);
  }

  deleteBranch(projectRoot: string, branch: string): void {
    const result = this.runner(['-C', projectRoot, 'branch', '-D', branch]);
    if (result.exitCode === 0) {
      return;
    }
    if (/not found|no such branch|did not match/i.test(detail(result))) {
      return;
    }
    throw new CliError(`no se pudo eliminar la rama "${branch}": ${detail(result)}`);
  }

  deleteBranchDetaching(projectRoot: string, branch: string): DeleteBranchDetachingResult {
    try {
      this.deleteBranch(projectRoot, branch);
      return {};
    } catch (err) {
      if (!(err instanceof CliError) || !/used by worktree at|checked out at/i.test(err.message)) {
        throw err;
      }
    }

    const list = this.runner(['-C', projectRoot, 'worktree', 'list', '--porcelain']);
    if (list.exitCode !== 0) {
      throw new CliError(`no se pudo eliminar la rama "${branch}": ${detail(list)}`);
    }
    const entries = parseWorktreeListPorcelain(list.stdout);
    const mainPath = entries[0]?.path;
    for (const entry of entries) {
      if (entry.branch !== `refs/heads/${branch}`) continue;
      if (entry.path === mainPath) continue; // la rama vive en el worktree principal: no se desacopla
      if (entry.locked) {
        throw new CliError(`no se pudo eliminar la rama "${branch}": el worktree "${entry.path}" está bloqueado`);
      }
      const removed = this.runner(['-C', projectRoot, 'worktree', 'remove', '--force', entry.path]);
      if (removed.exitCode === 0) continue;
      const removedDetail = detail(removed);
      if (/locked/i.test(removedDetail) || fs.existsSync(entry.path)) {
        throw new CliError(`no se pudo eliminar la rama "${branch}": ${removedDetail}`);
      }
      // Ruta ausente en el host (el contenedor ya no está): git solo deja la
      // registración; se repara el acceso a su metadata admin y se elimina de
      // forma dirigida, nunca `git worktree prune`.
      const outcome = removeStaleWorktreeMetadata(projectRoot, entry.path, this.chmodRunner);
      if (outcome.status === 'removed') continue;
      if (outcome.status === 'blocked') {
        throw blockedCliError(branch, outcome);
      }
      // Metadata admin de otro usuario (residuo extranjero) que sander no puede
      // reparar: último recurso — borrar la rama directamente. Los guards ya
      // están verificados por construcción: (1) el entry no es el worktree
      // principal (se omitió arriba) y git permite una rama en a lo sumo un
      // worktree, así que la rama no es el checkout principal; (2) el worktree
      // no está bloqueado (el caso locked lanzó); (3) entry.path está ausente
      // en el host (por eso estamos aquí); (4) el contenedor ya no está (runRm
      // elimina el contenedor antes de cualquier paso git).
      const updated = this.runner(['-C', projectRoot, 'update-ref', '-d', `refs/heads/${branch}`]);
      if (updated.exitCode !== 0) {
        throw blockedCliError(branch, { adminDir: outcome.adminDir, detail: detail(updated) });
      }
      return { leftoverAdminDir: { adminDir: outcome.adminDir, worktreePath: entry.path } };
    }

    this.deleteBranch(projectRoot, branch);
    return {};
  }

  deleteStaleBranches(projectRoot: string): void {
    // NOTE: do NOT run `git worktree prune` here. agentbox container worktrees
    // live at /home/vscode/.agentbox-worktrees/<name> INSIDE the container, so
    // git on the host considers them prunable and `prune` reaps their admin
    // metadata (.git/worktrees/<name>/), breaking git inside the box and
    // allowing `git branch -D` to delete branches live boxes still have
    // checked out. Without prune, `git branch -D` fails for any branch still
    // registered in a worktree (even a prunable one), so the sweep only ever
    // deletes branches that are genuinely not checked out anywhere. The legacy
    // `sander/*` namespace (pre-fix creates) is reaped alongside `agentbox/*`.
    const list = this.runner([
      '-C', projectRoot,
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads/agentbox',
      'refs/heads/sander',
    ]);
    if (list.exitCode !== 0) return; // not a repo / no matching refs
    const branches = list.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (branches.length === 0) return;
    // One batched delete for all candidates: git deletes the deletable ones and
    // reports non-zero for any branch still registered in a worktree (even a
    // prunable one) — same "some were skipped" tolerance as the old per-branch
    // sweep, which is exactly what keeps worktree-registered branches alive.
    this.runner(['-C', projectRoot, 'branch', '-D', ...branches]);
  }
}

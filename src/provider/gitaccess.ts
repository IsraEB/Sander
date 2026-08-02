import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRunner } from '../process/run';
import type { CommandRunner } from '../process/run';

export const BOX_USER_UID = 1000;

function hostUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : -1;
}

function hostGid(): number {
  return typeof process.getgid === 'function' ? process.getgid() : -1;
}

export function resolveBoxUid(env: NodeJS.ProcessEnv = process.env): number {
  const override = env.AGENTBOX_BOX_UID;
  if (override !== undefined && override.trim() !== '') {
    const parsed = Number.parseInt(override, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  const host = hostUid();
  return host > 0 ? host : BOX_USER_UID;
}

export function resolveBoxGid(env: NodeJS.ProcessEnv = process.env): number {
  const override = env.AGENTBOX_BOX_GID;
  if (override !== undefined && override.trim() !== '') {
    const parsed = Number.parseInt(override, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  const host = hostGid();
  return host > 0 ? host : BOX_USER_UID;
}

export interface GitAccessIssue {
  dir: string;
  mode: string;
  ownerUid: number;
  relative: string;
}

export interface GitAccessCheck {
  ok: boolean;
  issues: GitAccessIssue[];
  boxUid: number;
  hostUid: number;
  gitDir: string | null;
}

export function effectiveWriteExec(boxUid: number, stat: { uid: number; gid: number; mode: number }): boolean {
  const m = stat.mode;
  if (stat.uid === boxUid) {
    return (m & 0o300) === 0o300;
  }
  if (stat.gid === boxUid) {
    return (m & 0o030) === 0o030;
  }
  return (m & 0o003) === 0o003;
}

export function resolveGitDir(projectRoot: string): string | null {
  const dotGit = path.join(projectRoot, '.git');
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) {
    return dotGit;
  }
  if (st.isFile()) {
    const content = fs.readFileSync(dotGit, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/.exec(content);
    if (match && match[1]) {
      return path.resolve(projectRoot, match[1]);
    }
  }
  return null;
}

export function checkGitAccess(projectRoot: string, boxUid = resolveBoxUid()): GitAccessCheck {
  const gitDir = resolveGitDir(projectRoot);
  const issues: GitAccessIssue[] = [];
  if (gitDir === null) {
    return { ok: true, issues, boxUid, hostUid: hostUid(), gitDir: null };
  }

  const dirs = ['.', 'refs', 'refs/heads', 'objects', 'logs', 'worktrees'];
  for (const rel of dirs) {
    const abs = rel === '.' ? gitDir : path.join(gitDir, rel);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isDirectory()) {
      continue;
    }
    if (!effectiveWriteExec(boxUid, st)) {
      issues.push({
        dir: abs,
        mode: (st.mode & 0o777).toString(8),
        ownerUid: st.uid,
        relative: rel === '.' ? '.git' : `.git/${rel}`,
      });
    }
  }

  return { ok: issues.length === 0, issues, boxUid, hostUid: hostUid(), gitDir };
}

export interface FixGitAccessResult {
  ok: boolean;
  foreignResidue: boolean;
  detail: string;
}

export function fixGitAccess(gitDir: string, runner: CommandRunner = createRunner('chmod')): FixGitAccessResult {
  const result = runner(['-R', 'a+rwX', gitDir]);
  const detail = (result.stderr || result.stdout).trim();
  if (result.exitCode === 0) {
    return { ok: true, foreignResidue: false, detail: '' };
  }
  if (/operation not permitted|permission denied/i.test(detail)) {
    return { ok: false, foreignResidue: true, detail };
  }
  return { ok: false, foreignResidue: false, detail };
}

/**
 * Returns true when every reported git issue is owned by a uid other than the
 * box uid — i.e. foreign residue left by a previous box user (typically uid
 * 1000) that sander cannot chmod from the host but the post-create in-box
 * `chown --from=<oldUid>` sweep re-owns. An issue owned by the box uid itself
 * means a genuinely unwritable directory that sander must surface.
 */
export function issuesAreForeignResidue(issues: GitAccessIssue[], boxUid: number): boolean {
  return issues.length > 0 && issues.every((issue) => issue.ownerUid !== boxUid);
}

/**
 * The refs directories a host-side `git branch` creates for a slash-name branch
 * after the pre-branch check ran, e.g. .git/refs/heads/feature for feature/x.
 * They are created host-owned at 0755 and invisible to checkGitAccess, so they
 * are the first thing to fix when the box user cannot write them.
 */
function refsComponentsForBranch(gitDir: string, branchName: string): string[] {
  const parts = branchName.split('/');
  const dirs: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    dirs.push(path.join(gitDir, 'refs', 'heads', ...parts.slice(0, i)));
  }
  return dirs;
}

function refsComponentsWritable(gitDir: string, branchName: string, boxUid: number): boolean {
  for (const dir of refsComponentsForBranch(gitDir, branchName)) {
    let st: fs.Stats;
    try {
      st = fs.statSync(dir);
    } catch {
      continue; // git branch did not create it; the box can, once refs/heads is writable
    }
    if (!st.isDirectory() || !effectiveWriteExec(boxUid, st)) {
      return false;
    }
  }
  return true;
}

function fixRefsComponents(gitDir: string, branchName: string, runner: CommandRunner): void {
  for (const dir of refsComponentsForBranch(gitDir, branchName)) {
    try {
      if (fs.statSync(dir).isDirectory()) {
        runner(['a+rwX', dir]);
      }
    } catch {
      // component does not exist — nothing to fix
    }
  }
}

/**
 * Ensures the box user can write .git before agentbox's in-container `git
 * worktree add` runs. Stat-only check first; chmod only when the check fails,
 * targeted at the refs component `git branch` just created, with the full
 * recursive chmod only as a fallback. No-op when projectRoot is not a git
 * repository. Returns true when the fix succeeded or the failure is foreign
 * uid-1000 residue that the post-create in-box chown will re-own.
 */
export function ensureBoxGitAccess(projectRoot: string, branchName?: string, runner?: CommandRunner): boolean {
  const gitDir = resolveGitDir(projectRoot);
  if (gitDir === null) return true; // not a git repository — nothing to fix

  // The box user is still the image default uid during create: the host-side
  // alignment to the host uid only happens after `agentbox create`.
  const boxUid = BOX_USER_UID;
  const chmodRunner = runner ?? createRunner('chmod');
  const accessible = (): boolean =>
    checkGitAccess(projectRoot, boxUid).ok &&
    (branchName === undefined || refsComponentsWritable(gitDir, branchName, boxUid));
  if (accessible()) {
    return true;
  }

  if (branchName !== undefined) {
    fixRefsComponents(gitDir, branchName, chmodRunner);
    if (accessible()) {
      return true;
    }
  }

  const fix = fixGitAccess(gitDir, chmodRunner);
  return fix.ok || fix.foreignResidue;
}

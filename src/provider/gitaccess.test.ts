import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BOX_USER_UID, checkGitAccess, effectiveWriteExec, ensureBoxGitAccess, fixGitAccess, issuesAreForeignResidue, resolveBoxGid, resolveBoxUid } from './gitaccess';
import type { CommandRunner, RunResult } from '../process/run';

function result(overrides: Partial<RunResult> = {}): RunResult {
  return { exitCode: 0, stdout: '', stderr: '', ...overrides };
}

function tmpRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sander-gitaccess-'));
  const git = path.join(root, '.git');
  fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
  fs.mkdirSync(path.join(git, 'objects'), { recursive: true });
  fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
  return root;
}

function owner(git: string): number {
  return fs.statSync(git).uid;
}

describe('gitaccess', () => {
  it('defaults the box uid and gid to the host user and honors env overrides', () => {
    expect(BOX_USER_UID).toBe(1000);
    const hostUid = typeof process.getuid === 'function' ? process.getuid() : -1;
    const hostGid = typeof process.getgid === 'function' ? process.getgid() : -1;
    const defaultUid = hostUid > 0 ? hostUid : BOX_USER_UID;
    const defaultGid = hostGid > 0 ? hostGid : BOX_USER_UID;
    expect(resolveBoxUid({})).toBe(defaultUid);
    expect(resolveBoxGid({})).toBe(defaultGid);
    expect(resolveBoxUid({ AGENTBOX_BOX_UID: '4242' })).toBe(4242);
    expect(resolveBoxGid({ AGENTBOX_BOX_GID: '4242' })).toBe(4242);
    expect(resolveBoxUid({ AGENTBOX_BOX_UID: '' })).toBe(defaultUid);
    expect(resolveBoxUid({ AGENTBOX_BOX_UID: 'not-a-number' })).toBe(defaultUid);
  });

  it('treats a directory as writable when the box uid owns it with write+execute', () => {
    expect(effectiveWriteExec(1000, { uid: 1000, gid: 1000, mode: 0o700 })).toBe(true);
    expect(effectiveWriteExec(1000, { uid: 1000, gid: 1000, mode: 0o500 })).toBe(false);
  });

  it('treats a directory as writable via group bits', () => {
    expect(effectiveWriteExec(1000, { uid: 1001, gid: 1000, mode: 0o070 })).toBe(true);
    expect(effectiveWriteExec(1000, { uid: 1001, gid: 1000, mode: 0o050 })).toBe(false);
  });

  it('treats a directory as writable via other bits', () => {
    expect(effectiveWriteExec(1000, { uid: 1001, gid: 1001, mode: 0o007 })).toBe(true);
    expect(effectiveWriteExec(1000, { uid: 1001, gid: 1001, mode: 0o005 })).toBe(false);
  });

  it('reports ok when there is no .git directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sander-gitaccess-none-'));
    const check = checkGitAccess(root, 1000);
    expect(check.ok).toBe(true);
    expect(check.gitDir).toBeNull();
  });

  it('reports issues when the box uid cannot write .git subdirectories', () => {
    const root = tmpRepo();
    const git = path.join(root, '.git');
    fs.chmodSync(path.join(git, 'refs', 'heads'), 0o755);
    const hostUid = owner(git);
    const boxUid = hostUid === 1000 ? 2000 : 1000;
    const check = checkGitAccess(root, boxUid);
    expect(check.ok).toBe(false);
    expect(check.issues.map((issue) => issue.relative)).toContain('.git/refs/heads');
  });

  it('reports ok when .git is world-writable', () => {
    const root = tmpRepo();
    const git = path.join(root, '.git');
    fs.chmodSync(git, 0o777);
    fs.chmodSync(path.join(git, 'refs'), 0o777);
    fs.chmodSync(path.join(git, 'refs', 'heads'), 0o777);
    fs.chmodSync(path.join(git, 'objects'), 0o777);
    const hostUid = owner(git);
    const boxUid = hostUid === 1000 ? 2000 : 1000;
    const check = checkGitAccess(root, boxUid);
    expect(check.ok).toBe(true);
  });

  it('fixes .git permissions so the box uid can write', () => {
    const root = tmpRepo();
    const git = path.join(root, '.git');
    fs.chmodSync(git, 0o755);
    fs.chmodSync(path.join(git, 'refs'), 0o755);
    fs.chmodSync(path.join(git, 'refs', 'heads'), 0o755);
    const hostUid = owner(git);
    const boxUid = hostUid === 1000 ? 2000 : 1000;

    expect(checkGitAccess(root, boxUid).ok).toBe(false);
    expect(fixGitAccess(git).ok).toBe(true);
    expect(checkGitAccess(root, boxUid).ok).toBe(true);
  });

  it('follows a gitdir: pointer for worktree repositories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sander-gitaccess-link-'));
    const main = path.join(root, 'main');
    const mainGit = path.join(main, '.git');
    fs.mkdirSync(path.join(mainGit, 'refs', 'heads'), { recursive: true });
    const wt = path.join(root, 'worktree');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${mainGit}\n`);
    const check = checkGitAccess(wt, 1000);
    expect(check.gitDir).toBe(mainGit);
  });

  it('ensureBoxGitAccess fixes a host-owned refs subdir and no-ops on non-repos', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'sander-gitaccess-norepo-'));
    expect(ensureBoxGitAccess(plain)).toBe(true);

    const root = tmpRepo();
    const sander = path.join(root, '.git', 'refs', 'heads', 'sander');
    fs.mkdirSync(sander, { recursive: true });
    fs.chmodSync(sander, 0o755);
    const hostUid = owner(path.join(root, '.git'));
    const boxUid = hostUid === 1000 ? 2000 : 1000;
    expect(checkGitAccess(root, boxUid).ok).toBe(false);
    expect(ensureBoxGitAccess(root)).toBe(true);
    expect(checkGitAccess(root, boxUid).ok).toBe(true);
  });

  it('fixGitAccess classifies chmod failures as ok, foreign residue, or blocking', () => {
    const root = tmpRepo();
    const git = path.join(root, '.git');
    expect(fixGitAccess(git)).toEqual({ ok: true, foreignResidue: false, detail: '' });

    const foreign: CommandRunner = () => result({ exitCode: 1, stderr: "chmod: changing permissions of '/tmp/x/.git': Operation not permitted" });
    expect(fixGitAccess(git, foreign)).toEqual({
      ok: false,
      foreignResidue: true,
      detail: "chmod: changing permissions of '/tmp/x/.git': Operation not permitted",
    });

    const blocked: CommandRunner = () => result({ exitCode: 1, stderr: 'chmod: cannot access /proc/x: No such file or directory' });
    expect(fixGitAccess(git, blocked)).toEqual({ ok: false, foreignResidue: false, detail: 'chmod: cannot access /proc/x: No such file or directory' });
  });

  it('ensureBoxGitAccess tolerates foreign-residue chmod failures and blocks others', () => {
    const root = tmpRepo();
    const foreign: CommandRunner = () => result({ exitCode: 1, stderr: "chmod: changing permissions of '/tmp/x/.git/objects': Permission denied" });
    expect(ensureBoxGitAccess(root, undefined, foreign)).toBe(true);

    const blocked: CommandRunner = () => result({ exitCode: 1, stderr: 'chmod: cannot access /proc/x: No such file or directory' });
    expect(ensureBoxGitAccess(root, undefined, blocked)).toBe(false);
  });

  it('slash-names: with an already-writable .git, fixes only the new refs component', () => {
    const root = tmpRepo();
    const git = path.join(root, '.git');
    // .git is already writable by the box user (e.g. a previous create fixed
    // it), so the pre-branch check passes and a full recursive chmod is waste.
    fs.chmodSync(git, 0o777);
    fs.chmodSync(path.join(git, 'refs'), 0o777);
    fs.chmodSync(path.join(git, 'refs', 'heads'), 0o777);
    fs.chmodSync(path.join(git, 'objects'), 0o777);
    // `git branch feature/x` leaves the new nested refs dir host-owned at 0755.
    fs.mkdirSync(path.join(git, 'refs', 'heads', 'feature'), { recursive: true });
    fs.chmodSync(path.join(git, 'refs', 'heads', 'feature'), 0o755);
    const hostUid = owner(git);
    const boxUid = hostUid === 1000 ? 2000 : 1000;
    expect(checkGitAccess(root, boxUid).ok).toBe(true); // pre-branch check sees no problem

    const chmodCalls: string[][] = [];
    const runner: CommandRunner = (args) => {
      chmodCalls.push(args);
      if (args[0] === 'a+rwX') {
        fs.chmodSync(args[1]!, 0o777); // mirror what the real chmod would do
      }
      return result();
    };
    expect(ensureBoxGitAccess(root, 'feature/x', runner)).toBe(true);

    // Only the newly created refs component was chmod'd — never the whole
    // .git. On uid-1000 hosts the box user already owns the component, so no
    // chmod is needed at all.
    if (hostUid === 1000) {
      expect(chmodCalls).toEqual([]);
    } else {
      expect(chmodCalls).toEqual([['a+rwX', path.join(git, 'refs', 'heads', 'feature')]]);
    }
    expect(effectiveWriteExec(boxUid, fs.statSync(path.join(git, 'refs', 'heads', 'feature')))).toBe(true);
    expect(checkGitAccess(root, boxUid).ok).toBe(true);
  });

  it('classifies issues as foreign residue only when none are owned by the box uid', () => {
    const issue = (ownerUid: number) => ({ dir: '/x', mode: '755', ownerUid, relative: '.git/refs/heads' });
    expect(issuesAreForeignResidue([issue(1000), issue(1000)], 1001)).toBe(true);
    expect(issuesAreForeignResidue([issue(1000), issue(1001)], 1001)).toBe(false);
    expect(issuesAreForeignResidue([issue(1001)], 1001)).toBe(false);
    expect(issuesAreForeignResidue([], 1001)).toBe(false);
  });
});

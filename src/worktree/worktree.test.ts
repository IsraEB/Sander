import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CliError } from '../cli/errors';
import { run } from '../process/run';
import { GitWorktree, deriveWorktreeRef, parseWorktreeListPorcelain } from './worktree';
import type { WorktreeRef } from './worktree';
import type { CommandRunner, RunResult } from '../process/run';

function result(overrides: Partial<RunResult> = {}): RunResult {
  return { exitCode: 0, stdout: '', stderr: '', ...overrides };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sander-worktree-test-'));
}

interface Runner {
  calls: string[][];
  next: RunResult[];
}

function makeRunner(): { git: GitWorktree; runner: Runner } {
  const calls: string[][] = [];
  const next: RunResult[] = [];
  const runnerFn: CommandRunner = (args) => {
    calls.push(args);
    return next.shift() ?? result();
  };
  return { git: new GitWorktree({ runner: runnerFn }), runner: { calls, next } };
}

function makeChmodRunner(chmodResult: RunResult): { chmodCalls: string[][]; chmodRunner: CommandRunner } {
  const chmodCalls: string[][] = [];
  const chmodRunner: CommandRunner = (args) => {
    chmodCalls.push(args);
    return chmodResult;
  };
  return { chmodCalls, chmodRunner };
}

describe('deriveWorktreeRef', () => {
  it('derives a sander branch and a sibling worktree path outside the main tree', () => {
    const ref = deriveWorktreeRef('/home/user/proj', 'demo');
    expect(ref.branch).toBe('demo');
    expect(ref.worktreePath).toBe('/home/user/proj-sander-demo');
  });

  it('flattens slashes in the id into a single worktree directory', () => {
    const ref = deriveWorktreeRef('/home/user/proj', 'feature/new');
    expect(ref.branch).toBe('feature/new');
    expect(ref.worktreePath).toBe('/home/user/proj-sander-feature-new');
    expect(path.basename(ref.worktreePath)).not.toContain('/');
  });
});

describe('parseWorktreeListPorcelain', () => {
  it('parses records, keeps main first, parses locked, and ignores detached/bare/prunable lines', () => {
    const stdout =
      [
        'worktree /main',
        'HEAD abc',
        'branch refs/heads/main',
        '',
        'worktree /detached',
        'HEAD def',
        'detached',
        '',
        'worktree /bare',
        'bare',
        '',
        'worktree /locked',
        'HEAD ghi',
        'branch refs/heads/other',
        'locked',
        '',
        'worktree /prunable',
        'HEAD jkl',
        'branch refs/heads/demo',
        'prunable gitdir file points to non-existent location',
        '',
      ].join('\n') + '\n';

    expect(parseWorktreeListPorcelain(stdout)).toEqual([
      { path: '/main', branch: 'refs/heads/main', locked: false },
      { path: '/detached', branch: null, locked: false },
      { path: '/bare', branch: null, locked: false },
      { path: '/locked', branch: 'refs/heads/other', locked: true },
      { path: '/prunable', branch: 'refs/heads/demo', locked: false },
    ]);
  });
});

describe('GitWorktree', () => {
  it('creates a worktree branch and returns the ref', () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    const { git, runner } = makeRunner();
    const ref = deriveWorktreeRef(root, 'demo');

    const created = git.createWorktreeBranch(root, 'demo');

    expect(created).toEqual(ref);
    expect(runner.calls).toEqual([['-C', root, 'worktree', 'add', '--force', ref.worktreePath, 'demo']]);
  });

  it('returns null when the project is not a git repository', () => {
    const root = tmpDir();
    const { git, runner } = makeRunner();
    expect(git.createWorktreeBranch(root, 'demo')).toBeNull();
    expect(runner.calls).toEqual([]);
  });

  it('isGitRepo is true when .git exists', () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    const git = new GitWorktree();
    expect(git.isGitRepo(root)).toBe(true);
  });

  it('isGitRepo is false when .git is missing', () => {
    const root = tmpDir();
    const git = new GitWorktree();
    expect(git.isGitRepo(root)).toBe(false);
  });

  it('throws a CliError when git worktree add fails', () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    const { git, runner } = makeRunner();
    runner.next.push(result({ exitCode: 1, stderr: 'already exists' }));

    expect(() => git.createWorktreeBranch(root, 'demo')).toThrow(new CliError('no se pudo crear el worktree de la rama "demo": already exists'));
  });

  it('falls back to -b when the branch does not exist', () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    const { git, runner } = makeRunner();
    const ref = deriveWorktreeRef(root, 'demo');
    runner.next.push(result({ exitCode: 1, stderr: 'fatal: invalid reference: demo' }));
    runner.next.push(result());

    const created = git.createWorktreeBranch(root, 'demo');

    expect(created).toEqual(ref);
    expect(runner.calls).toEqual([
      ['-C', root, 'worktree', 'add', '--force', ref.worktreePath, 'demo'],
      ['-C', root, 'worktree', 'add', '-b', 'demo', ref.worktreePath],
    ]);
  });

  it('does not fall back on unrelated add failures', () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    const { git, runner } = makeRunner();
    const ref = deriveWorktreeRef(root, 'demo');
    runner.next.push(result({ exitCode: 1, stderr: 'permission denied' }));

    expect(() => git.createWorktreeBranch(root, 'demo')).toThrow(new CliError('no se pudo crear el worktree de la rama "demo": permission denied'));
    expect(runner.calls).toEqual([['-C', root, 'worktree', 'add', '--force', ref.worktreePath, 'demo']]);
  });

  it('removes a worktree', () => {
    const root = tmpDir();
    const ref: WorktreeRef = { branch: 'demo', worktreePath: '/x' };
    const { git, runner } = makeRunner();

    git.removeWorktree(root, ref);

    expect(runner.calls).toEqual([['-C', root, 'worktree', 'remove', '/x']]);
  });

  it('treats an already-removed worktree as success', async () => {
    const root = tmpDir();
    const ref: WorktreeRef = { branch: 'demo', worktreePath: '/x' };
    const { git, runner } = makeRunner();
    runner.next.push(result({ exitCode: 1, stderr: "fatal: '/x' is not a working tree" }));

    expect(() => git.removeWorktree(root, ref)).not.toThrow();
    runner.next.push(result({ exitCode: 1, stderr: 'not a valid worktree' }));
    expect(() => git.removeWorktree(root, ref)).not.toThrow();
  });

  it('retries with --force when the worktree is dirty', () => {
    const root = tmpDir();
    const ref: WorktreeRef = { branch: 'demo', worktreePath: '/x' };
    const { git, runner } = makeRunner();
    runner.next.push(result({ exitCode: 1, stderr: 'contains modified or untracked files' }));
    runner.next.push(result());

    git.removeWorktree(root, ref);

    expect(runner.calls).toEqual([
      ['-C', root, 'worktree', 'remove', '/x'],
      ['-C', root, 'worktree', 'remove', '--force', '/x'],
    ]);
  });

  it('throws a CliError when the forced removal also fails', () => {
    const root = tmpDir();
    const ref: WorktreeRef = { branch: 'demo', worktreePath: '/x' };
    const { git, runner } = makeRunner();
    runner.next.push(result({ exitCode: 1, stderr: 'contains modified or untracked files' }));
    runner.next.push(result({ exitCode: 1, stderr: 'boom' }));

    expect(() => git.removeWorktree(root, ref)).toThrow(new CliError('no se pudo eliminar el worktree de la rama "demo": boom'));
  });

  it('deletes a branch with -D', () => {
    const root = tmpDir();
    const { git, runner } = makeRunner();

    git.deleteBranch(root, 'demo');

    expect(runner.calls).toEqual([['-C', root, 'branch', '-D', 'demo']]);
  });

  it('treats a missing branch as success', () => {
    const root = tmpDir();
    const { git, runner } = makeRunner();
    runner.next.push(result({ exitCode: 1, stderr: 'fatal: branch not found' }));

    expect(() => git.deleteBranch(root, 'demo')).not.toThrow();
  });

  it('throws a CliError when branch deletion fails for another reason', () => {
    const root = tmpDir();
    const { git, runner } = makeRunner();
    runner.next.push(result({ exitCode: 1, stderr: 'permission denied' }));

    expect(() => git.deleteBranch(root, 'demo')).toThrow(new CliError('no se pudo eliminar la rama "demo": permission denied'));
  });

  it('deleteBranchDetaching returns after a successful first branch -D', () => {
    const root = tmpDir();
    const { git, runner } = makeRunner();

    git.deleteBranchDetaching(root, 'demo');

    expect(runner.calls).toEqual([['-C', root, 'branch', '-D', 'demo']]);
  });

  it('deleteBranchDetaching detaches every registered worktree and retries the deletion', () => {
    const root = tmpDir();
    const { git, runner } = makeRunner();
    const porcelain = [
      'worktree /main',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /x',
      'HEAD abc',
      'branch refs/heads/demo',
      '',
    ].join('\n');
    runner.next.push(result({ exitCode: 1, stderr: "error: cannot delete branch 'demo' used by worktree at '/x'" }));
    runner.next.push(result({ stdout: porcelain }));
    runner.next.push(result()); // worktree remove --force /x
    runner.next.push(result()); // retry branch -D

    git.deleteBranchDetaching(root, 'demo');

    expect(runner.calls).toEqual([
      ['-C', root, 'branch', '-D', 'demo'],
      ['-C', root, 'worktree', 'list', '--porcelain'],
      ['-C', root, 'worktree', 'remove', '--force', '/x'],
      ['-C', root, 'branch', '-D', 'demo'],
    ]);
  });

  it('deleteBranchDetaching never detaches the main worktree and throws when the branch stays stuck', () => {
    const root = tmpDir();
    const { git, runner } = makeRunner();
    const porcelain = [
      'worktree /main',
      'HEAD abc',
      'branch refs/heads/demo',
      '',
    ].join('\n');
    runner.next.push(result({ exitCode: 1, stderr: "error: cannot delete branch 'demo' used by worktree at '/main'" }));
    runner.next.push(result({ stdout: porcelain }));
    runner.next.push(result({ exitCode: 1, stderr: "error: cannot delete branch 'demo' used by worktree at '/main'" }));

    expect(() => git.deleteBranchDetaching(root, 'demo')).toThrow(
      new CliError("no se pudo eliminar la rama \"demo\": error: cannot delete branch 'demo' used by worktree at '/main'"),
    );
    expect(runner.calls).toEqual([
      ['-C', root, 'branch', '-D', 'demo'],
      ['-C', root, 'worktree', 'list', '--porcelain'],
      ['-C', root, 'branch', '-D', 'demo'],
    ]);
  });

  it('deleteBranchDetaching falls back to removing the stale admin metadata when the missing worktree cannot be removed', () => {
    const root = tmpDir();
    run('git', ['init', '-q', '-b', 'main', root]);
    run('git', ['-C', root, 'config', 'user.email', 't@t.t']);
    run('git', ['-C', root, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(root, 'f.txt'), 'hi');
    run('git', ['-C', root, 'add', 'f.txt']);
    run('git', ['-C', root, 'commit', '-qm', 'init']);
    run('git', ['-C', root, 'branch', 'demo', 'HEAD']);
    const wt = path.join(tmpDir(), 'wt-demo');
    run('git', ['-C', root, 'worktree', 'add', '-q', wt, 'demo']);
    fs.rmSync(wt, { recursive: true, force: true });

    const calls: string[][] = [];
    const runnerFn: CommandRunner = (args) => {
      calls.push(args);
      if (args.includes('remove') && args.includes('--force')) {
        return result({ exitCode: 128, stderr: 'fatal: refusing to remove worktree' });
      }
      return run('git', args);
    };
    const git = new GitWorktree({ runner: runnerFn });

    git.deleteBranchDetaching(root, 'demo');

    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/demo']).exitCode).not.toBe(0);
    expect(run('git', ['-C', root, 'worktree', 'list']).stdout).not.toContain('wt-demo');
    expect(fs.existsSync(path.join(root, '.git', 'worktrees', 'wt-demo'))).toBe(false);
    expect(calls.filter((args) => args.includes('remove') && args.includes('--force'))).toHaveLength(1);
  });

  it('deletes stale agentbox and sander branches without pruning worktrees', () => {
    const root = tmpDir();
    const { git, runner } = makeRunner();
    // One for-each-ref covering both namespaces, then a single batched delete.
    runner.next.push(result({ stdout: 'agentbox/new-2\nagentbox/new2\nsander/leaked\nsander/old\n' }));

    git.deleteStaleBranches(root);

    // No `git worktree prune`: pruning on the host would reap the admin
    // metadata of live agentbox container worktrees and un-guard branches
    // that are still checked out in them.
    expect(runner.calls).toEqual([
      ['-C', root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/agentbox', 'refs/heads/sander'],
      ['-C', root, 'branch', '-D', 'agentbox/new-2', 'agentbox/new2', 'sander/leaked', 'sander/old'],
    ]);
  });

  it('tolerates a non-zero batch delete as "some branches were skipped"', () => {
    const root = tmpDir();
    const { git, runner } = makeRunner();
    runner.next.push(result({ stdout: 'agentbox/new3\nsander/live\n' })); // for-each-ref both namespaces
    runner.next.push(result({ exitCode: 1, stderr: "error: cannot delete branch 'agentbox/new3' used by worktree at '/x'" }));

    expect(() => git.deleteStaleBranches(root)).not.toThrow();
    expect(runner.calls).toEqual([
      ['-C', root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/agentbox', 'refs/heads/sander'],
      ['-C', root, 'branch', '-D', 'agentbox/new3', 'sander/live'],
    ]);
  });

  it('does not run branch -D when listing refs finds nothing', () => {
    const root = tmpDir();
    const { git, runner } = makeRunner();
    runner.next.push(result({ stdout: '' }));

    git.deleteStaleBranches(root);

    expect(runner.calls).toEqual([
      ['-C', root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/agentbox', 'refs/heads/sander'],
    ]);
  });

  it('does nothing when listing refs fails', () => {
    const root = tmpDir();
    const { git, runner } = makeRunner();
    runner.next.push(result({ exitCode: 128, stderr: 'fatal: not a git repository' }));

    git.deleteStaleBranches(root);

    expect(runner.calls).toEqual([
      ['-C', root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/agentbox', 'refs/heads/sander'],
    ]);
  });

  it('real git: keeps branches registered in worktrees (even prunable ones) and deletes truly leaked agentbox and sander branches', () => {
    const root = tmpDir();
    run('git', ['init', '-q', '-b', 'main', root]);
    run('git', ['-C', root, 'config', 'user.email', 't@t.t']);
    run('git', ['-C', root, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(root, 'f.txt'), 'hi');
    run('git', ['-C', root, 'add', 'f.txt']);
    run('git', ['-C', root, 'commit', '-qm', 'init']);

    // A branch checked out in a real, existing worktree.
    const liveWt = path.join(tmpDir(), 'live');
    run('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'agentbox/live', liveWt]);
    const legacyLiveWt = path.join(tmpDir(), 'legacy-live');
    run('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'sander/live', legacyLiveWt]);

    // A branch whose worktree is registered in git's admin metadata but whose
    // directory does not exist on the host — exactly the agentbox container
    // situation (/home/vscode/.agentbox-worktrees/<name> lives in the box).
    const prunableWt = path.join(tmpDir(), 'prunable');
    run('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'agentbox/prunable', prunableWt]);
    fs.rmSync(prunableWt, { recursive: true, force: true });
    expect(run('git', ['-C', root, 'worktree', 'list']).stdout).toContain('prunable');

    // Truly leaked branches: no worktree anywhere.
    run('git', ['-C', root, 'branch', 'agentbox/leaked']);
    run('git', ['-C', root, 'branch', 'sander/leaked']);

    const git = new GitWorktree();
    git.deleteStaleBranches(root);

    // Branches still registered in a worktree survive the sweep — the prunable
    // one survives precisely because the sweep does NOT run `worktree prune`.
    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/agentbox/live']).exitCode).toBe(0);
    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/agentbox/prunable']).exitCode).toBe(0);
    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/sander/live']).exitCode).toBe(0);
    // The prunable worktree's admin metadata was NOT reaped by the sweep.
    expect(run('git', ['-C', root, 'worktree', 'list']).stdout).toContain('agentbox/prunable');
    // The truly leaked branches were deleted.
    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/agentbox/leaked']).exitCode).not.toBe(0);
    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/sander/leaked']).exitCode).not.toBe(0);
  });

  it('real git: batched delete still deletes the deletable branches when one in the same batch is registered in a worktree', () => {
    const root = tmpDir();
    run('git', ['init', '-q', '-b', 'main', root]);
    run('git', ['-C', root, 'config', 'user.email', 't@t.t']);
    run('git', ['-C', root, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(root, 'f.txt'), 'hi');
    run('git', ['-C', root, 'add', 'f.txt']);
    run('git', ['-C', root, 'commit', '-qm', 'init']);

    // One branch is checked out in a real, existing worktree.
    const liveWt = path.join(tmpDir(), 'live');
    run('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'agentbox/live', liveWt]);

    // Truly leaked branches that share the same single batched `branch -D`.
    run('git', ['-C', root, 'branch', 'agentbox/leaked']);
    run('git', ['-C', root, 'branch', 'sander/leaked']);

    const git = new GitWorktree();
    git.deleteStaleBranches(root);

    // The worktree-registered branch survives; the leaked ones are deleted
    // even though the same `git branch -D` invocation failed on agentbox/live.
    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/agentbox/live']).exitCode).toBe(0);
    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/agentbox/leaked']).exitCode).not.toBe(0);
    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/sander/leaked']).exitCode).not.toBe(0);
  });

  it('real git: shares one branch between the box worktree and the host worktree, and the rm sequence deletes it', () => {
    const root = tmpDir();
    run('git', ['init', '-q', '-b', 'main', root]);
    run('git', ['-C', root, 'config', 'user.email', 't@t.t']);
    run('git', ['-C', root, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(root, 'f.txt'), 'hi');
    run('git', ['-C', root, 'add', 'f.txt']);
    run('git', ['-C', root, 'commit', '-qm', 'init']);

    // Simulate the provider: the branch exists and the box worktree (inside the
    // container, not visible on the host) already has it checked out.
    run('git', ['-C', root, 'branch', 'demo', 'HEAD']);
    const boxWt = path.join(tmpDir(), 'box-wt');
    run('git', ['-C', root, 'worktree', 'add', '-q', boxWt, 'demo']);

    // The host sibling worktree reuses the same branch via --force.
    const git = new GitWorktree();
    const created = git.createWorktreeBranch(root, 'demo');
    expect(created).toEqual({ branch: 'demo', worktreePath: path.join(path.dirname(root), `${path.basename(root)}-sander-demo`) });
    expect(run('git', ['-C', created.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()).toBe('demo');
    expect(run('git', ['-C', root, 'worktree', 'list']).stdout).toContain('[demo]');

    // The bug's core guarantee, at the git level: create produced exactly ONE
    // branch — the plain id — never a sander/<id> branch.
    expect(run('git', ['-C', root, 'branch', '--list']).stdout).toContain('demo');
    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/sander/demo']).exitCode).not.toBe(0);

    // With both worktrees present, branch deletion must fail (rm precondition).
    expect(run('git', ['-C', root, 'branch', '-D', 'demo']).exitCode).not.toBe(0);

    // The rm sequence: the host worktree is removed first.
    git.removeWorktree(root, created);

    // The box worktree registration is still in .git/worktrees. At this point —
    // exactly the state production reaches when agentbox destroy does NOT clear
    // the box worktree metadata — `git branch -D` still fails. This is the honest
    // runRm behaviour: it warns ("Aviso: no se pudo eliminar la rama ...") and
    // leaves the branch for manual removal rather than deleting a branch a live
    // box still has checked out.
    expect(run('git', ['-C', root, 'branch', '-D', 'demo']).exitCode).not.toBe(0);

    // Simulate agentbox destroy clearing the box worktree registration from the
    // shared .git: agentbox runs `git worktree remove` on its container worktree
    // (/home/vscode/.agentbox-worktrees/<name>) inside the box, which removes the
    // .git/worktrees/<name> admin metadata. The host-side equivalent shown here
    // exercises the same git behaviour against a real repo.
    run('git', ['-C', root, 'worktree', 'remove', '--force', boxWt]);
    git.deleteBranch(root, 'demo');
    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/demo']).exitCode).not.toBe(0);
    // No sander/ namespace branch was ever created.
    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/sander/demo']).exitCode).not.toBe(0);
  });

  it('real git: deleteBranchDetaching deletes a branch whose worktree directory is missing and leaves unrelated worktrees untouched', () => {
    const root = tmpDir();
    run('git', ['init', '-q', '-b', 'main', root]);
    run('git', ['-C', root, 'config', 'user.email', 't@t.t']);
    run('git', ['-C', root, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(root, 'f.txt'), 'hi');
    run('git', ['-C', root, 'add', 'f.txt']);
    run('git', ['-C', root, 'commit', '-qm', 'init']);

    // The stale in-container worktree: registered in the shared .git but its
    // directory does not exist on the host (the container is already gone).
    run('git', ['-C', root, 'branch', 'feature/cool-wizard', 'HEAD']);
    const staleWt = path.join(tmpDir(), 'stale');
    run('git', ['-C', root, 'worktree', 'add', '-q', staleWt, 'feature/cool-wizard']);

    // An unrelated worktree/branch that must survive the detach.
    run('git', ['-C', root, 'branch', 'keep', 'HEAD']);
    const keepWt = path.join(tmpDir(), 'keep');
    run('git', ['-C', root, 'worktree', 'add', '-q', keepWt, 'keep']);

    fs.rmSync(staleWt, { recursive: true, force: true });
    expect(run('git', ['-C', root, 'worktree', 'list']).stdout).toContain('stale');

    const git = new GitWorktree();
    git.deleteBranchDetaching(root, 'feature/cool-wizard');

    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/feature/cool-wizard']).exitCode).not.toBe(0);
    expect(run('git', ['-C', root, 'worktree', 'list']).stdout).not.toContain('stale');
    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/keep']).exitCode).toBe(0);
    expect(run('git', ['-C', root, 'worktree', 'list']).stdout).toContain('keep');
    expect(fs.existsSync(keepWt)).toBe(true);
  });

  it('real git: deleteBranchDetaching force-removes a dirty host worktree sharing the branch and deletes it', () => {
    const root = tmpDir();
    run('git', ['init', '-q', '-b', 'main', root]);
    run('git', ['-C', root, 'config', 'user.email', 't@t.t']);
    run('git', ['-C', root, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(root, 'f.txt'), 'hi');
    run('git', ['-C', root, 'add', 'f.txt']);
    run('git', ['-C', root, 'commit', '-qm', 'init']);

    // Shared-branch layout: the box worktree (container already gone) and a
    // dirty host worktree both register the branch.
    run('git', ['-C', root, 'branch', 'demo', 'HEAD']);
    const boxWt = path.join(tmpDir(), 'box-wt');
    run('git', ['-C', root, 'worktree', 'add', '-q', boxWt, 'demo']);
    fs.rmSync(boxWt, { recursive: true, force: true });
    const hostWt = path.join(tmpDir(), 'host-wt');
    run('git', ['-C', root, 'worktree', 'add', '-q', '--force', hostWt, 'demo']);
    fs.writeFileSync(path.join(hostWt, 'dirty.txt'), 'dirty');
    expect(run('git', ['-C', root, 'branch', '-D', 'demo']).exitCode).not.toBe(0);

    const git = new GitWorktree();
    git.deleteBranchDetaching(root, 'demo');

    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/demo']).exitCode).not.toBe(0);
    expect(run('git', ['-C', root, 'worktree', 'list']).stdout).not.toContain('box-wt');
    expect(run('git', ['-C', root, 'worktree', 'list']).stdout).not.toContain('host-wt');
    expect(fs.existsSync(hostWt)).toBe(false);
  });

  it('real git: deleteBranchDetaching refuses to detach the main worktree and throws, leaving the branch and main worktree untouched', () => {
    const root = tmpDir();
    run('git', ['init', '-q', '-b', 'main', root]);
    run('git', ['-C', root, 'config', 'user.email', 't@t.t']);
    run('git', ['-C', root, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(root, 'f.txt'), 'hi');
    run('git', ['-C', root, 'add', 'f.txt']);
    run('git', ['-C', root, 'commit', '-qm', 'init']);
    run('git', ['-C', root, 'switch', '-q', '-c', 'demo']);

    const git = new GitWorktree();
    expect(() => git.deleteBranchDetaching(root, 'demo')).toThrow(CliError);

    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/demo']).exitCode).toBe(0);
    expect(run('git', ['-C', root, 'worktree', 'list']).stdout).toContain('demo');
  });

  it('deleteBranchDetaching deletes the branch via update-ref when the stale metadata is foreign-owned (unfixable) and reports the leftover', () => {
    const root = tmpDir();
    const adminDir = path.join(root, '.git', 'worktrees', 'wt-demo');
    fs.mkdirSync(adminDir, { recursive: true });
    fs.writeFileSync(path.join(adminDir, 'gitdir'), '/x/.git\n');

    const calls: string[][] = [];
    const next: RunResult[] = [
      result({ exitCode: 1, stderr: "error: cannot delete branch 'demo' used by worktree at '/x'" }),
      result({
        stdout: [
          'worktree /main',
          'HEAD abc',
          'branch refs/heads/main',
          '',
          'worktree /x',
          'HEAD abc',
          'branch refs/heads/demo',
          '',
        ].join('\n'),
      }),
      result({ exitCode: 128, stderr: 'fatal: refusing to remove worktree' }),
      result(),
    ];
    const runnerFn: CommandRunner = (args) => {
      calls.push(args);
      return next.shift() ?? result();
    };
    const { chmodCalls, chmodRunner } = makeChmodRunner(
      result({ exitCode: 1, stderr: `chmod: changing permissions of '${adminDir}': Operation not permitted` }),
    );
    const git = new GitWorktree({ runner: runnerFn, chmodRunner });

    const detach = git.deleteBranchDetaching(root, 'demo');

    expect(detach).toEqual({ leftoverAdminDir: { adminDir, worktreePath: '/x' } });
    expect(chmodCalls).toEqual([['-R', 'a+rwX', adminDir]]);
    // The branch is deleted atomically via update-ref; there is no second
    // `branch -D` retry after it.
    expect(calls).toEqual([
      ['-C', root, 'branch', '-D', 'demo'],
      ['-C', root, 'worktree', 'list', '--porcelain'],
      ['-C', root, 'worktree', 'remove', '--force', '/x'],
      ['-C', root, 'update-ref', '-d', 'refs/heads/demo'],
    ]);
  });

  it('deleteBranchDetaching throws a CliError (blocked, not foreign) when chmod fails for a non-permission reason and never reaches update-ref', () => {
    const root = tmpDir();
    const adminDir = path.join(root, '.git', 'worktrees', 'wt-demo');
    fs.mkdirSync(adminDir, { recursive: true });
    fs.writeFileSync(path.join(adminDir, 'gitdir'), '/x/.git\n');

    const calls: string[][] = [];
    const next: RunResult[] = [
      result({ exitCode: 1, stderr: "error: cannot delete branch 'demo' used by worktree at '/x'" }),
      result({
        stdout: [
          'worktree /main',
          'HEAD abc',
          'branch refs/heads/main',
          '',
          'worktree /x',
          'HEAD abc',
          'branch refs/heads/demo',
          '',
        ].join('\n'),
      }),
      result({ exitCode: 128, stderr: 'fatal: refusing to remove worktree' }),
    ];
    const runnerFn: CommandRunner = (args) => {
      calls.push(args);
      return next.shift() ?? result();
    };
    const { chmodRunner } = makeChmodRunner(result({ exitCode: 1, stderr: 'chmod: cannot access /tmp/x: No such file or directory' }));
    const git = new GitWorktree({ runner: runnerFn, chmodRunner });

    try {
      git.deleteBranchDetaching(root, 'demo');
      expect.unreachable('deleteBranchDetaching should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toMatch(/no se pudo eliminar la rama "demo"/);
      expect((err as CliError).message).toContain(adminDir);
    }
    expect(calls).toEqual([
      ['-C', root, 'branch', '-D', 'demo'],
      ['-C', root, 'worktree', 'list', '--porcelain'],
      ['-C', root, 'worktree', 'remove', '--force', '/x'],
    ]);
  });

  it('deleteBranchDetaching throws a CliError (blocked) when the stale worktree registration cannot be found and never reaches update-ref', () => {
    const root = tmpDir();
    const otherAdmin = path.join(root, '.git', 'worktrees', 'other');
    fs.mkdirSync(otherAdmin, { recursive: true });
    fs.writeFileSync(path.join(otherAdmin, 'gitdir'), '/other/.git\n');

    const calls: string[][] = [];
    const next: RunResult[] = [
      result({ exitCode: 1, stderr: "error: cannot delete branch 'demo' used by worktree at '/x'" }),
      result({
        stdout: [
          'worktree /main',
          'HEAD abc',
          'branch refs/heads/main',
          '',
          'worktree /x',
          'HEAD abc',
          'branch refs/heads/demo',
          '',
        ].join('\n'),
      }),
      result({ exitCode: 128, stderr: 'fatal: refusing to remove worktree' }),
    ];
    const runnerFn: CommandRunner = (args) => {
      calls.push(args);
      return next.shift() ?? result();
    };
    const { chmodRunner } = makeChmodRunner(result());
    const git = new GitWorktree({ runner: runnerFn, chmodRunner });

    try {
      git.deleteBranchDetaching(root, 'demo');
      expect.unreachable('deleteBranchDetaching should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toMatch(/no se pudo eliminar el registro del worktree/);
    }
    expect(calls.some((args) => args.includes('update-ref'))).toBe(false);
  });

  it('real git: deleteBranchDetaching repairs a mode-restricted owned admin dir (chmod) and removes it, deleting the branch', () => {
    const root = tmpDir();
    run('git', ['init', '-q', '-b', 'main', root]);
    run('git', ['-C', root, 'config', 'user.email', 't@t.t']);
    run('git', ['-C', root, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(root, 'f.txt'), 'hi');
    run('git', ['-C', root, 'add', 'f.txt']);
    run('git', ['-C', root, 'commit', '-qm', 'init']);
    run('git', ['-C', root, 'branch', 'demo', 'HEAD']);
    const wt = path.join(tmpDir(), 'wt-demo');
    run('git', ['-C', root, 'worktree', 'add', '-q', wt, 'demo']);
    fs.rmSync(wt, { recursive: true, force: true });

    // Mode-restricted but owned by the current user: the repair chmods it
    // (default real chmod runner) and rm succeeds.
    const adminDir = path.join(root, '.git', 'worktrees', 'wt-demo');
    fs.chmodSync(adminDir, 0o555);

    const calls: string[][] = [];
    const runnerFn: CommandRunner = (args) => {
      calls.push(args);
      if (args.includes('remove') && args.includes('--force')) {
        return result({ exitCode: 128, stderr: 'fatal: refusing to remove worktree' });
      }
      return run('git', args);
    };
    const git = new GitWorktree({ runner: runnerFn });

    const detach = git.deleteBranchDetaching(root, 'demo');

    expect(detach).toEqual({});
    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/demo']).exitCode).not.toBe(0);
    expect(fs.existsSync(adminDir)).toBe(false);
    expect(run('git', ['-C', root, 'worktree', 'list']).stdout).not.toContain('wt-demo');
  });

  it('real git: git update-ref -d deletes the branch ref while the stale worktree registration keeps its branch line (empirically observed)', () => {
    const root = tmpDir();
    run('git', ['init', '-q', '-b', 'main', root]);
    run('git', ['-C', root, 'config', 'user.email', 't@t.t']);
    run('git', ['-C', root, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(root, 'f.txt'), 'hi');
    run('git', ['-C', root, 'add', 'f.txt']);
    run('git', ['-C', root, 'commit', '-qm', 'init']);
    run('git', ['-C', root, 'branch', 'demo', 'HEAD']);
    const wt = path.join(tmpDir(), 'wt');
    run('git', ['-C', root, 'worktree', 'add', '-q', wt, 'demo']);
    fs.rmSync(wt, { recursive: true, force: true });

    const updated = run('git', ['-C', root, 'update-ref', '-d', 'refs/heads/demo']);
    expect(updated.exitCode).toBe(0);
    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/demo']).exitCode).not.toBe(0);

    // Empirical pin recorded during implementation: porcelain STILL prints
    // `branch refs/heads/demo` in the stale worktree record after update-ref -d,
    // with a null HEAD — the branch ref is gone (rev-parse fails above) but the
    // worktree registration itself is untouched. Only the admin metadata
    // cleanup (removeStaleWorktreeMetadata) clears the registration, which is
    // why the Aviso reports the leftover path.
    const porcelain = run('git', ['-C', root, 'worktree', 'list', '--porcelain']).stdout;
    expect(porcelain).toContain('branch refs/heads/demo');
    expect(porcelain).toContain('HEAD 0000000000000000000000000000000000000000');

    // update-ref -d is idempotent: a re-run still exits 0.
    expect(run('git', ['-C', root, 'update-ref', '-d', 'refs/heads/demo']).exitCode).toBe(0);
  });

  it('real git: deleteBranchDetaching deletes the branch via update-ref and reports the leftover when the stale metadata cannot be repaired', () => {
    const root = tmpDir();
    run('git', ['init', '-q', '-b', 'main', root]);
    run('git', ['-C', root, 'config', 'user.email', 't@t.t']);
    run('git', ['-C', root, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(root, 'f.txt'), 'hi');
    run('git', ['-C', root, 'add', 'f.txt']);
    run('git', ['-C', root, 'commit', '-qm', 'init']);
    run('git', ['-C', root, 'branch', 'demo', 'HEAD']);
    const wt = path.join(tmpDir(), 'wt-demo');
    run('git', ['-C', root, 'worktree', 'add', '-q', wt, 'demo']);
    fs.rmSync(wt, { recursive: true, force: true });

    // The admin dir is kept readable for the match but chmod fails with a
    // foreign-uid "Operation not permitted" (injected chmod runner), so the
    // repair is unfixable and the flow falls back to update-ref -d.
    const adminDir = path.join(root, '.git', 'worktrees', 'wt-demo');
    const calls: string[][] = [];
    const runnerFn: CommandRunner = (args) => {
      calls.push(args);
      if (args.includes('remove') && args.includes('--force')) {
        return result({ exitCode: 128, stderr: 'fatal: refusing to remove worktree' });
      }
      return run('git', args);
    };
    const { chmodRunner } = makeChmodRunner(result({ exitCode: 1, stderr: `chmod: changing permissions of '${adminDir}': Operation not permitted` }));
    const git = new GitWorktree({ runner: runnerFn, chmodRunner });

    const detach = git.deleteBranchDetaching(root, 'demo');

    expect(detach).toEqual({ leftoverAdminDir: { adminDir, worktreePath: wt } });
    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/demo']).exitCode).not.toBe(0);
    // The leftover metadata really is still there — the Aviso's claim is accurate.
    expect(fs.existsSync(adminDir)).toBe(true);
    expect(calls).toContainEqual(['-C', root, 'update-ref', '-d', 'refs/heads/demo']);
    // Empirically observed: the stale worktree registration keeps its branch
    // line (null HEAD) after update-ref -d — the leftover metadata is exactly
    // what the Aviso surfaces.
    expect(run('git', ['-C', root, 'worktree', 'list', '--porcelain']).stdout).toContain('branch refs/heads/demo');
  });

  it('deleteBranchDetaching falls back to update-ref when an unreadable foreign gitdir matches by name', () => {
    const root = tmpDir();
    const adminDir = path.join(root, '.git', 'worktrees', 'wt-demo');
    fs.mkdirSync(adminDir, { recursive: true });
    fs.writeFileSync(path.join(adminDir, 'gitdir'), '/tmp/wt-demo/.git\n');
    // The foreign 0o700-style shape: the admin dir is unreadable, so the scan
    // cannot verify the registration by content and must fall back to the name
    // match (basename "wt-demo").
    fs.chmodSync(adminDir, 0o000);

    const calls: string[][] = [];
    const next: RunResult[] = [
      result({ exitCode: 1, stderr: "error: cannot delete branch 'demo' used by worktree at '/tmp/wt-demo'" }),
      result({
        stdout: [
          'worktree /main',
          'HEAD abc',
          'branch refs/heads/main',
          '',
          'worktree /tmp/wt-demo',
          'HEAD abc',
          'branch refs/heads/demo',
          '',
        ].join('\n'),
      }),
      result({ exitCode: 128, stderr: 'fatal: refusing to remove worktree' }),
    ];
    const runnerFn: CommandRunner = (args) => {
      calls.push(args);
      return next.shift() ?? result();
    };
    // The repair chmod fails as foreign residue, so the flow falls back to the
    // guarded `git update-ref -d` last resort.
    const { chmodRunner } = makeChmodRunner(
      result({ exitCode: 1, stderr: `chmod: changing permissions of '${adminDir}': Operation not permitted` }),
    );
    const git = new GitWorktree({ runner: runnerFn, chmodRunner });

    try {
      const detach = git.deleteBranchDetaching(root, 'demo');

      // The result carries the REAL admin dir path, not null, so the caller's
      // Aviso can name the exact leftover.
      expect(detach).toEqual({ leftoverAdminDir: { adminDir, worktreePath: '/tmp/wt-demo' } });
    } finally {
      fs.chmodSync(adminDir, 0o755); // keep the temp dir cleanable
    }
    expect(calls).toEqual([
      ['-C', root, 'branch', '-D', 'demo'],
      ['-C', root, 'worktree', 'list', '--porcelain'],
      ['-C', root, 'worktree', 'remove', '--force', '/tmp/wt-demo'],
      ['-C', root, 'update-ref', '-d', 'refs/heads/demo'],
    ]);
  });

  it('real git: repairs an owned execute-only admin dir (0o100) and removes it, deleting the branch', () => {
    const root = tmpDir();
    run('git', ['init', '-q', '-b', 'main', root]);
    run('git', ['-C', root, 'config', 'user.email', 't@t.t']);
    run('git', ['-C', root, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(root, 'f.txt'), 'hi');
    run('git', ['-C', root, 'add', 'f.txt']);
    run('git', ['-C', root, 'commit', '-qm', 'init']);
    run('git', ['-C', root, 'branch', 'demo', 'HEAD']);
    const wt = path.join(tmpDir(), 'wt-demo');
    run('git', ['-C', root, 'worktree', 'add', '-q', wt, 'demo']);
    fs.rmSync(wt, { recursive: true, force: true });

    // Owned-but-execute-only admin dir: git can traverse into it (so the
    // branch -D still fails as used by a worktree and the gitdir file stays
    // readable for the content match), but git cannot remove it — the repair
    // chmods it (default real chmod runner) and the targeted rm removes it.
    const adminDir = path.join(root, '.git', 'worktrees', 'wt-demo');
    fs.chmodSync(adminDir, 0o100);

    const calls: string[][] = [];
    const runnerFn: CommandRunner = (args) => {
      calls.push(args);
      if (args.includes('remove') && args.includes('--force')) {
        return result({ exitCode: 128, stderr: 'fatal: refusing to remove worktree' });
      }
      return run('git', args);
    };
    const git = new GitWorktree({ runner: runnerFn });

    const detach = git.deleteBranchDetaching(root, 'demo');

    expect(detach).toEqual({});
    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/demo']).exitCode).not.toBe(0);
    expect(fs.existsSync(adminDir)).toBe(false);
    expect(run('git', ['-C', root, 'worktree', 'list']).stdout).not.toContain('wt-demo');
  });

  it('deleteBranchDetaching repairs an owned unreadable-gitdir admin dir matched by name and removes it', () => {
    const root = tmpDir();
    const adminDir = path.join(root, '.git', 'worktrees', 'wt-demo');
    fs.mkdirSync(adminDir, { recursive: true });
    fs.writeFileSync(path.join(adminDir, 'gitdir'), '/tmp/wt-demo/.git\n');
    // Unreadable admin dir (the owned-but-unreadable-gitdir shape): the scan
    // cannot verify by content and must fall back to the name match, then
    // repair with the real chmod runner and remove.
    fs.chmodSync(adminDir, 0o000);

    const calls: string[][] = [];
    const next: RunResult[] = [
      result({ exitCode: 1, stderr: "error: cannot delete branch 'demo' used by worktree at '/tmp/wt-demo'" }),
      result({
        stdout: [
          'worktree /main',
          'HEAD abc',
          'branch refs/heads/main',
          '',
          'worktree /tmp/wt-demo',
          'HEAD abc',
          'branch refs/heads/demo',
          '',
        ].join('\n'),
      }),
      result({ exitCode: 128, stderr: 'fatal: refusing to remove worktree' }),
      result(),
    ];
    const runnerFn: CommandRunner = (args) => {
      calls.push(args);
      return next.shift() ?? result();
    };
    const git = new GitWorktree({ runner: runnerFn }); // default real chmod runner

    try {
      const detach = git.deleteBranchDetaching(root, 'demo');

      expect(detach).toEqual({});
      expect(fs.existsSync(adminDir)).toBe(false);
    } finally {
      if (fs.existsSync(adminDir)) {
        fs.chmodSync(adminDir, 0o755); // keep the temp dir cleanable
      }
    }
    expect(calls).toEqual([
      ['-C', root, 'branch', '-D', 'demo'],
      ['-C', root, 'worktree', 'list', '--porcelain'],
      ['-C', root, 'worktree', 'remove', '--force', '/tmp/wt-demo'],
      ['-C', root, 'branch', '-D', 'demo'],
    ]);
  });

  it('deleteBranchDetaching blocks with the admin dir path when git already deleted the gitdir file (parent-restricted shape)', () => {
    const root = tmpDir();
    const adminDir = path.join(root, '.git', 'worktrees', 'wt-demo');
    fs.mkdirSync(adminDir, { recursive: true });
    // The gitdir file is missing: git's failed `worktree remove` deletes it
    // when the parent .git/worktrees is unwritable, so the scan can only fall
    // back to the name match and cannot re-verify the registration.

    const calls: string[][] = [];
    const next: RunResult[] = [
      result({ exitCode: 1, stderr: "error: cannot delete branch 'demo' used by worktree at '/tmp/wt-demo'" }),
      result({
        stdout: [
          'worktree /main',
          'HEAD abc',
          'branch refs/heads/main',
          '',
          'worktree /tmp/wt-demo',
          'HEAD abc',
          'branch refs/heads/demo',
          '',
        ].join('\n'),
      }),
      result({ exitCode: 128, stderr: 'fatal: refusing to remove worktree' }),
    ];
    const runnerFn: CommandRunner = (args) => {
      calls.push(args);
      return next.shift() ?? result();
    };
    const git = new GitWorktree({ runner: runnerFn }); // default real chmod runner

    try {
      git.deleteBranchDetaching(root, 'demo');
      expect.unreachable('deleteBranchDetaching should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toMatch(/no se pudo eliminar la rama "demo"/);
      // The blocked error names the real admin dir and gives the remediation.
      expect((err as CliError).message).toContain(adminDir);
      expect((err as CliError).message).toContain('sudo rm -rf');
    }
    // Blocked — never the update-ref last resort.
    expect(calls.some((args) => args.includes('update-ref'))).toBe(false);
  });

  it('deleteBranchDetaching throws a CliError (blocked) when the update-ref last resort fails, with admin dir and remediation', () => {
    const root = tmpDir();
    const adminDir = path.join(root, '.git', 'worktrees', 'wt-demo');
    fs.mkdirSync(adminDir, { recursive: true });
    fs.writeFileSync(path.join(adminDir, 'gitdir'), '/x/.git\n');

    const calls: string[][] = [];
    const next: RunResult[] = [
      result({ exitCode: 1, stderr: "error: cannot delete branch 'demo' used by worktree at '/x'" }),
      result({
        stdout: [
          'worktree /main',
          'HEAD abc',
          'branch refs/heads/main',
          '',
          'worktree /x',
          'HEAD abc',
          'branch refs/heads/demo',
          '',
        ].join('\n'),
      }),
      result({ exitCode: 128, stderr: 'fatal: refusing to remove worktree' }),
      result({ exitCode: 1, stderr: "fatal: update_ref failed for ref 'refs/heads/demo': cannot lock ref" }),
    ];
    const runnerFn: CommandRunner = (args) => {
      calls.push(args);
      return next.shift() ?? result();
    };
    const { chmodRunner } = makeChmodRunner(
      result({ exitCode: 1, stderr: `chmod: changing permissions of '${adminDir}': Operation not permitted` }),
    );
    const git = new GitWorktree({ runner: runnerFn, chmodRunner });

    try {
      git.deleteBranchDetaching(root, 'demo');
      expect.unreachable('deleteBranchDetaching should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toMatch(/no se pudo eliminar la rama "demo"/);
      expect((err as CliError).message).toContain(adminDir);
      expect((err as CliError).message).toContain('sudo rm -rf');
    }
    // The last resort was attempted and failed; nothing after it runs.
    expect(calls).toEqual([
      ['-C', root, 'branch', '-D', 'demo'],
      ['-C', root, 'worktree', 'list', '--porcelain'],
      ['-C', root, 'worktree', 'remove', '--force', '/x'],
      ['-C', root, 'update-ref', '-d', 'refs/heads/demo'],
    ]);
  });

  it('deleteBranchDetaching refuses a locked worktree from the porcelain record and never touches its metadata', () => {
    const root = tmpDir();
    const { git, runner } = makeRunner();
    const porcelain = [
      'worktree /main',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /locked-wt',
      'HEAD abc',
      'branch refs/heads/demo',
      'locked',
      '',
    ].join('\n');
    runner.next.push(result({ exitCode: 1, stderr: "error: cannot delete branch 'demo' used by worktree at '/locked-wt'" }));
    runner.next.push(result({ stdout: porcelain }));

    expect(() => git.deleteBranchDetaching(root, 'demo')).toThrow(
      new CliError('no se pudo eliminar la rama "demo": el worktree "/locked-wt" está bloqueado'),
    );
    // The `locked` line is parsed from the porcelain record, so the refusal
    // happens before any metadata touch: no remove --force, no chmod, no
    // update-ref.
    expect(runner.calls).toEqual([
      ['-C', root, 'branch', '-D', 'demo'],
      ['-C', root, 'worktree', 'list', '--porcelain'],
    ]);
  });

  it('deleteBranchDetaching refuses to touch the metadata of a worktree that still exists on the host', () => {
    const root = tmpDir();
    const wtPath = path.join(tmpDir(), 'wt-demo');
    fs.mkdirSync(wtPath, { recursive: true });

    const { git, runner } = makeRunner();
    const porcelain = [
      'worktree /main',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      `worktree ${wtPath}`,
      'HEAD abc',
      'branch refs/heads/demo',
      '',
    ].join('\n');
    runner.next.push(result({ exitCode: 1, stderr: `error: cannot delete branch 'demo' used by worktree at '${wtPath}'` }));
    runner.next.push(result({ stdout: porcelain }));
    runner.next.push(result({ exitCode: 128, stderr: `fatal: refusing to remove worktree at '${wtPath}'` }));

    expect(() => git.deleteBranchDetaching(root, 'demo')).toThrow(
      new CliError(`no se pudo eliminar la rama "demo": fatal: refusing to remove worktree at '${wtPath}'`),
    );
    // A host-present worktree is never treated as stale metadata: no chmod and
    // no update-ref last resort.
    expect(runner.calls).toEqual([
      ['-C', root, 'branch', '-D', 'demo'],
      ['-C', root, 'worktree', 'list', '--porcelain'],
      ['-C', root, 'worktree', 'remove', '--force', wtPath],
    ]);
  });
});

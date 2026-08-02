import { describe, expect, it } from 'vitest';
import { FakeWorktree } from './fake';

describe('FakeWorktree', () => {
  it('records create, remove, delete, detach, and sweep operations', () => {
    const worktree = new FakeWorktree();
    expect(worktree.createWorktreeBranch('/p', 'demo')).toEqual({
      branch: 'demo',
      worktreePath: '/tmp/proj-sander-demo',
    });
    worktree.removeWorktree('/p', { branch: 'demo', worktreePath: '/tmp/proj-sander-demo' });
    worktree.deleteBranch('/p', 'demo');
    worktree.deleteBranchDetaching('/p', 'demo');
    worktree.deleteStaleBranches('/p');

    expect(worktree.ops).toEqual([
      { op: 'createWorktreeBranch', projectRoot: '/p', id: 'demo' },
      { op: 'removeWorktree', projectRoot: '/p', ref: { branch: 'demo', worktreePath: '/tmp/proj-sander-demo' } },
      { op: 'deleteBranch', projectRoot: '/p', branch: 'demo' },
      { op: 'deleteBranchDetaching', projectRoot: '/p', branch: 'demo' },
      { op: 'deleteStaleBranches', projectRoot: '/p' },
    ]);
  });

  it('returns a configurable createResult', () => {
    const worktree = new FakeWorktree();
    worktree.createResult = null;
    expect(worktree.createWorktreeBranch('/p', 'demo')).toBeNull();
  });

  it('throws a configured error once', () => {
    const worktree = new FakeWorktree();
    worktree.nextError = new Error('boom');
    expect(() => worktree.removeWorktree('/p', { branch: 'b', worktreePath: '/x' })).toThrow('boom');
    expect(() => worktree.deleteBranchDetaching('/p', 'b')).not.toThrow();
  });

  it('returns a configurable detach result', () => {
    const worktree = new FakeWorktree();
    expect(worktree.deleteBranchDetaching('/p', 'b')).toEqual({});
    worktree.deleteBranchDetachingResult = {
      leftoverAdminDir: { adminDir: '/x/.git/worktrees/wt', worktreePath: '/y' },
    };
    expect(worktree.deleteBranchDetaching('/p', 'demo')).toEqual({
      leftoverAdminDir: { adminDir: '/x/.git/worktrees/wt', worktreePath: '/y' },
    });
  });
});

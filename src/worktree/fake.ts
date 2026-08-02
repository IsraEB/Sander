import type { DeleteBranchDetachingResult, Worktree, WorktreeRef } from './worktree';

export type WorktreeOp =
  | { op: 'createWorktreeBranch'; projectRoot: string; id: string }
  | { op: 'removeWorktree'; projectRoot: string; ref: WorktreeRef }
  | { op: 'deleteBranch'; projectRoot: string; branch: string }
  | { op: 'deleteBranchDetaching'; projectRoot: string; branch: string }
  | { op: 'deleteStaleBranches'; projectRoot: string };

export class FakeWorktree implements Worktree {
  readonly ops: WorktreeOp[] = [];
  createResult: WorktreeRef | null = { branch: 'demo', worktreePath: '/tmp/proj-sander-demo' };
  deleteBranchDetachingResult: DeleteBranchDetachingResult = {};
  nextError: Error | null = null;
  isGitRepoResult = true;

  private maybeThrow(): void {
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
  }

  createWorktreeBranch(projectRoot: string, id: string): WorktreeRef | null {
    this.maybeThrow();
    this.ops.push({ op: 'createWorktreeBranch', projectRoot, id });
    return this.createResult;
  }

  removeWorktree(projectRoot: string, ref: WorktreeRef): void {
    this.maybeThrow();
    this.ops.push({ op: 'removeWorktree', projectRoot, ref });
  }

  deleteBranch(projectRoot: string, branch: string): void {
    this.maybeThrow();
    this.ops.push({ op: 'deleteBranch', projectRoot, branch });
  }

  deleteBranchDetaching(projectRoot: string, branch: string): DeleteBranchDetachingResult {
    this.maybeThrow();
    this.ops.push({ op: 'deleteBranchDetaching', projectRoot, branch });
    return this.deleteBranchDetachingResult;
  }

  deleteStaleBranches(projectRoot: string): void {
    this.ops.push({ op: 'deleteStaleBranches', projectRoot });
  }

  isGitRepo(projectRoot: string): boolean {
    return this.isGitRepoResult;
  }
}

export type SyncStatus = 'M' | 'D' | '??';

export interface SyncManifest {
  readonly [relPath: string]: SyncStatus;
}

export interface SyncHashes {
  readonly [relPath: string]: {
    readonly host: string;
    readonly box: string;
  };
}

export type SyncSide = 'host' | 'box';

export type SyncOp =
  | { readonly kind: 'copy-host-to-box'; readonly relPath: string }
  | { readonly kind: 'pull-box-to-host'; readonly relPath: string }
  | { readonly kind: 'delete-in-box'; readonly relPath: string }
  | { readonly kind: 'delete-in-host'; readonly relPath: string }
  | { readonly kind: 'conflict'; readonly relPath: string; readonly backup: string; readonly apply: 'pull' | 'delete' }
  | { readonly kind: 'noop'; readonly relPath: string };

export type SyncPlan = readonly SyncOp[];

export interface PlanSummary {
  readonly boxToHost: number;
  readonly hostToBox: number;
  readonly conflicts: number;
}

/**
 * The path where the local (host) version of a conflicted file is preserved,
 * mirroring the spec's `.sander/<rel>.sander-<lado>` backup layout.
 */
export function backupRelPath(relPath: string, side: SyncSide): string {
  return `.sander/${relPath}.sander-${side}`;
}

type NormalizedStatus = 'M' | 'D' | 'clean';

// `M` and `??` (untracked) are the same for planning purposes; `D` means the
// file is gone from that side; an absent status means the path is clean. Any
// other status a caller might pass (porcelain `A`, `R`, ...) still means the
// content differs from the shared HEAD, so it is treated as modified.
function normalizeStatus(status: SyncStatus | undefined): NormalizedStatus {
  if (status === undefined) {
    return 'clean';
  }
  return status === 'D' ? 'D' : 'M';
}

function conflictOp(relPath: string, apply: 'pull' | 'delete'): SyncOp {
  return { kind: 'conflict', relPath, backup: backupRelPath(relPath, 'host'), apply };
}

function planPath(
  relPath: string,
  hostStatus: SyncStatus | undefined,
  boxStatus: SyncStatus | undefined,
  hash: { host: string; box: string } | undefined,
): SyncOp {
  const host = normalizeStatus(hostStatus);
  const box = normalizeStatus(boxStatus);

  if (host === 'clean' && box === 'clean') {
    return { kind: 'noop', relPath };
  }

  if (host === 'M' && box === 'clean') {
    return { kind: 'copy-host-to-box', relPath };
  }
  if (host === 'clean' && box === 'M') {
    return { kind: 'pull-box-to-host', relPath };
  }

  if (host === 'M' && box === 'M') {
    // Content hashes prove the sides are identical without transfer. A missing
    // or partial hash entry cannot prove equality, so the conservative outcome
    // is a conflict (never a silent no-op over a possible difference).
    const hostHash = hash?.host;
    const boxHash = hash?.box;
    if (hostHash !== undefined && boxHash !== undefined && hostHash === boxHash) {
      return { kind: 'noop', relPath };
    }
    return conflictOp(relPath, 'pull');
  }

  if (host === 'D' && box === 'clean') {
    return { kind: 'delete-in-box', relPath };
  }
  if (host === 'clean' && box === 'D') {
    return { kind: 'delete-in-host', relPath };
  }
  if (host === 'D' && box === 'D') {
    return { kind: 'noop', relPath };
  }

  // Deletion on one side vs. modification on the other is a conflict: the
  // other side (the box) wins, backed up when the local host version exists.
  // `pull` restores the box version over a host deletion; `delete` applies the
  // box deletion over a host modification, keeping the host version as backup.
  if (host === 'D' && box === 'M') {
    return conflictOp(relPath, 'pull');
  }
  return conflictOp(relPath, 'delete');
}

/**
 * Decides the sync action for every path present in either manifest. The plan
 * is ordered by relative path and covers exactly the union of both sides, so
 * the execution layer can apply it op by op with copy/pull/rm and print a
 * summary. Untracked deletions are invisible to `git status` in v1, so a file
 * deleted on one side while still untracked on the other is copied back (the
 * documented v1 limitation lives on the caller's side too).
 */
export function planSync(host: SyncManifest, box: SyncManifest, hashes: SyncHashes = {}): SyncPlan {
  const relPaths = Array.from(new Set([...Object.keys(host), ...Object.keys(box)]));
  relPaths.sort((a, b) => a.localeCompare(b));
  return relPaths.map((relPath) => planPath(relPath, host[relPath], box[relPath], hashes[relPath]));
}

export function summarizePlan(plan: SyncPlan): PlanSummary {
  const summary: { boxToHost: number; hostToBox: number; conflicts: number } = { boxToHost: 0, hostToBox: 0, conflicts: 0 };
  for (const op of plan) {
    if (op.kind === 'pull-box-to-host') {
      summary.boxToHost++;
    } else if (op.kind === 'copy-host-to-box') {
      summary.hostToBox++;
    } else if (op.kind === 'conflict') {
      summary.conflicts++;
    }
  }
  return summary;
}

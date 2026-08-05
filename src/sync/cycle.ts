import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { CliError } from '../cli/errors';
import { run } from '../process/run';
import type { CommandRunner } from '../process/run';
import { BOX_WORKTREE } from '../provider/box-user';
import type { Provider } from '../provider/provider';
import { planSync, summarizePlan } from './plan';
import type { PlanSummary, SyncHashes, SyncManifest, SyncPlan, SyncStatus } from './plan';

// The one-shot `sander sync <id>` cycle, extracted so the watch loop can reuse
// the exact same detection/plan/execute pipeline. `warn` is where per-op
// failures and cycle-level notices go: the one-shot writes them to stderr, the
// watcher appends them to its log.

export interface SyncCycleIo {
  id: string;
  hostWorktree: string;
  provider: Provider;
  gitRunner?: CommandRunner;
  warn: (message: string) => void;
}

// The exported manifest/hash types are readonly by contract; build them via a
// mutable local shape and return (a mutable index signature is assignable to
// the readonly one).
type MutableManifest = { [relPath: string]: SyncStatus };
type MutableHashes = { [relPath: string]: { host: string; box: string } };

function boxPath(rel: string): string {
  return path.posix.join(BOX_WORKTREE, rel);
}

// Parses `git status --porcelain -uall` output into a per-path manifest.
// Untracked (`??`) is its own status, a `D` in either column means the file is
// gone from that side, and every other status (M, A, R, ...) means the content
// differs from the shared HEAD and is normalized to modified.
function parsePorcelain(stdout: string): SyncManifest {
  const manifest: MutableManifest = {};
  for (const line of stdout.split('\n')) {
    const row = line.replace(/\r$/, '');
    if (row.trim() === '') {
      continue;
    }
    const status = row.slice(0, 2);
    const rel = row.slice(3);
    if (rel === '') {
      continue;
    }
    if (status === '??') {
      manifest[rel] = '??';
    } else if (status.includes('D')) {
      manifest[rel] = 'D';
    } else {
      manifest[rel] = 'M';
    }
  }
  return manifest;
}

function fileHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function detectHost(io: SyncCycleIo): SyncManifest {
  const gitRunner = io.gitRunner ?? ((args: string[]) => run('git', args));
  const result = gitRunner(['-C', io.hostWorktree, 'status', '--porcelain', '-uall']);
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new CliError(`git status falló en el worktree del host "${io.hostWorktree}"${detail ? `: ${detail}` : ''}`);
  }
  return parsePorcelain(result.stdout);
}

async function detectBox(io: SyncCycleIo): Promise<SyncManifest> {
  const result = await io.provider.exec(io.id, ['git', '-C', BOX_WORKTREE, 'status', '--porcelain', '-uall']);
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new CliError(`git status falló dentro del box${detail ? `: ${detail}` : ''}`);
  }
  return parsePorcelain(result.stdout);
}

// Content hashes for paths dirty on BOTH sides: the pure plan only needs them
// to decide no-op vs. conflict, and a missing entry means "no proof of
// equality", which planSync turns into a conservative conflict. A failed box
// read throws: the box is unusable, so the whole cycle is skipped (never a
// silent transfer).
async function computeHashes(io: SyncCycleIo, host: SyncManifest, box: SyncManifest): Promise<SyncHashes> {
  const hashes: MutableHashes = {};
  const bothDirty = Object.keys(host).filter((rel) => box[rel] !== undefined && host[rel] !== 'D' && box[rel] !== 'D');
  for (const rel of bothDirty) {
    let hostContent: string;
    try {
      hostContent = fs.readFileSync(path.join(io.hostWorktree, rel), 'utf8');
    } catch {
      continue;
    }
    const cat = await io.provider.exec(io.id, ['cat', boxPath(rel)]);
    if (cat.exitCode !== 0) {
      const detail = (cat.stderr || cat.stdout).trim();
      throw new CliError(`no se pudo leer "${rel}" dentro del box${detail ? `: ${detail}` : ''}`);
    }
    hashes[rel] = { host: fileHash(hostContent), box: fileHash(cat.stdout) };
  }
  return hashes;
}

// The host version of a conflicted file is preserved as a backup; planSync
// derives the path (.sander/<rel>.sander-host). Skipped when the host file is
// already gone (nothing to preserve; the box side wins).
function backupHost(io: SyncCycleIo, rel: string, backup: string): void {
  const source = path.join(io.hostWorktree, rel);
  if (!fs.existsSync(source)) {
    return;
  }
  const dest = path.join(io.hostWorktree, backup);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
}

async function executePlan(io: SyncCycleIo, plan: SyncPlan): Promise<void> {
  for (const op of plan) {
    try {
      switch (op.kind) {
        case 'copy-host-to-box':
          await io.provider.copy(io.id, path.join(io.hostWorktree, op.relPath), boxPath(op.relPath), { yes: true });
          break;
        case 'pull-box-to-host': {
          const dest = path.join(io.hostWorktree, op.relPath);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          await io.provider.pull(io.id, boxPath(op.relPath), dest);
          break;
        }
        case 'delete-in-host':
          fs.rmSync(path.join(io.hostWorktree, op.relPath), { force: true });
          break;
        case 'delete-in-box': {
          const rm = await io.provider.exec(io.id, ['rm', '-f', boxPath(op.relPath)]);
          if (rm.exitCode !== 0) {
            const detail = (rm.stderr || rm.stdout).trim();
            throw new CliError(`rm falló dentro del box${detail ? `: ${detail}` : ''}`);
          }
          break;
        }
        case 'conflict': {
          backupHost(io, op.relPath, op.backup);
          if (op.apply === 'pull') {
            const dest = path.join(io.hostWorktree, op.relPath);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            await io.provider.pull(io.id, boxPath(op.relPath), dest);
          } else {
            fs.rmSync(path.join(io.hostWorktree, op.relPath), { force: true });
          }
          break;
        }
        case 'noop':
          break;
      }
    } catch (err) {
      io.warn(`Aviso: falló la operación "${op.kind}" sobre "${op.relPath}" (${err instanceof Error ? err.message : String(err)}).\n`);
    }
  }
}

/**
 * One full two-way sync cycle: detect the dirty paths on both sides, plan with
 * planSync, execute the transfers and deletions, and return the summary. Any
 * box-side failure (box down, exec failure, hash read failure) throws so the
 * caller can skip the cycle and keep going — never a silent transfer.
 */
export async function runSyncCycle(io: SyncCycleIo): Promise<PlanSummary> {
  const hostManifest = detectHost(io);
  const boxManifest = await detectBox(io);
  const hashes = await computeHashes(io, hostManifest, boxManifest);
  const plan = planSync(hostManifest, boxManifest, hashes);
  await executePlan(io, plan);
  return summarizePlan(plan);
}

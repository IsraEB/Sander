import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { CliError } from '../errors';
import { helpForCommand } from '../help';
import { resolveSandboxId } from '../args';
import type { CliDeps } from '../deps';
import { run } from '../../process/run';
import { loadRegistry } from '../../registry/registry';
import { BOX_WORKTREE } from '../../provider/box-user';
import type { Provider } from '../../provider/provider';
import { planSync, summarizePlan } from '../../sync/plan';
import type { SyncHashes, SyncManifest, SyncPlan, SyncStatus } from '../../sync/plan';

// The exported manifest/hash types are readonly by contract; build them via a
// mutable local shape and return (a mutable index signature is assignable to
// the readonly one).
type MutableManifest = { [relPath: string]: SyncStatus };
type MutableHashes = { [relPath: string]: { host: string; box: string } };

interface SyncIo {
  deps: CliDeps;
  id: string;
  hostWorktree: string;
  provider: Provider;
}

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

function detectHost(io: SyncIo): SyncManifest {
  const gitRunner = io.deps.gitRunner ?? ((args: string[]) => run('git', args));
  const result = gitRunner(['-C', io.hostWorktree, 'status', '--porcelain', '-uall']);
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new CliError(`git status falló en el worktree del host "${io.hostWorktree}"${detail ? `: ${detail}` : ''}`);
  }
  return parsePorcelain(result.stdout);
}

async function detectBox(io: SyncIo): Promise<SyncManifest> {
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
async function computeHashes(io: SyncIo, host: SyncManifest, box: SyncManifest): Promise<SyncHashes> {
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
function backupHost(io: SyncIo, rel: string, backup: string): void {
  const source = path.join(io.hostWorktree, rel);
  if (!fs.existsSync(source)) {
    return;
  }
  const dest = path.join(io.hostWorktree, backup);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
}

async function executePlan(io: SyncIo, plan: SyncPlan): Promise<void> {
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
      io.deps.stderr.write(
        `Aviso: falló la operación "${op.kind}" sobre "${op.relPath}" (${err instanceof Error ? err.message : String(err)}).\n`
      );
    }
  }
}

export async function runSync(deps: CliDeps, argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    deps.stdout.write(helpForCommand('sync'));
    return 0;
  }

  const { id, rest } = resolveSandboxId(argv);
  if (rest.length > 0) {
    throw new CliError(`unexpected argument "${rest[0]}": sync takes a single sandbox id`);
  }

  const registry = loadRegistry(deps.configDir);
  const box = registry.boxes[id];
  if (!box) {
    throw new CliError(`sandbox not found: ${id}`);
  }
  if (box.worktreePath === undefined || box.worktreePath === '') {
    deps.stdout.write(
      `sync desactivada: el sandbox "${id}" no tiene worktree host (proyecto no-git); no se transfiere nada.\n`
    );
    return 0;
  }

  const io: SyncIo = {
    deps,
    id,
    hostWorktree: box.worktreePath,
    provider: deps.createProvider(box.provider),
  };

  try {
    const hostManifest = detectHost(io);
    const boxManifest = await detectBox(io);
    const hashes = await computeHashes(io, hostManifest, boxManifest);
    const plan = planSync(hostManifest, boxManifest, hashes);
    await executePlan(io, plan);
    const summary = summarizePlan(plan);
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

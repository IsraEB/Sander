import type { ExecResult } from './provider';

export interface BoxUserExec {
  (argv: string[], opts?: { user?: string; timeoutMs?: number }): Promise<ExecResult>;
}

export interface BoxUserAlignOptions {
  exec: BoxUserExec;
  hostUid: number;
  hostGid: number;
  projectRoot: string;
  gitDir: string | null;
}

export type BoxUserAlignResult =
  | { skipped: true; reason: 'uid-1000-host' | 'non-posix' | 'already-aligned' }
  | { skipped: false; fromUid: number; toUid: number; toGid: number; issues: string[] };

export const IMAGE_DEFAULT_UID = 1000;

const BOX_USER = 'vscode';
const BOX_DIRS = ['/workspace', '/run/agentbox', '/var/log/agentbox', '/var/lib/agentbox'];
export const BOX_WORKTREE = '/workspace';

function firstLine(value: string): string {
  return value.trim().split('\n')[0] ?? '';
}

function parseId(value: string): number {
  return Number.parseInt(value.trim(), 10);
}

function issue(label: string, r: ExecResult): string {
  const detail = firstLine(r.stderr) || firstLine(r.stdout) || '';
  return `${label} failed (exit ${r.exitCode}${detail ? `: ${detail}` : ''})`;
}

/** errno(3) text for EROFS: what a read-only image mount in the box home produces. */
const READ_ONLY_FS_RE = /read-only file system$/i;

/**
 * Classifies a failed chown sweep. Returns the first failure line that is
 * NOT the expected read-only-filesystem (EROFS) noise from the box's
 * read-only image layers — the detail to surface as an issue — or null
 * when every failure line is that benign noise and the failure can be
 * ignored. GNU chown -R reports every failing file and continues the walk,
 * so a sweep failure whose lines are all EROFS means only image-owned
 * read-only files were skipped and alignment is otherwise complete. A
 * result with no failure lines is unclassifiable and surfaced as a plain
 * failure ('' means the issue carries no detail).
 */
function genuineSweepFailure(r: ExecResult): string | null {
  const lines = (r.stderr || r.stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return '';
  }
  for (const line of lines) {
    if (!READ_ONLY_FS_RE.test(line)) {
      return line;
    }
  }
  return null;
}

/**
 * A combined box shell runs several read probes in one agentbox round trip.
 * Each probe is followed by `echo __sander_exit_<key>=$?` so a failure keeps
 * its own per-command attribution; parseMarked splits the combined stdout
 * back into one segment per probe with that probe's exit code and output.
 */
interface MarkedSegment {
  key: string;
  exit: number;
  output: string;
}

const MARKED_EXIT_RE = /^__sander_exit_([A-Za-z0-9_]+)=(-?\d+)$/;

function parseMarked(stdout: string): MarkedSegment[] {
  const segments: MarkedSegment[] = [];
  let current: string[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    const m = MARKED_EXIT_RE.exec(line);
    if (m !== null) {
      segments.push({ key: m[1], exit: Number.parseInt(m[2], 10), output: current.join('\n') });
      current = [];
    } else if (line !== '') {
      current.push(line);
    }
  }
  return segments;
}

/** Rebuilds one probe's ExecResult from a combined shell run. */
function markedResult(segments: MarkedSegment[], whole: ExecResult, key: string): ExecResult {
  const segment = segments.find((s) => s.key === key);
  return {
    exitCode: segment?.exit ?? whole.exitCode,
    stdout: segment?.output ?? '',
    stderr: whole.stderr,
  };
}

/**
 * Aligns the agentbox container user (vscode, image default uid/gid 1000) to
 * the host user's uid/gid so files the box writes into the bind-mounted host
 * .git are owned by the host user. Runs entirely through the injected `exec`
 * seam (agentbox shell --user root / default user). Never throws for box-side
 * failures: every best-effort step records an issue and the caller decides
 * severity.
 */
export async function alignBoxUser(opts: BoxUserAlignOptions): Promise<BoxUserAlignResult> {
  const { exec, hostUid, hostGid, projectRoot, gitDir } = opts;

  if (hostUid <= 0) {
    return { skipped: true, reason: 'non-posix' };
  }
  if (hostUid === IMAGE_DEFAULT_UID) {
    return { skipped: true, reason: 'uid-1000-host' };
  }

  const issues: string[] = [];
  const asRoot = (argv: string[]): Promise<ExecResult> => exec(argv, { user: 'root' });
  const record = (label: string, r: ExecResult): void => {
    if (r.exitCode !== 0) {
      issues.push(issue(label, r));
    }
  };

  // Combined uid+gid probe: one shell for both `id` reads, with per-command
  // exit markers so a failing probe keeps its own attribution.
  const probe = await asRoot([
    'sh',
    '-c',
    'id -u "$1"; echo __sander_exit_uid=$?; id -g "$1"; echo __sander_exit_gid=$?',
    'sh',
    BOX_USER,
  ]);
  const probeSegments = parseMarked(probe.stdout);
  const probeUid = markedResult(probeSegments, probe, 'uid');
  const probeGid = markedResult(probeSegments, probe, 'gid');
  if (probeUid.exitCode !== 0) {
    return {
      skipped: false,
      fromUid: -1,
      toUid: hostUid,
      toGid: hostGid,
      issues: [
        probeUid.stderr.trim() !== ''
          ? `probe of the box user uid failed: ${firstLine(probeUid.stderr)}`
          : `probe of the box user uid failed (exit ${probeUid.exitCode})`,
      ],
    };
  }
  const oldUid = parseId(probeUid.stdout);
  if (oldUid === hostUid) {
    return { skipped: true, reason: 'already-aligned' };
  }

  const oldGid = probeGid.exitCode === 0 ? parseId(probeGid.stdout) : Number.NaN;
  if (probeGid.exitCode !== 0) {
    issues.push(
      probeGid.stderr.trim() !== ''
        ? `probe of the box user gid failed; skipping group alignment: ${firstLine(probeGid.stderr)}`
        : `probe of the box user gid failed (exit ${probeGid.exitCode}); skipping group alignment`,
    );
  } else if (hostGid > 0 && oldGid !== hostGid) {
    record('groupmod', await asRoot(['groupmod', '-g', String(hostGid), BOX_USER]));
  }

  const usermod = await asRoot(['usermod', '-u', String(hostUid), '-g', BOX_USER, BOX_USER]);
  if (usermod.exitCode !== 0) {
    issues.push(issue('usermod', usermod));
    return { skipped: false, fromUid: oldUid, toUid: hostUid, toGid: hostGid, issues };
  }

  const homeSweep = await asRoot(['chown', '-R', `${BOX_USER}:${BOX_USER}`, `/home/${BOX_USER}`]);
  if (homeSweep.exitCode !== 0) {
    const detail = genuineSweepFailure(homeSweep);
    if (detail !== null) {
      issues.push(issue('home sweep', { ...homeSweep, stderr: detail }));
    }
  }
  record('box dirs sweep', await asRoot(['chown', `${BOX_USER}:${BOX_USER}`, ...BOX_DIRS]));
  if (gitDir !== null) {
    record('git residue sweep', await asRoot(['chown', '-R', `--from=${oldUid}`, `${BOX_USER}:${BOX_USER}`, gitDir]));
  }
  record('project root sweep', await asRoot(['chown', `${BOX_USER}:${BOX_USER}`, projectRoot]));

  const verify = await asRoot(['id', '-u', BOX_USER]);
  if (verify.exitCode !== 0 || parseId(verify.stdout) !== hostUid) {
    const got = verify.exitCode === 0 ? String(parseId(verify.stdout)) : 'unknown';
    issues.push(`verification failed: the box user uid is ${got}, expected ${hostUid}`);
  }

  if (gitDir !== null) {
    const asBoxUser = (argv: string[]): Promise<ExecResult> => exec(argv);
    // Combined git probes: one shell for the worktreeConfig write, the
    // gpgsign write, and the status read, each with its own exit marker.
    const gitProbes = await asBoxUser([
      'sh',
      '-c',
      'git -C "$1" config extensions.worktreeConfig true; echo __sander_exit_config=$?; ' +
        'git -C "$2" config --worktree commit.gpgsign false; echo __sander_exit_gpgsign=$?; ' +
        'git -C "$2" status --porcelain; echo __sander_exit_status=$?',
      'sh',
      gitDir,
      BOX_WORKTREE,
    ]);
    const gitSegments = parseMarked(gitProbes.stdout);
    record('worktree config', markedResult(gitSegments, gitProbes, 'config'));
    record('worktree gpgsign', markedResult(gitSegments, gitProbes, 'gpgsign'));
    record('worktree status', markedResult(gitSegments, gitProbes, 'status'));
  }

  return { skipped: false, fromUid: oldUid, toUid: hostUid, toGid: hostGid, issues };
}

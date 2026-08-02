import { describe, expect, it } from 'vitest';
import { alignBoxUser, IMAGE_DEFAULT_UID } from './box-user';
import type { BoxUserExec, BoxUserAlignResult } from './box-user';
import type { ExecResult } from './provider';

interface Call {
  argv: string[];
  user?: string;
  timeoutMs?: number;
}

function result(overrides: Partial<ExecResult> = {}): ExecResult {
  return { exitCode: 0, stdout: '', stderr: '', ...overrides };
}

function makeExec(): { exec: BoxUserExec; calls: Call[]; next: ExecResult[] } {
  const calls: Call[] = [];
  const next: ExecResult[] = [];
  const exec: BoxUserExec = async (argv, opts) => {
    calls.push({ argv, user: opts?.user, timeoutMs: opts?.timeoutMs });
    return next.shift() ?? result();
  };
  return { exec, calls, next };
}

const opts = {
  hostUid: 1001,
  hostGid: 1001,
  projectRoot: '/proj',
  gitDir: '/proj/.git',
};

function scriptSuccess(next: ExecResult[], hostUid: number): void {
  // Combined uid+gid probe: id -u then id -g, each with its own exit marker.
  next.push(result({ stdout: '1000\n__sander_exit_uid=0\n1000\n__sander_exit_gid=0\n' }));
  next.push(result()); // groupmod -g <hostGid> vscode
  next.push(result()); // usermod -u <hostUid> -g vscode vscode
  next.push(result()); // chown -R vscode:vscode /home/vscode
  next.push(result()); // chown vscode:vscode <box dirs>
  next.push(result()); // chown -R --from=1000 vscode:vscode <gitDir>
  next.push(result()); // chown vscode:vscode <projectRoot>
  next.push(result({ stdout: `${hostUid}\n` })); // verify id -u vscode
  // Combined git probes: worktreeConfig write, gpgsign write, status read.
  next.push(result({ stdout: '__sander_exit_config=0\n__sander_exit_gpgsign=0\n__sander_exit_status=0\n' }));
}

describe('alignBoxUser', () => {
  it('skips with zero exec calls when the host uid is the image default 1000', async () => {
    const { exec, calls } = makeExec();
    const out: BoxUserAlignResult = await alignBoxUser({ ...opts, exec, hostUid: IMAGE_DEFAULT_UID, hostGid: 1000 });
    expect(out).toEqual({ skipped: true, reason: 'uid-1000-host' });
    expect(calls).toHaveLength(0);
  });

  it('skips on a non-POSIX host (no uid available)', async () => {
    const { exec, calls } = makeExec();
    const out = await alignBoxUser({ ...opts, exec, hostUid: -1, hostGid: -1 });
    expect(out).toEqual({ skipped: true, reason: 'non-posix' });
    expect(calls).toHaveLength(0);
  });

  it('skips as already-aligned after probing when the box uid already matches', async () => {
    const { exec, calls, next } = makeExec();
    next.push(result({ stdout: '1001\n__sander_exit_uid=0\n1001\n__sander_exit_gid=0\n' }));
    const out = await alignBoxUser({ ...opts, exec });
    expect(out).toEqual({ skipped: true, reason: 'already-aligned' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ argv: ['sh', '-c', 'id -u "$1"; echo __sander_exit_uid=$?; id -g "$1"; echo __sander_exit_gid=$?', 'sh', 'vscode'], user: 'root' });
  });

  it('runs the full alignment sequence in order, root steps then box-user git steps', async () => {
    const { exec, calls, next } = makeExec();
    scriptSuccess(next, opts.hostUid);
    const out = await alignBoxUser({ ...opts, exec });

    expect(out).toEqual({ skipped: false, fromUid: 1000, toUid: 1001, toGid: 1001, issues: [] });
    expect(calls.map((c) => c.argv)).toEqual([
      ['sh', '-c', 'id -u "$1"; echo __sander_exit_uid=$?; id -g "$1"; echo __sander_exit_gid=$?', 'sh', 'vscode'],
      ['groupmod', '-g', '1001', 'vscode'],
      ['usermod', '-u', '1001', '-g', 'vscode', 'vscode'],
      ['chown', '-R', 'vscode:vscode', '/home/vscode'],
      ['chown', 'vscode:vscode', '/workspace', '/run/agentbox', '/var/log/agentbox', '/var/lib/agentbox'],
      ['chown', '-R', '--from=1000', 'vscode:vscode', '/proj/.git'],
      ['chown', 'vscode:vscode', '/proj'],
      ['id', '-u', 'vscode'],
      [
        'sh',
        '-c',
        'git -C "$1" config extensions.worktreeConfig true; echo __sander_exit_config=$?; ' +
          'git -C "$2" config --worktree commit.gpgsign false; echo __sander_exit_gpgsign=$?; ' +
          'git -C "$2" status --porcelain; echo __sander_exit_status=$?',
        'sh',
        '/proj/.git',
        '/workspace',
      ],
    ]);
    const rootCalls = calls.slice(0, 8);
    for (const c of rootCalls) expect(c.user).toBe('root');
    for (const c of calls.slice(8)) expect(c.user).toBeUndefined();
  });

  it('skips groupmod when the box gid already matches the host gid', async () => {
    const { exec, calls, next } = makeExec();
    next.push(result({ stdout: '1000\n__sander_exit_uid=0\n1001\n__sander_exit_gid=0\n' })); // old uid 1000, old gid == hostGid
    next.push(result()); // usermod
    next.push(result()); // chown -R /home/vscode
    next.push(result()); // chown dirs
    next.push(result()); // chown --from
    next.push(result()); // chown projectRoot
    next.push(result({ stdout: '1001\n' })); // verify
    next.push(result({ stdout: '__sander_exit_config=0\n__sander_exit_gpgsign=0\n__sander_exit_status=0\n' })); // git probes
    const out = await alignBoxUser({ ...opts, exec });
    expect(out).toEqual({ skipped: false, fromUid: 1000, toUid: 1001, toGid: 1001, issues: [] });
    expect(calls.map((c) => c.argv[0])).not.toContain('groupmod');
  });

  it('records best-effort failures in issues and keeps going', async () => {
    const { exec, calls, next } = makeExec();
    scriptSuccess(next, opts.hostUid);
    next[1] = result({ exitCode: 1, stderr: 'groupmod: GID 1001 already exists\n' });
    next[3] = result({ exitCode: 1, stderr: 'chown: changing ownership of /home/vscode/.ssh: Operation not permitted\n' });
    const out = await alignBoxUser({ ...opts, exec });

    expect(out.skipped).toBe(false);
    if (!out.skipped) {
      expect(out.issues).toEqual([
        'groupmod failed (exit 1: groupmod: GID 1001 already exists)',
        'home sweep failed (exit 1: chown: changing ownership of /home/vscode/.ssh: Operation not permitted)',
      ]);
      expect(calls).toHaveLength(9); // the full sequence still ran
    }
  });

  it('tolerates a home sweep that only hit read-only files and records no issue', async () => {
    const { exec, calls, next } = makeExec();
    scriptSuccess(next, opts.hostUid);
    next[3] = result({ exitCode: 1, stderr: "chown: changing ownership of '/home/vscode/.gitconfig': Read-only file system\n" });
    const out = await alignBoxUser({ ...opts, exec });

    expect(out.skipped).toBe(false);
    if (!out.skipped) {
      expect(out.issues).toEqual([]);
      expect(calls).toHaveLength(9); // the full sequence still ran
      expect(calls[3].argv).toEqual(['chown', '-R', 'vscode:vscode', '/home/vscode']); // sweep still attempted
    }
  });

  it('still records a home sweep issue when a genuine failure is mixed with read-only noise', async () => {
    const { exec, calls, next } = makeExec();
    scriptSuccess(next, opts.hostUid);
    next[3] = result({
      exitCode: 1,
      stderr: "chown: changing ownership of '/home/vscode/.gitconfig': Read-only file system\nchown: changing ownership of /home/vscode/.ssh: Operation not permitted\n",
    });
    const out = await alignBoxUser({ ...opts, exec });

    expect(out.skipped).toBe(false);
    if (!out.skipped) {
      expect(out.issues).toEqual([
        'home sweep failed (exit 1: chown: changing ownership of /home/vscode/.ssh: Operation not permitted)',
      ]);
      expect(calls).toHaveLength(9);
    }
  });

  it('keeps reporting other sweeps when the home sweep failure is read-only noise', async () => {
    const { exec, calls, next } = makeExec();
    scriptSuccess(next, opts.hostUid);
    next[3] = result({ exitCode: 1, stderr: "chown: changing ownership of '/home/vscode/.gitconfig': Read-only file system\n" });
    next[5] = result({ exitCode: 1, stderr: 'chown: changing ownership of /proj/.git/objects: Operation not permitted\n' });
    const out = await alignBoxUser({ ...opts, exec });

    expect(out.skipped).toBe(false);
    if (!out.skipped) {
      expect(out.issues).toEqual([
        'git residue sweep failed (exit 1: chown: changing ownership of /proj/.git/objects: Operation not permitted)',
      ]);
      expect(calls).toHaveLength(9);
    }
  });

  it('stops after a failed usermod without running sweeps or git steps', async () => {
    const { exec, calls, next } = makeExec();
    next.push(result({ stdout: '1000\n__sander_exit_uid=0\n1000\n__sander_exit_gid=0\n' })); // combined probe
    next.push(result()); // groupmod
    next.push(result({ exitCode: 1, stderr: 'usermod: user vscode is currently used by process 42\n' }));
    const out = await alignBoxUser({ ...opts, exec });

    expect(out.skipped).toBe(false);
    if (!out.skipped) {
      expect(out).toEqual({
        skipped: false,
        fromUid: 1000,
        toUid: 1001,
        toGid: 1001,
        issues: ['usermod failed (exit 1: usermod: user vscode is currently used by process 42)'],
      });
      expect(calls).toHaveLength(3); // combined probe, groupmod, usermod — nothing after
    }
  });

  it('skips git sweeps and worktree steps when gitDir is null', async () => {
    const { exec, calls, next } = makeExec();
    scriptSuccess(next, opts.hostUid);
    const out = await alignBoxUser({ ...opts, exec, gitDir: null });

    expect(out.skipped).toBe(false);
    const argv = calls.map((c) => c.argv);
    expect(argv.some((a) => a.includes('--from='))).toBe(false);
    expect(argv.some((a) => a[0] === 'git')).toBe(false);
    expect(argv.map((a) => a[0])).toEqual(['sh', 'groupmod', 'usermod', 'chown', 'chown', 'chown', 'id']);
  });

  it('reports a verification mismatch as an issue', async () => {
    const { exec, calls, next } = makeExec();
    scriptSuccess(next, opts.hostUid);
    next[7] = result({ stdout: '1002\n' }); // verify probe disagrees
    const out = await alignBoxUser({ ...opts, exec });
    expect(out.skipped).toBe(false);
    if (!out.skipped) {
      expect(out.issues).toContain('verification failed: the box user uid is 1002, expected 1001');
    }
  });

  it('reports a probe failure and stops instead of guessing the old uid', async () => {
    const { exec, calls, next } = makeExec();
    next.push(result({ exitCode: 1, stderr: 'docker: Error response from daemon: container not found\n' }));
    const out = await alignBoxUser({ ...opts, exec });

    expect(out.skipped).toBe(false);
    if (!out.skipped) {
      expect(out.fromUid).toBe(-1);
      expect(out.issues).toEqual(['probe of the box user uid failed: docker: Error response from daemon: container not found']);
      expect(calls).toHaveLength(1);
    }
  });

  it('reports a uid probe failure from inside the combined probe and stops', async () => {
    const { exec, calls, next } = makeExec();
    next.push(
      result({ exitCode: 1, stderr: "id: 'vscode': no such user\n", stdout: '__sander_exit_uid=1\n__sander_exit_gid=0\n' })
    );
    const out = await alignBoxUser({ ...opts, exec });

    expect(out.skipped).toBe(false);
    if (!out.skipped) {
      expect(out.fromUid).toBe(-1);
      expect(out.issues).toEqual(["probe of the box user uid failed: id: 'vscode': no such user"]);
      expect(calls).toHaveLength(1);
    }
  });

  it('reports a gid probe failure from inside the combined probe and skips group alignment', async () => {
    const { exec, calls, next } = makeExec();
    next.push(
      result({
        exitCode: 1,
        stdout: '1000\n__sander_exit_uid=0\n__sander_exit_gid=1\n',
        stderr: "id: 'vscode': no such group\n",
      }),
      result(), // usermod
      result(), // chown -R /home/vscode
      result(), // chown dirs
      result(), // chown --from
      result(), // chown projectRoot
      result({ stdout: '1001\n' }), // verify
      result({ stdout: '__sander_exit_config=0\n__sander_exit_gpgsign=0\n__sander_exit_status=0\n' }), // git probes
    );
    const out = await alignBoxUser({ ...opts, exec });

    expect(out.skipped).toBe(false);
    if (!out.skipped) {
      expect(out.issues).toEqual([
        "probe of the box user gid failed; skipping group alignment: id: 'vscode': no such group",
      ]);
      expect(calls.map((c) => c.argv[0])).not.toContain('groupmod');
    }
  });

  it('keeps per-command attribution when a trailing git probe fails', async () => {
    const { exec, calls, next } = makeExec();
    scriptSuccess(next, opts.hostUid);
    next[8] = result({
      exitCode: 1,
      stdout: '__sander_exit_config=0\n__sander_exit_gpgsign=1\n__sander_exit_status=0\n',
      stderr: "error: could not lock config file /workspace/.git/config.worktree: Permission denied\n",
    });
    const out = await alignBoxUser({ ...opts, exec });

    expect(out.skipped).toBe(false);
    if (!out.skipped) {
      expect(out.issues).toEqual([
        'worktree gpgsign failed (exit 1: error: could not lock config file /workspace/.git/config.worktree: Permission denied)',
      ]);
    }
  });
});

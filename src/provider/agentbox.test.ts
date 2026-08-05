import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentboxProvider, tmuxSessionArgs } from './agentbox';
import { CliError } from '../cli/errors';
import type { AsyncCommandRunner, CommandRunner, RunResult } from '../process/run';
import { run } from '../process/run';
import type { InteractiveRunner, PtyOptions } from '../process/pty';
import { containerNameForSandbox } from '../names/sandbox-name';
import { checkGitAccess, effectiveWriteExec } from './gitaccess';

function result(overrides: Partial<RunResult> = {}): RunResult {
  return { exitCode: 0, stdout: '', stderr: '', ...overrides };
}

interface RunnerCall {
  args: string[];
  env?: NodeJS.ProcessEnv;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sander-agentbox-test-'));
}

function makeProvider(opts: { hostUid?: number; hostGid?: number; providerName?: string; debug?: boolean } = {}): {
  provider: AgentboxProvider;
  calls: RunnerCall[];
  next: RunResult[];
  gitCalls: string[][];
  nextGit: RunResult[];
  dockerCalls: string[][];
  nextDocker: RunResult[];
} {
  const calls: RunnerCall[] = [];
  const next: RunResult[] = [];
  const gitCalls: string[][] = [];
  const nextGit: RunResult[] = [];
  const dockerCalls: string[][] = [];
  const nextDocker: RunResult[] = [];
  const runner: AsyncCommandRunner = async (args, opts) => {
    calls.push({ args, env: opts?.env });
    return next.shift() ?? result();
  };
  const gitRunner: CommandRunner = (args) => {
    gitCalls.push(args);
    return nextGit.shift() ?? result();
  };
  const dockerRunner: CommandRunner = (args) => {
    dockerCalls.push(args);
    return nextDocker.shift() ?? result();
  };
  return {
    provider: new AgentboxProvider({
      runner,
      gitRunner,
      dockerRunner,
      markerPath: path.join(tmpDir(), 'setup-complete.json'),
      hostUid: opts.hostUid ?? 1000,
      hostGid: opts.hostGid ?? 1000,
      providerName: opts.providerName,
      debug: opts.debug,
    }),
    calls,
    next,
    gitCalls,
    nextGit,
    dockerCalls,
    nextDocker,
  };
}

function makeProviderWithRealGit(): { provider: AgentboxProvider; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: AsyncCommandRunner = async (args, opts) => {
    calls.push({ args, env: opts?.env });
    return result();
  };
  return {
    provider: new AgentboxProvider({ runner, markerPath: path.join(tmpDir(), 'setup-complete.json'), hostUid: 1000, hostGid: 1000 }),
    calls,
  };
}

describe('AgentboxProvider', () => {
  it('creates a box via the agentbox create command', async () => {
    const { provider, calls, gitCalls } = makeProvider();
    await provider.prepareCreate({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
    const info = await provider.create({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
    expect(info).toEqual({ id: 'demo' });
    expect(gitCalls).toEqual([['-C', '/tmp/proj', 'branch', 'demo', 'HEAD']]);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['create', '--provider', 'docker', '-w', '/tmp/proj', '-n', 'demo', '-b', 'demo', '-y', '--carry-yes']);
  });

  it('passes the configured provider name as --provider to the create command', async () => {
    const { provider, calls } = makeProvider({ providerName: 'vercel' });
    const info = await provider.create({ id: 'demo', provider: 'vercel', harness: 'opencode', projectRoot: '/tmp/proj' });
    expect(info).toEqual({ id: 'demo' });
    expect(calls[0].args).toEqual(['create', '--provider', 'vercel', '-w', '/tmp/proj', '-n', 'demo', '-b', 'demo', '-y', '--carry-yes']);
  });

  it('reuses an already-existing box branch', async () => {
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderr.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const { provider, calls, nextGit } = makeProvider();
      nextGit.push(result({ exitCode: 1, stderr: "fatal: a branch named 'demo' already exists" }));
      await provider.prepareCreate({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
      const info = await provider.create({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
      expect(info).toEqual({ id: 'demo' });
      expect(calls[0].args).toEqual(['create', '--provider', 'docker', '-w', '/tmp/proj', '-n', 'demo', '-b', 'demo', '-y', '--carry-yes']);
      // Reuse is expected behaviour, but a later `rm` would delete the branch by
      // default, so the user must be told the pre-existing branch is being taken over.
      expect(stderr.join('')).toContain('Aviso: la rama "demo" ya existía y se reutilizará para el sandbox');
      expect(stderr.join('')).toContain('--dont-delete-branch');
    } finally {
      process.stderr.write = original;
    }
  });

  it('throws a CliError when the box branch cannot be prepared', async () => {
    const { provider, nextGit } = makeProvider();
    nextGit.push(result({ exitCode: 128, stderr: 'fatal: not a git repository' }));
    const promise = provider.prepareCreate({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
    await expect(promise).rejects.toThrow(CliError);
    await expect(promise).rejects.toThrow(/Could not prepare branch "demo" for agentbox/);
  });

  it('forwards the requested env to the agentbox create process', async () => {
    const { provider, calls } = makeProvider();
    await provider.create({
      id: 'demo',
      provider: 'agentbox',
      harness: 'opencode',
      projectRoot: '/tmp/proj',
      env: { GITHUB_TOKEN: 'ghp-secret', ANTHROPIC_API_KEY: 'sk-ant-secret' },
    });
    expect(calls[0].env).toMatchObject({ GITHUB_TOKEN: 'ghp-secret', ANTHROPIC_API_KEY: 'sk-ant-secret' });
  });

  it('adds non-interactive git env only to the agentbox create process', async () => {
    const { provider, calls } = makeProvider();
    await provider.create({
      id: 'demo',
      provider: 'agentbox',
      harness: 'opencode',
      projectRoot: '/tmp/proj',
      env: { GITHUB_TOKEN: 'ghp-secret' },
    });
    await provider.exec('demo', ['sh', '-c', 'true']);
    expect(calls[0].env).toMatchObject({
      GITHUB_TOKEN: 'ghp-secret',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
      GIT_TERMINAL_PROMPT: '0',
    });
    // scoped to create: other agentbox processes must NOT carry the vars
    expect(calls[1].env ?? {}).not.toHaveProperty('GIT_SSH_COMMAND');
    expect(calls[1].env ?? {}).not.toHaveProperty('GIT_TERMINAL_PROMPT');
  });

  it('real git: makes the host-created branch refs dir writable by the box user', async () => {
    const root = tmpDir();
    run('git', ['init', '-q', '-b', 'main', root]);
    run('git', ['-C', root, 'config', 'user.email', 't@t.t']);
    run('git', ['-C', root, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(root, 'f.txt'), 'hi');
    run('git', ['-C', root, 'add', 'f.txt']);
    run('git', ['-C', root, 'commit', '-qm', 'init']);

    // Simulate the regression: sander already created the branch on the host,
    // leaving .git/refs/heads/feature/ host-owned at 0755.
    run('git', ['-C', root, 'branch', 'feature/demo', 'HEAD']);
    fs.chmodSync(path.join(root, '.git', 'refs', 'heads', 'feature'), 0o755);

    const hostUid = fs.statSync(path.join(root, '.git')).uid;
    const boxUid = hostUid === 1000 ? 2000 : 1000; // box user distinct from host uid
    expect(checkGitAccess(root, boxUid).ok).toBe(false); // pre: box cannot write

    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderr.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const { provider, calls } = makeProviderWithRealGit();
      await provider.prepareCreate({ id: 'feature/demo', provider: 'agentbox', harness: 'opencode', projectRoot: root });
      const info = await provider.create({ id: 'feature/demo', provider: 'agentbox', harness: 'opencode', projectRoot: root });

      expect(info).toEqual({ id: 'feature/demo' });
      expect(calls[0].args).toEqual(['create', '--provider', 'docker', '-w', root, '-n', containerNameForSandbox('feature/demo'), '-b', 'feature/demo', '-y', '--carry-yes']);
      expect(checkGitAccess(root, boxUid).ok).toBe(true); // post: box can write
      expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/feature/demo']).exitCode).toBe(0);
      // The rejected sander/ namespace must not reappear: create only makes the plain id branch.
      expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/sander/demo']).exitCode).not.toBe(0);
      // The pre-existing branch is a reuse case, so create warns about the takeover.
      expect(stderr.join('')).toContain('Aviso: la rama "feature/demo" ya existía y se reutilizará para el sandbox');
    } finally {
      process.stderr.write = original;
    }
  });

  it('real git: slash-name branch only fixes the new refs component when .git is already writable', async () => {
    const root = tmpDir();
    run('git', ['init', '-q', '-b', 'main', root]);
    run('git', ['-C', root, 'config', 'user.email', 't@t.t']);
    run('git', ['-C', root, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(root, 'f.txt'), 'hi');
    run('git', ['-C', root, 'add', 'f.txt']);
    run('git', ['-C', root, 'commit', '-qm', 'init']);
    // .git is already writable by the box user (e.g. a previous create fixed it).
    const git = path.join(root, '.git');
    run('chmod', ['-R', 'a+rwX', git]);
    const hostUid = fs.statSync(git).uid;
    const boxUid = hostUid === 1000 ? 2000 : 1000;
    expect(checkGitAccess(root, boxUid).ok).toBe(true);

    // `git branch feature/demo` leaves the new nested refs dir host-owned at
    // 0755 — invisible to the pre-branch check.
    run('git', ['-C', root, 'branch', 'feature/demo', 'HEAD']);
    const nested = path.join(git, 'refs', 'heads', 'feature');
    fs.chmodSync(nested, 0o755);
    expect(effectiveWriteExec(boxUid, fs.statSync(nested))).toBe(false);

    const { provider } = makeProviderWithRealGit();
    await provider.prepareCreate({ id: 'feature/demo', provider: 'agentbox', harness: 'opencode', projectRoot: root });

    // The box user can now write the new refs dir before agentbox create runs
    // its in-container `git worktree add`.
    expect(effectiveWriteExec(boxUid, fs.statSync(nested))).toBe(true);
    expect(checkGitAccess(root, boxUid).ok).toBe(true);
    expect(run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/feature/demo']).exitCode).toBe(0);
  });

  it('throws a CliError when agentbox create fails', async () => {
    const { provider, next } = makeProvider();
    next.push(result({ exitCode: 1, stderr: 'boom' }));
    const promise = provider.create({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
    await expect(promise).rejects.toThrow(CliError);
    await expect(promise).rejects.toThrow(/agentbox create failed: boom/);
  });

  it('skips the box-user alignment bootstrap when the host uid is the image default', async () => {
    const { provider, calls } = makeProvider(); // hostUid defaults to 1000
    await provider.prepareCreate({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
    await provider.create({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
    await provider.finalizeCreate({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
    expect(calls).toHaveLength(1); // only the agentbox create process
    expect(calls[0].args[0]).toBe('create');
  });

  it('runs the box-user alignment bootstrap after create when the host uid differs', async () => {
    const root = tmpDir();
    run('git', ['init', '-q', '-b', 'main', root]);
    const gitDir = path.join(root, '.git');
    const { provider, calls, next } = makeProvider({ hostUid: 1001, hostGid: 1001 });
    next.push(
      result(), // agentbox create
      result({ stdout: '1000\n__sander_exit_uid=0\n1000\n__sander_exit_gid=0\n' }), // combined uid+gid probe
      result(), // groupmod -g 1001 vscode
      result(), // usermod -u 1001 -g vscode vscode
      result(), // chown -R vscode:vscode /home/vscode
      result(), // chown vscode:vscode <box dirs>
      result(), // chown -R --from=1000 vscode:vscode <gitDir>
      result(), // chown vscode:vscode <projectRoot>
      result({ stdout: '1001\n' }), // verify uid
      result({ stdout: '__sander_exit_config=0\n__sander_exit_gpgsign=0\n__sander_exit_status=0\n' }), // combined git probes
    );
    await provider.prepareCreate({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: root });
    const info = await provider.create({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: root });
    await provider.finalizeCreate({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: root });

    expect(info).toEqual({ id: 'demo' });
    expect(calls[0].args).toEqual(['create', '--provider', 'docker', '-w', root, '-n', 'demo', '-b', 'demo', '-y', '--carry-yes']);
    expect(calls.slice(1).map((c) => c.args)).toEqual([
      ['shell', 'demo', '--user', 'root', '--', 'sh', '-c', 'id -u "$1"; echo __sander_exit_uid=$?; id -g "$1"; echo __sander_exit_gid=$?', 'sh', 'vscode'],
      ['shell', 'demo', '--user', 'root', '--', 'groupmod', '-g', '1001', 'vscode'],
      ['shell', 'demo', '--user', 'root', '--', 'usermod', '-u', '1001', '-g', 'vscode', 'vscode'],
      ['shell', 'demo', '--user', 'root', '--', 'chown', '-R', 'vscode:vscode', '/home/vscode'],
      ['shell', 'demo', '--user', 'root', '--', 'chown', 'vscode:vscode', '/workspace', '/run/agentbox', '/var/log/agentbox', '/var/lib/agentbox'],
      ['shell', 'demo', '--user', 'root', '--', 'chown', '-R', '--from=1000', 'vscode:vscode', gitDir],
      ['shell', 'demo', '--user', 'root', '--', 'chown', 'vscode:vscode', root],
      ['shell', 'demo', '--user', 'root', '--', 'id', '-u', 'vscode'],
      ['shell', 'demo', '--', 'sh', '-c', 'git -C "$1" config extensions.worktreeConfig true; echo __sander_exit_config=$?; git -C "$2" config --worktree commit.gpgsign false; echo __sander_exit_gpgsign=$?; git -C "$2" status --porcelain; echo __sander_exit_status=$?', 'sh', gitDir, '/workspace'],
    ]);
    for (const call of calls.slice(1, 9)) expect(call.args[2]).toBe('--user');
    for (const call of calls.slice(9)) expect(call.args[2]).toBe('--');
  });

  it('does not run git sweeps when the project is not a git repository', async () => {
    const { provider, calls, next } = makeProvider({ hostUid: 1001, hostGid: 1001 });
    next.push(
      result(), // agentbox create
      result({ stdout: '1000\n__sander_exit_uid=0\n1000\n__sander_exit_gid=0\n' }), // combined probe
      result(), // groupmod
      result(), // usermod
      result(), // chown home
      result(), // chown dirs
      result(), // chown projectRoot
      result({ stdout: '1001\n' }), // verify uid
    );
    await provider.prepareCreate({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
    await provider.create({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
    await provider.finalizeCreate({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });

    const bootstrap = calls.slice(1).map((c) => c.args.join(' '));
    expect(bootstrap.some((a) => a.includes('--from='))).toBe(false);
    expect(bootstrap.some((a) => a.includes('git'))).toBe(false);
  });

  it('warns on stderr without throwing when the alignment has best-effort issues', async () => {
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderr.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    const root = tmpDir();
    run('git', ['init', '-q', '-b', 'main', root]);
    const { provider, next } = makeProvider({ hostUid: 1001, hostGid: 1001 });
    next.push(
      result(), // agentbox create
      result({ stdout: '1000\n__sander_exit_uid=0\n1000\n__sander_exit_gid=0\n' }), // combined probe
      result(), // groupmod
      result(), // usermod
      result({ exitCode: 1, stderr: 'chown: cannot read directory /home/vscode: Permission denied' }), // home sweep fails
      result(), // chown dirs
      result(), // chown --from
      result(), // chown projectRoot
      result({ stdout: '1001\n' }), // verify uid
      result({ stdout: '__sander_exit_config=0\n__sander_exit_gpgsign=0\n__sander_exit_status=0\n' }), // combined git probes
    );
    try {
      await provider.prepareCreate({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: root });
      await provider.create({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: root });
      await provider.finalizeCreate({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: root });
      expect(stderr.join('')).toContain('warning: box user uid/gid alignment is incomplete');
      expect(stderr.join('')).toContain('home sweep failed');
    } finally {
      process.stderr.write = original;
    }
  });

  it('does not warn when the home sweep only hit read-only image files', async () => {
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderr.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    const root = tmpDir();
    run('git', ['init', '-q', '-b', 'main', root]);
    const { provider, calls, next } = makeProvider({ hostUid: 1001, hostGid: 1001 });
    next.push(
      result(), // agentbox create
      result({ stdout: '1000\n__sander_exit_uid=0\n1000\n__sander_exit_gid=0\n' }), // combined probe
      result(), // groupmod
      result(), // usermod
      result({ exitCode: 1, stderr: "chown: changing ownership of '/home/vscode/.gitconfig': Read-only file system" }), // home sweep hits only read-only files
      result(), // chown dirs
      result(), // chown --from
      result(), // chown projectRoot
      result({ stdout: '1001\n' }), // verify uid
      result({ stdout: '__sander_exit_config=0\n__sander_exit_gpgsign=0\n__sander_exit_status=0\n' }), // combined git probes
    );
    try {
      await provider.prepareCreate({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: root });
      await provider.create({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: root });
      await provider.finalizeCreate({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: root });
      expect(stderr.join('')).toBe(''); // no warning on a successful create
      expect(calls.some((c) => c.args.join(' ').includes('chown -R vscode:vscode /home/vscode'))).toBe(true); // sweep still ran
    } finally {
      process.stderr.write = original;
    }
  });

  it('executes a command inside a box and preserves the exit code', async () => {
    const { provider, calls, next } = makeProvider();
    next.push(result({ exitCode: 3, stdout: 'out', stderr: 'err' }));
    const exec = await provider.exec('demo', ['sh', '-c', 'true']);
    expect(exec).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' });
    expect(calls[0].args).toEqual(['shell', 'demo', '--', 'sh', '-c', 'true']);
  });

  it('executes a command inside a box with a forced cwd via a shell wrap', async () => {
    const { provider, calls, next } = makeProvider();
    next.push(result({ exitCode: 0, stdout: 'ok' }));
    const exec = await provider.exec('demo', ['opencode', 'run', 'the prompt'], { cwd: '/workspace' });
    expect(exec).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
    expect(calls[0].args).toEqual([
      'shell',
      'demo',
      '--',
      'sh',
      '-c',
      'cd "$1" && shift && exec "$@"',
      'sh',
      '/workspace',
      'opencode',
      'run',
      'the prompt',
    ]);
  });

  it('probes whether a file is executable inside the box', async () => {
    const { provider, calls, next } = makeProvider();
    next.push(result({ exitCode: 0 }));
    expect(await provider.hasExecutable('demo', '/workspace/.sander/install.sh')).toBe(true);
    next.push(result({ exitCode: 1 }));
    expect(await provider.hasExecutable('demo', '/workspace/.sander/start.sh')).toBe(false);
    expect(calls.map((c) => c.args)).toEqual([
      ['shell', 'demo', '--', 'sh', '-c', 'test -f "$1" && test -x "$1"', 'sh', '/workspace/.sander/install.sh'],
      ['shell', 'demo', '--', 'sh', '-c', 'test -f "$1" && test -x "$1"', 'sh', '/workspace/.sander/start.sh'],
    ]);
  });

  it('copies files into a box with the box: path form', async () => {
    const { provider, calls } = makeProvider();
    await provider.copy('demo', '/host/stage', '/tmp/sander-config/opencode');
    expect(calls[0].args).toEqual(['cp', '/host/stage', 'demo:/tmp/sander-config/opencode']);
  });

  it('adds --yes to the copy argv only when the non-interactive flag is set', async () => {
    const { provider, calls } = makeProvider();
    await provider.copy('demo', '/host/stage', '/tmp/sander-config/opencode', { yes: true });
    expect(calls[0].args).toEqual(['cp', '--yes', '/host/stage', 'demo:/tmp/sander-config/opencode']);
  });

  it('pulls files from a box with the box: source form and --yes', async () => {
    const { provider, calls } = makeProvider();
    await provider.pull('demo', '/workspace/src/index.ts', '/host/worktree/src/index.ts');
    expect(calls[0].args).toEqual(['cp', '--yes', 'demo:/workspace/src/index.ts', '/host/worktree/src/index.ts']);
  });

  it('pulls from the mapped box name', async () => {
    const { provider, calls } = makeProvider();
    const name = containerNameForSandbox('feature/asd-jshdia');
    await provider.pull('feature/asd-jshdia', '/workspace/f.txt', '/host/f.txt');
    expect(calls[0].args).toEqual(['cp', '--yes', `${name}:/workspace/f.txt`, '/host/f.txt']);
  });

  it('surfaces a clear CliError when agentbox cp reports the size cap', async () => {
    const { provider, next } = makeProvider();
    next.push(result({ exitCode: 1, stderr: 'copy exceeds box.cpMaxBytes (100 MB)' }));
    const promise = provider.pull('demo', '/workspace/big.bin', '/host/big.bin');
    await expect(promise).rejects.toThrow(CliError);
    await expect(promise).rejects.toThrow(/supera el tope de 100 MB de agentbox cp/);
  });

  it('re-owns copied files to the aligned host uid after the cp on non-1000 hosts', async () => {
    const { provider, calls } = makeProvider({ hostUid: 1001, hostGid: 1001 });
    await provider.copy('demo', '/host/stage', '/tmp/sander-config/opencode');
    expect(calls.map((c) => c.args)).toEqual([
      ['cp', '/host/stage', 'demo:/tmp/sander-config/opencode'],
      [
        'shell',
        'demo',
        '--user',
        'root',
        '--',
        'sh',
        '-c',
        'chown -R "$1" "$2" && chown "$1" "$3"',
        'sh',
        '1001:1001',
        '/tmp/sander-config/opencode',
        '/tmp/sander-config',
      ],
    ]);
  });

  it('stops, starts, and removes boxes with the right flags', async () => {
    const { provider, calls } = makeProvider();
    await provider.stop('demo');
    await provider.start('demo');
    await provider.remove('demo');
    expect(calls.map((c) => c.args)).toEqual([
      ['stop', 'demo'],
      ['start', 'demo'],
      ['destroy', 'demo', '-y'],
    ]);
  });

  it('returns box names from agentbox list', async () => {
    const { provider, calls, next } = makeProvider();
    next.push(result({ stdout: JSON.stringify([{ name: 'a', id: 'x' }, { id: 'y' }, {}]) }));
    const list = await provider.list();
    expect(calls[0].args).toEqual(['ls', '-j']);
    expect(list).toEqual(['a', 'y', '']);
  });

  it('returns the exposed ports of a box from agentbox list', async () => {
    const { provider, calls, next } = makeProvider();
    next.push(result({ stdout: JSON.stringify([{ name: 'demo', state: 'running', webHostPort: 8080, vncHostPort: 5900 }, { name: 'other', state: 'running', webHostPort: 7000 }]) }));
    const ports = await provider.ports('demo');
    expect(calls[0].args).toEqual(['ls', '-j']);
    expect(ports).toEqual([{ host: '8080' }, { host: '5900' }]);
  });

  it('reads reachable endpoint URLs and dedupes against top-level host ports', async () => {
    const { provider, next } = makeProvider();
    next.push(result({ stdout: JSON.stringify([{ id: 'demo', state: 'running', webHostPort: 8080, vncHostPort: 5900, sshHostPort: 2222, ssh: { port: 2222 }, endpoints: { endpoints: [{ kind: 'web', containerPort: 80, url: 'http://127.0.0.1:8080/', reachable: true }, { kind: 'vnc', containerPort: 6080, url: 'http://127.0.0.1:5900/vnc.html?x=1', reachable: true }] } }]) }));
    expect(await provider.ports('demo')).toEqual([{ host: '8080', container: '80' }, { host: '5900', container: '6080' }, { host: '2222' }]);
  });

  it('maps top-level host ports to their container ports', async () => {
    const { provider, next } = makeProvider();
    next.push(result({ stdout: JSON.stringify([{ id: 'demo', state: 'running', webHostPort: 33015, webContainerPort: 80, vncHostPort: 33016, vncContainerPort: 6080, sshHostPort: 33014, sshContainerPort: 22, ssh: { port: 33014 } }]) }));
    expect(await provider.ports('demo')).toEqual([
      { host: '33015', container: '80' },
      { host: '33016', container: '6080' },
      { host: '33014', container: '22' },
    ]);
  });

  it('keeps an endpoint mapping richer than the top-level container port', async () => {
    const { provider, next } = makeProvider();
    next.push(result({ stdout: JSON.stringify([{ id: 'demo', state: 'running', vncHostPort: 33016, vncContainerPort: 6080, endpoints: { endpoints: [{ kind: 'vnc', containerPort: 6081, url: 'http://127.0.0.1:33016/vnc.html', reachable: true }] } }]) }));
    expect(await provider.ports('demo')).toEqual([{ host: '33016', container: '6081' }]);
  });

  it('dedupes endpoints that share a host port, keeping the first mapping', async () => {
    const { provider, next } = makeProvider();
    next.push(
      result({
        stdout: JSON.stringify([
          {
            id: 'demo',
            endpoints: {
              endpoints: [
                { containerPort: 80, url: 'http://127.0.0.1:8080/', reachable: true },
                { containerPort: 8080, url: 'http://127.0.0.1:8080/', reachable: true },
              ],
            },
          },
        ]),
      })
    );
    expect(await provider.ports('demo')).toEqual([{ host: '8080', container: '80' }]);
  });

  it('lets a richer endpoint overwrite a bare endpoint with the same host port', async () => {
    const { provider, next } = makeProvider();
    next.push(
      result({
        stdout: JSON.stringify([
          {
            id: 'demo',
            endpoints: {
              endpoints: [
                { url: 'http://127.0.0.1:8080/', reachable: true },
                { containerPort: 80, url: 'http://127.0.0.1:8080/', reachable: true },
              ],
            },
          },
        ]),
      })
    );
    expect(await provider.ports('demo')).toEqual([{ host: '8080', container: '80' }]);
  });

  it('omits the container mapping when an endpoint has no container port', async () => {
    const { provider, next } = makeProvider();
    next.push(result({ stdout: JSON.stringify([{ id: 'demo', endpoints: { endpoints: [{ containerPort: undefined, url: 'http://127.0.0.1:8080/', reachable: true }] } }]) }));
    expect(await provider.ports('demo')).toEqual([{ host: '8080' }]);
  });

  it('falls back to the container port when the endpoint URL has no parseable port', async () => {
    const { provider, next } = makeProvider();
    next.push(result({ stdout: JSON.stringify([{ id: 'demo', endpoints: { endpoints: [{ containerPort: 80, url: 'http://127.0.0.1/', reachable: true }] } }]) }));
    expect(await provider.ports('demo')).toEqual([{ host: '80' }]);
  });

  it('does not report ports for non-reachable endpoints', async () => {
    const { provider, next } = makeProvider();
    next.push(result({ stdout: JSON.stringify([{ name: 'demo', endpoints: { endpoints: [{ kind: 'web', containerPort: 80, reachable: false }] } }]) }));
    expect(await provider.ports('demo')).toEqual([]);
  });

  it('returns an empty list when the box has no ports or does not exist', async () => {
    const { provider, next } = makeProvider();
    next.push(result({ stdout: JSON.stringify([{ name: 'demo' }]) }));
    expect(await provider.ports('demo')).toEqual([]);
    next.push(result({ stdout: JSON.stringify([{ name: 'demo' }]) }));
    expect(await provider.ports('ghost')).toEqual([]);
  });

  it('throws on invalid agentbox list JSON when reading ports', async () => {
    const { provider, next } = makeProvider();
    next.push(result({ stdout: 'not json' }));
    await expect(provider.ports('demo')).rejects.toThrow(CliError);
  });

  it('throws on invalid agentbox list JSON', async () => {
    const { provider, next } = makeProvider();
    next.push(result({ stdout: 'not json' }));
    await expect(provider.list()).rejects.toThrow(CliError);
  });

  it('attaches to a box through an interactive pass-through session', async () => {
    const calls: { args: string[]; opts?: PtyOptions }[] = [];
    const interactive: InteractiveRunner = async (args, opts) => {
      calls.push({ args, opts });
      return 4;
    };
    const provider = new AgentboxProvider({ interactive, markerPath: path.join(tmpDir(), 'setup-complete.json') });

    const exit = await provider.attach('demo', { tty: true });

    expect(exit).toBe(4);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['attach', 'demo']);
    expect(calls[0].opts?.tty).toBe(true);
  });

  it('propagates the interactive session exit code', async () => {
    const interactive: InteractiveRunner = async () => 9;
    const provider = new AgentboxProvider({ interactive, markerPath: path.join(tmpDir(), 'setup-complete.json') });
    expect(await provider.attach('demo', { tty: true })).toBe(9);
  });

  it('forwards the configured env and cwd to the attach session', async () => {
    const calls: { args: string[]; opts?: PtyOptions }[] = [];
    const interactive: InteractiveRunner = async (args, opts) => {
      calls.push({ args, opts });
      return 0;
    };
    const provider = new AgentboxProvider({ interactive, cwd: '/work', env: { FOO: 'bar' }, markerPath: path.join(tmpDir(), 'setup-complete.json') });

    await provider.attach('demo', { tty: false });

    expect(calls[0].opts).toMatchObject({ cwd: '/work', env: { FOO: 'bar' }, tty: false });
  });

  it('writes the setup marker when the marker is missing before attach', async () => {
    const markerPath = path.join(tmpDir(), 'setup-complete.json');
    const interactive: InteractiveRunner = async () => 0;
    const provider = new AgentboxProvider({ interactive, markerPath });

    expect(fs.existsSync(markerPath)).toBe(false);
    await provider.attach('demo', { tty: true });
    expect(fs.existsSync(markerPath)).toBe(true);
    const body = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    expect(body).toMatchObject({ version: 1, provider: 'docker' });
  });

  it('does not rewrite the setup marker when it already exists', async () => {
    const markerPath = path.join(tmpDir(), 'setup-complete.json');
    fs.writeFileSync(markerPath, JSON.stringify({ version: 1 }));
    const interactive: InteractiveRunner = async () => 0;
    const provider = new AgentboxProvider({ interactive, markerPath });

    await provider.attach('demo', { tty: true });
    expect(JSON.parse(fs.readFileSync(markerPath, 'utf8'))).toEqual({ version: 1 });
  });

  it('completes setup by writing the marker without any wizard', async () => {
    const markerPath = path.join(tmpDir(), 'setup-complete.json');
    let interactiveCalled = false;
    const interactive: InteractiveRunner = async () => {
      interactiveCalled = true;
      return 0;
    };
    const provider = new AgentboxProvider({ interactive, markerPath });

    await provider.ensureSetup();

    expect(interactiveCalled).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(markerPath, 'utf8'))).toMatchObject({ version: 1, provider: 'docker' });
  });

  it('never invokes agentbox install, in any interactive state', async () => {
    const markerPath = path.join(tmpDir(), 'setup-complete.json');
    const calls: { args: string[]; opts?: PtyOptions }[] = [];
    const interactive: InteractiveRunner = async (args, opts) => {
      calls.push({ args, opts });
      return 0;
    };
    const provider = new AgentboxProvider({ interactive, markerPath });

    await provider.ensureSetup();

    expect(calls).toHaveLength(0);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(markerPath, 'utf8'))).toMatchObject({ version: 1, provider: 'docker' });
  });

  it('accepts the interactive option without changing behavior', async () => {
    const markerPath = path.join(tmpDir(), 'setup-complete.json');
    const calls: { args: string[]; opts?: PtyOptions }[] = [];
    const interactive: InteractiveRunner = async (args, opts) => {
      calls.push({ args, opts });
      return 0;
    };
    const provider = new AgentboxProvider({ interactive, markerPath });

    await provider.ensureSetup({ interactive: true });

    expect(calls).toHaveLength(0);
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it('is a no-op once the setup marker exists', async () => {
    const markerPath = path.join(tmpDir(), 'setup-complete.json');
    fs.writeFileSync(markerPath, JSON.stringify({ version: 1 }));
    let interactiveCalled = false;
    const interactive: InteractiveRunner = async () => {
      interactiveCalled = true;
      return 0;
    };
    const provider = new AgentboxProvider({ interactive, markerPath });

    await provider.ensureSetup();

    expect(interactiveCalled).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it('prepares the base image with the configured provider name', async () => {
    const { provider, calls, nextDocker } = makeProvider({ providerName: 'vercel' });
    nextDocker.push(result({ exitCode: 1, stderr: 'No such image: agentbox/box:dev' }));

    await provider.ensureBaseImage();

    expect(calls.map((c) => c.args)).toEqual([['prepare', '--provider', 'vercel', '-y']]);
  });

  it('runs agentbox prepare headlessly when the base docker image is missing', async () => {
    const { provider, calls, dockerCalls, nextDocker } = makeProvider();
    nextDocker.push(result({ exitCode: 1, stderr: 'No such image: agentbox/box:dev' }));

    await provider.ensureBaseImage();

    expect(dockerCalls).toEqual([['image', 'inspect', 'agentbox/box:dev']]);
    expect(calls.map((c) => c.args)).toEqual([['prepare', '--provider', 'docker', '-y']]);
  });

  it('skips agentbox prepare when the base docker image already exists', async () => {
    const { provider, calls, dockerCalls, nextDocker } = makeProvider();
    nextDocker.push(result());

    await provider.ensureBaseImage();

    expect(dockerCalls).toEqual([['image', 'inspect', 'agentbox/box:dev']]);
    expect(calls).toHaveLength(0);
  });

  it('writes the setup marker before agentbox prepare', async () => {
    const markerPath = path.join(tmpDir(), 'setup-complete.json');
    const calls: string[][] = [];
    const runner: AsyncCommandRunner = async (args) => {
      expect(fs.existsSync(markerPath)).toBe(true); // marker must exist before any agentbox argv
      calls.push(args);
      return result();
    };
    const dockerRunner: CommandRunner = () => result({ exitCode: 1 });
    const provider = new AgentboxProvider({ runner, dockerRunner, markerPath });

    await provider.ensureBaseImage();

    expect(fs.existsSync(markerPath)).toBe(true);
    expect(calls).toEqual([['prepare', '--provider', 'docker', '-y']]);
  });

  it('throws a CliError when agentbox prepare fails', async () => {
    const { provider, nextDocker, next } = makeProvider();
    nextDocker.push(result({ exitCode: 1 }));
    next.push(result({ exitCode: 1, stderr: 'docker daemon is not running' }));

    const promise = provider.ensureBaseImage();

    await expect(promise).rejects.toThrow(CliError);
    await expect(promise).rejects.toThrow(/agentbox prepare failed: docker daemon is not running/);
  });

  it('writes the setup marker before any agentbox command when the marker is missing', async () => {
    const markerPath = path.join(tmpDir(), 'setup-complete.json');
    const calls: string[][] = [];
    const runner: AsyncCommandRunner = async (args) => {
      calls.push(args);
      return result();
    };
    const provider = new AgentboxProvider({ runner, markerPath });

    await provider.exec('demo', ['sh', '-c', 'true']);

    expect(fs.existsSync(markerPath)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('shell');
  });

  it('detects a running agent session from tmux session names', async () => {
    const { provider, next } = makeProvider();
    next.push(result({ stdout: 'opencode\n' }));
    expect(await provider.hasAgentSession('demo')).toBe(true);

    next.push(result({ stdout: '' }));
    expect(await provider.hasAgentSession('demo')).toBe(false);

    next.push(result({ stdout: 'shell-1\n' }));
    expect(await provider.hasAgentSession('demo')).toBe(false);

    next.push(result({ exitCode: 1, stderr: 'no such box' }));
    expect(await provider.hasAgentSession('demo')).toBe(false);
  });

  it('opens a box shell through the interactive runner', async () => {
    const calls: { args: string[]; opts?: PtyOptions }[] = [];
    const interactive: InteractiveRunner = async (args, opts) => {
      calls.push({ args, opts });
      return 7;
    };
    const provider = new AgentboxProvider({ interactive, markerPath: path.join(tmpDir(), 'setup-complete.json') });

    const code = await provider.shell('demo');

    expect(code).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['shell', 'demo']);
    expect(calls[0].opts?.tty).toBe(true);
  });

  it('runs a command inside a tmux session and attaches through agentbox', async () => {
    const calls: string[][] = [];
    const interactiveCalls: { args: string[]; opts?: PtyOptions }[] = [];
    const interactive: InteractiveRunner = async (args, opts) => {
      interactiveCalls.push({ args, opts });
      return 3;
    };
    const provider = new AgentboxProvider({
      interactive,
      runner: async (args) => {
        calls.push(args);
        return result();
      },
      markerPath: path.join(tmpDir(), 'setup-complete.json'),
    });

    const code = await provider.shell('demo', { command: ['opencode'] });

    expect(code).toBe(3);
    // The harness session is started detached with agentbox's tmux config…
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['shell', 'demo', '--', 'tmux', 'new-session', '-d', '-s', 'opencode', '-c', '/workspace', "'opencode'", ...tmuxSessionArgs('opencode')]);
    // …and the user's terminal is handed to agentbox attach so its footer draws.
    expect(interactiveCalls).toHaveLength(1);
    expect(interactiveCalls[0].args).toEqual(['attach', 'demo']);
    expect(interactiveCalls[0].opts?.tty).toBe(true);
  });

  it('injects the prompt through a tmux session with a real PTY', async () => {
    const calls: { args: string[]; opts?: PtyOptions }[] = [];
    const interactive: InteractiveRunner = async (args, opts) => {
      calls.push({ args, opts });
      return 0;
    };
    const provider = new AgentboxProvider({
      interactive,
      runner: async (args) => ({ exitCode: 0, stdout: 'ready\n', stderr: '' }),
      markerPath: path.join(tmpDir(), 'setup-complete.json'),
      sessionReadyTimeoutMs: 50,
      promptEnterDelayMs: 0,
    });

    const code = await provider.shell('demo', { command: ['opencode'], input: 'hola' });

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    // The user's terminal attaches through agentbox's wrapped attach, which
    // draws the footer at the bottom of the terminal.
    expect(calls[0].args).toEqual(['attach', 'demo']);
    expect(calls[0].opts?.tty).toBe(true);
    expect(calls[0].opts?.input).toBeUndefined();
  });

  it('starts the harness tmux session, types the prompt and simulates Enter', async () => {
    const calls: string[][] = [];
    const interactive: InteractiveRunner = async () => 0;
    const provider = new AgentboxProvider({
      interactive,
      runner: async (args) => {
        calls.push(args);
        return { exitCode: 0, stdout: 'ready\n', stderr: '' };
      },
      markerPath: path.join(tmpDir(), 'setup-complete.json'),
      sessionReadyTimeoutMs: 50,
      promptEnterDelayMs: 0,
    });

    await provider.shell('demo', { command: ['opencode', '--agent', 'x'], input: 'hola' });

    const box = containerNameForSandbox('demo');
    expect(calls[0]).toEqual(['shell', box, '--', 'tmux', 'new-session', '-d', '-s', 'opencode', '-c', '/workspace', "'opencode' '--agent' 'x'", ...tmuxSessionArgs('opencode')]);
    expect(calls[1]).toEqual(['shell', box, '--', 'tmux', 'capture-pane', '-p', '-t', 'opencode']);
    expect(calls[2]).toEqual(['shell', box, '--', 'tmux', 'send-keys', '-t', 'opencode', '-l', '--', 'hola']);
    expect(calls[3]).toEqual(['shell', box, '--', 'tmux', 'send-keys', '-t', 'opencode', 'Enter']);
  });

  it('fails with a CliError when the tmux session cannot start', async () => {
    const interactive: InteractiveRunner = async () => 0;
    const provider = new AgentboxProvider({
      interactive,
      runner: async () => ({ exitCode: 127, stdout: '', stderr: 'tmux: not found' }),
      markerPath: path.join(tmpDir(), 'setup-complete.json'),
      sessionReadyTimeoutMs: 50,
      promptEnterDelayMs: 0,
    });

    await expect(provider.shell('demo', { command: ['opencode'], input: 'hola' })).rejects.toThrow(
      /failed to start the opencode session/
    );
  });

  it('maps a docker-invalid id to a docker-safe box name on create', async () => {
    const { provider, calls, gitCalls } = makeProvider();
    await provider.prepareCreate({ id: 'feature/asd-jshdia', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
    await provider.create({ id: 'feature/asd-jshdia', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['create', '--provider', 'docker', '-w', '/tmp/proj', '-n', containerNameForSandbox('feature/asd-jshdia'), '-b', 'feature/asd-jshdia', '-y', '--carry-yes']);
    expect(gitCalls).toEqual([['-C', '/tmp/proj', 'branch', 'feature/asd-jshdia', 'HEAD']]);
  });

  it('uses the mapped box name for exec, copy, stop, start, remove, and logs', async () => {
    const { provider, calls } = makeProvider();
    const name = containerNameForSandbox('feature/asd-jshdia');
    await provider.exec('feature/asd-jshdia', ['sh', '-c', 'true']);
    await provider.copy('feature/asd-jshdia', '/host/stage', '/tmp/x');
    await provider.stop('feature/asd-jshdia');
    await provider.start('feature/asd-jshdia');
    await provider.remove('feature/asd-jshdia');
    await provider.logs('feature/asd-jshdia');
    expect(calls.map((c) => c.args)).toEqual([
      ['shell', name, '--', 'sh', '-c', 'true'],
      ['cp', '/host/stage', `${name}:/tmp/x`],
      ['stop', name],
      ['start', name],
      ['destroy', name, '-y'],
      ['logs', name],
    ]);
  });

  it('attaches to the mapped box name', async () => {
    const calls: { args: string[]; opts?: PtyOptions }[] = [];
    const interactive: InteractiveRunner = async (args, opts) => {
      calls.push({ args, opts });
      return 0;
    };
    const provider = new AgentboxProvider({ interactive, markerPath: path.join(tmpDir(), 'setup-complete.json') });

    await provider.attach('feature/asd-jshdia', { tty: true });

    expect(calls[0].args).toEqual(['attach', containerNameForSandbox('feature/asd-jshdia')]);
  });

  it('probes agent sessions on the mapped box name', async () => {
    const { provider, calls, next } = makeProvider();
    next.push(result({ stdout: 'opencode\n' }));
    expect(await provider.hasAgentSession('feature/asd-jshdia')).toBe(true);
    expect(calls[0].args).toEqual([
      'shell',
      containerNameForSandbox('feature/asd-jshdia'),
      '--',
      'tmux',
      'list-sessions',
      '-F',
      '#{session_name}',
    ]);
  });

  it('matches ports by the mapped box name', async () => {
    const { provider, next } = makeProvider();
    const name = containerNameForSandbox('feature/asd-jshdia');
    const body = JSON.stringify([{ name, state: 'running', webHostPort: 8080 }, { name: 'other', state: 'running', webHostPort: 7000 }]);
    next.push(result({ stdout: body }));
    next.push(result({ stdout: body }));
    expect(await provider.ports('feature/asd-jshdia')).toEqual([{ host: '8080' }]);
    expect(await provider.ports('other')).toEqual([{ host: '7000' }]);
  });

  it('prints [debug] agentbox/git/docker timing lines when debug is on', async () => {
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderr.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const { provider } = makeProvider({ debug: true });
      await provider.prepareCreate({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
      provider.ensureBaseImage();
      await provider.create({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
      const out = stderr.join('');
      expect(out).toMatch(/\[debug\] git branch demo → \d+ms/);
      expect(out).toMatch(/\[debug\] docker image inspect → \d+ms/);
      expect(out).toMatch(/\[debug\] agentbox create → \d+ms/);
      expect(out).not.toContain('GITHUB_TOKEN');
      expect(out).not.toContain('--token');
    } finally {
      process.stderr.write = original;
    }
  });

  it('prints [debug] agentbox shell timing lines for in-box commands when debug is on', async () => {
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderr.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const { provider, next } = makeProvider({ hostUid: 1001, hostGid: 1001, debug: true });
      next.push(
        result(), // agentbox create
        result({ stdout: '1000\n__sander_exit_uid=0\n1000\n__sander_exit_gid=0\n' }), // combined probe
        result(), // groupmod
        result(), // usermod
        result(), // chown home
        result(), // chown dirs
        result(), // chown projectRoot
        result({ stdout: '1001\n' }), // verify uid
      );
      await provider.prepareCreate({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
      await provider.create({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
      await provider.finalizeCreate({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
      await provider.exec('demo', ['sh', '-c', 'true']);
      await provider.hasExecutable('demo', '/workspace/.sander/install.sh');
      const out = stderr.join('');
      expect(out).toMatch(/\[debug\] agentbox shell demo → \d+ms/);
      expect(out.match(/\[debug\] agentbox shell demo → \d+ms/g)).toHaveLength(9);
    } finally {
      process.stderr.write = original;
    }
  });

  it('prints no [debug] lines when debug is off', async () => {
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderr.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const { provider } = makeProvider();
      await provider.prepareCreate({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
      provider.ensureBaseImage();
      await provider.create({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
      await provider.finalizeCreate({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
      expect(stderr.join('')).not.toContain('[debug]');
    } finally {
      process.stderr.write = original;
    }
  });
});

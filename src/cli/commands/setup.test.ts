import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CaptureStream } from '../../../test/helpers/capture-stream';
import { FakeHarnessFactory } from '../../harness/fake';
import { FakeProvider } from '../../provider/fake';
import { FakeWorktree } from '../../worktree/fake';
import { runCli } from '../main';
import type { CliDeps } from '../deps';
import type { AsyncCommandRunner, CommandRunner, RunResult } from '../../process/run';
import { SETUP_PROMPT } from '../../setup/setup-agent';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sander-setup-command-test-'));
}

function result(overrides: Partial<RunResult> = {}): RunResult {
  return { exitCode: 0, stdout: '', stderr: '', ...overrides };
}

interface CopyCapture {
  tmpdir: string | null;
  files: string[];
  /** Modes of the copy at the moment the test container is created. */
  stat: Record<string, number> | null;
}

interface Ctx {
  deps: CliDeps;
  harnessFactory: FakeHarnessFactory;
  stdout: CaptureStream;
  stderr: CaptureStream;
  gitCalls: string[][];
  nextGit: RunResult[];
  dockerCalls: string[][];
  nextDocker: RunResult[];
  /** Snapshot of the repo copy at the moment the test container is created. */
  copy: CopyCapture;
}

function makeCtx(configDir: string): Ctx {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ provider: 'agentbox', harness: 'opencode' }),
  );
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const harnessFactory = new FakeHarnessFactory();
  const gitCalls: string[][] = [];
  const nextGit: RunResult[] = [];
  const dockerCalls: string[][] = [];
  const nextDocker: RunResult[] = [];
  const copy: CopyCapture = { tmpdir: null, files: [], stat: null };
  const gitRunner: CommandRunner = (args) => {
    gitCalls.push(args);
    return nextGit.shift() ?? result();
  };
  const dockerRunner: AsyncCommandRunner = async (args) => {
    dockerCalls.push(args);
    if (args[0] === 'run') {
      // The copy is complete by the time `docker run` is invoked; snapshot the
      // mounted tmpdir to verify the copy contents before cleanup removes it.
      const mount = args[args.indexOf('-v') + 1];
      const tmp = mount.split(':')[0];
      copy.tmpdir = tmp;
      copy.files = listFiles(tmp);
      copy.stat = {
        root: fs.statSync(tmp).mode & 0o777,
        sander: fs.statSync(path.join(tmp, '.sander')).mode & 0o777,
        src: fs.statSync(path.join(tmp, 'src')).mode & 0o777,
        install: fs.statSync(path.join(tmp, '.sander', 'install.sh')).mode & 0o777,
      };
    }
    return nextDocker.shift() ?? result();
  };
  return {
    deps: {
      configDir,
      stdout,
      stderr,
      provider: new FakeProvider(),
      harnessFactory,
      worktree: new FakeWorktree(),
      gitRunner,
      dockerRunner,
    },
    harnessFactory,
    stdout,
    stderr,
    gitCalls,
    nextGit,
    dockerCalls,
    nextDocker,
    copy,
  };
}

function makeProject(): string {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'README.md'), 'hi');
  return root;
}

function writeArtifact(projectRoot: string, name: string, mode = 0o755): string {
  const file = path.join(projectRoot, '.sander', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\necho hi\n', { mode });
  return file;
}

// Simulated `git ls-files` output for makeTestProject: tracked files plus paths
// under .git/node_modules/dist (which must be excluded from the copy) and no
// `.sander/*` (gitignored, so absent from ls-files but forced into the copy).
const TRACKED_FILES = [
  '.gitignore',
  'README.md',
  'package.json',
  'src/index.js',
  '.git/config',
  'node_modules/dep/x.js',
  'dist/bundle.js',
].join('\n');

function makeTestProject(): string {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), 'hi');
  fs.writeFileSync(path.join(root, '.gitignore'), '.sander/\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'export {};\n');
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'x.js'), 'x');
  fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), 'bundle');
  writeArtifact(root, 'install.sh');
  writeArtifact(root, 'start.sh');
  return root;
}

function listFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (rel: string): void => {
    const abs = path.join(dir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : path.join(rel, entry.name);
      if (entry.isDirectory()) {
        walk(childRel);
      } else {
        files.push(childRel);
      }
    }
  };
  walk('');
  return files.sort();
}

async function runIn(projectRoot: string, ctx: Ctx, args: string[]): Promise<number> {
  const prev = process.cwd();
  process.chdir(projectRoot);
  try {
    return await runCli(args, ctx.deps);
  } finally {
    process.chdir(prev);
  }
}

describe('sander setup', () => {
  it('runs the harness headless in the project root and writes both artifacts', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir);
    ctx.harnessFactory.get('opencode').headlessHook = (opts) => {
      writeArtifact(opts.cwd, 'install.sh');
      writeArtifact(opts.cwd, 'start.sh');
    };

    const code = await runIn(project, ctx, ['setup']);

    expect(code).toBe(0);
    const calls = ctx.harnessFactory.get('opencode').calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: 'headless',
      name: 'opencode',
      opts: { prompt: SETUP_PROMPT, cwd: project },
    });
    expect(fs.existsSync(path.join(project, '.sander', 'install.sh'))).toBe(true);
    expect(fs.existsSync(path.join(project, '.sander', 'start.sh'))).toBe(true);
    expect(ctx.stdout.text()).toContain('generó los scripts');
  });

  it('errors when artifacts already exist and points to --force without invoking the harness', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    writeArtifact(project, 'install.sh');
    writeArtifact(project, 'start.sh');
    const ctx = makeCtx(configDir);

    const code = await runIn(project, ctx, ['setup']);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('ya existen');
    expect(ctx.stderr.text()).toContain('--force');
    expect(ctx.harnessFactory.get('opencode').calls).toHaveLength(0);
  });

  it('--force deletes and regenerates existing artifacts', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    writeArtifact(project, 'install.sh');
    writeArtifact(project, 'start.sh');
    const ctx = makeCtx(configDir);
    ctx.harnessFactory.get('opencode').headlessHook = (opts) => {
      writeArtifact(opts.cwd, 'install.sh');
      writeArtifact(opts.cwd, 'start.sh');
    };

    const code = await runIn(project, ctx, ['setup', '--force']);

    expect(code).toBe(0);
    expect(ctx.harnessFactory.get('opencode').calls).toHaveLength(1);
    expect(fs.existsSync(path.join(project, '.sander', 'install.sh'))).toBe(true);
    expect(fs.existsSync(path.join(project, '.sander', 'start.sh'))).toBe(true);
    expect(ctx.stdout.text()).toContain('generó los scripts');
  });

  it('fails with an actionable CliError when the agent leaves the artifacts missing', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir);
    ctx.harnessFactory.get('opencode').headlessHook = () => undefined;

    const code = await runIn(project, ctx, ['setup']);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('no dejó el repo listo');
    expect(ctx.stderr.text()).toContain(path.join(project, '.sander', 'install.sh'));
    expect(ctx.stderr.text()).toContain(path.join(project, '.sander', 'start.sh'));
    expect(ctx.stderr.text()).toContain('no existen o no son ejecutables');
  });

  it('prints setup help and exits 0', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir);
    const code = await runIn(project, ctx, ['setup', '--help']);
    expect(code).toBe(0);
    const help = ctx.stdout.text();
    expect(help).toContain('sander setup');
    // Ticket 05: the test subcommand and its --time <s> option (default 5)
    expect(help).toContain('sander setup test [--time <s>]');
    expect(help).toContain('--time <s>   Seconds to keep start.sh running under setup test (default 5)');
    expect(help).toContain('agentbox/box:dev');
    expect(help).toContain('It registers no sandbox.');
  });

  it('prints setup test help and exits 0', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir);
    const code = await runIn(project, ctx, ['setup', 'test', '--help']);
    expect(code).toBe(0);
    const help = ctx.stdout.text();
    expect(help).toContain('sander setup test [--time <s>]');
    expect(help).toContain('--time <s>   Seconds to keep start.sh running under setup test (default 5)');
    expect(help).toContain('agentbox/box:dev');
    expect(help).toContain('It registers no sandbox.');
  });

  it('rejects unexpected positional arguments', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir);
    const code = await runIn(project, ctx, ['setup', 'extra']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('unexpected argument "extra"');
  });

  it('rejects extra positional arguments under setup test', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir);
    const code = await runIn(project, ctx, ['setup', 'test', 'bogus']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('unexpected argument "bogus"');
    expect(ctx.stderr.text()).toContain('setup test takes no arguments');
  });

  it('rejects unknown flags under setup test', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir);
    const code = await runIn(project, ctx, ['setup', 'test', '--foo']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('unexpected flag "--foo"');
    expect(ctx.stderr.text()).toContain('setup test takes only --time <s>');
  });

  it('rejects a non-numeric --time under setup test', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir);
    const code = await runIn(project, ctx, ['setup', 'test', '--time', 'abc']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('--time expects a number of seconds, got "abc"');
  });

  it('rejects a missing --time value under setup test', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir);
    const code = await runIn(project, ctx, ['setup', 'test', '--time']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('--time requires a value in seconds');
  });

  it('rejects a negative --time under setup test', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir);
    const code = await runIn(project, ctx, ['setup', 'test', '--time=-1']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('--time expects a number of seconds, got "-1"');
  });

  it('fails with a clear error when the cwd is not a git repository', async () => {
    const configDir = tmpDir();
    const project = makeProject();
    const ctx = makeCtx(configDir);
    ctx.nextGit.push(result({ exitCode: 128, stderr: 'fatal: not a git repository' }));
    const code = await runIn(project, ctx, ['setup', 'test']);
    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('no se puede ejecutar "sander setup test" desde un directorio que no es un repositorio git');
    expect(ctx.stderr.text()).toContain('ejecútalo desde la raíz de un proyecto versionado con git');
    expect(ctx.gitCalls).toEqual([['rev-parse', '--is-inside-work-tree']]);
  });

  it('runs the install and start liveness flow in an anonymous test container and reports success', async () => {
    const configDir = tmpDir();
    const project = makeTestProject();
    const ctx = makeCtx(configDir);
    ctx.nextGit.push(result()); // rev-parse: inside a work tree
    ctx.nextGit.push(result({ stdout: TRACKED_FILES })); // git ls-files
    ctx.nextDocker.push(result({ stdout: 'abc123\n' })); // docker run -> container id
    ctx.nextDocker.push(result()); // agentbox-dockerd-start
    ctx.nextDocker.push(result()); // docker info: daemon up
    ctx.nextDocker.push(result({ stdout: 'installed deps\n' })); // install.sh exit 0
    ctx.nextDocker.push(result({ stdout: 'server ready\n' })); // start.sh still alive after 5s, log captured

    const code = await runIn(project, ctx, ['setup', 'test']);

    expect(code).toBe(0);
    expect(ctx.gitCalls).toEqual([
      ['rev-parse', '--is-inside-work-tree'],
      ['ls-files'],
    ]);
    expect(ctx.dockerCalls).toEqual([
      ['run', '-d', '--privileged', '-v', `${ctx.copy.tmpdir}:/workspace`, 'agentbox/box:dev', 'sleep', 'infinity'],
      ['exec', '--user', 'root', 'abc123', '/usr/local/bin/agentbox-dockerd-start'],
      ['exec', 'abc123', 'docker', 'info'],
      ['exec', '-w', '/workspace', 'abc123', './.sander/install.sh'],
      [
        'exec',
        '-w',
        '/workspace',
        'abc123',
        'sh',
        '-c',
        './.sander/start.sh > /tmp/sander-start.log 2>&1 & pid=$!; sleep 5; if kill -0 "$pid" 2>/dev/null; then cat /tmp/sander-start.log; exit 0; else cat /tmp/sander-start.log; exit 1; fi',
      ],
      ['exec', '--user', 'root', 'abc123', 'rm', '-rf', '/workspace'],
      ['rm', '-f', 'abc123'],
    ]);
    // install output streams first, then the captured start log is printed at the end
    expect(ctx.stdout.text()).toBe('installed deps\nserver ready\n');
    expect(ctx.stderr.text()).toBe('');
    expect(fs.existsSync(ctx.copy.tmpdir as string)).toBe(false);
  });

  it('uses the configured --time seconds in the start liveness check inside the container', async () => {
    const configDir = tmpDir();
    const project = makeTestProject();
    const ctx = makeCtx(configDir);
    ctx.nextGit.push(result()); // rev-parse
    ctx.nextGit.push(result({ stdout: TRACKED_FILES })); // ls-files
    ctx.nextDocker.push(result({ stdout: 'abc123\n' })); // docker run
    ctx.nextDocker.push(result()); // agentbox-dockerd-start
    ctx.nextDocker.push(result()); // docker info: daemon up
    ctx.nextDocker.push(result({ stdout: 'installed deps\n' })); // install.sh exit 0
    ctx.nextDocker.push(result({ stdout: 'server ready\n' })); // start.sh alive after 10s

    const code = await runIn(project, ctx, ['setup', 'test', '--time', '10']);

    expect(code).toBe(0);
    expect(ctx.dockerCalls).toEqual([
      ['run', '-d', '--privileged', '-v', `${ctx.copy.tmpdir}:/workspace`, 'agentbox/box:dev', 'sleep', 'infinity'],
      ['exec', '--user', 'root', 'abc123', '/usr/local/bin/agentbox-dockerd-start'],
      ['exec', 'abc123', 'docker', 'info'],
      ['exec', '-w', '/workspace', 'abc123', './.sander/install.sh'],
      [
        'exec',
        '-w',
        '/workspace',
        'abc123',
        'sh',
        '-c',
        './.sander/start.sh > /tmp/sander-start.log 2>&1 & pid=$!; sleep 10; if kill -0 "$pid" 2>/dev/null; then cat /tmp/sander-start.log; exit 0; else cat /tmp/sander-start.log; exit 1; fi',
      ],
      ['exec', '--user', 'root', 'abc123', 'rm', '-rf', '/workspace'],
      ['rm', '-f', 'abc123'],
    ]);
    expect(ctx.stdout.text()).toContain('server ready');
    expect(ctx.stderr.text()).toBe('');
    expect(fs.existsSync(ctx.copy.tmpdir as string)).toBe(false);
  });

  it('reports a CliError with the captured log when start.sh dies before the duration and still cleans up', async () => {
    const configDir = tmpDir();
    const project = makeTestProject();
    const ctx = makeCtx(configDir);
    ctx.nextGit.push(result()); // rev-parse
    ctx.nextGit.push(result({ stdout: TRACKED_FILES })); // ls-files
    ctx.nextDocker.push(result({ stdout: 'abc123\n' })); // docker run
    ctx.nextDocker.push(result()); // agentbox-dockerd-start
    ctx.nextDocker.push(result()); // docker info: daemon up
    ctx.nextDocker.push(result({ stdout: 'installed deps\n' })); // install.sh exit 0
    ctx.nextDocker.push(result({ exitCode: 1, stdout: 'crash log line\n' })); // start.sh died before 5s

    const code = await runIn(project, ctx, ['setup', 'test']);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('el script de arranque .sander/start.sh no se mantuvo vivo 5s');
    expect(ctx.stderr.text()).toContain('crash log line');
    expect(ctx.dockerCalls).toEqual([
      ['run', '-d', '--privileged', '-v', `${ctx.copy.tmpdir}:/workspace`, 'agentbox/box:dev', 'sleep', 'infinity'],
      ['exec', '--user', 'root', 'abc123', '/usr/local/bin/agentbox-dockerd-start'],
      ['exec', 'abc123', 'docker', 'info'],
      ['exec', '-w', '/workspace', 'abc123', './.sander/install.sh'],
      [
        'exec',
        '-w',
        '/workspace',
        'abc123',
        'sh',
        '-c',
        './.sander/start.sh > /tmp/sander-start.log 2>&1 & pid=$!; sleep 5; if kill -0 "$pid" 2>/dev/null; then cat /tmp/sander-start.log; exit 0; else cat /tmp/sander-start.log; exit 1; fi',
      ],
      ['exec', '--user', 'root', 'abc123', 'rm', '-rf', '/workspace'],
      ['rm', '-f', 'abc123'],
    ]);
    // the start log travels in the CliError, not on stdout
    expect(ctx.stdout.text()).toBe('installed deps\n');
    expect(fs.existsSync(ctx.copy.tmpdir as string)).toBe(false);
  });

  it('reports a CliError with the captured output when install.sh fails and still cleans up', async () => {
    const configDir = tmpDir();
    const project = makeTestProject();
    const ctx = makeCtx(configDir);
    ctx.nextGit.push(result()); // rev-parse
    ctx.nextGit.push(result({ stdout: TRACKED_FILES })); // ls-files
    ctx.nextDocker.push(result({ stdout: 'abc123\n' })); // docker run
    ctx.nextDocker.push(result()); // agentbox-dockerd-start
    ctx.nextDocker.push(result()); // docker info: daemon up
    ctx.nextDocker.push(result({ exitCode: 7, stderr: 'npm ci failed\n' })); // install.sh exit 7

    const code = await runIn(project, ctx, ['setup', 'test', '--time', '10']);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('el script de instalación .sander/install.sh falló (exit 7: npm ci failed)');
    expect(ctx.stderr.text()).toContain('npm ci failed');
    expect(ctx.stderr.text()).not.toContain('unexpected flag');
    expect(ctx.stderr.text()).not.toContain('expects a number of seconds');
    expect(ctx.dockerCalls).toEqual([
      ['run', '-d', '--privileged', '-v', `${ctx.copy.tmpdir}:/workspace`, 'agentbox/box:dev', 'sleep', 'infinity'],
      ['exec', '--user', 'root', 'abc123', '/usr/local/bin/agentbox-dockerd-start'],
      ['exec', 'abc123', 'docker', 'info'],
      ['exec', '-w', '/workspace', 'abc123', './.sander/install.sh'],
      ['exec', '--user', 'root', 'abc123', 'rm', '-rf', '/workspace'],
      ['rm', '-f', 'abc123'],
    ]);
    expect(fs.existsSync(ctx.copy.tmpdir as string)).toBe(false);
  });

  it('copies only tracked files plus the gitignored .sander scripts, excluding .git, node_modules and dist', async () => {
    const configDir = tmpDir();
    const project = makeTestProject();
    const ctx = makeCtx(configDir);
    ctx.nextGit.push(result()); // rev-parse
    ctx.nextGit.push(result({ stdout: TRACKED_FILES })); // ls-files lists excluded paths too
    ctx.nextDocker.push(result({ stdout: 'abc123\n' })); // docker run
    ctx.nextDocker.push(result()); // agentbox-dockerd-start
    ctx.nextDocker.push(result()); // docker info: daemon up
    ctx.nextDocker.push(result()); // install.sh exit 0

    const code = await runIn(project, ctx, ['setup', 'test']);

    expect(code).toBe(0);
    expect(ctx.copy.files).toEqual([
      '.gitignore',
      '.sander/install.sh',
      '.sander/start.sh',
      'README.md',
      'package.json',
      'src/index.js',
    ]);
    expect(ctx.copy.files).not.toContain('.git/config');
    expect(ctx.copy.files).not.toContain('node_modules/dep/x.js');
    expect(ctx.copy.files).not.toContain('dist/bundle.js');
    expect(fs.existsSync(ctx.copy.tmpdir as string)).toBe(false);
  });

  it('makes the temporary copy accessible and writable to the box user (uid 1000)', async () => {
    const configDir = tmpDir();
    const project = makeTestProject();
    const ctx = makeCtx(configDir);
    ctx.nextGit.push(result()); // rev-parse
    ctx.nextGit.push(result({ stdout: TRACKED_FILES })); // ls-files
    ctx.nextDocker.push(result({ stdout: 'abc123\n' })); // docker run
    ctx.nextDocker.push(result()); // agentbox-dockerd-start
    ctx.nextDocker.push(result()); // docker info: daemon up
    ctx.nextDocker.push(result()); // install.sh exit 0

    const code = await runIn(project, ctx, ['setup', 'test']);

    expect(code).toBe(0);
    expect(ctx.copy.stat).toEqual({
      root: 0o777,
      sander: 0o777,
      src: 0o777,
      install: 0o777, // 0o666 | source exec bits (0o755)
    });
    expect(fs.existsSync(ctx.copy.tmpdir as string)).toBe(false);
  });

  it('reports a CliError and destroys the copy when the test container cannot be created', async () => {
    const configDir = tmpDir();
    const project = makeTestProject();
    const ctx = makeCtx(configDir);
    ctx.nextGit.push(result()); // rev-parse
    ctx.nextGit.push(result({ stdout: TRACKED_FILES })); // ls-files
    ctx.nextDocker.push(result({ exitCode: 1, stderr: 'cannot connect to the Docker daemon' })); // docker run fails

    const code = await runIn(project, ctx, ['setup', 'test']);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('no se pudo crear el contenedor de prueba');
    expect(ctx.stderr.text()).toContain('cannot connect to the Docker daemon');
    expect(ctx.dockerCalls).toEqual([
      ['run', '-d', '--privileged', '-v', `${ctx.copy.tmpdir}:/workspace`, 'agentbox/box:dev', 'sleep', 'infinity'],
    ]);
    expect(fs.existsSync(ctx.copy.tmpdir as string)).toBe(false);
  });

  it('fails with a CliError when the box docker daemon does not come up and still cleans up', async () => {
    const configDir = tmpDir();
    const project = makeTestProject();
    const ctx = makeCtx(configDir);
    ctx.nextGit.push(result()); // rev-parse
    ctx.nextGit.push(result({ stdout: TRACKED_FILES })); // ls-files
    ctx.nextDocker.push(result({ stdout: 'abc123\n' })); // docker run
    ctx.nextDocker.push(result()); // agentbox-dockerd-start exit 0 (launcher never fails itself)
    ctx.nextDocker.push(result({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon' })); // docker info fails

    const code = await runIn(project, ctx, ['setup', 'test']);

    expect(code).toBe(1);
    expect(ctx.stderr.text()).toContain('el daemon docker del contenedor de prueba no arrancó');
    expect(ctx.stderr.text()).toContain('Cannot connect to the Docker daemon');
    expect(ctx.dockerCalls).toEqual([
      ['run', '-d', '--privileged', '-v', `${ctx.copy.tmpdir}:/workspace`, 'agentbox/box:dev', 'sleep', 'infinity'],
      ['exec', '--user', 'root', 'abc123', '/usr/local/bin/agentbox-dockerd-start'],
      ['exec', 'abc123', 'docker', 'info'],
      ['exec', '--user', 'root', 'abc123', 'rm', '-rf', '/workspace'],
      ['rm', '-f', 'abc123'],
    ]);
    expect(fs.existsSync(ctx.copy.tmpdir as string)).toBe(false);
  });
});

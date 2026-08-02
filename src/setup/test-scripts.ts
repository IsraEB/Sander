import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CliError } from '../cli/errors';
import { DEFAULT_BASE_IMAGE } from '../provider/agentbox';
import { BOX_WORKTREE } from '../provider/box-user';
import type { AsyncCommandRunner, CommandRunner } from '../process/run';

export interface SetupTestOptions {
  projectRoot: string;
  gitRunner: CommandRunner;
  dockerRunner: AsyncCommandRunner;
  timeSeconds: number;
  stdout: NodeJS.WritableStream;
}

export interface SetupTestResult {
  installOk: boolean;
  startAlive: boolean;
  startLog: string;
}

export interface SetupTestCleanupOptions {
  containerId: string | null;
  tmpdir: string;
  dockerRunner: AsyncCommandRunner;
}

const FORCED_SETUP_FILES = ['.sander/install.sh', '.sander/start.sh'];

/** In-box launcher of the box's own docker daemon, shipped in agentbox/box:dev. */
const BOX_DOCKERD_LAUNCHER = '/usr/local/bin/agentbox-dockerd-start';

function isExcludedFromCopy(relativePath: string): boolean {
  return relativePath
    .split('/')
    .some((segment) => segment === '.git' || segment === 'node_modules' || segment === 'dist');
}

/**
 * Makes every directory in the copy world-writable and every file world-writable
 * while preserving executable bits. The temp copy is mounted into the anonymous
 * agentbox container as the worktree, and the container's box user (vscode, the
 * image default uid 1000) is neither the owner nor in the owning group of the
 * files (host uid). Without this, the box user cannot traverse the tmpdir
 * (`mkdtempSync` creates it 0700) nor write dependency/build outputs into the
 * worktree, exactly like the real worktree `create` gives the box user.
 */
function makeCopyAccessibleToBoxUser(dir: string): void {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        fs.chmodSync(abs, 0o777);
        stack.push(abs);
      } else {
        const mode = fs.statSync(abs).mode;
        fs.chmodSync(abs, 0o666 | (mode & 0o111));
      }
    }
  }
}

/**
 * Copies the tracked project (via `git ls-files`) into a fresh per-run temp
 * dir, forcing the bootstrap scripts `.sander/install.sh`/`.sander/start.sh`
 * even when the project gitignores them, and excluding `.git`, `node_modules`
 * and `dist`. Returns the temp dir path; on failure it removes the temp dir and
 * rethrows, so no residue survives a failed copy.
 */
export function copyRepoToTmp(opts: { projectRoot: string; gitRunner: CommandRunner }): string {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sander-setup-test-'));
  try {
    const listed = opts.gitRunner(['ls-files'], { cwd: opts.projectRoot });
    if (listed.exitCode !== 0) {
      const detail = (listed.stderr || listed.stdout).trim();
      throw new CliError(`git ls-files failed${detail ? `: ${detail}` : ''}`);
    }
    const files = new Set<string>();
    for (const rel of listed.stdout.split('\n').filter((line) => line !== '')) {
      if (!isExcludedFromCopy(rel)) {
        files.add(rel);
      }
    }
    for (const rel of FORCED_SETUP_FILES) {
      if (fs.existsSync(path.join(opts.projectRoot, rel))) {
        files.add(rel);
      }
    }
    for (const rel of files) {
      const source = path.join(opts.projectRoot, rel);
      const destination = path.join(tmpdir, rel);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
    fs.chmodSync(tmpdir, 0o777);
    makeCopyAccessibleToBoxUser(tmpdir);
    return tmpdir;
  } catch (err) {
    fs.rmSync(tmpdir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Destroys the test container (`docker rm -f`) and the temp copy. The box user
 * (uid 1000) owns everything install.sh created inside the mounted worktree
 * (npm installs, builds, ...), and the non-root host user cannot delete those
 * 1000-owned files, so the mounted tree is first cleared as root inside the
 * container (`rm -rf /workspace`). Best-effort: it never throws, so a cleanup
 * hiccup cannot mask the install/start outcome. Unconditional cleanup is reused
 * by the start half of the orchestration.
 */
export async function cleanupSetupTest(opts: SetupTestCleanupOptions): Promise<void> {
  if (opts.containerId !== null && opts.containerId !== '') {
    try {
      await opts.dockerRunner(['exec', '--user', 'root', opts.containerId, 'rm', '-rf', BOX_WORKTREE]);
    } catch {
      // best-effort: fall through to removing the container and the host copy
    }
    try {
      await opts.dockerRunner(['rm', '-f', opts.containerId]);
    } catch {
      // best-effort: keep going even if the container is already gone
    }
  }
  try {
    fs.rmSync(opts.tmpdir, { recursive: true, force: true });
  } catch {
    // best-effort: a leftover /tmp dir is better than masking the real outcome
  }
}

/**
 * Starts and verifies the test container's own docker daemon, mirroring how
 * agentbox brings up dockerd inside a real box (`agentbox-dockerd-start`, run
 * as root). The launcher blocks internally until the socket is ready (up to
 * ~30s) and always exits 0, so a follow-up `docker info` as the box user is the
 * actual readiness check — a daemon that never comes up surfaces there.
 * Rejects with a `CliError` on either a failed launch or a missing daemon.
 */
async function ensureBoxDockerd(opts: {
  containerId: string;
  dockerRunner: AsyncCommandRunner;
}): Promise<void> {
  const { containerId, dockerRunner } = opts;
  const started = await dockerRunner(['exec', '--user', 'root', containerId, BOX_DOCKERD_LAUNCHER]);
  if (started.exitCode !== 0) {
    const detail = (started.stderr || started.stdout).trim();
    throw new CliError(
      `no se pudo iniciar el daemon docker del contenedor de prueba${detail ? `: ${detail}` : ''}`,
    );
  }
  const daemon = await dockerRunner(['exec', containerId, 'docker', 'info']);
  if (daemon.exitCode !== 0) {
    const detail = (daemon.stderr || daemon.stdout).trim();
    throw new CliError(
      `el daemon docker del contenedor de prueba no arrancó${detail ? `: ${detail}` : ''}`,
    );
  }
}

/**
 * Orchestrates `sander setup test`: copies the tracked project to a temp dir,
 * creates an anonymous `--privileged` `agentbox/box:dev` container with the
 * copy mounted writable as the worktree, starts the box's own docker daemon
 * (so `install.sh` sees docker exactly like a real box), streams `install.sh`
 * output to stdout and maps a non-zero exit to a `CliError` carrying the
 * captured output. After a successful install, `start.sh` is launched in the
 * container and must stay alive for `timeSeconds`; the liveness wait happens
 * inside the container (one `docker exec` that sleeps and probes the process),
 * so an injected fake docker runner can simulate "stayed alive" (exit 0) vs
 * "died" (exit 1) without the host waiting. The captured `start.sh` log is
 * printed at the end of a successful run and carried by the `CliError` when it
 * dies early. Container and temp dir are always destroyed, on success and
 * failure alike.
 */
export async function runTestScripts(opts: SetupTestOptions): Promise<SetupTestResult> {
  const tmpdir = copyRepoToTmp({ projectRoot: opts.projectRoot, gitRunner: opts.gitRunner });
  let containerId: string | null = null;
  try {
    const created = await opts.dockerRunner([
      'run',
      '-d',
      '--privileged',
      '-v',
      `${tmpdir}:${BOX_WORKTREE}`,
      DEFAULT_BASE_IMAGE,
      'sleep',
      'infinity',
    ]);
    if (created.exitCode !== 0) {
      const detail = (created.stderr || created.stdout).trim();
      throw new CliError(`no se pudo crear el contenedor de prueba (docker run failed${detail ? `: ${detail}` : ''})`);
    }
    containerId = created.stdout.trim();
    if (containerId === '') {
      throw new CliError('no se pudo crear el contenedor de prueba: docker run no devolvió un id de contenedor');
    }

    await ensureBoxDockerd({ containerId, dockerRunner: opts.dockerRunner });

    const install = await opts.dockerRunner(['exec', '-w', BOX_WORKTREE, containerId, './.sander/install.sh']);
    if (install.stdout !== '') opts.stdout.write(install.stdout);
    if (install.stderr !== '') opts.stdout.write(install.stderr);
    if (install.exitCode !== 0) {
      const detail = (install.stderr || install.stdout).trim();
      throw new CliError(
        `el script de instalación .sander/install.sh falló (exit ${install.exitCode}${detail ? `: ${detail}` : ''})`,
      );
    }

    // Launches start.sh in the background with its output captured to a log
    // file inside the container, waits timeSeconds, then probes the process.
    // The probe's verdict (exit 0 = alive, exit 1 = died) and the log content
    // (cat'd to stdout on both paths) are both returned by this single exec,
    // keeping the docker runner seam the only thing the tests need to fake.
    const livenessScript =
      './.sander/start.sh > /tmp/sander-start.log 2>&1 & pid=$!; ' +
      `sleep ${opts.timeSeconds}; ` +
      'if kill -0 "$pid" 2>/dev/null; then cat /tmp/sander-start.log; exit 0; ' +
      'else cat /tmp/sander-start.log; exit 1; fi';
    const start = await opts.dockerRunner(['exec', '-w', BOX_WORKTREE, containerId, 'sh', '-c', livenessScript]);
    const startLog = start.stdout.trim();
    if (start.exitCode !== 0) {
      const detail = startLog || start.stderr.trim();
      throw new CliError(
        `el script de arranque .sander/start.sh no se mantuvo vivo ${opts.timeSeconds}s (exit ${start.exitCode}${detail ? `: ${detail}` : ''})`,
      );
    }
    if (startLog !== '') {
      opts.stdout.write(startLog.endsWith('\n') ? startLog : `${startLog}\n`);
    }
    return { installOk: true, startAlive: true, startLog };
  } finally {
    await cleanupSetupTest({ containerId, tmpdir, dockerRunner: opts.dockerRunner });
  }
}

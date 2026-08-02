import { CliError } from '../cli/errors';
import * as path from 'node:path';
import { agentboxBin, createAsyncRunner, run } from '../process/run';
import type { AsyncCommandRunner, CommandRunner, RunResult } from '../process/run';
import { createInteractiveRunner } from '../process/pty';
import type { InteractiveRunner } from '../process/pty';
import type { AttachOptions, BoxInfo, CreateRequest, ExecResult, PortMapping, Provider } from './provider';
import { agentboxSetupMarkerPath, isAgentboxSetupDone, writeAgentboxSetupMarker } from './agentbox-setup';
import { containerNameForSandbox } from '../names/sandbox-name';
import { ensureBoxGitAccess, resolveGitDir } from './gitaccess';
import { alignBoxUser as alignBoxUserInBox, IMAGE_DEFAULT_UID } from './box-user';
import type { BoxUserExec } from './box-user';

const CREATE_TIMEOUT_MS = 15 * 60 * 1000;
const ALIGN_TIMEOUT_MS = 120 * 1000;
const PREPARE_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_BASE_IMAGE = 'agentbox/box:dev';

function elapsedMs(startedAt: number): string {
  return `${Math.round(performance.now() - startedAt)}`;
}

// agentbox's host-side `git fetch` (resolveUseBranch, dist/index.js:2828) probes
// origin whenever --use-branch is passed, and that fetch would prompt for the
// SSH passphrase. Force it to fail fast instead. Scoped to the create process
// only: the box's own git operations do not inherit the agentbox process env.
const AGENTBOX_CREATE_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
  GIT_TERMINAL_PROMPT: '0',
};

export interface AgentboxProviderOptions {
  runner?: AsyncCommandRunner;
  gitRunner?: CommandRunner;
  interactive?: InteractiveRunner;
  dockerRunner?: CommandRunner;
  bin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  markerPath?: string;
  baseImage?: string;
  hostUid?: number;
  hostGid?: number;
  alignTimeoutMs?: number;
  providerName?: string;
  debug?: boolean;
}

interface AgentboxEndpoint {
  kind?: string;
  name?: string;
  containerPort?: number;
  url?: string;
  reachable?: boolean;
}

interface AgentboxListEntry {
  name?: string;
  id?: string;
  state?: string;
  webHostPort?: number;
  vncHostPort?: number;
  sshHostPort?: number;
  webContainerPort?: number;
  vncContainerPort?: number;
  sshContainerPort?: number;
  ssh?: { host?: string; port?: number; identityFile?: string };
  endpoints?: { endpoints?: AgentboxEndpoint[] };
}

function hostPortFromUrl(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.port !== '') return Number(u.port);
  } catch {
    // fall through to the regex fallback
  }
  const m = /:(\d{1,5})([/?#]|$)/.exec(url);
  return m ? Number(m[1]) : null;
}

function normalizePorts(entry: AgentboxListEntry): PortMapping[] {
  const hosts = new Map<string, PortMapping>();
  const add = (host: number | string | null | undefined, container?: number | string | null | undefined): void => {
    if (host === null || host === undefined) return;
    const h = String(host).trim();
    if (h === '') return;
    const c = container === null || container === undefined ? undefined : String(container).trim();
    const existing = hosts.get(h);
    if (existing && existing.container !== undefined) return; // keep richer entry
    hosts.set(h, c === '' ? { host: h } : { host: h, container: c });
  };
  for (const ep of entry.endpoints?.endpoints ?? []) {
    if (ep.reachable) {
      const hostPort = hostPortFromUrl(ep.url ?? '');
      add(hostPort ?? ep.containerPort, hostPort !== null ? ep.containerPort : undefined);
    }
  }
  add(entry.webHostPort, entry.webContainerPort);
  add(entry.vncHostPort, entry.vncContainerPort);
  add(entry.sshHostPort, entry.sshContainerPort);
  add(entry.ssh?.port, entry.sshContainerPort);
  return Array.from(hosts.values());
}

export class AgentboxProvider implements Provider {
  private readonly runner: AsyncCommandRunner;
  private readonly gitRunner: CommandRunner;
  private readonly dockerRunner: CommandRunner;
  private readonly interactive: InteractiveRunner;
  private readonly cwd: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly setupMarkerPath: string;
  private readonly baseImage: string;
  private readonly hostUid: number;
  private readonly hostGid: number;
  private readonly alignTimeoutMs: number;
  private readonly providerName: string;
  private readonly debug: boolean;

  constructor(opts: AgentboxProviderOptions = {}) {
    const bin = opts.bin ?? agentboxBin();
    this.runner = opts.runner ?? createAsyncRunner(bin);
    this.gitRunner = opts.gitRunner ?? ((args, opts) => run('git', args, opts));
    this.dockerRunner = opts.dockerRunner ?? ((args, runOpts) => run('docker', args, runOpts));
    this.interactive = opts.interactive ?? createInteractiveRunner(bin);
    this.cwd = opts.cwd ?? process.cwd();
    this.env = opts.env;
    this.setupMarkerPath = opts.markerPath ?? agentboxSetupMarkerPath();
    this.baseImage = opts.baseImage ?? DEFAULT_BASE_IMAGE;
    this.hostUid = opts.hostUid ?? (typeof process.getuid === 'function' ? process.getuid() : -1);
    this.hostGid = opts.hostGid ?? (typeof process.getgid === 'function' ? process.getgid() : -1);
    this.alignTimeoutMs = opts.alignTimeoutMs ?? ALIGN_TIMEOUT_MS;
    this.providerName = opts.providerName ?? 'docker';
    this.debug = opts.debug ?? false;
  }

  // Writing agentbox's setup marker before any agentbox invocation kills its
  // first-run auto-trigger (isFirstRun), so agentbox's wizard can never take
  // over sander's terminal, in TTY or non-TTY paths alike.
  private ensureAgentboxMarker(): void {
    if (!isAgentboxSetupDone(this.setupMarkerPath)) {
      writeAgentboxSetupMarker(this.setupMarkerPath);
    }
  }

  // Debug/timing mode: prints one `[debug]` line per timed invocation to
  // stderr. Only subcommand + box name are ever printed — never env values or
  // argv secrets.
  private debugLog(message: string): void {
    if (this.debug) {
      process.stderr.write(`[debug] ${message}\n`);
    }
  }

  private async runAgentbox(args: string[], timeoutMs?: number, env?: NodeJS.ProcessEnv): Promise<RunResult> {
    this.ensureAgentboxMarker();
    const startedAt = performance.now();
    const result = await this.runner(args, { cwd: this.cwd, env: { ...this.env, ...env }, timeoutMs });
    this.debugLog(`agentbox ${args[0]} → ${elapsedMs(startedAt)}ms`);
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new CliError(`agentbox ${args[0]} failed${detail ? `: ${detail}` : ''}`);
    }
    return result;
  }

  private boxName(id: string): string {
    return containerNameForSandbox(id);
  }

  async ensureSetup(opts: { interactive?: boolean } = {}): Promise<void> {
    this.ensureAgentboxMarker();
  }

  hasBaseImage(): boolean {
    const startedAt = performance.now();
    const result = this.dockerRunner(['image', 'inspect', this.baseImage], { cwd: this.cwd, env: this.env });
    this.debugLog(`docker image inspect → ${elapsedMs(startedAt)}ms`);
    return result.exitCode === 0;
  }

  async ensureBaseImage(): Promise<void> {
    if (this.hasBaseImage()) {
      return;
    }
    await this.runAgentbox(['prepare', '--provider', this.providerName, '-y'], PREPARE_TIMEOUT_MS);
  }

  private ensureBoxBranch(projectRoot: string, id: string): void {
    const branch = id;
    const startedAt = performance.now();
    const result = this.gitRunner(['-C', projectRoot, 'branch', branch, 'HEAD']);
    this.debugLog(`git branch ${branch} → ${elapsedMs(startedAt)}ms`);
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      if (!/already exists/i.test(detail)) {
        throw new CliError(`Could not prepare branch "${branch}" for agentbox: ${detail}`);
      }
      process.stderr.write(
        `Aviso: la rama "${branch}" ya existía y se reutilizará para el sandbox; ` +
          `al eliminarlo, sander la borrará (usa --dont-delete-branch para conservarla).\n`
      );
    }
    // The host-side `git branch` created refs dirs (e.g. .git/refs/heads/feature
    // for feature/x) owned by the host user at 0755 — invisible to the pre-branch
    // check. Make sure the box user can write them before agentbox's in-container
    // `git worktree add` runs; chmod only runs when the stat-only check fails,
    // targeted at the new refs component first and the whole .git as a fallback.
    if (!ensureBoxGitAccess(projectRoot, id)) {
      throw new CliError(
        `Could not make the git directory of "${projectRoot}" writable by the agentbox box user; ` +
          `run "chmod -R a+rwX ${projectRoot}/.git" manually and retry`
      );
    }
  }

  async prepareCreate(req: CreateRequest): Promise<void> {
    this.ensureBoxBranch(req.projectRoot, req.id);
  }

  async create(req: CreateRequest): Promise<BoxInfo> {
    await this.runAgentbox(
      ['create', '--provider', this.providerName, '-w', req.projectRoot, '-n', this.boxName(req.id), '-b', req.id, '-y', '--carry-yes'],
      CREATE_TIMEOUT_MS,
      { ...req.env, ...AGENTBOX_CREATE_GIT_ENV }
    );
    return { id: req.id };
  }

  async finalizeCreate(req: CreateRequest): Promise<void> {
    await this.alignBoxUser(req);
  }

  private async execInBox(id: string, user: string | null, command: string[], timeoutMs?: number): Promise<RunResult> {
    this.ensureAgentboxMarker();
    const argv =
      user === null
        ? ['shell', this.boxName(id), '--', ...command]
        : ['shell', this.boxName(id), '--user', user, '--', ...command];
    const startedAt = performance.now();
    const result = await this.runner(argv, { cwd: this.cwd, env: this.env, timeoutMs });
    this.debugLog(`agentbox shell ${this.boxName(id)} → ${elapsedMs(startedAt)}ms`);
    return result;
  }

  private async alignBoxUser(req: CreateRequest): Promise<void> {
    const exec: BoxUserExec = async (argv, opts) => {
      const result = await this.execInBox(req.id, opts?.user ?? null, argv, opts?.timeoutMs ?? this.alignTimeoutMs);
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    };
    const result = await alignBoxUserInBox({
      exec,
      hostUid: this.hostUid,
      hostGid: this.hostGid,
      projectRoot: req.projectRoot,
      gitDir: resolveGitDir(req.projectRoot),
    });
    if (result.skipped) {
      return;
    }
    if (result.issues.length > 0) {
      process.stderr.write(
        `warning: box user uid/gid alignment is incomplete (aligned from uid ${result.fromUid} to uid ${result.toUid}); ` +
          `continuing create.\n  - ${result.issues.join('\n  - ')}\n`
      );
    }
  }

  async attach(id: string, opts: AttachOptions): Promise<number> {
    this.ensureAgentboxMarker();
    return this.interactive(['attach', this.boxName(id)], { cwd: this.cwd, env: this.env, tty: opts.tty });
  }

  async hasAgentSession(id: string): Promise<boolean> {
    this.ensureAgentboxMarker();
    const r = await this.runner(['shell', this.boxName(id), '--', 'tmux', 'list-sessions', '-F', '#{session_name}'], { cwd: this.cwd, env: this.env });
    const names = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    return r.exitCode === 0 && names.some((n) => ['claude', 'codex', 'opencode'].includes(n)); // mirrors agentbox AGENT_KINDS
  }

  async shell(id: string): Promise<number> {
    this.ensureAgentboxMarker();
    return this.interactive(['shell', this.boxName(id)], { cwd: this.cwd, env: this.env, tty: true }); // agentbox shell auto-starts the box
  }

  async exec(id: string, command: string[], opts: { cwd?: string } = {}): Promise<ExecResult> {
    this.ensureAgentboxMarker();
    const argv =
      opts.cwd === undefined
        ? ['shell', this.boxName(id), '--', ...command]
        : ['shell', this.boxName(id), '--', 'sh', '-c', 'cd "$1" && shift && exec "$@"', 'sh', opts.cwd, ...command];
    const startedAt = performance.now();
    const result = await this.runner(argv, { cwd: this.cwd, env: this.env });
    this.debugLog(`agentbox shell ${this.boxName(id)} → ${elapsedMs(startedAt)}ms`);
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  async hasExecutable(id: string, p: string): Promise<boolean> {
    this.ensureAgentboxMarker();
    const startedAt = performance.now();
    const result = await this.runner(
      ['shell', this.boxName(id), '--', 'sh', '-c', 'test -f "$1" && test -x "$1"', 'sh', p],
      { cwd: this.cwd, env: this.env }
    );
    this.debugLog(`agentbox shell ${this.boxName(id)} → ${elapsedMs(startedAt)}ms`);
    return result.exitCode === 0;
  }

  async copy(id: string, source: string, destination: string): Promise<void> {
    await this.runAgentbox(['cp', source, `${this.boxName(id)}:${destination}`]);
    // agentbox cp chowns the copied files to uid 1000 (the image default box
    // user). After the alignment bootstrap the box user is the host uid, so
    // re-own the copy as root. Best-effort: a failure surfaces later when the
    // box user tries to read the copy. Skipped entirely on uid-1000 hosts.
    if (this.hostUid > 0 && this.hostUid !== IMAGE_DEFAULT_UID) {
      const destDir = destination.replace(/\/+$/, '') || '/';
      const parent = path.posix.dirname(destDir);
      const owner = `${this.hostUid}:${this.hostGid}`;
      const chown = await this.execInBox(
        id,
        'root',
        ['sh', '-c', 'chown -R "$1" "$2" && chown "$1" "$3"', 'sh', owner, destDir, parent]
      );
      if (chown.exitCode !== 0) {
        process.stderr.write(
          `warning: could not re-own copied files at ${destDir} to ${owner} inside the box ` +
            `(${(chown.stderr || chown.stdout).trim() || `exit ${chown.exitCode}`}).\n`
        );
      }
    }
  }

  async stop(id: string): Promise<void> {
    await this.runAgentbox(['stop', this.boxName(id)]);
  }

  async start(id: string): Promise<void> {
    await this.runAgentbox(['start', this.boxName(id)]);
  }

  async remove(id: string): Promise<void> {
    await this.runAgentbox(['destroy', this.boxName(id), '-y']);
  }

  async logs(id: string): Promise<string> {
    const result = await this.runAgentbox(['logs', this.boxName(id)]);
    return result.stdout;
  }

  private async listEntries(): Promise<AgentboxListEntry[]> {
    const result = await this.runAgentbox(['ls', '-j']);
    let entries: AgentboxListEntry[];
    try {
      entries = JSON.parse(result.stdout) as AgentboxListEntry[];
    } catch {
      throw new CliError('agentbox ls returned invalid JSON');
    }
    if (!Array.isArray(entries)) {
      throw new CliError('agentbox ls returned an unexpected shape');
    }
    return entries;
  }

  async list(): Promise<string[]> {
    return (await this.listEntries()).map((entry) => entry.name ?? entry.id ?? '');
  }

  async ports(id: string): Promise<PortMapping[]> {
    const entry = (await this.listEntries()).find((e) => (e.name ?? e.id) === this.boxName(id));
    return entry ? normalizePorts(entry) : [];
  }
}

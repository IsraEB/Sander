export interface CreateRequest {
  id: string;
  provider: string;
  harness: string;
  projectRoot: string;
  env?: Record<string, string>;
}

export interface BoxInfo {
  id: string;
}

export interface AttachOptions {
  tty: boolean;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PortMapping {
  host: string;
  container?: string;
}

/**
 * Provider interface. Every `id` parameter is the user-facing sandbox id
 * (the registry key the user types). Each provider is responsible for
 * resolving that id to its own concrete box/container name internally;
 * agentbox maps ids through `containerNameForSandbox` to a docker-safe
 * container name before building agentbox argv.
 */
export interface Provider {
  /**
   * Complete any one-time provider setup. agentbox: writes the setup marker
   * so agentbox's own first-run auto-trigger can never fire. Safe to call
   * repeatedly; no-op once set up. Never runs any wizard or prompt, in any
   * TTY state. `interactive` is kept for backwards compatibility and is
   * ignored.
   */
  ensureSetup(opts?: { interactive?: boolean }): Promise<void>;
  /**
   * Ensure the provider's base docker image exists before a create. agentbox:
   * checks `docker image inspect` for the base image and, when missing, runs
   * `agentbox prepare --provider docker -y` headlessly. No-op when the image
   * is present. Throws when the check/prepare fails so the caller can warn
   * and continue (agentbox builds the image lazily on first use anyway).
   */
  ensureBaseImage(): Promise<void>;
  /**
   * Prepare a sandbox create before provisioning: make the git branch the box
   * will check out and ensure the repo is writable by the box user. Runs
   * before create() and is a no-op for providers that don't need it.
   */
  prepareCreate(req: CreateRequest): Promise<void>;
  create(req: CreateRequest): Promise<BoxInfo>;
  /**
   * Finish a sandbox create after provisioning: align the box user's uid/gid
   * with the host so files written inside the box are owned by the host user.
   * Runs after create() and is a no-op for providers that don't need it.
   */
  finalizeCreate(req: CreateRequest): Promise<void>;
  attach(id: string, opts: AttachOptions): Promise<number>;
  hasAgentSession(id: string): Promise<boolean>;
  /**
   * Open an interactive pass-through session inside the box. Without a command
   * this is a plain shell; with `command` the command runs inside the session
   * on a PTY (used by the create/attach agent quick-start to launch the box's
   * harness). The session's exit code is the resolved value.
   */
  shell(id: string, opts?: { command?: string[] }): Promise<number>;
  exec(id: string, command: string[], opts?: { cwd?: string }): Promise<ExecResult>;
  /**
   * In-box probe: whether a regular file at `path` exists and is executable
   * (shell `test -f && test -x`). Never throws; returns false on absent,
   * non-regular, non-executable, or unrunnable boxes.
   */
  hasExecutable(id: string, path: string): Promise<boolean>;
  copy(id: string, source: string, destination: string): Promise<void>;
  stop(id: string): Promise<void>;
  start(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  logs(id: string): Promise<string>;
  list(): Promise<string[]>;
  /**
   * Puertos que el sandbox expone, cada uno con su puerto interno del contenedor
   * cuando se conoce. `container` falta si el mapeo no se puede determinar.
   * Vacío si ninguno.
   */
  ports(id: string): Promise<PortMapping[]>;
}

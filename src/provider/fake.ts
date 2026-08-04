import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AttachOptions,
  BoxInfo,
  CreateRequest,
  ExecResult,
  PortMapping,
  Provider,
} from './provider';

export type ProviderOp =
  | { op: 'create'; req: CreateRequest }
  | { op: 'attach'; id: string; opts: AttachOptions }
  | { op: 'hasAgentSession'; id: string }
  | { op: 'shell'; id: string; command?: string[]; input?: string }
  | { op: 'exec'; id: string; command: string[]; cwd?: string }
  | { op: 'hasExecutable'; id: string; path: string }
  | { op: 'copy'; id: string; source: string; destination: string }
  | { op: 'stop'; id: string }
  | { op: 'start'; id: string }
  | { op: 'remove'; id: string }
  | { op: 'logs'; id: string }
  | { op: 'list' }
  | { op: 'ports'; id: string };

export class FakeProvider implements Provider {
  readonly ops: ProviderOp[] = [];
  // Snapshot of every copy's source content at copy time (a staging dir or a
  // single file), so tests can assert exactly what was staged into the box.
  copiedContents: Array<{ op: 'copy'; id: string; source: string; destination: string; files: Record<string, string> }> = [];
  boxes = new Map<string, BoxInfo>();
  execResult: ExecResult = { exitCode: 0, stdout: '', stderr: '' };
  execHook: ((id: string, command: string[], opts?: { cwd?: string }) => ExecResult | void) | null = null;
  // Simulated in-box file state: box id -> absolute path -> executable flag.
  // Presence of a key means the file exists; the value is whether it is
  // executable. `defaultFileState` is the fallback for boxes without an entry.
  boxFileState = new Map<string, Map<string, boolean>>();
  defaultFileState = new Map<string, boolean>();
  attachResult = 0;
  hasAgentSessionResult = true;
  shellResult = 0;
  logsResult = '';
  nextError: Error | null = null;
  copyError: Error | null = null;
  removeError: Error | null = null;
  // FIFO queue of list() results; when non-empty list() shifts from it instead
  // of reading `boxes`. Exhausted/empty falls back to the boxes map.
  listResults: string[][] | null = null;
  portsByBox = new Map<string, PortMapping[]>();
  ensureSetupCalls: Array<{ interactive?: boolean }> = [];
  ensureSetupError: Error | null = null;
  ensureBaseImageCalls = 0;
  ensureBaseImageError: Error | null = null;
  // Ordered log of the create phases the command drives: prepare -> create ->
  // finalize. Each entry carries the request so tests can assert the payload
  // and the exact phase ordering without polluting `ops` (prepare/finalize are
  // host-side prep that a fake box does not need).
  createPhases: Array<{ phase: 'prepare' | 'create' | 'finalize'; req: CreateRequest }> = [];

  private maybeThrow(): void {
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
  }

  async ensureSetup(opts: { interactive?: boolean } = {}): Promise<void> {
    this.ensureSetupCalls.push(opts);
    if (this.ensureSetupError) {
      const e = this.ensureSetupError;
      this.ensureSetupError = null;
      throw e;
    }
  }

  async ensureBaseImage(): Promise<void> {
    this.ensureBaseImageCalls++;
    if (this.ensureBaseImageError) {
      const e = this.ensureBaseImageError;
      this.ensureBaseImageError = null;
      throw e;
    }
  }

  async prepareCreate(req: CreateRequest): Promise<void> {
    this.createPhases.push({ phase: 'prepare', req });
  }

  async create(req: CreateRequest): Promise<BoxInfo> {
    this.createPhases.push({ phase: 'create', req });
    this.maybeThrow();
    this.ops.push({ op: 'create', req });
    const info = { id: req.id };
    this.boxes.set(req.id, info);
    return info;
  }

  async finalizeCreate(req: CreateRequest): Promise<void> {
    this.createPhases.push({ phase: 'finalize', req });
  }

  async attach(id: string, opts: AttachOptions): Promise<number> {
    this.maybeThrow();
    this.ops.push({ op: 'attach', id, opts });
    return this.attachResult;
  }

  async hasAgentSession(id: string): Promise<boolean> {
    this.maybeThrow();
    this.ops.push({ op: 'hasAgentSession', id });
    return this.hasAgentSessionResult;
  }

  async shell(id: string, opts: { command?: string[]; input?: string } = {}): Promise<number> {
    this.maybeThrow();
    this.ops.push({
      op: 'shell',
      id,
      ...(opts.command === undefined ? {} : { command: opts.command }),
      ...(opts.input === undefined ? {} : { input: opts.input }),
    });
    return this.shellResult;
  }

  async exec(id: string, command: string[], opts: { cwd?: string } = {}): Promise<ExecResult> {
    this.maybeThrow();
    this.ops.push({ op: 'exec', id, command, cwd: opts.cwd });
    if (this.execHook !== null) {
      const hooked = this.execHook(id, command, opts);
      if (hooked !== undefined) {
        return hooked;
      }
    }
    return this.execResult;
  }

  async hasExecutable(id: string, p: string): Promise<boolean> {
    this.maybeThrow();
    this.ops.push({ op: 'hasExecutable', id, path: p });
    return this.boxFileState.get(id)?.get(p) ?? this.defaultFileState.get(p) ?? false;
  }

  async copy(id: string, source: string, destination: string): Promise<void> {
    this.maybeThrow();
    if (this.copyError) {
      const err = this.copyError;
      this.copyError = null;
      throw err;
    }
    this.ops.push({ op: 'copy', id, source, destination });
    const files: Record<string, string> = {};
    if (fs.existsSync(source) && fs.statSync(source).isDirectory()) {
      const walk = (dir: string, base: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const rel = base === '' ? entry.name : `${base}/${entry.name}`;
          if (entry.isDirectory()) {
            walk(full, rel);
          } else if (entry.isFile()) {
            files[rel] = fs.readFileSync(full, 'utf8');
          }
        }
      };
      walk(source, '');
    } else if (fs.existsSync(source)) {
      files[path.basename(source)] = fs.readFileSync(source, 'utf8');
    }
    this.copiedContents.push({ op: 'copy', id, source, destination, files });
  }

  async stop(id: string): Promise<void> {
    this.maybeThrow();
    this.ops.push({ op: 'stop', id });
  }

  async start(id: string): Promise<void> {
    this.maybeThrow();
    this.ops.push({ op: 'start', id });
  }

  async remove(id: string): Promise<void> {
    this.maybeThrow();
    this.ops.push({ op: 'remove', id });
    if (this.removeError) {
      const err = this.removeError;
      this.removeError = null;
      throw err;
    }
    this.boxes.delete(id);
  }

  async logs(id: string): Promise<string> {
    this.maybeThrow();
    this.ops.push({ op: 'logs', id });
    return this.logsResult;
  }

  async list(): Promise<string[]> {
    this.maybeThrow();
    this.ops.push({ op: 'list' });
    if (this.listResults !== null && this.listResults.length > 0) {
      return this.listResults.shift()!;
    }
    return Array.from(this.boxes.keys());
  }

  async ports(id: string): Promise<PortMapping[]> {
    this.maybeThrow();
    this.ops.push({ op: 'ports', id });
    return this.portsByBox.get(id) ?? [];
  }
}

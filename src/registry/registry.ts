import * as fs from 'node:fs';
import { CliError } from '../cli/errors';
import { registryPath } from '../config/config';

export type SandboxStatus = 'running' | 'stopped' | 'unknown';

export interface Sandbox {
  id: string;
  provider: string;
  harness: string;
  yolo?: boolean;
  status: SandboxStatus;
  createdAt: string;
  updatedAt: string;
  projectRoot: string;
  containerName?: string;
  envKeys?: string[];
  branch?: string;
  worktreePath?: string;
}

export interface RegistryFile {
  version: 1;
  boxes: Record<string, Sandbox>;
}

export function emptyRegistry(): RegistryFile {
  return { version: 1, boxes: {} };
}

export function loadRegistry(dir: string): RegistryFile {
  const file = registryPath(dir);
  if (!fs.existsSync(file)) {
    return emptyRegistry();
  }
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.trim() === '') {
    return emptyRegistry();
  }
  try {
    const parsed = JSON.parse(raw) as RegistryFile;
    if (!parsed || parsed.version !== 1 || typeof parsed.boxes !== 'object' || parsed.boxes === null) {
      throw new CliError(`invalid registry file: ${file}`);
    }
    return parsed;
  } catch (err) {
    if (err instanceof CliError) {
      throw err;
    }
    throw new CliError(`cannot parse registry file: ${file}`);
  }
}

export function saveRegistry(dir: string, registry: RegistryFile): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = registryPath(dir);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function upsertBox(registry: RegistryFile, box: Sandbox): RegistryFile {
  const now = new Date().toISOString();
  const existing = registry.boxes[box.id];
  registry.boxes[box.id] = {
    ...box,
    createdAt: existing ? existing.createdAt : box.createdAt ?? now,
    updatedAt: now,
  };
  return registry;
}

export function setBoxStatus(registry: RegistryFile, id: string, status: SandboxStatus): RegistryFile {
  const box = registry.boxes[id];
  if (!box) {
    throw new CliError(`sandbox not found: ${id}`);
  }
  box.status = status;
  box.updatedAt = new Date().toISOString();
  return registry;
}

export function removeBox(registry: RegistryFile, id: string): RegistryFile {
  // Idempotent: deleting a missing id is a no-op. rm relies on this to clear a
  // registry entry even when the sandbox was never created or already removed.
  delete registry.boxes[id];
  return registry;
}

export function listBoxes(registry: RegistryFile): Sandbox[] {
  return Object.values(registry.boxes).sort((a, b) => a.id.localeCompare(b.id));
}

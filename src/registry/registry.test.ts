import { describe, expect, it } from 'vitest';
import {
  emptyRegistry,
  listBoxes,
  loadRegistry,
  removeBox,
  saveRegistry,
  setBoxStatus,
  upsertBox,
} from './registry';
import type { Sandbox } from './registry';
import { CliError } from '../cli/errors';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sander-registry-test-'));
}

function makeBox(id: string, overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    id,
    provider: 'agentbox',
    harness: 'opencode',
    status: 'running',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    projectRoot: '/tmp/project',
    ...overrides,
  };
}

describe('registry', () => {
  it('starts empty and loads an empty registry when no file exists', () => {
    const dir = tmpDir();
    const registry = loadRegistry(dir);
    expect(registry).toEqual(emptyRegistry());
    expect(listBoxes(registry)).toEqual([]);
  });

  it('treats an empty file as an empty registry', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'registry.json'), '');
    expect(loadRegistry(dir)).toEqual(emptyRegistry());
  });

  it('saves and reloads a registry', () => {
    const dir = tmpDir();
    const registry = emptyRegistry();
    upsertBox(registry, makeBox('abc'));
    saveRegistry(dir, registry);

    const reloaded = loadRegistry(dir);
    expect(reloaded.version).toBe(1);
    expect(listBoxes(reloaded).map((b) => b.id)).toEqual(['abc']);
  });

  it('upserts preserve createdAt and bump updatedAt', () => {
    const registry = emptyRegistry();
    upsertBox(registry, makeBox('abc'));
    const first = registry.boxes['abc'];
    upsertBox(registry, makeBox('abc', { harness: 'claude' }));
    const second = registry.boxes['abc'];
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.harness).toBe('claude');
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(first.updatedAt).getTime());
  });

  it('sets status and throws on unknown id', () => {
    const registry = emptyRegistry();
    upsertBox(registry, makeBox('abc'));
    setBoxStatus(registry, 'abc', 'stopped');
    expect(registry.boxes['abc'].status).toBe('stopped');
    expect(() => setBoxStatus(registry, 'nope', 'stopped')).toThrow(CliError);
  });

  it('removes a box and no-ops on unknown id', () => {
    const registry = emptyRegistry();
    upsertBox(registry, makeBox('abc'));
    removeBox(registry, 'abc');
    expect(listBoxes(registry)).toEqual([]);
    expect(() => removeBox(registry, 'nope')).not.toThrow();
    expect(listBoxes(registry)).toEqual([]);
  });

  it('lists boxes sorted by id', () => {
    const registry = emptyRegistry();
    upsertBox(registry, makeBox('b'));
    upsertBox(registry, makeBox('a'));
    upsertBox(registry, makeBox('c'));
    expect(listBoxes(registry).map((b) => b.id)).toEqual(['a', 'b', 'c']);
  });

  it('rejects an invalid registry file', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'registry.json'), 'not json');
    expect(() => loadRegistry(dir)).toThrow(CliError);
  });

  it('round-trips the optional containerName field through save and load', () => {
    const dir = tmpDir();
    const registry = emptyRegistry();
    upsertBox(registry, makeBox('feature/asd-jshdia', { containerName: 'feature-asd-jshdia-01234567' }));
    saveRegistry(dir, registry);

    const reloaded = loadRegistry(dir);
    expect(reloaded.boxes['feature/asd-jshdia'].containerName).toBe('feature-asd-jshdia-01234567');
  });

  it('loads boxes without a containerName field (optionality)', () => {
    const dir = tmpDir();
    const registry = emptyRegistry();
    upsertBox(registry, makeBox('demo'));
    saveRegistry(dir, registry);

    const reloaded = loadRegistry(dir);
    expect(reloaded.boxes['demo'].containerName).toBeUndefined();
  });
});

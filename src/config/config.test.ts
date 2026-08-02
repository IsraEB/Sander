import { describe, expect, it } from 'vitest';
import { configDir, configPath, readGlobalConfig, registryPath, workspaceLayer } from './config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sander-config-test-'));
}

describe('config', () => {
  it('uses SANDER_CONFIG_DIR when set', () => {
    const dir = tmpDir();
    const env = { SANDER_CONFIG_DIR: dir };
    expect(configDir(env)).toBe(dir);
  });

  it('falls back to ~/.config/sander', () => {
    const env = {};
    expect(configDir(env)).toBe(path.join(os.homedir(), '.config', 'sander'));
  });

  it('computes registry and config paths', () => {
    const dir = tmpDir();
    expect(registryPath(dir)).toBe(path.join(dir, 'registry.json'));
    expect(configPath(dir)).toBe(path.join(dir, 'config.json'));
  });

  it('returns empty defaults when no global config exists', () => {
    const dir = tmpDir();
    expect(readGlobalConfig(dir)).toEqual({});
  });

  it('reads a global config file', () => {
    const dir = tmpDir();
    fs.writeFileSync(configPath(dir), JSON.stringify({ provider: 'agentbox' }));
    expect(readGlobalConfig(dir)).toEqual({ provider: 'agentbox' });
  });

  it('reads a global config with a yolo boolean', () => {
    const dir = tmpDir();
    fs.writeFileSync(configPath(dir), JSON.stringify({ yolo: false }));
    expect(readGlobalConfig(dir)).toEqual({ yolo: false });
  });

  it('exposes a workspace layer for the future overlay', () => {
    const dir = tmpDir();
    const layer = workspaceLayer(dir);
    expect(layer.dir).toBe(path.join(dir, '.sander'));
    expect(layer.read()).toEqual({});
  });
});

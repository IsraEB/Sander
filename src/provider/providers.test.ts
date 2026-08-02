import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CliError } from '../cli/errors';
import { AgentboxProvider } from './agentbox';
import {
  CONFIG_PROVIDERS,
  createProvider,
  DEFAULT_PROVIDER,
  LEGACY_PROVIDER_ALIASES,
  PROVIDERS,
  PROVIDER_REQUIRES_SETUP,
  resolveProviderName,
  validateProviderValue,
} from './providers';
import type { AsyncCommandRunner, CommandRunner, RunResult } from '../process/run';

function result(overrides: Partial<RunResult> = {}): RunResult {
  return { exitCode: 0, stdout: '', stderr: '', ...overrides };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sander-providers-test-'));
}

interface EngineHarness {
  provider: ReturnType<typeof createProvider>;
  calls: string[][];
}

function engineFor(name: string): EngineHarness {
  const calls: string[][] = [];
  const runner: AsyncCommandRunner = async (args) => {
    calls.push(args);
    return result();
  };
  const gitRunner: CommandRunner = () => result();
  const provider = createProvider(name, {
    runner,
    gitRunner,
    markerPath: path.join(tmpDir(), 'setup-complete.json'),
    hostUid: 1000,
    hostGid: 1000,
  });
  return { provider, calls };
}

describe('providers', () => {
  it('lists the five supported providers and marks the cloud ones as requiring setup', () => {
    expect(PROVIDERS).toEqual(['docker', 'daytona', 'hetzner', 'vercel', 'e2b']);
    expect(PROVIDER_REQUIRES_SETUP).toEqual({
      docker: false,
      daytona: true,
      hetzner: true,
      vercel: true,
      e2b: true,
    });
  });

  it('keeps agentbox as a legacy alias for docker and the config default as docker', () => {
    expect(LEGACY_PROVIDER_ALIASES).toEqual({ agentbox: 'docker' });
    expect(DEFAULT_PROVIDER).toBe('docker');
    expect(CONFIG_PROVIDERS).toEqual(['docker', 'daytona', 'hetzner', 'vercel', 'e2b']);
  });

  it('rejects the legacy agentbox alias with an actionable error suggesting docker', () => {
    expect(() => validateProviderValue('agentbox')).toThrow(CliError);
    expect(() => validateProviderValue('agentbox')).toThrow('provider "agentbox" is deprecated');
    expect(() => validateProviderValue('agentbox')).toThrow('"docker"');
    expect(() => validateProviderValue('agentbox')).toThrow('sander config set provider docker');
  });

  it('accepts only the five real providers', () => {
    for (const name of PROVIDERS) {
      expect(() => validateProviderValue(name)).not.toThrow();
    }
    expect(() => validateProviderValue('vps')).toThrow(CliError);
    expect(() => validateProviderValue('vps')).toThrow('unsupported provider "vps"');
  });

  it('resolves the legacy agentbox alias to docker and keeps the real names', () => {
    expect(resolveProviderName('agentbox')).toBe('docker');
    for (const name of PROVIDERS) {
      expect(resolveProviderName(name)).toBe(name);
    }
  });

  it('rejects unknown providers', () => {
    expect(() => resolveProviderName('vps')).toThrow(CliError);
    expect(() => resolveProviderName('vps')).toThrow('unsupported provider "vps"');
  });

  it('accepts all five supported providers', () => {
    for (const name of PROVIDERS) {
      expect(() => createProvider(name)).not.toThrow();
    }
  });

  it('createProvider("agentbox") produces the docker engine', async () => {
    const { provider, calls } = engineFor('agentbox');
    expect(provider).toBeInstanceOf(AgentboxProvider);
    await provider.create({ id: 'demo', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/proj' });
    expect(calls[0]).toEqual(['create', '--provider', 'docker', '-w', '/tmp/proj', '-n', 'demo', '-b', 'demo', '-y', '--carry-yes']);
  });

  it('createProvider("vercel") produces the agentbox engine with --provider vercel', async () => {
    const { provider, calls } = engineFor('vercel');
    expect(provider).toBeInstanceOf(AgentboxProvider);
    await provider.create({ id: 'demo', provider: 'vercel', harness: 'opencode', projectRoot: '/tmp/proj' });
    expect(calls[0]).toEqual(['create', '--provider', 'vercel', '-w', '/tmp/proj', '-n', 'demo', '-b', 'demo', '-y', '--carry-yes']);
  });
});

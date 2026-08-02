import { describe, expect, it } from 'vitest';
import { FakeProvider } from './fake';

describe('FakeProvider', () => {
  it('records create and list operations', async () => {
    const provider = new FakeProvider();
    await provider.create({ id: 'abc', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/p' });
    await provider.list();

    expect(provider.ops).toEqual([
      { op: 'create', req: { id: 'abc', provider: 'agentbox', harness: 'opencode', projectRoot: '/tmp/p' } },
      { op: 'list' },
    ]);
    expect(provider.boxes.has('abc')).toBe(true);
  });

  it('records the create phases in order without polluting ops', async () => {
    const provider = new FakeProvider();
    const req = { id: 'abc', provider: 'docker', harness: 'opencode', projectRoot: '/tmp/p' };
    await provider.prepareCreate(req);
    await provider.create(req);
    await provider.finalizeCreate(req);

    expect(provider.createPhases).toEqual([
      { phase: 'prepare', req },
      { phase: 'create', req },
      { phase: 'finalize', req },
    ]);
    expect(provider.ops).toEqual([{ op: 'create', req }]);
  });

  it('records exec with exact argv', async () => {
    const provider = new FakeProvider();
    provider.execResult = { exitCode: 3, stdout: 'out', stderr: 'err' };
    const result = await provider.exec('abc', ['ls', '-la']);

    expect(provider.ops).toEqual([{ op: 'exec', id: 'abc', command: ['ls', '-la'] }]);
    expect(result).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' });
  });

  it('records the exec cwd and lets the exec hook override the result', async () => {
    const provider = new FakeProvider();
    const result = await provider.exec('abc', ['opencode', 'run', 'p'], { cwd: '/workspace' });

    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(provider.ops).toEqual([{ op: 'exec', id: 'abc', command: ['opencode', 'run', 'p'], cwd: '/workspace' }]);

    provider.execHook = (id, command) => {
      return { exitCode: 7, stdout: 'boom', stderr: '' };
    };
    expect(await provider.exec('abc', ['true'], { cwd: '/x' })).toEqual({ exitCode: 7, stdout: 'boom', stderr: '' });
    expect(provider.ops[1]).toEqual({ op: 'exec', id: 'abc', command: ['true'], cwd: '/x' });
  });

  it('answers hasExecutable from the box file state and records the probe', async () => {
    const provider = new FakeProvider();
    provider.defaultFileState.set('/workspace/.sander/install.sh', true);
    provider.boxFileState.set('abc', new Map([['/workspace/.sander/start.sh', false]]));

    expect(await provider.hasExecutable('abc', '/workspace/.sander/install.sh')).toBe(true);
    expect(await provider.hasExecutable('abc', '/workspace/.sander/start.sh')).toBe(false);
    expect(await provider.hasExecutable('abc', '/workspace/.sander/nope.sh')).toBe(false);
    expect(provider.ops).toEqual([
      { op: 'hasExecutable', id: 'abc', path: '/workspace/.sander/install.sh' },
      { op: 'hasExecutable', id: 'abc', path: '/workspace/.sander/start.sh' },
      { op: 'hasExecutable', id: 'abc', path: '/workspace/.sander/nope.sh' },
    ]);
  });

  it('records logs and returns the configured output', async () => {
    const provider = new FakeProvider();
    provider.logsResult = 'log line';
    expect(await provider.logs('abc')).toBe('log line');
    expect(provider.ops).toEqual([{ op: 'logs', id: 'abc' }]);
  });

  it('records ports and returns the configured ports for the box', async () => {
    const provider = new FakeProvider();
    provider.portsByBox.set('abc', [{ host: '8080' }, { host: '9000' }]);
    expect(await provider.ports('abc')).toEqual([{ host: '8080' }, { host: '9000' }]);
    expect(await provider.ports('missing')).toEqual([]);
    expect(provider.ops).toEqual([
      { op: 'ports', id: 'abc' },
      { op: 'ports', id: 'missing' },
    ]);
  });

  it('throws a configured error once', async () => {
    const provider = new FakeProvider();
    provider.nextError = new Error('boom');
    await expect(provider.create({ id: 'x', provider: 'p', harness: 'h', projectRoot: '/p' })).rejects.toThrow('boom');
    await expect(provider.list()).resolves.toEqual([]);
  });

  it('throws a configured copy error once', async () => {
    const provider = new FakeProvider();
    provider.copyError = new Error('cp failed');
    await expect(provider.copy('abc', '/s', '/d')).rejects.toThrow('cp failed');
    await expect(provider.copy('abc', '/s', '/d')).resolves.toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { FakeHarness, FakeHarnessFactory } from './fake';

describe('FakeHarness', () => {
  it('records interactive and headless calls', async () => {
    const harness = new FakeHarness('opencode');
    harness.headlessResult = { exitCode: 2, output: 'answer' };

    await harness.interactive({ env: { A: '1' } });
    const result = await harness.headless({ prompt: 'hi', env: { A: '1' } });

    expect(harness.configDir()).toBe('/tmp/fake-harness-config');
    expect(result).toEqual({ exitCode: 2, output: 'answer' });
    expect(harness.calls).toEqual([
      { kind: 'interactive', name: 'opencode', opts: { env: { A: '1' } } },
      { kind: 'headless', name: 'opencode', opts: { prompt: 'hi', env: { A: '1' } } },
    ]);
  });

  it('runs the headless hook with the recorded options', async () => {
    const harness = new FakeHarness('opencode');
    let seen: unknown;
    harness.headlessHook = (opts) => {
      seen = opts;
    };

    const result = await harness.headless({ prompt: 'hi', cwd: '/tmp/wt', env: { A: '1' } });

    expect(seen).toEqual({ prompt: 'hi', cwd: '/tmp/wt', env: { A: '1' } });
    expect(result).toEqual({ exitCode: 0, output: '' });
    expect(harness.calls).toEqual([
      { kind: 'headless', name: 'opencode', opts: { prompt: 'hi', cwd: '/tmp/wt', env: { A: '1' } } },
    ]);
  });

  it('propagates errors thrown by the headless hook', async () => {
    const harness = new FakeHarness('opencode');
    harness.headlessHook = () => {
      throw new Error('hook boom');
    };

    await expect(harness.headless({ prompt: 'hi' })).rejects.toThrow('hook boom');
  });

  it('returns the generic headless command argv', () => {
    const harness = new FakeHarness('opencode');
    expect(harness.headlessCommand('hi')).toEqual(['hi']);
  });

  it('returns the --agent argv by default and honors a configured null', () => {
    const harness = new FakeHarness('opencode');
    expect(harness.agentArg('orquestator')).toEqual(['--agent', 'orquestator']);

    harness.agentArgResult = null;
    expect(harness.agentArg('orquestator')).toBeNull();
  });
});

describe('FakeHarnessFactory', () => {
  it('returns and reuses harnesses by name', () => {
    const factory = new FakeHarnessFactory();
    const first = factory.get('opencode');
    const second = factory.get('opencode');
    expect(first).toBe(second);
    expect(factory.registered('opencode')).toBe(first);
  });
});

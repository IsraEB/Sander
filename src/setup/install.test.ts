import { describe, expect, it } from 'vitest';
import { CliError } from '../cli/errors';
import { FakeProvider } from '../provider/fake';
import { BOX_WORKTREE } from '../provider/box-user';
import { runInstallScript } from './install';

describe('runInstallScript', () => {
  it('runs the install script in-box once with the worktree cwd', async () => {
    const provider = new FakeProvider();

    await runInstallScript({ boxId: 'demo', provider });

    expect(provider.ops).toEqual([
      { op: 'exec', id: 'demo', command: [`${BOX_WORKTREE}/.sander/install.sh`], cwd: BOX_WORKTREE },
    ]);
    expect(provider.ops.filter((op) => op.op === 'hasExecutable')).toHaveLength(0);
  });

  it('uses a custom worktree path for the script path and cwd', async () => {
    const provider = new FakeProvider();

    await runInstallScript({ boxId: 'demo', provider, worktreePath: '/home/vscode/proj' });

    expect(provider.ops).toEqual([
      { op: 'exec', id: 'demo', command: ['/home/vscode/proj/.sander/install.sh'], cwd: '/home/vscode/proj' },
    ]);
  });

  it('throws a CliError surfacing the script error, exit code, and rollback wording on failure', async () => {
    const provider = new FakeProvider();
    provider.execHook = () => ({ exitCode: 1, stdout: '', stderr: 'npm ERR! code ENOENT' });

    const promise = runInstallScript({ boxId: 'demo', provider });

    await expect(promise).rejects.toThrow(CliError);
    await expect(promise).rejects.toThrow(/install\.sh/);
    await expect(promise).rejects.toThrow(/exit 1/);
    await expect(promise).rejects.toThrow(/npm ERR! code ENOENT/);
    await expect(promise).rejects.toThrow(/rollback/);
  });

  it('surfaces stdout when stderr is empty', async () => {
    const provider = new FakeProvider();
    provider.execHook = () => ({ exitCode: 3, stdout: 'some error', stderr: '' });

    const promise = runInstallScript({ boxId: 'demo', provider });

    await expect(promise).rejects.toThrow(/exit 3/);
    await expect(promise).rejects.toThrow(/some error/);
  });

  it('resolves when the script exits 0 and does not surface its output', async () => {
    const provider = new FakeProvider();
    provider.execResult = { exitCode: 0, stdout: 'installed deps\n', stderr: '' };

    await expect(runInstallScript({ boxId: 'demo', provider })).resolves.toBeUndefined();
  });

  it('propagates provider errors unchanged', async () => {
    const provider = new FakeProvider();
    provider.nextError = new Error('agentbox shell failed');

    await expect(runInstallScript({ boxId: 'demo', provider })).rejects.toThrow('agentbox shell failed');
  });
});

import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CliError } from '../cli/errors';
import { FakeProvider } from '../provider/fake';
import { BOX_WORKTREE } from '../provider/box-user';
import {
  deploySupervisor,
  launchSupervisor,
  startLogPath,
  stopService,
  supervisorScriptSource,
} from './supervisor';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sander-supervisor-test-'));
}

describe('supervisorScriptSource', () => {
  it('resolves to the committed resources/supervisor.sh file', () => {
    const source = supervisorScriptSource();
    expect(path.basename(source)).toBe('supervisor.sh');
    expect(source).toMatch(/resources[\\/]supervisor\.sh$/);
    expect(fs.existsSync(source)).toBe(true);
  });
});

describe('startLogPath', () => {
  it('defaults to the box worktree start.log', () => {
    expect(startLogPath()).toBe('/workspace/.sander/start.log');
  });

  it('honors a custom worktree path', () => {
    expect(startLogPath('/home/vscode/proj')).toBe('/home/vscode/proj/.sander/start.log');
  });
});

describe('deploySupervisor', () => {
  it('copies the shipped script into the box .sander directory', async () => {
    const provider = new FakeProvider();

    await deploySupervisor({ boxId: 'demo', provider });

    expect(provider.ops).toEqual([
      { op: 'copy', id: 'demo', source: supervisorScriptSource(), destination: '/workspace/.sander/supervisor.sh' },
    ]);
  });

  it('honors a custom worktree path', async () => {
    const provider = new FakeProvider();

    await deploySupervisor({ boxId: 'demo', provider, worktreePath: '/home/vscode/proj' });

    expect(provider.ops[0]).toMatchObject({
      op: 'copy',
      id: 'demo',
      destination: '/home/vscode/proj/.sander/supervisor.sh',
    });
  });

  it('propagates copy failures', async () => {
    const provider = new FakeProvider();
    provider.copyError = new Error('cp failed');

    await expect(deploySupervisor({ boxId: 'demo', provider })).rejects.toThrow('cp failed');
  });
});

describe('launchSupervisor', () => {
  it('runs the detached nohup launch', async () => {
    const provider = new FakeProvider();

    await launchSupervisor({ boxId: 'demo', provider });

    expect(provider.ops).toEqual([
      {
        op: 'exec',
        id: 'demo',
        command: ['sh', '-c', `nohup sh ${BOX_WORKTREE}/.sander/supervisor.sh start </dev/null >/dev/null 2>&1 &`],
      },
    ]);
  });

  it('throws a CliError on a non-zero launch', async () => {
    const provider = new FakeProvider();
    provider.execHook = () => ({ exitCode: 1, stdout: '', stderr: 'boom' });

    const promise = launchSupervisor({ boxId: 'demo', provider });

    await expect(promise).rejects.toThrow(CliError);
    await expect(promise).rejects.toThrow(/supervisor/);
    await expect(promise).rejects.toThrow(/exit 1/);
    await expect(promise).rejects.toThrow(/boom/);
    // Without a rollbackNote the message must not claim a rollback: the start
    // command surfaces this error as a warning and continues, no rollback runs.
    await expect(promise).rejects.not.toThrow(/rollback/);
  });

  it('appends the rollback note only when requested', async () => {
    const provider = new FakeProvider();
    provider.execHook = () => ({ exitCode: 1, stdout: '', stderr: 'boom' });

    const promise = launchSupervisor({ boxId: 'demo', provider, rollbackNote: 'se hizo rollback completo.' });

    await expect(promise).rejects.toThrow(/rollback/);
  });

  it('uses a custom worktree path', async () => {
    const provider = new FakeProvider();

    await launchSupervisor({ boxId: 'demo', provider, worktreePath: '/home/vscode/proj' });

    expect(provider.ops[0].command.join(' ')).toContain('/home/vscode/proj/.sander/supervisor.sh start');
  });
});

describe('stopService', () => {
  it('runs the supervisor stop subcommand', async () => {
    const provider = new FakeProvider();

    await stopService({ boxId: 'demo', provider });

    expect(provider.ops).toEqual([
      { op: 'exec', id: 'demo', command: ['sh', `${BOX_WORKTREE}/.sander/supervisor.sh`, 'stop'] },
    ]);
  });

  it('throws a CliError on failure', async () => {
    const provider = new FakeProvider();
    provider.execHook = () => ({ exitCode: 127, stdout: '', stderr: 'no such file' });

    const promise = stopService({ boxId: 'demo', provider });

    await expect(promise).rejects.toThrow(CliError);
    await expect(promise).rejects.toThrow(/exit 127/);
  });

  it('propagates provider errors', async () => {
    const provider = new FakeProvider();
    provider.nextError = new Error('agentbox shell failed');

    await expect(stopService({ boxId: 'demo', provider })).rejects.toThrow('agentbox shell failed');
  });
});

function canRunSupervisorScript(): boolean {
  if (process.platform === 'win32') {
    return false;
  }
  for (const tool of ['find', 'md5sum', 'setsid', 'sleep']) {
    const r = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
    if (r.status !== 0) {
      return false;
    }
  }
  return true;
}

function runScript(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('sh', [supervisorScriptSource(), ...args], { encoding: 'utf8', timeout: 15000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function waitForLog(logPath: string, needle: string, attempts = 20): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes(needle)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function makeScriptWorktree(): string {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, '.sander'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.sander', 'start.sh'),
    '#!/bin/sh\nwhile true; do echo "service-alive"; sleep 1; done\n',
    { mode: 0o755 },
  );
  return root;
}

describe('resources/supervisor.sh (local harness)', () => {
  it.skipIf(!canRunSupervisorScript())(
    'start ignores a stale pidfile whose pid is not a supervisor',
    async () => {
      const root = makeScriptWorktree();
      const sandbox = path.join(root, '.sander');
      const innocent = spawn('sleep', ['60'], { stdio: 'ignore' });
      fs.writeFileSync(path.join(sandbox, 'supervisor.pid'), String(innocent.pid));
      try {
        const proc = spawn('sh', [supervisorScriptSource(), 'start', root], { detached: true, stdio: 'ignore' });
        proc.unref();

        expect(await waitForLog(path.join(sandbox, 'start.log'), 'supervisor started')).toBe(true);
        const log = fs.readFileSync(path.join(sandbox, 'start.log'), 'utf8');
        // The stale innocent pid was NOT trusted: the supervisor started instead
        // of logging "already running" with no service.
        expect(log).not.toContain('already running');
        const pid = fs.readFileSync(path.join(sandbox, 'supervisor.pid'), 'utf8').trim();
        expect(pid).not.toBe(String(innocent.pid));
      } finally {
        runScript(['stop', root]);
        innocent.kill();
      }
    },
    45000,
  );

  it.skipIf(!canRunSupervisorScript())('stop does not kill an innocent process when the pidfile is stale', async () => {
    const root = makeScriptWorktree();
    const sandbox = path.join(root, '.sander');
    const innocent = spawn('sleep', ['60'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(sandbox, 'supervisor.pid'), String(innocent.pid));
    try {
      const r = runScript(['stop', root]);
      expect(r.status).toBe(0);
      expect(fs.existsSync(path.join(sandbox, 'supervisor.pid'))).toBe(false);
      expect(innocent.exitCode).toBeNull();
      expect(spawnSync('sh', ['-c', `kill -0 ${innocent.pid}`]).status).toBe(0);
    } finally {
      innocent.kill();
    }
  });

  it.skipIf(!canRunSupervisorScript())(
    'start refuses a second supervisor while one is running',
    async () => {
      const root = makeScriptWorktree();
      const sandbox = path.join(root, '.sander');
      try {
        const proc = spawn('sh', [supervisorScriptSource(), 'start', root], { detached: true, stdio: 'ignore' });
        proc.unref();
        expect(await waitForLog(path.join(sandbox, 'start.log'), 'supervisor started')).toBe(true);

        const r = runScript(['start', root]);
        expect(r.status).toBe(0);
        const log = fs.readFileSync(path.join(sandbox, 'start.log'), 'utf8');
        expect(log).toContain('already running');
      } finally {
        runScript(['stop', root]);
      }
    },
    45000,
  );
});

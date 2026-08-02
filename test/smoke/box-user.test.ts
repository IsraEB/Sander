import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentboxProvider } from '../../src/provider/agentbox';
import { containerNameForSandbox, dockerContainerName } from '../../src/names/sandbox-name';

const smokeEnv = process.env.SANDER_SMOKE;

function agentboxAvailable(): boolean {
  try {
    const probe = spawnSync('agentbox', ['--version'], { encoding: 'utf8' });
    return probe.status === 0;
  } catch {
    return false;
  }
}

const canRun = smokeEnv !== undefined && smokeEnv.trim() !== '' && agentboxAvailable();

function runGit(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
}

function safeRm(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // The box creation writes files into the project as the container user,
    // which the host user may not be able to remove; cleanup is best-effort.
  }
}

describe.skipIf(!canRun)('agentbox box-user smoke test (SANDER_SMOKE=1)', () => {
  it('aligns the box vscode user to the host uid/gid and re-owns the bind-mounted .git', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sander-smoke-user-'));
    const boxName = `smoke-user-${process.pid}-${Date.now().toString(36)}`;

    runGit(projectRoot, ['init', '-q', '-b', 'main']);
    runGit(projectRoot, ['config', 'user.email', 'smoke@example.com']);
    runGit(projectRoot, ['config', 'user.name', 'Sander Smoke']);
    fs.writeFileSync(path.join(projectRoot, 'README.md'), 'smoke project\n');
    runGit(projectRoot, ['add', '-A']);
    runGit(projectRoot, ['commit', '-qm', 'init']);

    const provider = new AgentboxProvider({ cwd: projectRoot });
    try {
      await provider.create({ id: boxName, provider: 'agentbox', harness: 'opencode', projectRoot });

      const container = dockerContainerName(containerNameForSandbox(boxName));

      // The box user uid/gid now match the host user.
      const idU = spawnSync('docker', ['exec', '--user', 'root', container, 'id', '-u', 'vscode'], { encoding: 'utf8' });
      expect(idU.status).toBe(0);
      expect(idU.stdout.trim()).toBe(String(process.getuid()));
      const idG = spawnSync('docker', ['exec', '--user', 'root', container, 'id', '-g', 'vscode'], { encoding: 'utf8' });
      expect(idG.status).toBe(0);
      expect(idG.stdout.trim()).toBe(String(process.getgid()));

      // A file written in-container as the (now aligned) box user into the
      // bind-mounted host .git is owned on the host by the host user.
      const probePath = `${projectRoot}/.git/sander-uid-probe.txt`;
      const write = await provider.exec(boxName, ['sh', '-c', `printf probe > ${probePath}`]);
      expect(write.exitCode).toBe(0);
      const probeStat = fs.statSync(path.join(projectRoot, '.git', 'sander-uid-probe.txt'));
      expect(probeStat.uid).toBe(process.getuid());

      // The seeded worktree is usable as the aligned user.
      const status = await provider.exec(boxName, ['git', '-C', '/workspace', 'status', '--porcelain']);
      expect(status.exitCode).toBe(0);
    } finally {
      try {
        await provider.remove(boxName);
      } catch {
        // box may already be gone; the test outcome stands
      }
      safeRm(projectRoot);
    }
  }, 600_000);
});

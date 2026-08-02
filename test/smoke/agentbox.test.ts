import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CaptureStream } from '../helpers/capture-stream';
import { AgentboxProvider } from '../../src/provider/agentbox';
import { GitWorktree } from '../../src/worktree/worktree';
import type { CliDeps } from '../../src/cli/deps';
import { runCli } from '../../src/cli/main';
import { loadRegistry } from '../../src/registry/registry';
import type { Harness, HarnessFactory } from '../../src/harness/harness';

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

class TempHarness implements Harness {
  constructor(
    readonly name: string,
    private readonly config: string,
  ) {}

  configDir(): string {
    return this.config;
  }

  async interactive(): Promise<number> {
    throw new Error('not used in the create smoke test');
  }

  async headless(): Promise<{ exitCode: number; output: string }> {
    throw new Error('not used in the create smoke test');
  }

  headlessCommand(prompt: string): string[] {
    return [prompt];
  }
}

class TempHarnessFactory implements HarnessFactory {
  private readonly harnesses = new Map<string, TempHarness>();

  constructor(private readonly configDir: string) {}

  get(name: string): Harness {
    let harness = this.harnesses.get(name);
    if (!harness) {
      harness = new TempHarness(name, this.configDir);
      this.harnesses.set(name, harness);
    }
    return harness;
  }
}

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

describe.skipIf(!canRun)('agentbox smoke test (SANDER_SMOKE=1)', () => {
  it('creates a box with the project and harness config, execs, survives restart, then destroys', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sander-smoke-proj-'));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sander-smoke-config-'));
    const harnessConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'sander-smoke-harness-'));
    const boxName = `smoke-${process.pid}-${Date.now().toString(36)}`;

    fs.writeFileSync(path.join(harnessConfig, 'smoketest.json'), 'model=gpt-smoke\n');
    fs.writeFileSync(path.join(projectRoot, 'README.md'), 'smoke project\n');
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'node_modules/\n');
    fs.writeFileSync(path.join(projectRoot, '.env.sander'), 'SMOKE_SECRET=from-env-file\n');
    fs.writeFileSync(path.join(projectRoot, 'agentbox.yaml'), 'carry:\n  - src: ./node_modules\n    dest: /workspace/node_modules\n');
    fs.mkdirSync(path.join(projectRoot, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'node_modules', 'dep.txt'), 'heavy\n');
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src', 'main.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'smoke-ant-key' } }));
    // Seed the bootstrap artifacts so the setup agent is skipped, install.sh
    // runs once, and the supervisor can run start.sh (executable bits matter:
    // create probes hasExecutable and execs install.sh directly).
    fs.mkdirSync(path.join(projectRoot, '.sander'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.sander', 'install.sh'), '#!/bin/sh\necho "sander-smoke install ok"\n', { mode: 0o755 });
    fs.writeFileSync(
      path.join(projectRoot, '.sander', 'start.sh'),
      '#!/bin/sh\nwhile true; do echo "service-alive"; sleep 1; done\n',
      { mode: 0o755 },
    );

    runGit(projectRoot, ['init', '-q']);
    runGit(projectRoot, ['config', 'user.email', 'smoke@example.com']);
    runGit(projectRoot, ['config', 'user.name', 'Sander Smoke']);
    runGit(projectRoot, ['add', '-A']);
    runGit(projectRoot, ['commit', '-qm', 'init']);
    const chmod = spawnSync('chmod', ['-R', 'a+rwX', path.join(projectRoot, '.git')], { encoding: 'utf8' });
    if (chmod.status !== 0) {
      throw new Error(`chmod .git failed: ${chmod.stderr}`);
    }

    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const provider = new AgentboxProvider({ cwd: projectRoot });
    const deps: CliDeps = {
      configDir,
      stdout,
      stderr,
      createProvider: () => provider,
      harnessFactory: new TempHarnessFactory(harnessConfig),
      worktree: new GitWorktree(),
    };

    const prev = process.cwd();
    process.chdir(projectRoot);
    try {
      const code = await runCli(['create', '--harness', 'smoketest', '--provider', 'agentbox', '--name', boxName], deps);
      expect(code).toBe(0);
      expect(stdout.text()).toContain(`Created sandbox "${boxName}"`);
      expect(fs.existsSync(path.join(os.homedir(), '.agentbox', 'setup-complete.json'))).toBe(true);

      const box = loadRegistry(configDir).boxes[boxName];
      expect(box).toBeDefined();
      expect(box).toMatchObject({ provider: 'agentbox', harness: 'smoketest', status: 'running' });

      const names = await provider.list();
      expect(names).toContain(boxName);

      const workspace = await provider.exec(boxName, ['ls', '/workspace']);
      expect(workspace.exitCode).toBe(0);
      expect(workspace.stdout).toContain('README.md');
      expect(workspace.stdout).toContain('src');
      expect(workspace.stdout).toContain('node_modules');

      const gitIgnoreCheck = await provider.exec(boxName, ['sh', '-c', 'cd /workspace && git check-ignore node_modules/dep.txt']);
      expect(gitIgnoreCheck.exitCode).toBe(0);

      const configCheck = await provider.exec(boxName, ['sh', '-c', 'cat ~/.config/smoketest/smoketest.json']);
      expect(configCheck.exitCode).toBe(0);
      expect(configCheck.stdout).toContain('model=gpt-smoke');

      const envFileCheck = await provider.exec(boxName, ['sh', '-c', 'cat /workspace/.env']);
      expect(envFileCheck.exitCode).toBe(0);
      expect(envFileCheck.stdout).toContain('SMOKE_SECRET=from-env-file');

      const envVarCheck = await provider.exec(boxName, ['sh', '-c', 'printf %s "$ANTHROPIC_API_KEY"']);
      expect(envVarCheck.exitCode).toBe(0);
      expect(envVarCheck.stdout).toContain('smoke-ant-key');

      // Watcher: create launched the supervisor, which runs start.sh and
      // restarts it whenever worktree files change (spec §57).
      const logPath = '/workspace/.sander/start.log';
      const waitForLog = async (needle: string, attempts: number): Promise<boolean> => {
        for (let i = 0; i < attempts; i++) {
          const r = await provider.exec(boxName, ['cat', logPath]);
          if (r.exitCode === 0 && r.stdout.includes(needle)) {
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return false;
      };

      expect(await waitForLog('service-alive', 15)).toBe(true);

      const pidCheck = await provider.exec(boxName, [
        'sh',
        '-c',
        'test -f /workspace/.sander/supervisor.pid && kill -0 $(cat /workspace/.sander/supervisor.pid)',
      ]);
      expect(pidCheck.exitCode).toBe(0);

      const touch = await provider.exec(boxName, ['sh', '-c', 'printf "changed\\n" >> /workspace/src/main.ts']);
      expect(touch.exitCode).toBe(0);

      expect(await waitForLog('[sander-supervisor] worktree changed; restarting start.sh', 20)).toBe(true);

      const aliveAfterRestart = await (async (): Promise<boolean> => {
        for (let i = 0; i < 10; i++) {
          const r = await provider.exec(boxName, ['cat', logPath]);
          if (r.exitCode === 0) {
            const marker = r.stdout.lastIndexOf('worktree changed');
            if (marker !== -1 && r.stdout.indexOf('service-alive', marker) > marker) {
              return true;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return false;
      })();
      expect(aliveAfterRestart).toBe(true);

      const logsOut = new CaptureStream();
      const logsErr = new CaptureStream();
      const logsCode = await runCli(['logs', boxName], { ...deps, stdout: logsOut, stderr: logsErr });
      expect(logsCode).toBe(0);
      expect(logsOut.text()).toContain('service-alive');

      await provider.stop(boxName);
      await provider.start(boxName);

      const depsAfterRestart = await provider.exec(boxName, ['ls', '/workspace/node_modules']);
      expect(depsAfterRestart.exitCode).toBe(0);
      expect(depsAfterRestart.stdout).toContain('dep.txt');
    } finally {
      process.chdir(prev);
      try {
        await provider.remove(boxName);
      } catch {
        // box may already be gone; the test outcome stands
      }
      safeRm(harnessConfig);
      safeRm(configDir);
      safeRm(projectRoot);
    }
  }, 600_000);
});

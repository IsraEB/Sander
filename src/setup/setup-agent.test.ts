import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CliError } from '../cli/errors';
import { FakeHarness } from '../harness/fake';
import type { SetupArtifact } from './setup-agent';
import { ensureRepoSetupArtifacts, SETUP_ARTIFACTS, SETUP_PROMPT } from './setup-agent';

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sander-setup-agent-test-'));
}

function artifactPath(projectRoot: string, artifact: SetupArtifact): string {
  return path.join(projectRoot, '.sander', artifact);
}

function writeArtifact(projectRoot: string, artifact: SetupArtifact, mode = 0o755): string {
  const file = artifactPath(projectRoot, artifact);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\necho hi\n', { mode });
  return file;
}

describe('SETUP_PROMPT', () => {
  it('defines the two bootstrap artifacts in order', () => {
    expect(SETUP_ARTIFACTS).toEqual(['install.sh', 'start.sh']);
  });

  it('instructs the agent about the artifacts, idempotency, foreground process and preservation', () => {
    expect(SETUP_PROMPT).toContain('.sander/install.sh');
    expect(SETUP_PROMPT).toContain('.sander/start.sh');
    expect(SETUP_PROMPT).toContain('idempotent');
    expect(SETUP_PROMPT).toContain('Python');
    expect(SETUP_PROMPT).toContain('node_modules');
    expect(SETUP_PROMPT).toContain('long-running foreground process');
    expect(SETUP_PROMPT).toContain('Never delete or rewrite existing artifacts');
  });

  it('encodes the clean commit instruction for a gitignored .sander/ on the current branch', () => {
    expect(SETUP_PROMPT).toContain('git add -f .sander/install.sh .sander/start.sh');
    expect(SETUP_PROMPT).toContain('current (sandbox) branch');
    expect(SETUP_PROMPT).toContain('never stage or commit anything outside .sander/');
    expect(SETUP_PROMPT).toContain('do not push');
  });
});

describe('ensureRepoSetupArtifacts', () => {
  it('does not invoke the harness when both artifacts already exist and no force is given', async () => {
    const projectRoot = tmpProject();
    writeArtifact(projectRoot, 'install.sh');
    writeArtifact(projectRoot, 'start.sh');
    const harness = new FakeHarness('opencode');

    const outcome = await ensureRepoSetupArtifacts({ projectRoot, harness, force: false });

    expect(outcome.existed).toBe(true);
    expect(outcome.invoked).toBe(false);
    expect(outcome.missing).toEqual([]);
    expect(outcome.output).toBe('');
    expect(harness.calls).toHaveLength(0);
  });

  it('treats any single existing artifact as already-set-up and skips the harness', async () => {
    const projectRoot = tmpProject();
    writeArtifact(projectRoot, 'install.sh');
    const harness = new FakeHarness('opencode');

    const outcome = await ensureRepoSetupArtifacts({ projectRoot, harness, force: false });

    expect(outcome.existed).toBe(true);
    expect(outcome.invoked).toBe(false);
    expect(harness.calls).toHaveLength(0);
  });

  it('invokes the harness headless in the project root with SETUP_PROMPT when no artifacts exist', async () => {
    const projectRoot = tmpProject();
    const harness = new FakeHarness('opencode');
    harness.headlessHook = (opts) => {
      writeArtifact(opts.cwd, 'install.sh');
      writeArtifact(opts.cwd, 'start.sh');
    };

    const outcome = await ensureRepoSetupArtifacts({ projectRoot, harness, force: false });

    expect(outcome.existed).toBe(false);
    expect(outcome.invoked).toBe(true);
    expect(outcome.missing).toEqual(['install.sh', 'start.sh']);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]).toMatchObject({
      kind: 'headless',
      name: 'opencode',
      opts: { prompt: SETUP_PROMPT, cwd: projectRoot },
    });
    expect(fs.existsSync(artifactPath(projectRoot, 'install.sh'))).toBe(true);
    expect(fs.existsSync(artifactPath(projectRoot, 'start.sh'))).toBe(true);
  });

  it('--force deletes the existing artifacts and regenerates both', async () => {
    const projectRoot = tmpProject();
    writeArtifact(projectRoot, 'install.sh');
    writeArtifact(projectRoot, 'start.sh');
    const harness = new FakeHarness('opencode');
    harness.headlessHook = (opts) => {
      writeArtifact(opts.cwd, 'install.sh');
      writeArtifact(opts.cwd, 'start.sh');
    };

    const outcome = await ensureRepoSetupArtifacts({ projectRoot, harness, force: true });

    expect(outcome.existed).toBe(false);
    expect(outcome.invoked).toBe(true);
    expect(outcome.missing).toEqual(['install.sh', 'start.sh']);
    expect(harness.calls).toHaveLength(1);
    expect(fs.existsSync(artifactPath(projectRoot, 'install.sh'))).toBe(true);
    expect(fs.existsSync(artifactPath(projectRoot, 'start.sh'))).toBe(true);
  });

  it('rejects with an actionable CliError when the agent leaves artifacts missing', async () => {
    const projectRoot = tmpProject();
    const harness = new FakeHarness('opencode');
    harness.headlessHook = (opts) => {
      writeArtifact(opts.cwd, 'install.sh');
    };

    const promise = ensureRepoSetupArtifacts({ projectRoot, harness, force: false });

    await expect(promise).rejects.toThrow(CliError);
    await expect(promise).rejects.toThrow(/no dejó el repo listo/);
    await expect(promise).rejects.toThrow(/start\.sh/);
  });

  it('rejects when the agent leaves artifacts non-executable', async () => {
    const projectRoot = tmpProject();
    const harness = new FakeHarness('opencode');
    harness.headlessHook = (opts) => {
      writeArtifact(opts.cwd, 'install.sh', 0o644);
      writeArtifact(opts.cwd, 'start.sh', 0o644);
    };

    const promise = ensureRepoSetupArtifacts({ projectRoot, harness, force: false });

    await expect(promise).rejects.toThrow(CliError);
    await expect(promise).rejects.toThrow(/no existen o no son ejecutables/);
  });

  it('surfaces the agent output and ignores a non-zero harness exit when the artifacts are valid', async () => {
    const projectRoot = tmpProject();
    const harness = new FakeHarness('opencode');
    harness.headlessResult = { exitCode: 7, output: 'generated but exited oddly\n' };
    harness.headlessHook = (opts) => {
      writeArtifact(opts.cwd, 'install.sh');
      writeArtifact(opts.cwd, 'start.sh');
    };

    const outcome = await ensureRepoSetupArtifacts({ projectRoot, harness, force: false });

    expect(outcome.invoked).toBe(true);
    expect(outcome.output).toBe('generated but exited oddly');
  });

  it('--force never touches other .sander/ files such as config.json', async () => {
    const projectRoot = tmpProject();
    writeArtifact(projectRoot, 'install.sh');
    const configFile = path.join(projectRoot, '.sander', 'config.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, '{"harness":"opencode"}\n');
    const harness = new FakeHarness('opencode');
    harness.headlessHook = (opts) => {
      writeArtifact(opts.cwd, 'install.sh');
      writeArtifact(opts.cwd, 'start.sh');
    };

    await ensureRepoSetupArtifacts({ projectRoot, harness, force: true });

    expect(fs.readFileSync(configFile, 'utf8')).toBe('{"harness":"opencode"}\n');
    expect(fs.existsSync(artifactPath(projectRoot, 'install.sh'))).toBe(true);
    expect(fs.existsSync(artifactPath(projectRoot, 'start.sh'))).toBe(true);
  });
});

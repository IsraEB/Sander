import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'sander.js');

const PTY_DRIVER = `import json
import os
import pty
import select
import sys
import time

config_dir = sys.argv[1]
steps = json.loads(sys.argv[2])
cmd = sys.argv[3:]

pid, fd = pty.fork()
if pid == 0:
    if config_dir:
        os.environ['SANDER_CONFIG_DIR'] = config_dir
        os.environ['HOME'] = config_dir
    os.execvp(cmd[0], cmd)

out = b''
start = time.time()
pending = 0
sent = {}
exitcode = None

while time.time() - start < 15:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            chunk = b''
        if chunk:
            out += chunk
            while pending < len(steps) and steps[pending]['wait'].encode() in out:
                time.sleep(0.3)
                os.write(fd, steps[pending]['send'].encode())
                sent[steps[pending]['flag']] = True
                pending += 1
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        exitcode = os.waitstatus_to_exitcode(status)
        deadline = time.time() + 1.0
        while time.time() < deadline:
            r, _, _ = select.select([fd], [], [], 0.2)
            if not r:
                break
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
        break

if exitcode is None:
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    exitcode = 'timeout'

print(json.dumps({
    'exitcode': exitcode,
    'sent': sent,
    'output': out.decode(errors='replace'),
}))
`;

interface PtyStep {
  wait: string;
  send: string;
  flag: string;
}

interface PtyResult {
  exitcode: number | string;
  sent: Record<string, boolean>;
  output: string;
}

interface PtyRun {
  status: number;
  stderr: string;
  result: PtyResult | undefined;
  workDir: string;
}

function runPty(configDir: string, steps: PtyStep[], cmd: string[]): PtyRun {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sander-pty-'));
  const driverPath = path.join(work, 'pty-driver.py');
  fs.writeFileSync(driverPath, PTY_DRIVER, 'utf8');
  const r = spawnSync('python3', [driverPath, configDir, JSON.stringify(steps), ...cmd], {
    encoding: 'utf8',
    env: { ...process.env, HOME: work },
    timeout: 30000,
  });
  let result: PtyResult | undefined;
  if (r.stdout) {
    try {
      result = JSON.parse(r.stdout) as PtyResult;
    } catch {
      result = undefined;
    }
  }
  return { status: r.status ?? -1, stderr: r.stderr ?? '', result, workDir: work };
}

const CONFIG_STEPS: PtyStep[] = [
  { wait: '1) docker', send: '\r', flag: 'sent_provider' },
  { wait: 'Other…', send: '\r', flag: 'sent_harness' },
];

const OTHER_STEPS: PtyStep[] = [
  { wait: '1) docker', send: '\r', flag: 'sent_provider' },
  { wait: 'Other…', send: '4', flag: 'sent_other' },
  { wait: 'Harness (other): ', send: 'my-harness\n', flag: 'sent_typed' },
];

const CANCEL_STEPS: PtyStep[] = [
  { wait: '1) docker', send: 'q', flag: 'sent_cancel' },
];

describe('sander config on a real PTY', () => {
  it('lets the navigable selectors pick provider and harness and persists the config', () => {
    const configDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sander-pty-cfg-')), 'config');
    const { status, stderr, result } = runPty(configDir, CONFIG_STEPS, ['node', BIN, 'config']);

    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(result).toBeDefined();
    expect(result?.exitcode).toBe(0);
    expect(result?.sent.sent_provider).toBe(true);
    expect(result?.sent.sent_harness).toBe(true);
    // The provider question renders as a closed selector with cloud marks...
    expect(result?.output).toContain('1) docker');
    expect(result?.output).toContain('daytona [requieren setup]');
    expect(result?.output).toContain('5) e2b');
    // ...and the harness question offers the "Other…" entry.
    expect(result?.output).toContain('4) Other…');
    expect(result?.output).toContain('provider = docker');
    expect(result?.output).toContain('harness = opencode');

    const saved = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(saved).toEqual({ provider: 'docker', harness: 'opencode' });
  }, 30000);

  it('choosing Other… in the harness selector reads a typed name and persists it', () => {
    const configDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sander-pty-other-')), 'config');
    const { status, stderr, result } = runPty(configDir, OTHER_STEPS, ['node', BIN, 'config']);

    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(result).toBeDefined();
    expect(result?.exitcode).toBe(0);
    expect(result?.sent.sent_provider).toBe(true);
    expect(result?.sent.sent_other).toBe(true);
    expect(result?.sent.sent_typed).toBe(true);
    expect(result?.output).toContain('Harness (other): ');
    expect(result?.output).toContain('harness = my-harness');

    const saved = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(saved).toEqual({ provider: 'docker', harness: 'my-harness' });
  }, 30000);

  it('cancelling the wizard with q fails with an actionable error and writes no config', () => {
    const configDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sander-pty-cancel-')), 'config');
    const { status, stderr, result } = runPty(configDir, CANCEL_STEPS, ['node', BIN, 'config']);

    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(result).toBeDefined();
    expect(result?.sent.sent_cancel).toBe(true);
    expect(result?.exitcode).toBe(1);
    expect(result?.output).toContain('wizard cancelled');
    expect(result?.output).toContain('sander config set <key> <value>');
    expect(fs.existsSync(path.join(configDir, 'config.json'))).toBe(false);
  }, 30000);
});

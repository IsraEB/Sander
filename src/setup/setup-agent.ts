import * as fs from 'node:fs';
import * as path from 'node:path';
import { CliError } from '../cli/errors';
import type { Harness } from '../harness/harness';

export type SetupArtifact = 'install.sh' | 'start.sh';

export const SETUP_ARTIFACTS: readonly SetupArtifact[] = ['install.sh', 'start.sh'];

export const SETUP_PROMPT = `You are the Sander setup agent. You are inside the sandbox worktree of a project,
on the sandbox branch that Sander created (do not create, delete, rename or switch
branches; do not push).

Ensure the project's bootstrap scripts exist in the .sander/ directory of the
current working directory:

1. .sander/install.sh — one-time provisioning, run once per sandbox creation:
   - idempotent and environment-aware: installing a missing runtime (e.g. Python),
     installing dependencies such as node_modules, running commands, and modifying
     files must all be safe to run again and leave the same final state.
2. .sander/start.sh — the long-running foreground process that serves or develops
   the project (dev server, watcher, etc.). It must stay in the foreground and only
   exit when the service stops.

Rules:
- Check which of the two scripts are missing or not executable. Create missing
  scripts; make existing non-executable scripts executable without changing their
  logic; leave other existing scripts untouched.
- Never delete or rewrite existing artifacts.
- Both scripts must be executable (chmod +x).
- Commit the result to the current (sandbox) branch:
  - stage ONLY the .sander/ directory, explicitly: git add -f .sander/install.sh .sander/start.sh
    (the -f/--force guarantees staging even if the project's .gitignore excludes .sander/)
  - commit with a clear message: git commit -m "Configure sandbox bootstrap scripts"
  - never stage or commit anything outside .sander/`;

export interface RepoSetupOutcome {
  existed: boolean;
  invoked: boolean;
  missing: SetupArtifact[];
  output: string;
}

function artifactPath(projectRoot: string, artifact: SetupArtifact): string {
  return path.join(projectRoot, '.sander', artifact);
}

function isUsable(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Generates `.sander/install.sh` and `.sander/start.sh` for the current repo on
 * the host by running the configured harness headless with SETUP_PROMPT in the
 * project root. Never writes when any artifact already exists unless `force`
 * is set, in which case only the two artifact files are deleted (other
 * `.sander/` contents such as `config.json` are never touched) and the harness
 * regenerates them.
 */
export async function ensureRepoSetupArtifacts(opts: {
  projectRoot: string;
  harness: Harness;
  force: boolean;
}): Promise<RepoSetupOutcome> {
  const { projectRoot, harness, force } = opts;
  const existing = SETUP_ARTIFACTS.filter((artifact) => isUsable(artifactPath(projectRoot, artifact)));

  if (!force && existing.length > 0) {
    return { existed: true, invoked: false, missing: [], output: '' };
  }

  if (force) {
    for (const artifact of SETUP_ARTIFACTS) {
      const file = artifactPath(projectRoot, artifact);
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
      }
    }
  }

  const missing = SETUP_ARTIFACTS.filter((artifact) => !isUsable(artifactPath(projectRoot, artifact)));

  const result = await harness.headless({ prompt: SETUP_PROMPT, cwd: projectRoot });
  const output = result.output.trim();

  const unusable = SETUP_ARTIFACTS.filter((artifact) => !isUsable(artifactPath(projectRoot, artifact))).map(
    (artifact) => artifactPath(projectRoot, artifact),
  );
  if (unusable.length > 0) {
    throw new CliError(`el agente de arranque no dejó el repo listo: ${unusable.join(', ')} no existen o no son ejecutables`);
  }

  return { existed: false, invoked: true, missing, output };
}

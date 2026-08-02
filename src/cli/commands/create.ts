import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CliError } from '../errors';
import { helpForCommand } from '../help';
import { parseFlags, popBooleanFlag } from '../args';
import type { CliDeps } from '../deps';
import { debugEnv } from '../deps';
import { readGlobalConfig, saveConfig, workspaceLayer } from '../../config/config';
import type { GlobalConfig } from '../../config/config';
import { missingRequiredKeys } from '../../config/configured';
import type { RequiredKey } from '../../config/configured';
import { runConfigWizard } from '../../config/wizard';
import type { WizardDeps } from '../../config/wizard';
import { loadRegistry, saveRegistry, upsertBox } from '../../registry/registry';
import { getRecipe, transformConfigFor } from '../../recipes/recipes';
import type { RecipeMode } from '../../recipes/recipes';
import { filterGitignored, listFilesRelative } from '../../teleport/teleport';
import { resolveToken } from '../../token/token';
import { checkGitAccess, fixGitAccess, issuesAreForeignResidue, resolveBoxUid } from '../../provider/gitaccess';
import { deriveWorktreeRef } from '../../worktree/worktree';
import type { WorktreeRef } from '../../worktree/worktree';
import { runStep, StepList } from '../steps';
import type { Step } from '../steps';
import { containerNameForSandbox, dockerContainerName, isValidGitBranchName } from '../../names/sandbox-name';
import { runInstallScript } from '../../setup/install';
import { deploySupervisor, launchSupervisor } from '../../setup/supervisor';
import { BOX_WORKTREE } from '../../provider/box-user';
import type { Provider } from '../../provider/provider';
import {
  DEFAULT_PROVIDER,
  LEGACY_PROVIDER_ALIASES,
  validateProviderValue,
} from '../../provider/providers';

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;
const BOX_ENV_FILE = '/workspace/.env';

export const DEFAULT_HARNESS = 'opencode';
export const DEFAULT_YOLO = true;

export interface CreateOptions {
  id: string;
  harness: string;
  provider: string;
  yolo: boolean;
  token?: string;
  flags: Partial<Record<RequiredKey, string>>;
  skipInstall: boolean;
  skipStart: boolean;
  debug: boolean;
}

function flagOn(value: string | boolean | undefined): boolean {
  return value === true || value === 'true';
}

// Symmetric boolean flags for the yolo mode: --yolo forces it on, --no-yolo
// forces it off; absent, the config layers decide. When both are given the
// no-yolo flag wins (the explicit opt-out is the safer reading).
function resolveYoloFlag(flags: Record<string, string | boolean>): boolean | undefined {
  if (flagOn(flags['no-yolo'])) {
    return false;
  }
  if (flagOn(flags.yolo)) {
    return true;
  }
  return undefined;
}

// Config-resolution contract for `sander create`:
// - --provider/--harness flags apply ONLY to the sandbox being created: they
//   take top precedence here, but they are never persisted to any config file
//   (neither the global config nor the workspace layer). Only the wizard and
//   `sander config` write config values.
// - Without a flag, the workspace config wins over the global config, and the
//   built-in defaults ('opencode' harness, 'docker' provider, yolo on) are the
//   final fallback. yolo follows the same order (flag > workspace > global >
//   true), so a project can switch the yolo default without touching the
//   global config.
// - A legacy `provider: agentbox` value in either config layer is tolerated but
//   behaves as UNCONFIGURED: the user is warned to migrate (`sander config set
//   provider docker`) and the create uses the default docker provider. The
//   config file is never rewritten here; only the wizard and `sander config`
//   write config values.
export interface ResolvedConfig {
  harness: string;
  provider: string;
  yolo: boolean;
  legacyProvider: boolean;
}

export function resolveRequiredConfig(
  flags: Partial<Record<RequiredKey, string>>,
  global: GlobalConfig,
  workspace: GlobalConfig,
  yoloFlag: boolean | undefined = undefined,
): ResolvedConfig {
  const harness = flags.harness ?? workspace.harness ?? global.harness ?? DEFAULT_HARNESS;
  const yolo = yoloFlag ?? workspace.yolo ?? global.yolo ?? DEFAULT_YOLO;
  if (flags.provider !== undefined) {
    return { harness, provider: flags.provider, yolo, legacyProvider: false };
  }
  const configured = workspace.provider ?? global.provider;
  if (configured === undefined) {
    return { harness, provider: DEFAULT_PROVIDER, yolo, legacyProvider: false };
  }
  const canonical = (LEGACY_PROVIDER_ALIASES as Readonly<Record<string, string>>)[configured];
  if (canonical !== undefined) {
    return { harness, provider: DEFAULT_PROVIDER, yolo, legacyProvider: true };
  }
  return { harness, provider: configured, yolo, legacyProvider: false };
}

export function parseCreateArgs(argv: string[], deps: CliDeps): CreateOptions | null {
  const { argv: argvClean, value: shortSkipSetup } = popBooleanFlag(argv, 'skip-setup', ['s']);
  const { flags, positionals } = parseFlags(argvClean);
  if (flags.help === true) {
    deps.stdout.write(helpForCommand('create'));
    return null;
  }
  if (flags.token === true) {
    throw new CliError('--token requires a value: pass --token <token>');
  }

  const skipSetup = shortSkipSetup || flagOn(flags['skip-setup']);
  const skipInstall = flagOn(flags['skip-install']) || skipSetup;
  const skipStart = flagOn(flags['skip-start']) || skipSetup;

  const positionalId = positionals.length > 0 ? positionals[0] : undefined;
  if (positionals.length > 1) {
    throw new CliError(
      `unexpected extra argument "${positionals[1]}": pass a single sandbox id positionally or with --name <id>`,
    );
  }
  const flagName = flags.name;
  const flagId = typeof flagName === 'string' && flagName.trim() !== '' ? flagName.trim() : undefined;
  if (positionalId !== undefined && flagId !== undefined) {
    throw new CliError('ambiguous sandbox id: pass the id either positionally or with --name <id>, not both');
  }
  const id = positionalId ?? flagId;
  if (id === undefined) {
    throw new CliError('missing sandbox id: pass <id> or --name <id>');
  }
  if (!isValidGitBranchName(id)) {
    throw new CliError(
      `invalid sandbox id "${id}": names must be valid git branch names (max 180 chars, no spaces or ~ ^ : ? * [ \\, no .., @{, lone @, leading -, leading/trailing /, //, trailing ., or components starting with . or ending with .lock)`,
    );
  }

  const global = readGlobalConfig(deps.configDir);
  const workspace = workspaceLayer(process.cwd()).read();
  const flagHarness = typeof flags.harness === 'string' && flags.harness.trim() !== '' ? flags.harness.trim() : undefined;
  const flagProvider = typeof flags.provider === 'string' && flags.provider.trim() !== '' ? flags.provider.trim() : undefined;
  const token = typeof flags.token === 'string' && flags.token.trim() !== '' ? flags.token.trim() : undefined;

  const requiredFlags: Partial<Record<RequiredKey, string>> = {};
  if (flagHarness !== undefined) {
    requiredFlags.harness = flagHarness;
  }
  if (flagProvider !== undefined) {
    requiredFlags.provider = flagProvider;
  }
  const { harness, provider, yolo } = resolveRequiredConfig(requiredFlags, global, workspace, resolveYoloFlag(flags));

  if (!SAFE_NAME.test(harness)) {
    throw new CliError(`invalid harness name "${harness}"`);
  }
  validateProviderValue(provider);

  return { id, harness, provider, yolo, token, flags: requiredFlags, skipInstall, skipStart, debug: flagOn(flags.debug) || debugEnv() };
}

interface SyncResult {
  injected: number;
  note: string;
}

interface YoloInjection {
  note: string;
  warning: string;
}

/**
 * Materializes the resolved yolo mode inside the box: reads the harness config
 * file at the recipe's boxConfigDir (the real dir the harness reads in the
 * box), applies the recipe's yolo/no-yolo transform additively, and writes the
 * result back through the same staging pattern syncHarnessConfig uses (copy a
 * staged file in, exec a `cp` into place). deny rules are preserved by the
 * recipe transforms; JSONC/unparseable files are skipped with a warning and
 * never rewritten. Harnesses without a recipe warn and skip injection. The
 * host harness config is never touched: only provider ops against the box
 * happen here.
 *
 * Injection happens only at create. The box volume persists across
 * stop/start, so the injected config survives `sander start`; starting the
 * engine directly (e.g. "agentbox … start") re-syncs host config over the box
 * volume and can remove the yolo injection — that limitation is documented in
 * the create help.
 */
async function injectYoloMode(provider: Provider, id: string, harnessName: string, yolo: boolean): Promise<YoloInjection> {
  const recipe = getRecipe(harnessName);
  if (recipe === undefined) {
    return { note: '', warning: `no recipe for harness "${harnessName}"; yolo mode was not injected into the box` };
  }
  const rel = recipe.configFileName;
  const boxPath = `${recipe.boxConfigDir}/${rel}`;
  const read = await provider.exec(id, ['sh', '-c', `cat ${boxPath}`]);
  const existing = read.exitCode !== 0 || read.stdout.trim() === '' ? undefined : read.stdout;
  const mode: RecipeMode = yolo ? 'yolo' : 'no-yolo';
  const result = transformConfigFor(recipe, mode, existing);
  if (result.kind === 'skipped') {
    const reason = result.reason === 'jsonc' ? 'is JSONC (has comments)' : 'is not valid JSON';
    return { note: '', warning: `${harnessName} config inside the box (${boxPath}) ${reason}; yolo mode was not applied, leaving it untouched` };
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'sander-yolo-'));
  try {
    fs.writeFileSync(path.join(staging, rel), result.content);
    await provider.copy(id, staging, `/tmp/sander-yolo/${harnessName}`);
    const place = await provider.exec(id, [
      'sh',
      '-c',
      `mkdir -p ${recipe.boxConfigDir} && cp /tmp/sander-yolo/${harnessName}/${rel} ${boxPath}`,
    ]);
    if (place.exitCode !== 0) {
      throw new CliError(`failed to apply ${mode} mode to ${harnessName} config inside the box (exit ${place.exitCode}${place.stderr ? `: ${place.stderr.trim()}` : ''})`);
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return { note: `Applied ${mode} mode to the ${harnessName} config inside the box.`, warning: '' };
}

function buildBoxEnv(global: GlobalConfig, workspace: GlobalConfig, token: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(global.env ?? {})) {
    env[key] = value;
  }
  for (const [key, value] of Object.entries(workspace.env ?? {})) {
    env[key] = value;
  }
  if (token !== undefined) {
    env.GITHUB_TOKEN = token;
    env.GH_TOKEN = token;
  }
  return env;
}

function ensureGitAccessible(deps: CliDeps, projectRoot: string): void {
  const boxUid = resolveBoxUid();
  const check = checkGitAccess(projectRoot, boxUid);
  if (check.ok) {
    return;
  }
  if (check.gitDir === null) {
    return;
  }

  const listing = check.issues.map((issue) => `  ${issue.relative} (owned by uid ${issue.ownerUid}, mode ${issue.mode})`).join('\n');
  deps.stderr.write(
    `warning: the sandbox box runs as uid ${boxUid} (the box user), but these git directories\n` +
      `are not writable by that uid. Without write access the box cannot create its worktree branch\n` +
      `or commit from inside the box.\n${listing}\n` +
      `Fixing by making .git group/other-writable (chmod -R a+rwX) ...\n`
  );
  const fix = fixGitAccess(check.gitDir);
  if (!fix.ok && !fix.foreignResidue) {
    throw new CliError(
      `could not make ${check.gitDir} writable by the box user (uid ${boxUid}); ` +
        `run "chmod -R a+rwX ${check.gitDir}" manually and retry`
    );
  }
  if (!fix.ok && fix.foreignResidue) {
    deps.stderr.write(
      `warning: some files in ${check.gitDir} are owned by a previous box user (uid 1000) and cannot be fixed\n` +
        `from the host; they will be re-owned inside the box after create.\n`
    );
    return;
  }
  const after = checkGitAccess(projectRoot, boxUid);
  if (!after.ok) {
    if (issuesAreForeignResidue(after.issues, boxUid)) {
      deps.stderr.write(
        `warning: some files in ${check.gitDir} are owned by a previous box user and will be\n` +
          `re-owned inside the box after create.\n`
      );
      return;
    }
    const remaining = after.issues.map((issue) => `  ${issue.relative} (${issue.mode})`).join('\n');
    throw new CliError(
      `git permissions for the box user (uid ${boxUid}) are still not writable:\n${remaining}\n` +
        `run "chmod -R a+rwX ${check.gitDir}" manually and retry`
    );
  }
  deps.stdout.write(`Fixed: ${check.gitDir} is now writable by the box user (uid ${boxUid}).\n`);
}

async function copyEnvSander(provider: Provider, id: string, projectRoot: string): Promise<boolean> {
  const source = path.join(projectRoot, '.env.sander');
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    return false;
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'sander-env-'));
  try {
    fs.copyFileSync(source, path.join(staging, '.env'));
    await provider.copy(id, path.join(staging, '.env'), BOX_ENV_FILE);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return true;
}

async function syncHarnessConfig(provider: Provider, id: string, harnessName: string, configDir: string, projectRoot: string): Promise<SyncResult> {
  const recipe = getRecipe(harnessName);
  // The recipe owns the directory knowledge: the sync reads from the harness's
  // real host config dir and writes into the real dir the harness reads inside
  // the box. Harnesses without a recipe keep the legacy generic fallback.
  const hostConfigDir = recipe?.hostConfigDir ?? configDir;
  if (hostConfigDir === '' || !fs.existsSync(hostConfigDir)) {
    return { injected: 0, note: `no global ${harnessName} config found; the box will use defaults` };
  }
  const files = listFilesRelative(hostConfigDir);
  if (files.length === 0) {
    return { injected: 0, note: `global ${harnessName} config is empty; the box will use defaults` };
  }
  const allowed = filterGitignored(projectRoot, files);
  if (allowed.length === 0) {
    return { injected: 0, note: `global ${harnessName} config is fully excluded by the project .gitignore; the box will use defaults` };
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'sander-config-'));
  try {
    for (const rel of allowed) {
      const src = path.join(hostConfigDir, rel);
      const dest = path.join(staging, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
    await provider.copy(id, staging, `/tmp/sander-config/${harnessName}`);
    const boxConfigDir = recipe?.boxConfigDir ?? `~/.config/${harnessName}`;
    const place = await provider.exec(id, [
      'sh',
      '-c',
      `mkdir -p ${boxConfigDir} && cp -a /tmp/sander-config/${harnessName}/. ${boxConfigDir}/`,
    ]);
    if (place.exitCode !== 0) {
      throw new CliError(`failed to place ${harnessName} config inside the box (exit ${place.exitCode}${place.stderr ? `: ${place.stderr.trim()}` : ''})`);
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return { injected: allowed.length, note: `synced ${allowed.length} ${harnessName} config file(s) into the box` };
}

export async function runCreate(deps: CliDeps, argv: string[]): Promise<number> {
  const opts = parseCreateArgs(argv, deps);
  if (opts === null) {
    return 0;
  }

  const projectRoot = process.cwd();
  const registry = loadRegistry(deps.configDir);
  if (registry.boxes[opts.id]) {
    throw new CliError(`sandbox "${opts.id}" already exists; choose a different name`);
  }
  const containerName = containerNameForSandbox(opts.id);
  const clash = Object.values(registry.boxes).find(
    (b) => b.id !== opts.id && (b.containerName ?? containerNameForSandbox(b.id)) === containerName,
  );
  if (clash) {
    throw new CliError(`sandbox container name "${containerName}" already in use by "${clash.id}"; choose a different sandbox name`);
  }

  // Bare `sander create` with no global config: the first-interaction wizard
  // writes its answers to the GLOBAL config file (deps.configDir), so they
  // persist beyond this sandbox — not just for this create. Rebinding
  // `global = answered` then lets the resolution below apply the same answers
  // to the current create too. The wizard only ever writes the global config;
  // the workspace layer stays untouched here.
  let global = readGlobalConfig(deps.configDir);
  const workspace = workspaceLayer(projectRoot).read();
  const missing = missingRequiredKeys({ global, workspace, flags: opts.flags });
  if (missing.length > 0) {
    const wizardDeps: WizardDeps = {
      input: deps.stdin ?? process.stdin,
      output: deps.stderr,
      keySource: deps.selectorKeySource,
      prompt: deps.prompt ?? (() => undefined),
    };
    const answered = await runConfigWizard(wizardDeps, global, missing);
    saveConfig(deps.configDir, answered);
    global = answered;
  }

  // opts.yolo is the parse-time resolution (flag > workspace > global > true).
  // Pinning it as the flag-precedence value keeps it stable across the wizard,
  // which only ever fills provider/harness and never touches yolo.
  const resolved = resolveRequiredConfig(opts.flags, global, workspace, opts.yolo);
  const { harness: effectiveHarness, provider: effectiveProvider, yolo: effectiveYolo } = resolved;
  if (resolved.legacyProvider) {
    deps.stderr.write(
      `warning: config provider "agentbox" is deprecated; run "sander config set provider docker" to migrate. ` +
        `Using "docker" for this sandbox.\n`
    );
  }
  const provider = deps.createProvider(effectiveProvider, { debug: opts.debug });

  const resolution = resolveToken({
    flag: opts.token,
    global: global.token,
    workspace: workspace.token,
  });
  const boxEnv = buildBoxEnv(global, workspace, resolution.token);
  const envKeys = Object.keys(boxEnv);

  const harness = deps.harnessFactory.get(effectiveHarness);
  ensureGitAccessible(deps, projectRoot);

  // The full step plan is shown up front as a checklist and each step is ticked
  // off as it completes, so a long create always shows what is still pending.
  const steps = new StepList({ stream: deps.stderr, debug: opts.debug });
  const stepProvider = steps.add('Setting up provider');
  const stepBaseImage = steps.add('Preparing provider base image');
  const stepBranch = steps.add('Creating the sandbox git branch');
  const stepCreate = steps.add(`Creating sandbox "${opts.id}"`);
  const stepAlignUser = steps.add('Aligning the box user');
  const stepWorktree = steps.add('Mounting the sandbox worktree');
  const stepEnv = steps.add('Copying project .env.sander into the box');
  const stepSync = steps.add(`Syncing ${effectiveHarness} config into the box`);
  const stepYolo = steps.add(`Applying ${effectiveHarness} permission mode`);
  const stepInstall = steps.add('Running .sander/install.sh');
  const stepSupervisor = steps.add('Deploying the service supervisor');

  // Runs one checklist step, driving its status transitions; `skippedWhen`
  // shows a step that turned out not to apply as skipped instead of done.
  // Errors mark the step failed and propagate to the caller (the rollback in
  // the worktree block below handles cleanup for steps that ran on the box).
  let currentStep: Step | null = null;
  const withStep = <T>(
    step: Step,
    run: () => Promise<T>,
    skippedWhen?: (value: T) => boolean,
  ): Promise<T> => {
    currentStep = step;
    return runStep(steps, step, run, skippedWhen).finally(() => {
      if (currentStep === step) {
        currentStep = null;
      }
    });
  };

  let sync: SyncResult = { injected: 0, note: '' };
  let injection: YoloInjection = { note: '', warning: '' };
  let envCopied = false;
  let worktreeRef: WorktreeRef | null = null;

  try {
    await withStep(stepProvider, async () => {
      try {
        await provider.ensureSetup();
      } catch (err) {
        steps.log(`warning: provider setup did not complete (${err instanceof Error ? err.message : String(err)}); continuing create.`);
      }
    });

    await withStep(stepBaseImage, async () => {
      try {
        await provider.ensureBaseImage();
      } catch (err) {
        steps.log(
          `warning: provider base image is not ready (${err instanceof Error ? err.message : String(err)}); ` +
            `continuing create; it will be prepared on first use.`
        );
      }
    });

    await withStep(stepBranch, async () => {
      try {
        await provider.prepareCreate({ id: opts.id, provider: effectiveProvider, harness: effectiveHarness, projectRoot });
      } catch (err) {
        throw new CliError(`failed to prepare the sandbox branch: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    await withStep(stepCreate, async () => {
      try {
        await provider.create({ id: opts.id, provider: effectiveProvider, harness: effectiveHarness, projectRoot, env: boxEnv });
      } catch (err) {
        throw new CliError(`failed to create box: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    await withStep(stepAlignUser, async () => {
      await provider.finalizeCreate({ id: opts.id, provider: effectiveProvider, harness: effectiveHarness, projectRoot });
    });

    try {
      deps.worktree.deleteStaleBranches(projectRoot);
    } catch (err) {
      steps.log(`Aviso: no se pudieron limpiar las ramas obsoletas de sandboxes previos (${err instanceof Error ? err.message : String(err)}).`);
    }

    try {
      worktreeRef = await withStep(
        stepWorktree,
        async () => {
          const ref = deps.worktree.createWorktreeBranch(projectRoot, opts.id);
          if (ref === null) {
            steps.log('Aviso: el proyecto no es un repositorio git; no se montó la rama/worktree del sandbox.');
          }
          return ref;
        },
        (ref) => ref === null,
      );

      envCopied = await withStep(stepEnv, () => copyEnvSander(provider, opts.id, projectRoot), (copied) => !copied);

      sync = await withStep(stepSync, () =>
        syncHarnessConfig(provider, opts.id, effectiveHarness, harness.configDir(), projectRoot),
      );

      injection = await withStep(
        stepYolo,
        () => injectYoloMode(provider, opts.id, effectiveHarness, effectiveYolo),
        (result) => result.note === '',
      );

      if (worktreeRef !== null) {
        const installScript = path.posix.join(BOX_WORKTREE, '.sander', 'install.sh');
        const startScript = path.posix.join(BOX_WORKTREE, '.sander', 'start.sh');
        const [hasInstall, hasStart] = await Promise.all([
          provider.hasExecutable(opts.id, installScript),
          provider.hasExecutable(opts.id, startScript),
        ]);
        if (!opts.skipInstall && hasInstall) {
          // §91 step 9: ejecutar install.sh (una vez) — antes del supervisor (ticket 03)
          await withStep(stepInstall, () => runInstallScript({ boxId: opts.id, provider }));
        } else {
          steps.markSkipped(stepInstall);
        }
        if (!opts.skipStart && hasStart) {
          // §91 step 10: desplegar y lanzar el supervisor del servicio (ticket 03)
          await withStep(stepSupervisor, async () => {
            await deploySupervisor({ boxId: opts.id, provider });
            await launchSupervisor({ boxId: opts.id, provider, rollbackNote: 'se hizo rollback completo.' });
          });
        } else {
          steps.markSkipped(stepSupervisor);
        }
      } else {
        steps.markSkipped(stepInstall);
        steps.markSkipped(stepSupervisor);
      }
    } catch (err) {
      if (currentStep !== null) {
        steps.markFailed(currentStep);
        currentStep = null;
      }
      try {
        await provider.remove(opts.id);
      } catch {
        // best-effort cleanup; the original error is the one the user needs
      }
      const ref = worktreeRef ?? deriveWorktreeRef(projectRoot, opts.id);
      try {
        deps.worktree.removeWorktree(projectRoot, ref);
      } catch {
        // best-effort cleanup
      }
      try {
        deps.worktree.deleteBranch(projectRoot, ref.branch);
      } catch (err) {
        steps.log(`Aviso: no se pudo eliminar la rama "${ref.branch}" (${err instanceof Error ? err.message : String(err)}).`);
      }
      throw err;
    }
  } finally {
    steps.finish();
  }

  upsertBox(registry, {
    id: opts.id,
    provider: effectiveProvider,
    harness: effectiveHarness,
    yolo: effectiveYolo,
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projectRoot,
    containerName,
    ...(envKeys.length > 0 ? { envKeys } : {}),
    ...(worktreeRef ? { branch: worktreeRef.branch, worktreePath: worktreeRef.worktreePath } : {}),
  });
  saveRegistry(deps.configDir, registry);

  const containerNote = containerName !== opts.id ? ` (real container ${dockerContainerName(containerName)})` : '';
  deps.stdout.write(`Created sandbox "${opts.id}" (provider ${effectiveProvider}, harness ${effectiveHarness})${containerNote}.\n`);
  deps.stdout.write(`Project teleported from ${projectRoot}; ${sync.note}.\n`);
  if (injection.warning !== '') {
    deps.stderr.write(`warning: ${injection.warning}\n`);
  }
  if (injection.note !== '') {
    deps.stdout.write(`${injection.note}\n`);
  }
  if (envCopied) {
    deps.stdout.write(`Copied project .env.sander into the box as ${BOX_ENV_FILE}.\n`);
  }
  if (resolution.token === undefined) {
    deps.stdout.write('No GitHub token specified; no token was injected into the box.\n');
  }
  if (envKeys.length > 0) {
    const tokenNote = resolution.token !== undefined ? `GitHub token from ${resolution.source}; ` : '';
    deps.stdout.write(`${tokenNote}Injected ${envKeys.length} environment variable(s) into the box; secrets stay in memory and never touch disk.\n`);
  }
  return 0;
}

import { CliError } from '../errors';
import { helpForCommand } from '../help';
import { parseFlags } from '../args';
import type { CliDeps } from '../deps';
import { readGlobalConfig, workspaceLayer } from '../../config/config';
import { ensureRepoSetupArtifacts } from '../../setup/setup-agent';
import { runTestScripts } from '../../setup/test-scripts';
import { run, runAsync } from '../../process/run';

function flagOn(value: string | boolean | undefined): boolean {
  return value === true || value === 'true';
}

function parseTimeSeconds(flags: Record<string, string | boolean>): number {
  const raw = flags.time;
  if (raw === undefined) {
    return 5;
  }
  if (typeof raw !== 'string') {
    throw new CliError('--time requires a value in seconds');
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new CliError(`--time expects a number of seconds, got "${raw}"`);
  }
  return seconds;
}

async function runSetupTest(deps: CliDeps, flags: Record<string, string | boolean>, extra: string[]): Promise<number> {
  if (extra.length > 0) {
    throw new CliError(`unexpected argument "${extra[0]}": setup test takes no arguments`);
  }
  for (const name of Object.keys(flags)) {
    if (name !== 'time') {
      throw new CliError(`unexpected flag "--${name}": setup test takes only --time <s>`);
    }
  }
  const timeSeconds = parseTimeSeconds(flags);
  const projectRoot = process.cwd();
  const gitRunner = deps.gitRunner ?? ((args, opts) => run('git', args, opts));
  const dockerRunner = deps.dockerRunner ?? ((args, opts) => runAsync('docker', args, opts));
  const repo = gitRunner(['rev-parse', '--is-inside-work-tree'], { cwd: projectRoot });
  if (repo.exitCode !== 0) {
    throw new CliError(
      'no se puede ejecutar "sander setup test" desde un directorio que no es un repositorio git; ' +
        'ejecútalo desde la raíz de un proyecto versionado con git',
    );
  }
  await runTestScripts({ projectRoot, gitRunner, dockerRunner, timeSeconds, stdout: deps.stdout });
  return 0;
}

export async function runSetup(deps: CliDeps, argv: string[]): Promise<number> {
  const { flags, positionals } = parseFlags(argv);
  if (flags.help === true) {
    deps.stdout.write(helpForCommand('setup'));
    return 0;
  }
  if (positionals[0] === 'test') {
    return runSetupTest(deps, flags, positionals.slice(1));
  }
  if (positionals.length > 0) {
    throw new CliError(`unexpected argument "${positionals[0]}": setup takes no arguments`);
  }

  const projectRoot = process.cwd();
  const global = readGlobalConfig(deps.configDir);
  const workspace = workspaceLayer(projectRoot).read();
  const harnessName = global.harness ?? workspace.harness ?? 'opencode';
  const harness = deps.harnessFactory.get(harnessName);

  const force = flagOn(flags.force);
  const outcome = await ensureRepoSetupArtifacts({ projectRoot, harness, force });

  if (outcome.existed) {
    throw new CliError(
      `ya existen los scripts de arranque en .sander/ (install.sh, start.sh); usa "sander setup --force" para regenerarlos`,
    );
  }

  deps.stdout.write(`El agente de arranque generó los scripts de .sander/ (${outcome.missing.join(', ')}).\n`);
  if (outcome.output !== '') {
    deps.stdout.write(`${outcome.output}\n`);
  }
  return 0;
}

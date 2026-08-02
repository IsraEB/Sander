import { CliError } from '../errors';
import { helpForCommand } from '../help';
import { resolveExecId } from '../args';
import type { CliDeps } from '../deps';
import { loadRegistry } from '../../registry/registry';

export async function runExec(deps: CliDeps, argv: string[]): Promise<number> {
  if (argv[0] === '-h' || argv[0] === '--help') {
    deps.stdout.write(helpForCommand('exec'));
    return 0;
  }

  const { id, rest } = resolveExecId(argv);
  if (rest.length === 0) {
    throw new CliError('missing command: pass the command after the sandbox id, e.g. sander exec <id> "ls -la"');
  }

  const registry = loadRegistry(deps.configDir);
  const box = registry.boxes[id];
  if (!box) {
    throw new CliError(`sandbox not found: ${id}`);
  }

  const provider = deps.createProvider(box.provider);
  const result = await provider.exec(id, rest);

  if (result.stdout !== '') {
    deps.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  }
  if (result.stderr !== '') {
    deps.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  }
  return result.exitCode;
}

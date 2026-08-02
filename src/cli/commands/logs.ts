import { CliError } from '../errors';
import { helpForCommand } from '../help';
import { resolveSandboxId } from '../args';
import type { CliDeps } from '../deps';
import { loadRegistry } from '../../registry/registry';
import { startLogPath } from '../../setup/supervisor';

export async function runLogs(deps: CliDeps, argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    deps.stdout.write(helpForCommand('logs'));
    return 0;
  }

  const { id, rest } = resolveSandboxId(argv);
  if (rest.length > 0) {
    throw new CliError(`unexpected argument "${rest[0]}": logs takes a single sandbox id`);
  }

  const registry = loadRegistry(deps.configDir);
  const box = registry.boxes[id];
  if (!box) {
    throw new CliError(`sandbox not found: ${id}`);
  }

  const provider = deps.createProvider(box.provider);
  const result = await provider.exec(id, ['cat', startLogPath()]);
  if (result.exitCode === 0 && result.stdout !== '') {
    const output = result.stdout;
    deps.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  }
  return 0;
}

import { CliError } from '../errors';
import { helpForCommand } from '../help';
import { resolveSandboxId } from '../args';
import type { CliDeps } from '../deps';
import { loadRegistry } from '../../registry/registry';

export async function runRun(deps: CliDeps, argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    deps.stdout.write(helpForCommand('run'));
    return 0;
  }

  const { id, rest } = resolveSandboxId(argv);
  const prompt = rest.join(' ').trim();
  if (prompt === '') {
    throw new CliError('missing prompt: pass the prompt as the last argument, e.g. sander run <id> "fix the tests"');
  }

  const registry = loadRegistry(deps.configDir);
  const box = registry.boxes[id];
  if (!box) {
    throw new CliError(`sandbox not found: ${id}`);
  }

  const provider = deps.createProvider(box.provider);
  const harness = deps.harnessFactory.get(box.harness);
  const result = await provider.exec(box.id, [box.harness, ...harness.headlessCommand(prompt)]);

  deps.stdout.write(`Sandbox "${id}" (${box.harness}) finished with exit code ${result.exitCode}.\n`);
  const output = `${result.stdout}${result.stderr}`.trim();
  if (output !== '') {
    deps.stdout.write(`${output}\n`);
  }
  return result.exitCode;
}

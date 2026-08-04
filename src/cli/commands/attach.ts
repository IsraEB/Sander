import { CliError } from '../errors';
import { helpForCommand } from '../help';
import { resolveSandboxId } from '../args';
import type { CliDeps } from '../deps';
import { loadRegistry } from '../../registry/registry';

export async function runAttach(
  deps: CliDeps,
  argv: string[],
  opts: { launchHarness?: boolean; agent?: string; prompt?: string } = {},
): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    deps.stdout.write(helpForCommand('attach'));
    return 0;
  }

  const { id, rest } = resolveSandboxId(argv);
  if (rest.length > 0) {
    throw new CliError(`unexpected argument "${rest[0]}": attach takes a single sandbox id`);
  }

  const registry = loadRegistry(deps.configDir);
  const box = registry.boxes[id];
  if (!box) {
    throw new CliError(`sandbox not found: ${id}`);
  }
  // A box without the yolo field predates ticket 04 and defaults to yolo.
  deps.stdout.write(
    box.yolo ?? true
      ? `Sandbox "${id}" is yolo: actions auto-approve.\n`
      : `Sandbox "${id}" is not yolo: the harness will ask for approval.\n`
  );
  const provider = deps.createProvider(box.provider);

  await provider.ensureSetup({ interactive: false }); // writes the marker; attach never runs a wizard

  if (await provider.hasAgentSession(id)) {
    if (opts.prompt !== undefined || opts.agent !== undefined) {
      deps.stderr.write(
        `warning: --prompt/--agent are ignored: a session is already running in "${id}"; attaching to it.\n`
      );
    }
    const exitCode = await provider.attach(id, { tty: true });
    deps.stdout.write(`Sandbox "${id}" (${box.harness}) session exited with code ${exitCode}.\n`);
    return exitCode;
  }

  if (opts.launchHarness === true) {
    deps.stderr.write(`no agent session running in "${id}"; launching ${box.harness}.\n`);
    const harness = deps.harnessFactory.get(box.harness);
    const agentArgs = opts.agent === undefined ? [] : harness.agentArg(opts.agent);
    if (opts.agent !== undefined && agentArgs === null) {
      deps.stderr.write(`warning: harness "${box.harness}" does not support --agent; ignoring --agent ${opts.agent}.\n`);
    }
    const command = [box.harness, ...(agentArgs ?? [])];
    const code = await provider.shell(id, { command, input: opts.prompt });
    deps.stdout.write(`Sandbox "${id}" (${box.harness}) session exited with code ${code}.\n`);
    return code;
  }

  deps.stderr.write(
    `no agent session running in "${id}"; opening a box shell.\n` +
      `Start an agent by hand: run "${box.harness}" in the shell.\n`
  );
  const shellCode = await provider.shell(id);
  deps.stdout.write(`Sandbox "${id}" (${box.harness}) shell exited with code ${shellCode}.\n`);
  return shellCode;
}

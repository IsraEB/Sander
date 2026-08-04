import { CliError } from '../errors';
import { helpForCommand } from '../help';
import { parseFlags, popBooleanFlag } from '../args';
import type { CliDeps } from '../deps';
import { readGlobalConfig, saveConfig, workspaceLayer } from '../../config/config';
import type { GlobalConfig } from '../../config/config';
import { REQUIRED_KEYS, missingRequiredKeys, validateConfiguredKey } from '../../config/configured';
import type { RequiredKey } from '../../config/configured';
import { interactiveNeededError, missingKeysError, runConfigWizard, WIZARD_KEYS } from '../../config/wizard';
import type { WizardDeps } from '../../config/wizard';

const TOP_LEVEL_KEYS = ['provider', 'harness', 'token', 'yolo'] as const;
type TopLevelKey = (typeof TOP_LEVEL_KEYS)[number];

// The token is a secret: bulk listings always redact it. An explicit
// "config get token" still prints the real value via readEntry.
const SECRET_REDACTION = '***';

interface Scope {
  dir: string;
  label: string;
  read(): GlobalConfig;
  write(config: GlobalConfig): void;
}

function flagOn(value: string | boolean | undefined): boolean {
  return value === true || value === 'true';
}

function resolveScope(deps: CliDeps, workspace: boolean, global: boolean): Scope {
  if (workspace && global) {
    throw new CliError('cannot combine --global and --workspace: pick one scope');
  }
  if (workspace) {
    const layer = workspaceLayer(process.cwd());
    return {
      dir: layer.dir,
      label: 'workspace',
      read: () => layer.read(),
      write: (config) => saveConfig(layer.dir, config),
    };
  }
  return {
    dir: deps.configDir,
    label: 'global',
    read: () => readGlobalConfig(deps.configDir),
    write: (config) => saveConfig(deps.configDir, config),
  };
}

interface ParsedKey {
  section: string;
  envKey?: string;
}

function parseKey(key: string): ParsedKey {
  const dot = key.indexOf('.');
  if (dot === -1) {
    return { section: key };
  }
  const section = key.slice(0, dot);
  const rest = key.slice(dot + 1);
  if (section !== 'env') {
    throw new CliError(`unknown config key "${key}": nested keys are only supported as env.<KEY>`);
  }
  if (rest === '') {
    throw new CliError('config key "env." is invalid: pass env.<KEY>');
  }
  return { section: 'env', envKey: rest };
}

function requireTopLevelKey(key: string, section: string): asserts section is TopLevelKey {
  if (!TOP_LEVEL_KEYS.includes(section as TopLevelKey)) {
    throw new CliError(
      `unknown config key "${key}": supported keys are ${TOP_LEVEL_KEYS.join(', ')} and env.<KEY>`,
    );
  }
}

function parseYoloValue(value: string): boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new CliError(
    `invalid value for "yolo": pass "sander config set yolo true" or "sander config set yolo false"`,
  );
}

function validateValue(section: string, value: string): void {
  if (section === 'provider' || section === 'harness') {
    validateConfiguredKey(section as RequiredKey, value);
  } else if (section === 'yolo') {
    parseYoloValue(value);
  }
}

function readEntry(config: GlobalConfig, parsed: ParsedKey): { found: boolean; value: unknown } {
  if (parsed.section === 'env') {
    if (parsed.envKey === undefined) {
      return config.env === undefined ? { found: false, value: undefined } : { found: true, value: config.env };
    }
    const value = config.env?.[parsed.envKey];
    return value === undefined ? { found: false, value: undefined } : { found: true, value };
  }
  const value = config[parsed.section as TopLevelKey];
  return value === undefined ? { found: false, value: undefined } : { found: true, value };
}

function setEntry(config: GlobalConfig, parsed: ParsedKey, value: string): GlobalConfig {
  if (parsed.section === 'env') {
    if (parsed.envKey === undefined) {
      throw new CliError('cannot set the whole env section with a value: use "sander config set env.<KEY> <value>"');
    }
    config.env = config.env ?? {};
    config.env[parsed.envKey] = value;
    return config;
  }
  if (parsed.section === 'yolo') {
    config.yolo = parseYoloValue(value);
    return config;
  }
  if (parsed.section === 'token') {
    // Trimmed like the flag (flagValue) and wizard (askForToken) paths.
    // env.<KEY> is NEVER trimmed: env values may contain legitimate spaces.
    config.token = value.trim();
    return config;
  }
  config[parsed.section as Exclude<TopLevelKey, 'yolo' | 'token'>] = value;
  return config;
}

function unsetEntry(config: GlobalConfig, parsed: ParsedKey): boolean {
  if (parsed.section === 'env') {
    if (parsed.envKey === undefined) {
      if (config.env === undefined) {
        return false;
      }
      delete config.env;
      return true;
    }
    if (config.env === undefined || config.env[parsed.envKey] === undefined) {
      return false;
    }
    delete config.env[parsed.envKey];
    if (Object.keys(config.env).length === 0) {
      delete config.env;
    }
    return true;
  }
  if (config[parsed.section as TopLevelKey] === undefined) {
    return false;
  }
  delete config[parsed.section as TopLevelKey];
  return true;
}

function listEntries(config: GlobalConfig): string {
  const lines: string[] = [];
  for (const key of TOP_LEVEL_KEYS) {
    const value = config[key];
    if (value !== undefined) {
      lines.push(`${key} = ${key === 'token' ? SECRET_REDACTION : value}`);
    }
  }
  const env = config.env;
  if (env !== undefined) {
    for (const [key, value] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`env.${key} = ${value}`);
    }
  }
  return lines.join('\n');
}

function renderValue(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    return `${JSON.stringify(value, null, 2)}\n`;
  }
  return `${String(value)}\n`;
}

function runConfigSet(deps: CliDeps, scope: Scope, args: string[]): number {
  if (args.length < 2) {
    throw new CliError('missing arguments: sander config set <key> <value>');
  }
  if (args.length > 2) {
    throw new CliError(`unexpected argument "${args[2]}": sander config set takes <key> and <value>`);
  }
  const [keyArg, valueArg] = args;
  const parsed = parseKey(keyArg);
  if (parsed.section !== 'env') {
    requireTopLevelKey(keyArg, parsed.section);
    if (valueArg.trim() === '') {
      throw new CliError(`empty value for "${keyArg}": pass sander config set ${keyArg} <value>`);
    }
    validateValue(parsed.section, valueArg);
  } else if (valueArg.trim() === '') {
    throw new CliError(`empty value for "${keyArg}": pass sander config set ${keyArg} <value>`);
  }
  const storedValue = parsed.section === 'token' ? valueArg.trim() : valueArg;
  const config = scope.read();
  setEntry(config, parsed, storedValue);
  scope.write(config);
  deps.stdout.write(`Set ${keyArg} to "${storedValue}" in ${scope.label} config.\n`);
  return 0;
}

function runConfigGet(deps: CliDeps, scope: Scope, args: string[]): number {
  if (args.length > 1) {
    throw new CliError(`unexpected argument "${args[1]}": sander config get takes at most one key`);
  }
  const config = scope.read();
  if (args.length === 0) {
    const rendered = listEntries(config);
    deps.stdout.write(rendered === '' ? `No config set in the ${scope.label} scope.\n` : `${rendered}\n`);
    return 0;
  }
  const keyArg = args[0];
  const parsed = parseKey(keyArg);
  const entry = readEntry(config, parsed);
  if (!entry.found) {
    throw new CliError(
      `config key "${keyArg}" is not set in the ${scope.label} scope; use "sander config set ${keyArg} <value>"`,
    );
  }
  deps.stdout.write(renderValue(entry.value));
  return 0;
}

function runConfigUnset(deps: CliDeps, scope: Scope, args: string[]): number {
  if (args.length === 0) {
    throw new CliError('missing key: sander config unset <key>');
  }
  if (args.length > 1) {
    throw new CliError(`unexpected argument "${args[1]}": sander config unset takes a single key`);
  }
  const keyArg = args[0];
  const parsed = parseKey(keyArg);
  if (parsed.section !== 'env') {
    requireTopLevelKey(keyArg, parsed.section);
  }
  const config = scope.read();
  if (!unsetEntry(config, parsed)) {
    throw new CliError(`config key "${keyArg}" is not set in the ${scope.label} scope`);
  }
  scope.write(config);
  deps.stdout.write(`Unset ${keyArg} in ${scope.label} config.\n`);
  return 0;
}

function runConfigList(deps: CliDeps, scope: Scope, args: string[]): number {
  if (args.length > 0) {
    throw new CliError(`unexpected argument "${args[0]}": sander config list takes no arguments`);
  }
  const rendered = listEntries(scope.read());
  deps.stdout.write(rendered === '' ? `No config set in the ${scope.label} scope.\n` : `${rendered}\n`);
  return 0;
}

function flagValue(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  if (value === true) {
    throw new CliError(`--${name} requires a value: pass --${name} <value>`);
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function applyConfigFlags(deps: CliDeps, config: GlobalConfig, flags: Record<string, string | boolean>): GlobalConfig {
  const next = { ...config };
  let changed = false;
  for (const key of TOP_LEVEL_KEYS) {
    const value = flagValue(flags, key);
    if (value === undefined) {
      continue;
    }
    if (key === 'yolo') {
      next.yolo = parseYoloValue(value);
    } else {
      if (key !== 'token') {
        validateConfiguredKey(key as RequiredKey, value);
      }
      next[key] = value;
    }
    changed = true;
  }
  if (changed) {
    saveConfig(deps.configDir, next);
  }
  return next;
}

function flagSources(flags: Record<string, string | boolean>): Partial<Record<RequiredKey, string>> {
  const sources: Partial<Record<RequiredKey, string>> = {};
  for (const key of REQUIRED_KEYS) {
    const value = flagValue(flags, key);
    if (value !== undefined) {
      sources[key] = value;
    }
  }
  return sources;
}

function wizardDeps(deps: CliDeps): WizardDeps {
  return {
    input: deps.stdin ?? process.stdin,
    output: deps.stderr,
    keySource: deps.selectorKeySource,
    prompt: deps.prompt ?? (() => undefined),
    promptSecret: deps.promptSecret,
  };
}

async function runConfigBare(deps: CliDeps, scope: Scope, flags: Record<string, string | boolean>): Promise<number> {
  // Bare `sander config` is INTENTIONALLY always interactive. In a TTY it runs
  // the wizard for every configurable key (provider, harness, and the optional
  // token) not already passed as a --provider/--harness/--token flag — even
  // when everything is already configured — showing the current value as the
  // selector's starting cursor. In a non-TTY the wizard throws an actionable
  // error for the required keys (the selector never renders); the optional
  // token is silently skipped when it cannot be asked. Never regress this to
  // the old "print the config when nothing is missing" shortcut: `sander config
  // list` is the read-only view.
  const global = applyConfigFlags(deps, readGlobalConfig(deps.configDir), flags);
  const workspace = workspaceLayer(process.cwd()).read();
  const flagKeys = flagSources(flags);
  const missing = missingRequiredKeys({ global, workspace, flags: flagKeys });
  const ask = WIZARD_KEYS.filter((key) => flagValue(flags, key) === undefined);
  if (ask.length > 0) {
    const noPromptError = missing.length > 0 ? () => missingKeysError(missing) : interactiveNeededError;
    const answered = await runConfigWizard(wizardDeps(deps), global, [...ask], noPromptError);
    // Only persist when the wizard actually changed something: in a non-TTY run
    // where only the optional token is askable, the wizard returns the config
    // unchanged and a save would be a redundant rewrite.
    if (JSON.stringify(answered) !== JSON.stringify(global)) {
      saveConfig(deps.configDir, answered);
    }
  }
  const rendered = listEntries(scope.read());
  deps.stdout.write(rendered === '' ? `No config set in the ${scope.label} scope.\n` : `${rendered}\n`);
  return 0;
}

export async function runConfig(deps: CliDeps, argv: string[]): Promise<number> {
  const { argv: argvNoWorkspace, value: workspaceShort } = popBooleanFlag(argv, 'workspace');
  const { argv: argvClean, value: globalShort } = popBooleanFlag(argvNoWorkspace, 'global');
  const { flags, positionals } = parseFlags(argvClean);
  if (flags.help === true) {
    deps.stdout.write(helpForCommand('config'));
    return 0;
  }
  const scope = resolveScope(deps, workspaceShort || flagOn(flags.workspace), globalShort || flagOn(flags.global));
  const [sub, ...rest] = positionals;

  switch (sub) {
    case undefined:
      return runConfigBare(deps, scope, flags);
    case 'set':
      return runConfigSet(deps, scope, rest);
    case 'get':
      return runConfigGet(deps, scope, rest);
    case 'unset':
      return runConfigUnset(deps, scope, rest);
    case 'list':
      return runConfigList(deps, scope, rest);
    default:
      throw new CliError(`unknown subcommand "${sub}": use set, get, unset or list`);
  }
}

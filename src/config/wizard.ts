import { CliError } from '../cli/errors';
import type { GlobalConfig } from './config';
import { validateConfiguredKey } from './configured';
import type { RequiredKey } from './configured';
import { PROVIDERS, PROVIDER_REQUIRES_SETUP } from '../provider/providers';
import type { ProviderName } from '../provider/providers';
import { runSelector } from '../selector/selector';
import type { KeySource, SelectOption } from '../selector/selector';
import { readLineSync } from '../process/tty';

interface Question {
  label: string;
  default: string;
}

const QUESTIONS: Record<RequiredKey, Question> = {
  provider: { label: 'Provider', default: 'docker' },
  harness: { label: 'Harness', default: 'opencode' },
};

// The provider question is a CLOSED list: the five real providers, with cloud
// ones visually marked as needing a one-time setup. There is no free-text
// input, so a value outside this list can never be produced by the wizard.
export const PROVIDER_OPTIONS: readonly SelectOption<ProviderName>[] = PROVIDERS.map((provider) => ({
  value: provider,
  mark: PROVIDER_REQUIRES_SETUP[provider] ? 'requieren setup' : undefined,
}));

export const HARNESS_OTHER = '__other__';

// The harness question is a selector over the known harnesses plus an
// "Other…" entry that switches to free text typing (with the existing
// SAFE_NAME validation) when chosen.
export const HARNESS_OPTIONS: readonly SelectOption<string>[] = [
  { value: 'opencode' },
  { value: 'claude' },
  { value: 'codex' },
  { value: HARNESS_OTHER, label: 'Other…' },
];

const SELECTOR_HINT = ' (1-9 selects, arrows move, Enter confirms, q/Esc cancels):';

export function createPrompt(
  input: NodeJS.ReadableStream | undefined,
  output: NodeJS.WritableStream,
): (question: string) => string | undefined {
  return (question: string): string | undefined => {
    const tty = input as unknown as { isTTY?: boolean; fd?: number } | undefined;
    if (!tty || !tty.isTTY || typeof tty.fd !== 'number') {
      return undefined;
    }
    output.write(question);
    return readLineSync(tty.fd);
  };
}

export function missingKeysError(missing: RequiredKey[]): CliError {
  const flags = missing.map((key) => `--${key} ${QUESTIONS[key].default}`).join(' ');
  return new CliError(
    `missing required configuration: ${missing.join(', ')}\n` +
      `run "sander config set <key> <value>" or pass the flags: ${flags}`,
  );
}

export function interactiveNeededError(): CliError {
  return new CliError(
    'bare "sander config" needs an interactive terminal to ask for provider and harness\n' +
      'run "sander config list" to view the current config, or change values with\n' +
      '"sander config set <key> <value>" or the --provider/--harness flags',
  );
}

export function wizardCancelledError(missing: RequiredKey[]): CliError {
  const flags = missing.map((key) => `--${key} ${QUESTIONS[key].default}`).join(' ');
  return new CliError(
    'wizard cancelled: no configuration was saved\n' +
      `run "sander config set <key> <value>" or pass the flags: ${flags}`,
  );
}

export function otherNameError(): CliError {
  return new CliError(
    'harness name is required after choosing "Other…": type a name, or pass --harness <name>',
  );
}

export interface WizardDeps {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  keySource?: KeySource;
  prompt?: (question: string) => string | undefined;
}

// The wizard runs only when it can interact: an injectable key source (tests)
// or a real TTY input. Without either it must never render or read anything —
// the caller gets the actionable no-prompt error instead.
function isInteractive(deps: WizardDeps): boolean {
  if (deps.keySource !== undefined) {
    return true;
  }
  const stream = deps.input as { isTTY?: boolean; setRawMode?: unknown };
  return stream.isTTY === true && typeof stream.setRawMode === 'function';
}

function initialCursor<T>(options: readonly SelectOption<T>[], current: string): number {
  const index = options.findIndex((option) => option.value === current);
  return index < 0 ? 0 : index;
}

async function askForKey(deps: WizardDeps, key: RequiredKey, current: string, asked: RequiredKey[]): Promise<string> {
  const question = QUESTIONS[key];
  const options: readonly SelectOption<string>[] = key === 'provider' ? PROVIDER_OPTIONS : HARNESS_OPTIONS;
  const result = await runSelector(options, {
    input: deps.input,
    output: deps.output,
    keySource: deps.keySource,
    title: `${question.label}${SELECTOR_HINT}`,
    initialCursor: initialCursor(options, current),
  });
  if (result.kind === 'cancelled') {
    throw wizardCancelledError(asked);
  }
  if (key === 'harness' && result.option.value === HARNESS_OTHER) {
    const raw = deps.prompt ? deps.prompt('Harness (other): ') : undefined;
    if (raw === undefined || raw.trim() === '') {
      throw otherNameError();
    }
    return raw.trim();
  }
  return result.option.value;
}

export async function runConfigWizard(
  deps: WizardDeps,
  config: GlobalConfig,
  keys: RequiredKey[],
  noPromptError?: () => CliError,
): Promise<GlobalConfig> {
  if (keys.length === 0) {
    return { ...config };
  }
  if (!isInteractive(deps)) {
    throw noPromptError ? noPromptError() : missingKeysError(keys);
  }
  const next = { ...config };
  for (const key of keys) {
    const current = next[key] ?? QUESTIONS[key].default;
    const value = await askForKey(deps, key, current, keys);
    validateConfiguredKey(key, value);
    next[key] = value;
  }
  return next;
}

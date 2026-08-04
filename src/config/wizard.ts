import { CliError } from '../cli/errors';
import type { GlobalConfig } from './config';
import { REQUIRED_KEYS, validateConfiguredKey } from './configured';
import type { RequiredKey } from './configured';
import { PROVIDERS, PROVIDER_REQUIRES_SETUP } from '../provider/providers';
import type { ProviderName } from '../provider/providers';
import { runSelector } from '../selector/selector';
import type { KeySource, SelectOption } from '../selector/selector';
import { readLineSync } from '../process/tty';
import { spawnSync } from 'node:child_process';

interface Question {
  label: string;
  default: string;
}

const QUESTIONS: Record<RequiredKey, Question> = {
  provider: { label: 'Provider', default: 'docker' },
  harness: { label: 'Harness', default: 'opencode' },
};

// The wizard can ask for the required keys (provider, harness) plus the
// optional free-text token. `yolo` is intentionally never askable: it has no
// selector question and is only set via flags or "sander config set yolo".
export type WizardKey = RequiredKey | 'token';

// Ask order: the required selectors first, then the optional token. The token
// is the only optional key and is asked last, through the prompt seam.
export const WIZARD_KEYS: readonly WizardKey[] = ['provider', 'harness', 'token'];

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

// Best-effort stty echo toggle on the TTY fd. If stty is missing or fails
// (non-POSIX platform), the read falls back to the visible prompt — the
// same behavior as before this correction. Platform is linux/macOS.
function setEcho(fd: number, enabled: boolean): void {
  const result = spawnSync('stty', [enabled ? 'echo' : '-echo'], { stdio: [fd, 'ignore', 'ignore'] });
  if (result.error !== undefined || result.status !== 0) {
    // ignore: keep going with whatever echo state the terminal has
  }
}

// The secret prompt adapter: same reading primitive as createPrompt, but the
// TTY echo is disabled while the answer is typed so a secret never appears in
// the terminal output. It falls back to the visible prompt when stty fails.
export function createSecretPrompt(
  input: NodeJS.ReadableStream | undefined,
  output: NodeJS.WritableStream,
): (question: string) => string | undefined {
  return (question: string): string | undefined => {
    const tty = input as unknown as { isTTY?: boolean; fd?: number } | undefined;
    if (!tty || !tty.isTTY || typeof tty.fd !== 'number') {
      return undefined;
    }
    output.write(question);
    setEcho(tty.fd, false);
    try {
      const line = readLineSync(tty.fd);
      // The terminal never echoes the Enter that ends a hidden read, so move
      // to a fresh line ourselves; without this the next output would run
      // onto the prompt line.
      output.write('\n');
      return line;
    } finally {
      setEcho(tty.fd, true);
    }
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
    'bare "sander config" needs an interactive terminal to ask for provider, harness and token\n' +
      'run "sander config list" to view the current config, or change values with\n' +
      '"sander config set <key> <value>" or the --provider/--harness/--token flags',
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
  promptSecret?: (question: string) => string | undefined;
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

// The token question is free text (never a closed list) through the secret
// prompt seam: the real adapter hides what is typed (no echo), while the plain
// prompt is used as the fallback when no secret adapter was provided (tests and
// non-TTY callers). It always starts blank so an existing secret is never
// prefilled: leaving it blank keeps the current token (or leaves it unset).
// There is no validation — any non-empty text is accepted.
function askForToken(deps: WizardDeps, current: string | undefined): string | undefined {
  const state =
    current === undefined || current.trim() === ''
      ? 'optional; leave blank for none'
      : 'currently set; leave blank to keep it';
  const prompt = deps.promptSecret ?? deps.prompt;
  const raw = prompt ? prompt(`Token (${state}): `) : undefined;
  if (raw === undefined) {
    return undefined; // no answer (EOF / non-writing prompt): keep the current value
  }
  const value = raw.trim();
  return value === '' ? undefined : value;
}

export async function runConfigWizard(
  deps: WizardDeps,
  config: GlobalConfig,
  keys: WizardKey[],
  noPromptError?: () => CliError,
): Promise<GlobalConfig> {
  if (keys.length === 0) {
    return { ...config };
  }
  const required = keys.filter((key): key is RequiredKey =>
    (REQUIRED_KEYS as readonly string[]).includes(key),
  );
  if (!isInteractive(deps)) {
    if (required.length === 0) {
      return { ...config }; // only optional keys: skip silently in non-TTY
    }
    throw noPromptError ? noPromptError() : missingKeysError(required);
  }
  const next = { ...config };
  for (const key of required) {
    const current = next[key] ?? QUESTIONS[key].default;
    const value = await askForKey(deps, key, current, required);
    validateConfiguredKey(key, value);
    next[key] = value;
  }
  if (keys.includes('token')) {
    const value = await askForToken(deps, next.token);
    if (value !== undefined) {
      next.token = value;
    }
  }
  return next;
}

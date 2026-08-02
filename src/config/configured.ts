import { CliError } from '../cli/errors';
import type { GlobalConfig } from './config';
import { validateProviderValue } from '../provider/providers';

export const REQUIRED_KEYS = ['provider', 'harness'] as const;
export type RequiredKey = (typeof REQUIRED_KEYS)[number];

export const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

export interface RequiredKeySources {
  global: GlobalConfig;
  workspace: GlobalConfig;
  flags: Partial<Record<RequiredKey, string>>;
}

function present(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

export function missingRequiredKeys(sources: RequiredKeySources): RequiredKey[] {
  return REQUIRED_KEYS.filter((key) => {
    const inGlobal = present(sources.global[key]);
    const inWorkspace = present(sources.workspace[key]);
    const inFlags = present(sources.flags[key]);
    return !(inGlobal || inWorkspace || inFlags);
  });
}

export function validateConfiguredKey(key: RequiredKey, value: string): void {
  if (key === 'provider') {
    validateProviderValue(value);
    return;
  }
  if (!SAFE_NAME.test(value)) {
    throw new CliError(
      `invalid harness name "${value}": names must be letters, digits and dashes and cannot start with a dash`,
    );
  }
}

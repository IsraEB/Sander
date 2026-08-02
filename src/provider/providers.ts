import { CliError } from '../cli/errors';
import { AgentboxProvider } from './agentbox';
import type { AgentboxProviderOptions } from './agentbox';
import type { Provider } from './provider';

export const PROVIDERS = ['docker', 'daytona', 'hetzner', 'vercel', 'e2b'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

// Cloud providers need a one-time setup step on first use; docker is local.
export const PROVIDER_REQUIRES_SETUP: Readonly<Record<ProviderName, boolean>> = {
  docker: false,
  daytona: true,
  hetzner: true,
  vercel: true,
  e2b: true,
};

const LEGACY_PROVIDER_ALIAS_KEYS = ['agentbox'] as const;
export type LegacyProviderAlias = (typeof LEGACY_PROVIDER_ALIAS_KEYS)[number];

// Legacy config/registry values. `agentbox` is tolerated when READING legacy
// config and resolves to the docker engine internally; writing it as a config
// value is rejected (see validateProviderValue).
// Backward compatibility only: REMOVE this alias when no registry box has
// `provider: agentbox` anymore. If an agent finds this section and there are
// no `agentbox` boxes left, delete the alias.
export const LEGACY_PROVIDER_ALIASES: Readonly<Record<LegacyProviderAlias, ProviderName>> = {
  agentbox: 'docker',
};

export const DEFAULT_PROVIDER: ProviderName = 'docker';

// Values accepted in config and by the CLI: the five real providers. The
// legacy `agentbox` alias is NOT a valid config value anymore.
export const CONFIG_PROVIDERS = PROVIDERS;

export function isConfigProvider(name: string): name is (typeof CONFIG_PROVIDERS)[number] {
  return (CONFIG_PROVIDERS as readonly string[]).includes(name);
}

// Validation shared by config set, --provider flags and the wizard. Rejects the
// legacy alias with an actionable error suggesting the canonical provider.
export function validateProviderValue(value: string): void {
  const canonical = (LEGACY_PROVIDER_ALIASES as Readonly<Record<string, ProviderName>>)[value];
  if (canonical !== undefined) {
    throw new CliError(
      `provider "${value}" is deprecated: use "${canonical}" instead; run "sander config set provider ${canonical}" to migrate`,
    );
  }
  if (!(PROVIDERS as readonly string[]).includes(value)) {
    const list = PROVIDERS.map((p) => `"${p}"`).join(', ');
    throw new CliError(`unsupported provider "${value}": only ${list} are implemented`);
  }
}

export function resolveProviderName(name: string): ProviderName {
  const canonical = (LEGACY_PROVIDER_ALIASES as Readonly<Record<string, ProviderName>>)[name] ?? name;
  if (!(PROVIDERS as readonly string[]).includes(canonical)) {
    throw new CliError(`unsupported provider "${name}"`);
  }
  return canonical as ProviderName;
}

export type ProviderFactory = (name: string, opts?: AgentboxProviderOptions) => Provider;

// In v0 every provider resolves to the agentbox engine; the legacy `agentbox`
// alias resolves to the docker engine.
export function createProvider(name: string = DEFAULT_PROVIDER, opts: AgentboxProviderOptions = {}): Provider {
  return new AgentboxProvider({ ...opts, providerName: resolveProviderName(name) });
}

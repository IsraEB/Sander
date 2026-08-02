import * as os from 'node:os';
import * as path from 'node:path';

export type RecipeMode = 'yolo' | 'no-yolo';

/**
 * A per-harness recipe centralizing "where each harness reads its config"
 * (host + inside the box) and the pure yolo/no-yolo transforms.
 */
export interface HarnessRecipe {
  readonly name: string;
  /** Real config dir on the host; source of the host→box sync. */
  readonly hostConfigDir: string;
  /** Real config dir inside the box (posix, relative to the box home via ~);
   * destination of the sync and of the yolo injection. */
  readonly boxConfigDir: string;
  readonly configFileName: string;
  readonly format: 'json' | 'toml';
  readonly applyYolo: (config: unknown) => unknown;
  readonly applyNoYolo: (config: unknown) => unknown;
}

export type ConfigTransformResult =
  | { kind: 'transformed'; content: string }
  | { kind: 'skipped'; reason: 'jsonc' | 'invalid-json' };

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function openCodeApplyYolo(config: unknown): unknown {
  const obj = asRecord(config);
  if (obj.permission === undefined) {
    return obj;
  }
  const permission = asRecord(obj.permission);
  const nextPermission: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(permission)) {
    nextPermission[key] = value === 'ask' ? 'allow' : value;
  }
  return { ...obj, permission: nextPermission };
}

function openCodeApplyNoYolo(config: unknown): unknown {
  const obj = asRecord(config);
  const permission = asRecord(obj.permission);
  const nextPermission: Record<string, unknown> = { ...permission };
  // Explicit deny of the catch-all is preserved; anything else becomes ask.
  if (nextPermission['*'] !== 'deny') {
    nextPermission['*'] = 'ask';
  }
  return { ...obj, permission: nextPermission };
}

function claudeApplyWithDefaultMode(mode: string): (config: unknown) => unknown {
  return (config: unknown): unknown => {
    const obj = asRecord(config);
    const permissions = asRecord(obj.permissions);
    return { ...obj, permissions: { ...permissions, defaultMode: mode } };
  };
}

function setApprovalPolicy(toml: string, value: string): string {
  const lines = toml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^([ \t]*)approval_policy[ \t]*=[ \t]*(?<value>"[^"]*"|[^#\n]*)(?<comment>[ \t]*#.*)?$/.exec(line);
    if (m) {
      const comment = m.groups?.comment ?? '';
      lines[i] = `${m[1] ?? ''}approval_policy = "${value}"${comment}`;
      return lines.join('\n');
    }
  }
  const trailingEmpty = lines.length > 0 && lines[lines.length - 1] === '';
  lines.splice(trailingEmpty ? lines.length - 1 : lines.length, 0, `approval_policy = "${value}"`);
  return lines.join('\n');
}

function codexApplyYolo(config: unknown): unknown {
  return setApprovalPolicy(typeof config === 'string' ? config : '', 'never');
}

function codexApplyNoYolo(config: unknown): unknown {
  return setApprovalPolicy(typeof config === 'string' ? config : '', 'on-request');
}

function hasComments(text: string): boolean {
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '\\') {
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      return true;
    }
  }
  return false;
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export const harnessRecipes: ReadonlyMap<string, HarnessRecipe> = new Map<string, HarnessRecipe>([
  [
    'opencode',
    {
      name: 'opencode',
      hostConfigDir: path.join(os.homedir(), '.config', 'opencode'),
      boxConfigDir: '~/.local/share/opencode/config',
      configFileName: 'opencode.json',
      format: 'json',
      applyYolo: openCodeApplyYolo,
      applyNoYolo: openCodeApplyNoYolo,
    },
  ],
  [
    'claude',
    {
      name: 'claude',
      hostConfigDir: path.join(os.homedir(), '.claude'),
      boxConfigDir: '~/.claude',
      configFileName: 'settings.json',
      format: 'json',
      applyYolo: claudeApplyWithDefaultMode('bypassPermissions'),
      applyNoYolo: claudeApplyWithDefaultMode('default'),
    },
  ],
  [
    'codex',
    {
      name: 'codex',
      hostConfigDir: path.join(os.homedir(), '.codex'),
      boxConfigDir: '~/.codex',
      configFileName: 'config.toml',
      format: 'toml',
      applyYolo: codexApplyYolo,
      applyNoYolo: codexApplyNoYolo,
    },
  ],
]);

/**
 * A harness without a recipe has no entry in the map; absence (undefined) is
 * distinguishable from a present recipe.
 */
export function getRecipe(name: string): HarnessRecipe | undefined {
  return harnessRecipes.get(name);
}

/**
 * Applies a recipe's transform to the existing config file content (raw text,
 * or undefined when the file does not exist). The merge is additive: the full
 * transformed content is returned, and the caller writes it back. JSONC files
 * (comments in the JSON) are never rewritten: the transform is skipped with a
 * signal so the caller can warn without touching the file.
 */
export function transformConfigFor(
  recipe: HarnessRecipe,
  mode: RecipeMode,
  existing: string | undefined,
): ConfigTransformResult {
  const apply = (config: unknown): unknown => (mode === 'yolo' ? recipe.applyYolo(config) : recipe.applyNoYolo(config));
  if (recipe.format === 'toml') {
    return { kind: 'transformed', content: apply(existing === undefined ? '' : existing) as string };
  }
  if (existing === undefined) {
    return { kind: 'transformed', content: serializeJson(apply({})) };
  }
  if (hasComments(existing)) {
    return { kind: 'skipped', reason: 'jsonc' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return { kind: 'skipped', reason: 'invalid-json' };
  }
  return { kind: 'transformed', content: serializeJson(apply(parsed)) };
}

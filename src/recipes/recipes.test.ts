import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { getRecipe, harnessRecipes, transformConfigFor } from './recipes';
import type { ConfigTransformResult, HarnessRecipe } from './recipes';

function jsonOf(result: ConfigTransformResult): Record<string, unknown> {
  expect(result.kind).toBe('transformed');
  return JSON.parse((result as { content: string }).content) as Record<string, unknown>;
}

describe('harnessRecipes map', () => {
  it('has a recipe for opencode, claude and codex', () => {
    expect(harnessRecipes.size).toBe(3);
    for (const name of ['opencode', 'claude', 'codex']) {
      expect(harnessRecipes.has(name)).toBe(true);
    }
  });

  it('has no entry for a harness without a recipe, distinguishable from a valid recipe', () => {
    expect(harnessRecipes.has('other')).toBe(false);
    expect(getRecipe('other')).toBeUndefined();
    expect(getRecipe('opencode')).toBeDefined();
    expect(getRecipe('opencode')?.name).toBe('opencode');
  });
});

describe('recipe directories', () => {
  it('opencode reads its config from the OPENCODE_CONFIG_DIR volume dir inside the box', () => {
    const opencode = getRecipe('opencode')!;
    expect(opencode.hostConfigDir).toBe(path.join(os.homedir(), '.config', 'opencode'));
    expect(opencode.boxConfigDir).toBe('~/.local/share/opencode/config');
    expect(opencode.configFileName).toBe('opencode.json');
  });

  it('claude reads its config from ~/.claude', () => {
    const claude = getRecipe('claude')!;
    expect(claude.hostConfigDir).toBe(path.join(os.homedir(), '.claude'));
    expect(claude.boxConfigDir).toBe('~/.claude');
    expect(claude.configFileName).toBe('settings.json');
  });

  it('codex reads its config from ~/.codex', () => {
    const codex = getRecipe('codex')!;
    expect(codex.hostConfigDir).toBe(path.join(os.homedir(), '.codex'));
    expect(codex.boxConfigDir).toBe('~/.codex');
    expect(codex.configFileName).toBe('config.toml');
  });
});

describe('opencode transforms', () => {
  it('applyYolo converts every ask rule to allow and preserves deny', () => {
    const recipe = getRecipe('opencode')!;
    const result = recipe.applyYolo({
      permission: { edit: 'ask', bash: 'ask', webfetch: 'deny', '*': 'ask' },
    });
    expect(result).toEqual({ permission: { edit: 'allow', bash: 'allow', webfetch: 'deny', '*': 'allow' } });
  });

  it('applyYolo leaves non-ask rules and the rest of the config untouched', () => {
    const recipe = getRecipe('opencode')!;
    const result = recipe.applyYolo({ theme: 'dark', permission: { bash: ['ls', 'cat'], webfetch: 'deny', edit: 'allow' } });
    expect(result).toEqual({ theme: 'dark', permission: { bash: ['ls', 'cat'], webfetch: 'deny', edit: 'allow' } });
  });

  it('applyYolo returns the config unchanged when there is no permission block', () => {
    const recipe = getRecipe('opencode')!;
    expect(recipe.applyYolo({})).toEqual({});
    expect(recipe.applyYolo({ theme: 'dark' })).toEqual({ theme: 'dark' });
  });

  it('applyNoYolo ensures the "*": "ask" catch-all and preserves deny', () => {
    const recipe = getRecipe('opencode')!;
    const result = recipe.applyNoYolo({ permission: { edit: 'allow', webfetch: 'deny' } });
    expect(result).toEqual({ permission: { edit: 'allow', webfetch: 'deny', '*': 'ask' } });
  });

  it('applyNoYolo preserves an explicit catch-all deny', () => {
    const recipe = getRecipe('opencode')!;
    const result = recipe.applyNoYolo({ permission: { '*': 'deny', edit: 'ask' } });
    expect(result).toEqual({ permission: { '*': 'deny', edit: 'ask' } });
  });

  it('applyNoYolo adds the permission block with the catch-all when absent', () => {
    const recipe = getRecipe('opencode')!;
    expect(recipe.applyNoYolo({})).toEqual({ permission: { '*': 'ask' } });
  });
});

describe('claude transforms', () => {
  it('applyYolo sets permissions.defaultMode to bypassPermissions', () => {
    const recipe = getRecipe('claude')!;
    expect(recipe.applyYolo({})).toEqual({ permissions: { defaultMode: 'bypassPermissions' } });
    expect(recipe.applyYolo({ permissions: { defaultMode: 'default' } })).toEqual({
      permissions: { defaultMode: 'bypassPermissions' },
    });
  });

  it('applyNoYolo sets permissions.defaultMode to default', () => {
    const recipe = getRecipe('claude')!;
    expect(recipe.applyNoYolo({})).toEqual({ permissions: { defaultMode: 'default' } });
    expect(recipe.applyNoYolo({ permissions: { defaultMode: 'bypassPermissions' } })).toEqual({
      permissions: { defaultMode: 'default' },
    });
  });

  it('preserves the rest of the permissions payload (allow/deny lists never touched)', () => {
    const recipe = getRecipe('claude')!;
    const result = recipe.applyYolo({ permissions: { defaultMode: 'default', allow: ['Bash(npm run build)'], deny: ['Read(~/secrets)'] } });
    expect(result).toEqual({ permissions: { defaultMode: 'bypassPermissions', allow: ['Bash(npm run build)'], deny: ['Read(~/secrets)'] } });
  });
});

describe('codex transforms', () => {
  it('applyYolo sets approval_policy to never', () => {
    const recipe = getRecipe('codex')!;
    expect(recipe.applyYolo('')).toBe('approval_policy = "never"\n');
    expect(recipe.applyYolo('approval_policy = "on-request"')).toBe('approval_policy = "never"');
    expect(recipe.applyYolo('approval_policy = "on-request"\n')).toBe('approval_policy = "never"\n');
  });

  it('applyNoYolo sets approval_policy to on-request', () => {
    const recipe = getRecipe('codex')!;
    expect(recipe.applyNoYolo('')).toBe('approval_policy = "on-request"\n');
    expect(recipe.applyNoYolo('approval_policy = "never"')).toBe('approval_policy = "on-request"');
    expect(recipe.applyNoYolo('approval_policy = "never"\n')).toBe('approval_policy = "on-request"\n');
  });

  it('appends the approval_policy line when absent, preserving other content', () => {
    const recipe = getRecipe('codex')!;
    const result = recipe.applyYolo('model = "gpt-4o"\n');
    expect(result).toBe('model = "gpt-4o"\napproval_policy = "never"\n');
  });

  it('manipulates an indented approval_policy line and preserves a trailing comment', () => {
    const recipe = getRecipe('codex')!;
    const result = recipe.applyYolo('  approval_policy = "on-request"  # auto-approve\n');
    expect(result).toBe('  approval_policy = "never"  # auto-approve\n');
  });

  it('does not mistake a commented-out approval_policy line for the real one', () => {
    const recipe = getRecipe('codex')!;
    const result = recipe.applyYolo('# approval_policy = "on-request"\n');
    expect(result).toBe('# approval_policy = "on-request"\napproval_policy = "never"\n');
  });
});

describe('transformConfigFor', () => {
  it('starts from the initial content when the config file is absent', () => {
    const opencode = getRecipe('opencode')!;
    expect(transformConfigFor(opencode, 'yolo', undefined)).toEqual({ kind: 'transformed', content: '{}\n' });
    expect(jsonOf(transformConfigFor(opencode, 'no-yolo', undefined))).toEqual({ permission: { '*': 'ask' } });

    const claude = getRecipe('claude')!;
    expect(jsonOf(transformConfigFor(claude, 'yolo', undefined))).toEqual({ permissions: { defaultMode: 'bypassPermissions' } });

    const codex = getRecipe('codex')!;
    expect(transformConfigFor(codex, 'yolo', undefined)).toEqual({ kind: 'transformed', content: 'approval_policy = "never"\n' });
  });

  it('merges additively with existing content and returns the full transformed content', () => {
    const opencode = getRecipe('opencode')!;
    const result = transformConfigFor(
      opencode,
      'yolo',
      '{\n  "theme": "dark",\n  "permission": { "edit": "ask", "webfetch": "deny" }\n}\n',
    );
    expect(jsonOf(result)).toEqual({ theme: 'dark', permission: { edit: 'allow', webfetch: 'deny' } });
    expect((result as { content: string }).content).toBe(
      '{\n  "theme": "dark",\n  "permission": {\n    "edit": "allow",\n    "webfetch": "deny"\n  }\n}\n',
    );
  });

  it('skips JSONC files with a warning signal and never rewrites them', () => {
    const opencode = getRecipe('opencode')!;
    const lineComment = '{\n  // yolo applies only to plain JSON\n  "permission": { "edit": "ask" }\n}\n';
    expect(transformConfigFor(opencode, 'yolo', lineComment)).toEqual({ kind: 'skipped', reason: 'jsonc' });

    const blockComment = '{\n  /* keep */\n  "permission": { "edit": "ask" }\n}\n';
    expect(transformConfigFor(opencode, 'yolo', blockComment)).toEqual({ kind: 'skipped', reason: 'jsonc' });
  });

  it('does not treat "//" inside a string literal as a comment', () => {
    const opencode = getRecipe('opencode')!;
    const content = '{\n  "url": "https://example.com",\n  "permission": { "edit": "ask" }\n}\n';
    const result = transformConfigFor(opencode, 'yolo', content);
    expect(result.kind).toBe('transformed');
    expect(jsonOf(result)).toEqual({ url: 'https://example.com', permission: { edit: 'allow' } });
  });

  it('skips unparseable JSON with a warning signal instead of corrupting it', () => {
    const claude = getRecipe('claude')!;
    const broken = '{\n  "permissions": { "defaultMode": "default",\n}\n';
    expect(transformConfigFor(claude, 'yolo', broken)).toEqual({ kind: 'skipped', reason: 'invalid-json' });
  });

  it('serializes JSON with 2-space indentation and a trailing newline', () => {
    const claude = getRecipe('claude')!;
    const result = transformConfigFor(claude, 'yolo', undefined);
    expect((result as { content: string }).content).toBe('{\n  "permissions": {\n    "defaultMode": "bypassPermissions"\n  }\n}\n');
  });
});

describe('transforms are pure', () => {
  it('returns the same output for the same input and never mutates the input', () => {
    const recipes = [getRecipe('opencode')!, getRecipe('claude')!, getRecipe('codex')!];
    const inputs: unknown[][] = [
      [{ permission: { edit: 'ask', webfetch: 'deny' } }],
      [{ permissions: { defaultMode: 'default', deny: ['Read(~/secrets)'] } }],
      ['model = "gpt-4o"\n'],
    ];
    for (let i = 0; i < recipes.length; i++) {
      const recipe = recipes[i]!;
      const input = inputs[i]![0]!;
      const snapshot = JSON.stringify(input);
      const a = recipe.applyYolo(input);
      const b = recipe.applyYolo(input);
      expect(a).toEqual(b);
      expect(JSON.stringify(input)).toBe(snapshot);
      const na = recipe.applyNoYolo(input);
      const nb = recipe.applyNoYolo(input);
      expect(na).toEqual(nb);
      expect(JSON.stringify(input)).toBe(snapshot);
    }
  });

  it('performs no I/O: the pure functions need no harness or provider', () => {
    for (const recipe of harnessRecipes.values()) {
      expect(typeof recipe.applyYolo).toBe('function');
      expect(typeof recipe.applyNoYolo).toBe('function');
      expect(recipe.applyYolo).not.toThrow();
      expect(recipe.applyNoYolo).not.toThrow();
    }
  });
});

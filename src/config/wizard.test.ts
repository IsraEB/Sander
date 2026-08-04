import { describe, expect, it } from 'vitest';
import { CaptureStream } from '../../test/helpers/capture-stream';
import { CliError } from '../cli/errors';
import { renderSelector, runSelector } from '../selector/selector';
import type { KeySource, SelectorKey } from '../selector/selector';
import {
  HARNESS_OPTIONS,
  HARNESS_OTHER,
  PROVIDER_OPTIONS,
  interactiveNeededError,
  missingKeysError,
  otherNameError,
  runConfigWizard,
  wizardCancelledError,
} from './wizard';
import type { WizardDeps } from './wizard';
import type { GlobalConfig } from './config';

function keysSource(keys: SelectorKey[]): KeySource {
  let index = 0;
  return {
    next: async () => (index < keys.length ? keys[index++]! : null),
  };
}

function nonTtyDeps(overrides: Partial<WizardDeps> = {}): WizardDeps {
  return {
    input: {} as NodeJS.ReadableStream,
    output: new CaptureStream(),
    ...overrides,
  };
}

function deps(keys: SelectorKey[], output: CaptureStream, prompt?: (question: string) => string | undefined): WizardDeps {
  return { input: {} as NodeJS.ReadableStream, output, keySource: keysSource(keys), prompt };
}

describe('runConfigWizard selection logic', () => {
  it('selects the default provider and harness with enter', async () => {
    const out = new CaptureStream();
    const config = await runConfigWizard(deps(['enter', 'enter'], out), {}, ['provider', 'harness']);
    expect(config).toEqual({ provider: 'docker', harness: 'opencode' });
  });

  it('navigates with arrows to a cloud provider and a non-default harness', async () => {
    const out = new CaptureStream();
    const config = await runConfigWizard(deps(['down', 'down', 'down', 'enter', 'down', 'enter'], out), {}, [
      'provider',
      'harness',
    ]);
    expect(config).toEqual({ provider: 'vercel', harness: 'claude' });
  });

  it('selects directly with numeric shortcuts', async () => {
    const out = new CaptureStream();
    const config = await runConfigWizard(deps(['2', '3'], out), {}, ['provider', 'harness']);
    expect(config).toEqual({ provider: 'daytona', harness: 'codex' });
  });

  it('wraps up to the last provider option', async () => {
    const out = new CaptureStream();
    const config = await runConfigWizard(deps(['up', 'enter', 'enter'], out), {}, ['provider', 'harness']);
    expect(config).toEqual({ provider: 'e2b', harness: 'opencode' });
  });

  it('asks only for the requested keys and keeps the rest of the config', async () => {
    const out = new CaptureStream();
    const config = await runConfigWizard(deps(['down', 'enter'], out), { provider: 'docker', token: 't' }, ['harness']);
    expect(config).toEqual({ provider: 'docker', token: 't', harness: 'claude' });
  });

  it('starts the cursor on the current configured value so enter keeps it', async () => {
    const out = new CaptureStream();
    const config = await runConfigWizard(deps(['enter', 'enter'], out), { provider: 'vercel', harness: 'codex' }, [
      'provider',
      'harness',
    ]);
    expect(config).toEqual({ provider: 'vercel', harness: 'codex' });
  });

  it('choosing Other… prompts for a free-text harness name and validates it', async () => {
    const out = new CaptureStream();
    const config = await runConfigWizard(deps(['enter', '4'], out, () => 'my-harness'), {}, ['provider', 'harness']);
    expect(config).toEqual({ provider: 'docker', harness: 'my-harness' });
  });

  it('rejects an invalid harness name typed after Other…', async () => {
    const out = new CaptureStream();
    await expect(
      runConfigWizard(deps(['enter', '4'], out, () => 'under_score'), {}, ['provider', 'harness']),
    ).rejects.toThrow(CliError);
    await expect(
      runConfigWizard(deps(['enter', '4'], out, () => 'under_score'), {}, ['provider', 'harness']),
    ).rejects.toThrow('invalid harness name "under_score"');
  });

  it('rejects an empty Other… name with an actionable error', async () => {
    const out = new CaptureStream();
    await expect(runConfigWizard(deps(['enter', '4'], out, () => ''), {}, ['provider', 'harness'])).rejects.toThrow(
      otherNameError().message,
    );
    await expect(runConfigWizard(deps(['enter', '4'], out), {}, ['provider', 'harness'])).rejects.toThrow(
      otherNameError().message,
    );
  });

  it('does not call the prompt seam when a listed harness is chosen', async () => {
    const out = new CaptureStream();
    const prompt = (): string => {
      throw new Error('prompt must not be called for a listed harness');
    };
    const config = await runConfigWizard(deps(['enter', 'down', 'enter'], out, prompt), {}, ['provider', 'harness']);
    expect(config).toEqual({ provider: 'docker', harness: 'claude' });
  });

  it('cancelling with q throws an actionable error and leaves the config untouched', async () => {
    const out = new CaptureStream();
    const original: GlobalConfig = { provider: 'docker' };
    await expect(runConfigWizard(deps(['q'], out), original, ['provider', 'harness'])).rejects.toThrow(
      wizardCancelledError(['provider', 'harness']).message,
    );
    await expect(runConfigWizard(deps(['q'], out), original, ['provider', 'harness'])).rejects.toThrow(
      'sander config set <key> <value>',
    );
    expect(original).toEqual({ provider: 'docker' });
  });

  it('cancelling with esc on the second question aborts before saving anything', async () => {
    const out = new CaptureStream();
    await expect(runConfigWizard(deps(['enter', 'esc'], out), {}, ['provider', 'harness'])).rejects.toThrow(
      'wizard cancelled',
    );
  });

  it('does not accept a key sequence that ends without a decision', async () => {
    const out = new CaptureStream();
    await expect(runConfigWizard(deps(['down'], out), {}, ['provider', 'harness'])).rejects.toThrow('wizard cancelled');
  });
});

describe('runConfigWizard token question', () => {
  it('asks for the token through the prompt seam after the selectors and stores it', async () => {
    const out = new CaptureStream();
    const config = await runConfigWizard(deps(['enter', 'enter'], out, () => 'ghp_secret'), {}, [
      'provider',
      'harness',
      'token',
    ]);
    expect(config).toEqual({ provider: 'docker', harness: 'opencode', token: 'ghp_secret' });
  });

  it('keeps an existing token when the token prompt is left blank', async () => {
    const out = new CaptureStream();
    const config = await runConfigWizard(deps([], out, () => ''), { provider: 'docker', harness: 'opencode', token: 'old' }, [
      'token',
    ]);
    expect(config).toEqual({ provider: 'docker', harness: 'opencode', token: 'old' });
  });

  it('leaves the token unset when blank and none was configured', async () => {
    const out = new CaptureStream();
    const config = await runConfigWizard(deps([], out, () => '   '), {}, ['token']);
    expect(config).toEqual({});
  });

  it('accepts any non-empty token text (no SAFE_NAME validation)', async () => {
    const out = new CaptureStream();
    const config = await runConfigWizard(deps([], out, () => 'ghp_Under_score!9'), {}, ['token']);
    expect(config).toEqual({ token: 'ghp_Under_score!9' });
  });

  it('does not consume selector keys for the token question', async () => {
    const out = new CaptureStream();
    const config = await runConfigWizard(deps([], out, () => 'x'), {}, ['token']);
    expect(config).toEqual({ token: 'x' });
  });

  it('hints the state without revealing the secret', async () => {
    const out = new CaptureStream();
    let question = '';
    const config = await runConfigWizard(
      deps([], out, (q) => {
        question = q;
        return '';
      }),
      { provider: 'docker', harness: 'opencode', token: 'secret-token' },
      ['token'],
    );
    expect(config).toEqual({ provider: 'docker', harness: 'opencode', token: 'secret-token' });
    expect(question).toContain('Token');
    expect(question).toContain('blank');
    expect(question).not.toContain('secret-token');
  });

  it('skips the optional token in a non-TTY when no required key is asked', async () => {
    const out = new CaptureStream();
    const config = await runConfigWizard(nonTtyDeps({ output: out }), { provider: 'docker', harness: 'opencode', token: 'keep' }, [
      'token',
    ]);
    expect(config).toEqual({ provider: 'docker', harness: 'opencode', token: 'keep' });
    expect(out.text()).toBe('');
  });

  it('throws for required keys in a non-TTY and never mentions token', async () => {
    const out = new CaptureStream();
    await expect(runConfigWizard(nonTtyDeps({ output: out }), {}, ['provider', 'harness', 'token'])).rejects.toThrow(
      missingKeysError(['provider', 'harness']).message,
    );
    let message = '';
    try {
      await runConfigWizard(nonTtyDeps({ output: out }), {}, ['provider', 'harness', 'token']);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain('token');
    expect(out.text()).toBe('');
  });
});

describe('runConfigWizard non-TTY contract', () => {
  it('throws the missing-keys error in a non-TTY without a key source and renders nothing', async () => {
    const out = new CaptureStream();
    await expect(runConfigWizard(nonTtyDeps({ output: out }), {}, ['provider', 'harness'])).rejects.toThrow(
      missingKeysError(['provider', 'harness']).message,
    );
    await expect(runConfigWizard(nonTtyDeps({ output: out }), {}, ['provider', 'harness'])).rejects.toThrow(
      'sander config set <key> <value>',
    );
    expect(out.text()).toBe('');
  });

  it('prefers the caller-supplied no-prompt error in a non-TTY', async () => {
    const out = new CaptureStream();
    await expect(
      runConfigWizard(nonTtyDeps({ output: out }), {}, ['provider', 'harness'], interactiveNeededError),
    ).rejects.toThrow('interactive terminal');
    expect(out.text()).toBe('');
  });

  it('never invokes the wizard when there are no keys to ask', async () => {
    const out = new CaptureStream();
    const config = await runConfigWizard(nonTtyDeps({ output: out }), { provider: 'docker', harness: 'opencode' }, []);
    expect(config).toEqual({ provider: 'docker', harness: 'opencode' });
    expect(out.text()).toBe('');
  });
});

describe('wizard render', () => {
  it('renders the closed provider list with the five providers and cloud setup marks', () => {
    expect(PROVIDER_OPTIONS.map((option) => option.value)).toEqual(['docker', 'daytona', 'hetzner', 'vercel', 'e2b']);
    expect(renderSelector(PROVIDER_OPTIONS, 0)).toBe(
      '> 1) docker\n' +
        '  2) daytona [requieren setup]\n' +
        '  3) hetzner [requieren setup]\n' +
        '  4) vercel [requieren setup]\n' +
        '  5) e2b [requieren setup]',
    );
    expect(renderSelector(PROVIDER_OPTIONS, 0)).not.toContain('agentbox');
  });

  it('renders the harness selector with opencode, claude, codex and Other…', () => {
    expect(renderSelector(HARNESS_OPTIONS, 3)).toBe('  1) opencode\n  2) claude\n  3) codex\n> 4) Other…');
    expect(HARNESS_OPTIONS.map((option) => option.value)).toEqual(['opencode', 'claude', 'codex', HARNESS_OTHER]);
  });

  it('renders both navigable questions as generated text through the wizard', async () => {
    const out = new CaptureStream();
    const config = await runConfigWizard(deps(['enter', 'enter'], out), {}, ['provider', 'harness']);
    expect(config).toEqual({ provider: 'docker', harness: 'opencode' });
    const text = out.text();
    expect(text).toContain('Provider');
    expect(text).toContain('> 1) docker');
    expect(text).toContain('2) daytona [requieren setup]');
    expect(text).toContain('Harness');
    expect(text).toContain('4) Other…');
  });

  it('runs the wizard selectors through the raw driver with an injected key source', async () => {
    const out = new CaptureStream();
    const result = await runSelector(PROVIDER_OPTIONS, {
      input: {} as NodeJS.ReadableStream,
      output: out,
      keySource: keysSource(['down', 'enter']),
      title: 'Provider',
    });
    expect(result).toEqual({ kind: 'selected', option: { value: 'daytona', mark: 'requieren setup' } });
    expect(out.text()).toContain('\r\x1b[2K> 1) docker\n');
    expect(out.text()).toContain('> 2) daytona [requieren setup]');
  });
});

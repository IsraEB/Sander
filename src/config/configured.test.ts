import { describe, expect, it } from 'vitest';
import { CliError } from '../cli/errors';
import { missingRequiredKeys, validateConfiguredKey } from './configured';
import { PROVIDERS } from '../provider/providers';

describe('missingRequiredKeys', () => {
  it('reports both required keys when nothing is configured', () => {
    expect(missingRequiredKeys({ global: {}, workspace: {}, flags: {} })).toEqual(['provider', 'harness']);
  });

  it('counts a key present in the global config', () => {
    expect(missingRequiredKeys({ global: { provider: 'docker' }, workspace: {}, flags: {} })).toEqual(['harness']);
    expect(missingRequiredKeys({ global: { harness: 'codex' }, workspace: {}, flags: {} })).toEqual(['provider']);
  });

  it('counts a key present in the workspace config', () => {
    expect(missingRequiredKeys({ global: {}, workspace: { harness: 'claude' }, flags: {} })).toEqual(['provider']);
    expect(missingRequiredKeys({ global: {}, workspace: { provider: 'docker' }, flags: {} })).toEqual(['harness']);
  });

  it('counts a key passed as a command flag', () => {
    expect(missingRequiredKeys({ global: {}, workspace: {}, flags: { provider: 'docker' } })).toEqual(['harness']);
    expect(missingRequiredKeys({ global: {}, workspace: {}, flags: { harness: 'codex' } })).toEqual(['provider']);
  });

  it('never treats internal defaults as configured', () => {
    expect(missingRequiredKeys({ global: {}, workspace: {}, flags: {} })).toEqual(['provider', 'harness']);
  });

  it('does not count empty or whitespace values as present', () => {
    const empty = missingRequiredKeys({ global: { provider: '' }, workspace: { harness: '  ' }, flags: {} });
    expect(empty).toEqual(['provider', 'harness']);
  });

  it('counts a legacy agentbox value as present so create never rewrites legacy config', () => {
    expect(missingRequiredKeys({ global: { provider: 'agentbox', harness: 'opencode' }, workspace: {}, flags: {} })).toEqual([]);
  });

  it('never requires the token', () => {
    expect(missingRequiredKeys({ global: { provider: 'docker', harness: 'codex' }, workspace: {}, flags: {} })).toEqual([]);
  });

  it('never requires yolo even when a layer sets it', () => {
    expect(missingRequiredKeys({ global: { yolo: false }, workspace: {}, flags: {} })).toEqual(['provider', 'harness']);
    expect(missingRequiredKeys({ global: {}, workspace: { yolo: true }, flags: {} })).toEqual(['provider', 'harness']);
  });

  it('returns no missing keys when every layer contributes one key', () => {
    expect(
      missingRequiredKeys({ global: { provider: 'docker' }, workspace: { harness: 'opencode' }, flags: {} }),
    ).toEqual([]);
  });
});

describe('validateConfiguredKey', () => {
  it('accepts all five real providers', () => {
    for (const provider of PROVIDERS) {
      expect(() => validateConfiguredKey('provider', provider)).not.toThrow();
    }
  });

  it('rejects the legacy agentbox alias with an actionable error suggesting docker', () => {
    try {
      validateConfiguredKey('provider', 'agentbox');
      throw new Error('expected validateConfiguredKey to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toContain('provider "agentbox" is deprecated');
      expect((err as CliError).message).toContain('"docker"');
      expect((err as CliError).message).toContain('sander config set provider docker');
    }
  });

  it('rejects unknown providers', () => {
    expect(() => validateConfiguredKey('provider', 'vps')).toThrow(CliError);
    expect(() => validateConfiguredKey('provider', 'vps')).toThrow('unsupported provider "vps"');
  });
});

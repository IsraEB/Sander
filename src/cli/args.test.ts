import { describe, expect, it } from 'vitest';
import { popBooleanFlag, resolveExecId, resolveSandboxId, parseFlags } from './args';
import { CliError } from './errors';

describe('resolveSandboxId', () => {
  it('uses the first positional as the id', () => {
    const { id, rest } = resolveSandboxId(['abc', 'ls', '-la']);
    expect(id).toBe('abc');
    expect(rest).toEqual(['ls', '-la']);
  });

  it('uses --sandbox as an alternative', () => {
    const { id, rest } = resolveSandboxId(['--sandbox', 'abc', 'prompt']);
    expect(id).toBe('abc');
    expect(rest).toEqual(['prompt']);
  });

  it('accepts the --sandbox=id form', () => {
    const { id } = resolveSandboxId(['--sandbox=abc']);
    expect(id).toBe('abc');
  });

  it('throws a CliError when no id is present', () => {
    expect(() => resolveSandboxId([])).toThrow(CliError);
    expect(() => resolveSandboxId(['--force'])).toThrow(CliError);
  });

  it('throws a CliError when --sandbox has no value', () => {
    expect(() => resolveSandboxId(['--sandbox'])).toThrow(CliError);
  });
});

describe('resolveExecId', () => {
  it('treats the first argument as the id and everything after as the raw command tail', () => {
    const { id, rest } = resolveExecId(['abc', 'ls', '-la']);
    expect(id).toBe('abc');
    expect(rest).toEqual(['ls', '-la']);
  });

  it('keeps flags in the command tail untouched', () => {
    const { id, rest } = resolveExecId(['abc', 'echo', '--sandbox', '--help', '-n']);
    expect(id).toBe('abc');
    expect(rest).toEqual(['echo', '--sandbox', '--help', '-n']);
  });

  it('uses --sandbox as an alternative and keeps the tail raw', () => {
    const { id, rest } = resolveExecId(['--sandbox', 'abc', 'ls', '-la']);
    expect(id).toBe('abc');
    expect(rest).toEqual(['ls', '-la']);
  });

  it('accepts the --sandbox=id form', () => {
    const { id, rest } = resolveExecId(['--sandbox=abc', 'sh', '-c', 'echo hi']);
    expect(id).toBe('abc');
    expect(rest).toEqual(['sh', '-c', 'echo hi']);
  });

  it('throws a CliError when no id is present', () => {
    expect(() => resolveExecId([])).toThrow(CliError);
  });

  it('throws a CliError when --sandbox has no value', () => {
    expect(() => resolveExecId(['--sandbox'])).toThrow(CliError);
  });

  it('throws a CliError when --sandbox= is empty', () => {
    expect(() => resolveExecId(['--sandbox='])).toThrow(CliError);
  });
});

describe('parseFlags', () => {
  it('parses string flags with a value', () => {
    const { flags, positionals } = parseFlags(['--name', 'abc', '--harness', 'opencode']);
    expect(flags.name).toBe('abc');
    expect(flags.harness).toBe('opencode');
    expect(positionals).toEqual([]);
  });

  it('parses --flag=value and boolean flags', () => {
    const { flags } = parseFlags(['--sandbox=abc', '--force']);
    expect(flags.sandbox).toBe('abc');
    expect(flags.force).toBe(true);
  });

  it('handles -h/--help', () => {
    expect(parseFlags(['-h']).flags.help).toBe(true);
    expect(parseFlags(['--help']).flags.help).toBe(true);
  });

  it('collects positionals, including values consumed by flags', () => {
    const { positionals } = parseFlags(['run', 'abc', '--sandbox', 'x', 'tail']);
    expect(positionals).toEqual(['run', 'abc', 'tail']);
  });
});

describe('popBooleanFlag', () => {
  it('returns false and keeps argv when the flag is absent', () => {
    const { argv, value } = popBooleanFlag(['demo', 'extra'], 'delete-branch');
    expect(value).toBe(false);
    expect(argv).toEqual(['demo', 'extra']);
  });

  it('returns true and strips the flag when present', () => {
    const { argv, value } = popBooleanFlag(['demo', '--delete-branch'], 'delete-branch');
    expect(value).toBe(true);
    expect(argv).toEqual(['demo']);
  });

  it('strips the flag regardless of position and keeps the rest intact', () => {
    const { argv, value } = popBooleanFlag(['--sandbox', 'demo', '--delete-branch'], 'delete-branch');
    expect(value).toBe(true);
    expect(argv).toEqual(['--sandbox', 'demo']);
  });

  it('strips every occurrence of the flag', () => {
    const { argv, value } = popBooleanFlag(['--delete-branch', 'demo', '--delete-branch'], 'delete-branch');
    expect(value).toBe(true);
    expect(argv).toEqual(['demo']);
  });

  it('strips a short alias and returns true when present', () => {
    const { argv, value } = popBooleanFlag(['--name', 'demo', '-s'], 'skip-setup', ['s']);
    expect(value).toBe(true);
    expect(argv).toEqual(['--name', 'demo']);
  });

  it('strips the long flag and aliases together and keeps the rest intact', () => {
    const { argv, value } = popBooleanFlag(['--skip-setup', 'demo', '-s', 'tail'], 'skip-setup', ['s']);
    expect(value).toBe(true);
    expect(argv).toEqual(['demo', 'tail']);
  });

  it('returns false and keeps argv when only an alias is absent', () => {
    const { argv, value } = popBooleanFlag(['demo', 'extra'], 'skip-setup', ['s']);
    expect(value).toBe(false);
    expect(argv).toEqual(['demo', 'extra']);
  });
});

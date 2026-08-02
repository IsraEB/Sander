import { describe, expect, it } from 'vitest';
import { resolveToken } from './token';
import type { TokenResolution } from './token';

function sourceOf(res: TokenResolution): string {
  return res.source;
}

describe('resolveToken precedence', () => {
  it('uses the --token flag over global and workspace', () => {
    const res = resolveToken({ flag: 'flag-token', global: 'global-token', workspace: 'ws-token' });
    expect(res).toEqual({ token: 'flag-token', source: 'flag' });
  });

  it('uses the global config token over workspace', () => {
    const res = resolveToken({ global: 'global-token', workspace: 'ws-token' });
    expect(res).toEqual({ token: 'global-token', source: 'global' });
  });

  it('uses the workspace config token', () => {
    const res = resolveToken({ workspace: 'ws-token' });
    expect(res).toEqual({ token: 'ws-token', source: 'workspace' });
  });

  it('returns none when no token is configured anywhere', () => {
    const res = resolveToken({});
    expect(res).toEqual({ token: undefined, source: 'none' });
  });

  it('treats empty and whitespace-only values as absent', () => {
    const res = resolveToken({ flag: '', global: '   ', workspace: undefined });
    expect(sourceOf(res)).toBe('none');
  });
});

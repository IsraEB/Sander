export type TokenSource = 'flag' | 'global' | 'workspace' | 'none';

export interface TokenResolution {
  token: string | undefined;
  source: TokenSource;
}

export interface TokenResolveOptions {
  flag?: string;
  global?: string;
  workspace?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function resolveToken(opts: TokenResolveOptions): TokenResolution {
  const flag = nonEmpty(opts.flag);
  if (flag !== undefined) {
    return { token: flag, source: 'flag' };
  }
  const global = nonEmpty(opts.global);
  if (global !== undefined) {
    return { token: global, source: 'global' };
  }
  const workspace = nonEmpty(opts.workspace);
  if (workspace !== undefined) {
    return { token: workspace, source: 'workspace' };
  }

  return { token: undefined, source: 'none' };
}

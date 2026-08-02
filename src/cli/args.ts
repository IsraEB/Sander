import { CliError } from './errors';

export interface ResolvedId {
  id: string;
  rest: string[];
}

export function resolveSandboxId(argv: string[]): ResolvedId {
  const sandboxIndex = argv.indexOf('--sandbox');
  if (sandboxIndex !== -1) {
    const value = argv[sandboxIndex + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new CliError('--sandbox requires an id');
    }
    const rest = argv.filter((_, i) => i !== sandboxIndex && i !== sandboxIndex + 1);
    return { id: value, rest };
  }

  const eq = argv.findIndex((a) => a.startsWith('--sandbox='));
  if (eq !== -1) {
    const value = argv[eq].slice('--sandbox='.length);
    const rest = argv.filter((_, i) => i !== eq);
    return { id: value, rest };
  }

  const firstPositional = argv.findIndex((a) => !a.startsWith('-'));
  if (firstPositional === -1) {
    throw new CliError('missing sandbox id: pass a positional id or --sandbox <id>');
  }
  const id = argv[firstPositional];
  const rest = argv.filter((_, i) => i !== firstPositional);
  return { id, rest };
}

export function resolveExecId(argv: string[]): ResolvedId {
  if (argv[0] === '--sandbox') {
    const value = argv[1];
    if (value === undefined) {
      throw new CliError('--sandbox requires an id');
    }
    return { id: value, rest: argv.slice(2) };
  }
  if (typeof argv[0] === 'string' && argv[0].startsWith('--sandbox=')) {
    const value = argv[0].slice('--sandbox='.length);
    if (value === '') {
      throw new CliError('--sandbox requires an id');
    }
    return { id: value, rest: argv.slice(1) };
  }
  if (argv[0] === undefined) {
    throw new CliError('missing sandbox id: pass a positional id or --sandbox <id>');
  }
  return { id: argv[0], rest: argv.slice(1) };
}

export interface ParsedFlags {
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export function popBooleanFlag(argv: string[], name: string, aliases: string[] = []): { argv: string[]; value: boolean } {
  const strip = [`--${name}`, ...aliases.map((a) => (a.startsWith('-') ? a : `-${a}`))];
  return { argv: argv.filter((a) => !strip.includes(a)), value: argv.some((a) => strip.includes(a)) };
}

export function parseFlags(argv: string[]): ParsedFlags {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const name = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

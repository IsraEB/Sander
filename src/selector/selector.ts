export type SelectorKey =
  | 'up'
  | 'down'
  | 'enter'
  | 'q'
  | 'esc'
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9';

export interface SelectOption<T = string> {
  value: T;
  label?: string;
  mark?: string;
}

export type SelectResult<T> =
  | { kind: 'selected'; option: SelectOption<T> }
  | { kind: 'cancelled' };

export interface SelectorState<T> {
  options: readonly SelectOption<T>[];
  cursor: number;
  done: boolean;
  result: SelectResult<T> | null;
}

const ESC_TIMEOUT_MS = 50;

function numericIndex(key: SelectorKey): number {
  if (key === '0') {
    return 9;
  }
  if (key >= '1' && key <= '9') {
    return Number(key) - 1;
  }
  return -1;
}

export function createSelector<T>(options: readonly SelectOption<T>[]): SelectorState<T> {
  return { options, cursor: 0, done: false, result: null };
}

export function applyKey<T>(state: SelectorState<T>, key: SelectorKey): SelectorState<T> {
  if (state.done) {
    return state;
  }
  const { options, cursor } = state;
  switch (key) {
    case 'up': {
      if (options.length === 0) {
        return state;
      }
      return { ...state, cursor: cursor === 0 ? options.length - 1 : cursor - 1 };
    }
    case 'down': {
      if (options.length === 0) {
        return state;
      }
      return { ...state, cursor: (cursor + 1) % options.length };
    }
    case 'enter': {
      if (options.length === 0) {
        return { ...state, done: true, result: { kind: 'cancelled' } };
      }
      return { ...state, done: true, result: { kind: 'selected', option: options[cursor]! } };
    }
    case 'q':
    case 'esc':
      return { ...state, done: true, result: { kind: 'cancelled' } };
    default: {
      const index = numericIndex(key);
      if (index < 0 || index >= options.length) {
        return state;
      }
      return { ...state, cursor: index, done: true, result: { kind: 'selected', option: options[index]! } };
    }
  }
}

export function selectFromKeys<T>(options: readonly SelectOption<T>[], keys: Iterable<SelectorKey>): SelectResult<T> {
  let state = createSelector(options);
  for (const key of keys) {
    state = applyKey(state, key);
    if (state.done) {
      return state.result!;
    }
  }
  return { kind: 'cancelled' };
}

export function renderSelector<T>(options: readonly SelectOption<T>[], cursor: number): string {
  return options
    .map((option, index) => {
      const label = option.label ?? String(option.value);
      const mark = option.mark !== undefined && option.mark !== '' ? ` [${option.mark}]` : '';
      const number = `${index + 1})`;
      return `${index === cursor ? '>' : ' '} ${number} ${label}${mark}`;
    })
    .join('\n');
}

export type ParsedKey = { key: SelectorKey | null; consumed: number } | 'need-more';

export function parseKeyFromBytes(buffer: Buffer): ParsedKey {
  if (buffer.length === 0) {
    return 'need-more';
  }
  const first = buffer[0];
  if (first === 0x1b) {
    if (buffer.length === 1) {
      return 'need-more';
    }
    const second = buffer[1];
    if (second === 0x5b || second === 0x4f) {
      if (buffer.length === 2) {
        return 'need-more';
      }
      const third = buffer[2];
      if (third === 0x41) {
        return { key: 'up', consumed: 3 };
      }
      if (third === 0x42) {
        return { key: 'down', consumed: 3 };
      }
      // Not a recognized arrow: swallow the whole ECMA-48 sequence through its
      // final byte (0x40-0x7E) so unsupported sequences (F5 "\x1b[15~",
      // Shift+Up "\x1b[1;2A", ...) never leak bytes that could be re-parsed as
      // numeric shortcuts.
      for (let i = 2; i < buffer.length; i++) {
        if (buffer[i] >= 0x40 && buffer[i] <= 0x7e) {
          return { key: null, consumed: i + 1 };
        }
      }
      return 'need-more';
    }
    return { key: 'esc', consumed: 1 };
  }
  if (first === 0x0d || first === 0x0a) {
    return { key: 'enter', consumed: 1 };
  }
  if (first === 0x71 || first === 0x51) {
    return { key: 'q', consumed: 1 };
  }
  if (first >= 0x30 && first <= 0x39) {
    return { key: String.fromCharCode(first) as SelectorKey, consumed: 1 };
  }
  if (first === 0x03) {
    return { key: 'esc', consumed: 1 };
  }
  return { key: null, consumed: 1 };
}

export interface KeySource {
  next(): Promise<SelectorKey | null>;
}

export interface DisposableKeySource extends KeySource {
  dispose(): void;
}

interface StreamLike extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

export function createTtyKeySource(input: NodeJS.ReadableStream): DisposableKeySource {
  const stream = input as StreamLike;
  if (stream.isTTY !== true || typeof stream.setRawMode !== 'function') {
    return { next: async () => null, dispose: () => undefined };
  }

  let buffer = Buffer.alloc(0);
  let waiter: ((key: SelectorKey | null) => void) | null = null;
  let escTimer: NodeJS.Timeout | null = null;
  let ended = false;

  const settle = (key: SelectorKey | null): void => {
    if (waiter !== null) {
      const resolve = waiter;
      waiter = null;
      resolve(key);
    }
  };

  const armEscapeTimer = (): void => {
    if (escTimer !== null) {
      return;
    }
    // ESC-prefixed input is ambiguous: it may be a standalone Esc or the start
    // of an escape sequence. Give the terminal a short window to deliver the
    // rest, then fall back to esc.
    escTimer = setTimeout(() => {
      escTimer = null;
      buffer = Buffer.alloc(0);
      settle('esc');
    }, ESC_TIMEOUT_MS);
  };

  const pump = (): void => {
    if (waiter === null) {
      return;
    }
    for (;;) {
      if (buffer.length === 0) {
        if (ended) {
          settle(null);
        }
        return;
      }
      const parsed = parseKeyFromBytes(buffer);
      if (parsed === 'need-more') {
        if (buffer[0] === 0x1b) {
          armEscapeTimer();
        }
        return;
      }
      if (escTimer !== null) {
        clearTimeout(escTimer);
        escTimer = null;
      }
      buffer = buffer.subarray(parsed.consumed);
      if (parsed.key !== null) {
        settle(parsed.key);
        return;
      }
    }
  };

  const onData = (chunk: Buffer | string): void => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')]);
    pump();
  };

  const onEnd = (): void => {
    ended = true;
    if (escTimer !== null) {
      clearTimeout(escTimer);
      escTimer = null;
    }
    settle(null);
  };

  stream.setRawMode(true);
  stream.on('data', onData);
  stream.on('end', onEnd);
  stream.on('close', onEnd);
  // Explicit resume: a previous selector's dispose() paused the stream, and a
  // paused TTY does not re-arm its read when a new 'data' listener is attached.
  if (typeof stream.resume === 'function') {
    stream.resume();
  }

  return {
    next(): Promise<SelectorKey | null> {
      if (waiter !== null) {
        return Promise.reject(new Error('createTtyKeySource: overlapping next() calls'));
      }
      return new Promise((resolve) => {
        waiter = resolve;
        pump();
      });
    },
    dispose(): void {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onEnd);
      if (escTimer !== null) {
        clearTimeout(escTimer);
        escTimer = null;
      }
      if (stream.isTTY === true && typeof stream.setRawMode === 'function') {
        stream.setRawMode(false);
      }
      // After removing the data listener, pause the stream so the underlying
      // TTY handle stops keeping the process's event loop alive; otherwise a
      // wizard that finishes cleanly would leave the CLI hanging until stdin
      // closes.
      if (typeof stream.pause === 'function') {
        stream.pause();
      }
      settle(null);
    },
  };
}

export interface SelectorDriverOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  keySource?: KeySource;
  title?: string;
  initialCursor?: number;
}

export async function runSelector<T>(
  options: readonly SelectOption<T>[],
  opts: SelectorDriverOptions,
): Promise<SelectResult<T>> {
  if (options.length === 0) {
    return { kind: 'cancelled' };
  }
  const input = opts.input as StreamLike;
  const interactive = input.isTTY === true && typeof input.setRawMode === 'function';
  if (opts.keySource === undefined && !interactive) {
    return { kind: 'cancelled' };
  }

  const ownsSource = opts.keySource === undefined;
  const keySource: KeySource = opts.keySource ?? createTtyKeySource(opts.input);

  let state = createSelector(options);
  if (options.length > 0) {
    const initial = opts.initialCursor ?? 0;
    state = { ...state, cursor: Math.min(Math.max(initial, 0), options.length - 1) };
  }
  if (opts.title !== undefined && opts.title !== '') {
    opts.output.write(`${opts.title}\n`);
  }

  let rendered = false;
  const render = (): void => {
    const lines = renderSelector(options, state.cursor).split('\n');
    if (rendered) {
      opts.output.write(`\x1b[${lines.length}A`);
    }
    for (const line of lines) {
      opts.output.write(`\r\x1b[2K${line}\n`);
    }
    rendered = true;
  };
  render();

  try {
    for (;;) {
      const key = await keySource.next();
      if (key === null) {
        return { kind: 'cancelled' };
      }
      state = applyKey(state, key);
      if (state.done) {
        return state.result!;
      }
      render();
    }
  } finally {
    if (ownsSource) {
      (keySource as DisposableKeySource).dispose();
    }
  }
}

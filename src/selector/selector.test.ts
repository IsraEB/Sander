import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { CaptureStream } from '../../test/helpers/capture-stream';
import {
  applyKey,
  createSelector,
  createTtyKeySource,
  parseKeyFromBytes,
  renderSelector,
  runSelector,
  selectFromKeys,
} from './selector';
import type { KeySource, SelectOption, SelectorKey } from './selector';

const OPTIONS: SelectOption[] = [
  { value: 'docker' },
  { value: 'daytona', mark: 'requiere setup' },
  { value: 'hetzner', mark: 'requiere setup' },
];

function keysSource(keys: SelectorKey[]): KeySource {
  let index = 0;
  return {
    next: async () => (index < keys.length ? keys[index++]! : null),
  };
}

describe('selectFromKeys', () => {
  it('selects the second option after down/enter', () => {
    const result = selectFromKeys(OPTIONS, ['down', 'enter']);
    expect(result).toEqual({ kind: 'selected', option: { value: 'daytona', mark: 'requiere setup' } });
  });

  it('selects the option matching a numeric shortcut', () => {
    expect(selectFromKeys(OPTIONS, ['3'])).toEqual({
      kind: 'selected',
      option: { value: 'hetzner', mark: 'requiere setup' },
    });
  });

  it('selects via numeric shortcut and ignores a trailing enter', () => {
    expect(selectFromKeys(OPTIONS, ['3', 'enter'])).toEqual({
      kind: 'selected',
      option: { value: 'hetzner', mark: 'requiere setup' },
    });
  });

  it('selects the first option with the 1 shortcut', () => {
    expect(selectFromKeys(OPTIONS, ['1'])).toEqual({ kind: 'selected', option: { value: 'docker' } });
  });

  it('maps the 0 shortcut to the tenth option when present', () => {
    const ten: SelectOption[] = Array.from({ length: 10 }, (_, i) => ({ value: `opt-${i + 1}` }));
    expect(selectFromKeys(ten, ['0'])).toEqual({ kind: 'selected', option: { value: 'opt-10' } });
  });

  it('ignores an out-of-range numeric shortcut and keeps the current selection', () => {
    const result = selectFromKeys(OPTIONS, ['down', '9', 'enter']);
    expect(result).toEqual({ kind: 'selected', option: { value: 'daytona', mark: 'requiere setup' } });
  });

  it('ignores an out-of-range numeric shortcut from the initial position', () => {
    expect(selectFromKeys(OPTIONS, ['9', 'enter'])).toEqual({ kind: 'selected', option: { value: 'docker' } });
  });

  it('cancels on q', () => {
    expect(selectFromKeys(OPTIONS, ['q'])).toEqual({ kind: 'cancelled' });
  });

  it('cancels on esc', () => {
    expect(selectFromKeys(OPTIONS, ['esc'])).toEqual({ kind: 'cancelled' });
  });

  it('returns a cancellation result distinguishable from a selection', () => {
    const cancelled = selectFromKeys(OPTIONS, ['q']);
    const selected = selectFromKeys(OPTIONS, ['enter']);
    expect(cancelled.kind).toBe('cancelled');
    expect(selected.kind).toBe('selected');
  });

  it('wraps up to the last option', () => {
    expect(selectFromKeys(OPTIONS, ['up', 'enter'])).toEqual({
      kind: 'selected',
      option: { value: 'hetzner', mark: 'requiere setup' },
    });
  });

  it('cancels when the key sequence ends without a decision', () => {
    expect(selectFromKeys(OPTIONS, ['down', 'down'])).toEqual({ kind: 'cancelled' });
  });

  it('cancels on enter with no options', () => {
    expect(selectFromKeys([], ['enter'])).toEqual({ kind: 'cancelled' });
  });
});

describe('createSelector and applyKey', () => {
  it('starts at the first option and not done', () => {
    const state = createSelector(OPTIONS);
    expect(state.cursor).toBe(0);
    expect(state.done).toBe(false);
    expect(state.result).toBeNull();
  });

  it('moves the cursor without wrapping mid-list', () => {
    const state = applyKey(applyKey(createSelector(OPTIONS), 'down'), 'down');
    expect(state.cursor).toBe(2);
    expect(state.done).toBe(false);
  });

  it('wraps up from the first option to the last', () => {
    expect(applyKey(createSelector(OPTIONS), 'up').cursor).toBe(OPTIONS.length - 1);
  });

  it('wraps down from the last option to the first', () => {
    const last = { ...createSelector(OPTIONS), cursor: OPTIONS.length - 1 };
    expect(applyKey(last, 'down').cursor).toBe(0);
  });

  it('returns a new state instead of mutating', () => {
    const state = createSelector(OPTIONS);
    expect(applyKey(state, 'down')).not.toBe(state);
    expect(state.cursor).toBe(0);
  });

  it('is a no-op after the state is done', () => {
    const done = applyKey(createSelector(OPTIONS), 'enter');
    expect(applyKey(done, 'down')).toBe(done);
  });
});

describe('renderSelector', () => {
  it('renders numbered options with a cursor over the selection', () => {
    expect(renderSelector(OPTIONS, 0)).toBe(
      '> 1) docker\n  2) daytona [requiere setup]\n  3) hetzner [requiere setup]',
    );
  });

  it('moves the cursor marker to the selected option', () => {
    expect(renderSelector(OPTIONS, 2)).toBe(
      '  1) docker\n  2) daytona [requiere setup]\n> 3) hetzner [requiere setup]',
    );
  });

  it('renders no mark when the option has none', () => {
    const options: SelectOption[] = [{ value: 'docker' }, { value: 'daytona' }];
    expect(renderSelector(options, 0)).toBe('> 1) docker\n  2) daytona');
  });

  it('uses the label when provided', () => {
    const options: SelectOption[] = [{ value: 'x', label: 'Custom' }];
    expect(renderSelector(options, 0)).toBe('> 1) Custom');
  });

  it('produces stable text for the same input', () => {
    expect(renderSelector(OPTIONS, 1)).toBe(renderSelector(OPTIONS, 1));
  });
});

describe('parseKeyFromBytes', () => {
  it('parses arrow-up as up', () => {
    expect(parseKeyFromBytes(Buffer.from([0x1b, 0x5b, 0x41]))).toEqual({ key: 'up', consumed: 3 });
  });

  it('parses arrow-down as down', () => {
    expect(parseKeyFromBytes(Buffer.from([0x1b, 0x5b, 0x42]))).toEqual({ key: 'down', consumed: 3 });
  });

  it('parses application-mode arrows', () => {
    expect(parseKeyFromBytes(Buffer.from([0x1b, 0x4f, 0x41]))).toEqual({ key: 'up', consumed: 3 });
    expect(parseKeyFromBytes(Buffer.from([0x1b, 0x4f, 0x42]))).toEqual({ key: 'down', consumed: 3 });
  });

  it('parses digit keys', () => {
    expect(parseKeyFromBytes(Buffer.from([0x33]))).toEqual({ key: '3', consumed: 1 });
  });

  it('parses q and Q as q', () => {
    expect(parseKeyFromBytes(Buffer.from([0x71]))).toEqual({ key: 'q', consumed: 1 });
    expect(parseKeyFromBytes(Buffer.from([0x51]))).toEqual({ key: 'q', consumed: 1 });
  });

  it('parses carriage return and newline as enter', () => {
    expect(parseKeyFromBytes(Buffer.from([0x0d]))).toEqual({ key: 'enter', consumed: 1 });
    expect(parseKeyFromBytes(Buffer.from([0x0a]))).toEqual({ key: 'enter', consumed: 1 });
  });

  it('parses Ctrl+C as esc', () => {
    expect(parseKeyFromBytes(Buffer.from([0x03]))).toEqual({ key: 'esc', consumed: 1 });
  });

  it('waits for more bytes after a lone ESC', () => {
    expect(parseKeyFromBytes(Buffer.from([0x1b]))).toBe('need-more');
  });

  it('waits for the final byte of an incomplete escape sequence', () => {
    expect(parseKeyFromBytes(Buffer.from([0x1b, 0x5b]))).toBe('need-more');
  });

  it('ignores unsupported escape sequences', () => {
    expect(parseKeyFromBytes(Buffer.from([0x1b, 0x5b, 0x43]))).toEqual({ key: null, consumed: 3 });
  });

  it('swallows an unknown CSI sequence through its final byte', () => {
    expect(parseKeyFromBytes(Buffer.from([0x1b, 0x5b, 0x31, 0x35, 0x7e]))).toEqual({ key: null, consumed: 5 });
  });

  it('swallows a modified arrow through its final byte', () => {
    expect(parseKeyFromBytes(Buffer.from([0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x41]))).toEqual({ key: null, consumed: 6 });
  });

  it('swallows SS3 function-key sequences', () => {
    expect(parseKeyFromBytes(Buffer.from([0x1b, 0x4f, 0x50]))).toEqual({ key: null, consumed: 3 });
  });

  it('waits for the final byte of an incomplete CSI sequence', () => {
    expect(parseKeyFromBytes(Buffer.from([0x1b, 0x5b, 0x31, 0x3b]))).toBe('need-more');
  });

  it('ignores unknown bytes', () => {
    expect(parseKeyFromBytes(Buffer.from([0x78]))).toEqual({ key: null, consumed: 1 });
  });
});

class FakeTtyStream extends EventEmitter {
  isTTY = true;
  rawMode = false;
  rawModeCalls: boolean[] = [];

  setRawMode(mode: boolean): void {
    this.rawMode = mode;
    this.rawModeCalls.push(mode);
  }

  push(bytes: Buffer | string): void {
    this.emit('data', bytes);
  }

  close(): void {
    this.emit('close');
  }
}

describe('createTtyKeySource', () => {
  it('reads a whole escape sequence as one key', async () => {
    const stream = new FakeTtyStream();
    const source = createTtyKeySource(stream);
    const pending = source.next();
    stream.push(Buffer.from([0x1b, 0x5b, 0x41]));
    await expect(pending).resolves.toBe('up');
    source.dispose();
  });

  it('normalizes escape bytes arriving one at a time', async () => {
    const stream = new FakeTtyStream();
    const source = createTtyKeySource(stream);
    const pending = source.next();
    stream.push(Buffer.from([0x1b]));
    stream.push(Buffer.from([0x5b]));
    stream.push(Buffer.from([0x42]));
    await expect(pending).resolves.toBe('down');
    source.dispose();
  });

  it('normalizes digits, q and enter', async () => {
    const stream = new FakeTtyStream();
    const source = createTtyKeySource(stream);
    const first = source.next();
    stream.push('3');
    await expect(first).resolves.toBe('3');
    const second = source.next();
    stream.push('q');
    await expect(second).resolves.toBe('q');
    const third = source.next();
    stream.push('\r');
    await expect(third).resolves.toBe('enter');
    source.dispose();
  });

  it('turns a lone Esc into esc after the disambiguation window', async () => {
    vi.useFakeTimers();
    try {
      const stream = new FakeTtyStream();
      const source = createTtyKeySource(stream);
      const pending = source.next();
      stream.push(Buffer.from([0x1b]));
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toBe('esc');
      source.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not treat Esc as standalone when the sequence follows quickly', async () => {
    const stream = new FakeTtyStream();
    const source = createTtyKeySource(stream);
    const pending = source.next();
    stream.push(Buffer.from([0x1b]));
    stream.push(Buffer.from([0x5b, 0x41]));
    await expect(pending).resolves.toBe('up');
    source.dispose();
  });

  it('does not leak bytes from an unknown CSI sequence', async () => {
    const stream = new FakeTtyStream();
    const source = createTtyKeySource(stream);
    const pending = source.next();
    stream.push(Buffer.from([0x1b, 0x5b, 0x31, 0x35, 0x7e]));
    stream.push('q');
    await expect(pending).resolves.toBe('q');
    source.dispose();
  });

  it('settles an incomplete escape prefix instead of hanging', async () => {
    vi.useFakeTimers();
    try {
      const stream = new FakeTtyStream();
      const source = createTtyKeySource(stream);
      const pending = source.next();
      stream.push(Buffer.from([0x1b]));
      stream.push(Buffer.from([0x5b]));
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toBe('esc');
      source.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips ignored bytes until the next meaningful key', async () => {
    const stream = new FakeTtyStream();
    const source = createTtyKeySource(stream);
    const pending = source.next();
    stream.push('x');
    stream.push('q');
    await expect(pending).resolves.toBe('q');
    source.dispose();
  });

  it('returns keys remaining in the buffer on subsequent reads', async () => {
    const stream = new FakeTtyStream();
    const source = createTtyKeySource(stream);
    const first = source.next();
    stream.push(Buffer.from([0x1b, 0x5b, 0x42]));
    await expect(first).resolves.toBe('down');
    const second = source.next();
    stream.push('1');
    await expect(second).resolves.toBe('1');
    source.dispose();
  });

  it('resolves null when the stream ends without input', async () => {
    const stream = new FakeTtyStream();
    const source = createTtyKeySource(stream);
    const pending = source.next();
    stream.close();
    await expect(pending).resolves.toBeNull();
    source.dispose();
  });

  it('sets and restores raw mode around reading', async () => {
    const stream = new FakeTtyStream();
    const source = createTtyKeySource(stream);
    expect(stream.rawModeCalls).toEqual([true]);
    const pending = source.next();
    stream.push('q');
    await expect(pending).resolves.toBe('q');
    source.dispose();
    expect(stream.rawMode).toBe(false);
    expect(stream.rawModeCalls).toEqual([true, false]);
  });

  it('resolves null for non-TTY input without touching raw mode', async () => {
    const plain = {} as unknown as NodeJS.ReadableStream;
    const source = createTtyKeySource(plain);
    await expect(source.next()).resolves.toBeNull();
    expect(() => source.dispose()).not.toThrow();
  });
});

describe('runSelector', () => {
  const FIVE_OPTIONS: SelectOption[] = [
    { value: 'docker' },
    { value: 'daytona', mark: 'requiere setup' },
    { value: 'hetzner', mark: 'requiere setup' },
    { value: 'vercel', mark: 'requiere setup' },
    { value: 'e2b', mark: 'requiere setup' },
  ];

  it('navigates and confirms with the injected key source', async () => {
    const out = new CaptureStream();
    const result = await runSelector(OPTIONS, { input: new FakeTtyStream(), output: out, keySource: keysSource(['down', 'enter']) });
    expect(result).toEqual({ kind: 'selected', option: { value: 'daytona', mark: 'requiere setup' } });
    expect(out.text()).toContain('\r\x1b[2K> 1) docker\n');
    expect(out.text()).toContain('\x1b[3A');
    expect(out.text()).toContain('> 2) daytona [requiere setup]');
  });

  it('selects directly with a numeric shortcut', async () => {
    const out = new CaptureStream();
    const result = await runSelector(OPTIONS, { input: new FakeTtyStream(), output: out, keySource: keysSource(['3']) });
    expect(result).toEqual({ kind: 'selected', option: { value: 'hetzner', mark: 'requiere setup' } });
  });

  it('cancels on q', async () => {
    const out = new CaptureStream();
    const result = await runSelector(OPTIONS, { input: new FakeTtyStream(), output: out, keySource: keysSource(['q']) });
    expect(result).toEqual({ kind: 'cancelled' });
  });

  it('cancels on esc', async () => {
    const out = new CaptureStream();
    const result = await runSelector(OPTIONS, { input: new FakeTtyStream(), output: out, keySource: keysSource(['esc']) });
    expect(result).toEqual({ kind: 'cancelled' });
  });

  it('cancels when the key source runs dry without a decision', async () => {
    const out = new CaptureStream();
    const result = await runSelector(OPTIONS, { input: new FakeTtyStream(), output: out, keySource: keysSource(['down']) });
    expect(result).toEqual({ kind: 'cancelled' });
  });

  it('writes the title once before the options', async () => {
    const out = new CaptureStream();
    await runSelector(OPTIONS, {
      input: new FakeTtyStream(),
      output: out,
      keySource: keysSource(['enter']),
      title: '¿Provider?',
    });
    expect(out.text()).toContain('¿Provider?\n');
  });

  it('starts the cursor at the initialCursor option', async () => {
    const out = new CaptureStream();
    const result = await runSelector(OPTIONS, {
      input: new FakeTtyStream(),
      output: out,
      keySource: keysSource(['enter']),
      initialCursor: 1,
    });
    expect(result).toEqual({ kind: 'selected', option: { value: 'daytona', mark: 'requiere setup' } });
    expect(out.text()).toContain('> 2) daytona [requiere setup]');
  });

  it('clamps an out-of-range initialCursor into the list', async () => {
    const out = new CaptureStream();
    const high = await runSelector(OPTIONS, {
      input: new FakeTtyStream(),
      output: out,
      keySource: keysSource(['enter']),
      initialCursor: 99,
    });
    expect(high).toEqual({ kind: 'selected', option: { value: 'hetzner', mark: 'requiere setup' } });
    out.reset();
    const low = await runSelector(OPTIONS, {
      input: new FakeTtyStream(),
      output: out,
      keySource: keysSource(['enter']),
      initialCursor: -1,
    });
    expect(low).toEqual({ kind: 'selected', option: { value: 'docker' } });
  });

  it('cancels without rendering on non-TTY input without a key source', async () => {
    const out = new CaptureStream();
    const result = await runSelector(OPTIONS, { input: {} as unknown as NodeJS.ReadableStream, output: out });
    expect(result).toEqual({ kind: 'cancelled' });
    expect(out.text()).toBe('');
  });

  it('cancels when there are no options', async () => {
    const out = new CaptureStream();
    const result = await runSelector([], { input: new FakeTtyStream(), output: out, keySource: keysSource(['enter']) });
    expect(result).toEqual({ kind: 'cancelled' });
  });

  it('ignores F5 instead of selecting the fifth option', async () => {
    const stream = new FakeTtyStream();
    const out = new CaptureStream();
    const result = runSelector(FIVE_OPTIONS, { input: stream, output: out });
    stream.push(Buffer.from([0x1b, 0x5b, 0x31, 0x35, 0x7e]));
    stream.push('\r');
    await expect(result).resolves.toEqual({ kind: 'selected', option: { value: 'docker' } });
  });

  it('ignores Shift+Up instead of selecting the second option', async () => {
    const stream = new FakeTtyStream();
    const out = new CaptureStream();
    const result = runSelector(FIVE_OPTIONS, { input: stream, output: out });
    stream.push(Buffer.from([0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x41]));
    stream.push('\r');
    await expect(result).resolves.toEqual({ kind: 'selected', option: { value: 'docker' } });
  });
});

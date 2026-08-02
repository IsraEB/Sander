import { describe, expect, it, vi, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import { StepList, runStep } from './steps';

class FakeStream extends Writable {
  isTTY: boolean;
  private chunks: string[] = [];

  constructor(isTTY: boolean) {
    super();
    this.isTTY = isTTY;
  }

  _write(chunk: Buffer | string, _encoding: string, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk));
    callback();
  }

  text(): string {
    return this.chunks.join('');
  }
}

// The raw TTY output interleaves ANSI cursor/clear sequences across redraws;
// strip them and keep only the last `count` visible rows (the final render).
function finalLines(text: string, count: number): string[] {
  const visible = text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line !== '');
  return visible.slice(-count);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('StepList (non-TTY)', () => {
  it('prints each step once as it reaches a final state, with an icon', () => {
    const stream = new FakeStream(false);
    const list = new StepList({ stream });
    const a = list.add('First');
    const b = list.add('Second');
    list.markRunning(a);
    list.markDone(a);
    list.markRunning(b);
    list.markSkipped(b);
    list.finish();
    expect(stream.text()).toBe('✓ First\n– Second\n');
  });

  it('marks a failed step with a cross', () => {
    const stream = new FakeStream(false);
    const list = new StepList({ stream });
    const a = list.add('First');
    list.markRunning(a);
    list.markFailed(a);
    list.finish();
    expect(stream.text()).toBe('✗ First\n');
  });

  it('prints still-pending steps at finish so the full plan is visible', () => {
    const stream = new FakeStream(false);
    const list = new StepList({ stream });
    const done = list.add('Done');
    list.add('Never reached');
    list.markRunning(done);
    list.markDone(done);
    list.finish();
    expect(stream.text()).toBe('✓ Done\n• Never reached\n');
  });

  it('writes log messages directly', () => {
    const stream = new FakeStream(false);
    const list = new StepList({ stream });
    list.add('First');
    list.log('warning: something odd happened');
    expect(stream.text()).toBe('warning: something odd happened\n');
  });
});

describe('StepList (TTY)', () => {
  it('renders the full list up front and ticks steps off in place', () => {
    vi.useFakeTimers();
    const stream = new FakeStream(true);
    const list = new StepList({ stream, intervalMs: 10 });
    const a = list.add('First');
    list.add('Second');
    list.markRunning(a);
    expect(finalLines(stream.text(), 2)).toEqual(['⠋ First', '• Second']);
    list.markDone(a);
    expect(finalLines(stream.text(), 2)).toEqual(['✓ First', '• Second']);
    list.finish();
  });

  it('animates the running step and advances on the timer', () => {
    vi.useFakeTimers();
    const stream = new FakeStream(true);
    const list = new StepList({ stream, intervalMs: 10 });
    const a = list.add('Working');
    list.markRunning(a);
    expect(stream.text()).toContain('⠋ Working');
    vi.advanceTimersByTime(10);
    expect(stream.text()).toContain('⠙ Working');
    list.markDone(a);
    expect(stream.text()).toContain('✓ Working');
    // No running steps left: the timer stops and no more frames are written.
    const before = stream.text();
    vi.advanceTimersByTime(50);
    expect(stream.text()).toBe(before);
  });

  it('redraws above log messages without corrupting the checklist', () => {
    vi.useFakeTimers();
    const stream = new FakeStream(true);
    const list = new StepList({ stream, intervalMs: 10 });
    const a = list.add('First');
    list.add('Second');
    list.markRunning(a);
    list.log('warning: provider base image is not ready');
    list.markDone(a);
    const text = stream.text();
    expect(text).toContain('warning: provider base image is not ready');
    expect(finalLines(text, 2)).toContain('✓ First');
    expect(finalLines(text, 2)).toContain('• Second');
  });

  it('marks a failed step with a cross on screen', () => {
    vi.useFakeTimers();
    const stream = new FakeStream(true);
    const list = new StepList({ stream });
    const a = list.add('First');
    list.add('Second');
    list.markRunning(a);
    list.markFailed(a);
    expect(finalLines(stream.text(), 2)).toEqual(['✗ First', '• Second']);
  });

  it('does not write anything when no steps are added', () => {
    const stream = new FakeStream(true);
    const list = new StepList({ stream });
    list.finish();
    expect(stream.text()).toBe('');
  });
});

describe('runStep debug timing', () => {
  it('prints a [debug] step line after a done step when debug is enabled', async () => {
    const stream = new FakeStream(false);
    const list = new StepList({ stream, debug: true });
    const step = list.add('Working');
    await runStep(list, step, async () => 'ok');
    expect(stream.text()).toMatch(/✓ Working\n\[debug\] step "Working" done in \d+ms\n/);
  });

  it('prints a [debug] step line for skipped and failed steps', async () => {
    const skipped = new FakeStream(false);
    const skipList = new StepList({ stream: skipped, debug: true });
    await runStep(skipList, skipList.add('Optional'), async () => null, (value) => value === null);
    expect(skipped.text()).toMatch(/– Optional\n\[debug\] step "Optional" skipped in \d+ms\n/);

    const failed = new FakeStream(false);
    const failList = new StepList({ stream: failed, debug: true });
    await expect(runStep(failList, failList.add('Boom'), async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(failed.text()).toMatch(/✗ Boom\n\[debug\] step "Boom" failed in \d+ms\n/);
  });

  it('prints no [debug] line when debug is disabled', async () => {
    const stream = new FakeStream(false);
    const list = new StepList({ stream });
    const step = list.add('Working');
    await runStep(list, step, async () => 'ok');
    expect(stream.text()).toBe('✓ Working\n');
  });
});

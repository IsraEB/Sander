import * as fs from 'node:fs';

const sleepSignal = new Int32Array(new SharedArrayBuffer(4));

export function syncSleep(ms: number): void {
  Atomics.wait(sleepSignal, 0, 0, ms);
}

export function readLineSync(fd: number): string | undefined {
  let data = '';
  const buf = Buffer.alloc(256);
  for (;;) {
    let n: number;
    try {
      n = fs.readSync(fd, buf, 0, buf.length, null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EAGAIN') {
        syncSleep(10);
        continue;
      }
      return undefined;
    }
    if (n <= 0) {
      return undefined;
    }
    data += buf.subarray(0, n).toString('utf8');
    if (data.includes('\n')) {
      break;
    }
  }
  return data.replace(/\r?\n$/, '').trim();
}

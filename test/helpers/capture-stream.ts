import { Writable } from 'node:stream';

export class CaptureStream extends Writable {
  private chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: string, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk));
    callback();
  }

  text(): string {
    return this.chunks.join('');
  }

  reset(): void {
    this.chunks = [];
  }
}

export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export function notImplemented(command: string): CliError {
  return new CliError(`"sander ${command}" is not implemented yet`);
}

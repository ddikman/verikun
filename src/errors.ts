// CliError carries the process exit code so the dispatcher can map failures to
// stable, agent-readable exit statuses:
//   0  success / found / assertion passed
//   1  not found / assertion failed / wait timeout
//   2  usage error or ambiguous selector (caller must refine)
//   3  environment error (adb/simctl missing, no/multiple devices, dump failed)

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export const usageError = (m: string) => new CliError(m, 2);
export const notFound = (m: string) => new CliError(m, 1);
export const envError = (m: string) => new CliError(m, 3);

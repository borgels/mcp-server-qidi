export class MoonrakerHttpError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, payload: unknown) {
    super(formatMoonrakerError(status, path, payload));
    this.name = 'MoonrakerHttpError';
    this.status = status;
    this.path = path;
  }
}

/** A tool refused to act because the printer is not in a state where the action is safe. */
export class PrinterStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrinterStateError';
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return 'Printer did not answer in time (is the printer on and the tunnel up?)';
    }
    return error.message;
  }
  return String(error);
}

function formatMoonrakerError(status: number, path: string, payload: unknown): string {
  const message =
    typeof payload === 'object' && payload !== null && 'error' in payload
      ? (payload as { error?: { message?: unknown } }).error?.message
      : typeof payload === 'string'
        ? payload.slice(0, 300)
        : undefined;
  return [`Moonraker ${path.split('?')[0]} failed with HTTP ${status}`, typeof message === 'string' ? message : undefined]
    .filter(Boolean)
    .join(': ');
}

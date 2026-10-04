export type ExportErrorCode = 'too-large' | 'unsupported' | 'encode-failed' | 'empty';

/** A failure the UI can show verbatim (messages are written for users, not developers). */
export class ExportError extends Error {
  readonly code: ExportErrorCode;
  constructor(code: ExportErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ExportError';
    this.code = code;
  }
}

/** Cancellation surfaces as the platform's AbortError so callers can treat every exporter alike. */
export function abortError(): DOMException {
  return new DOMException('Export canceled', 'AbortError');
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Rejects with AbortError as soon as `signal` fires, even while `promise` is still pending. */
export function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * A request that failed without an HTTP response. `maybeSent` is false only when the
 * failure happened before the request could have reached the server (DNS failure,
 * connection refused, connect timeout); in every other case the server may have
 * processed it, which matters for non-idempotent calls such as creating an issue.
 */
export class NetworkError extends Error {
  constructor(
    message: string,
    readonly maybeSent: boolean,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function errorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new NetworkError(`Request timed out after ${timeoutMs}ms`, true, 'TIMEOUT');
    }
    const code = errorCode(err);
    const maybeSent = !(code && NOT_SENT_CODES.has(code));
    throw new NetworkError(`Network error${code ? ` (${code})` : ''}`, maybeSent, code);
  } finally {
    clearTimeout(timer);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

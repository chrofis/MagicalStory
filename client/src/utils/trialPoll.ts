// Trial job-status polling policy. A non-2xx answer from job-status is NOT proof the trial
// failed: the server returns JSON 5xx on a transient DB error and 429/503 under load, while the
// story keeps generating. One trial per user means a false "failed" screen is very costly.

export type PollHttpOutcome = 'ok' | 'retry' | 'failed';

/** 2xx -> ok; 5xx/429/408 -> retry (transient); every other non-2xx (401/403/404...) -> definitive. */
export function classifyJobStatusHttp(status: number): PollHttpOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 500 || status === 429 || status === 408) return 'retry';
  return 'failed';
}

export const MAX_TRANSIENT_POLL_ERRORS = 10;

/** Delay before the next allowed poll after `consecutiveErrors` transient failures (3s base, 30s cap). */
export function pollBackoffMs(consecutiveErrors: number, baseMs = 3000, capMs = 30000): number {
  if (consecutiveErrors <= 0) return 0;
  return Math.min(baseMs * 2 ** consecutiveErrors, capMs);
}

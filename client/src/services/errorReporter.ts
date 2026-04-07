/**
 * Browser-side error reporter.
 *
 * Sends error events to the server's `/api/log-error` endpoint so that
 * client-side failures show up in Railway logs alongside backend events.
 * Use this whenever a user-visible error happens that we'd want to debug
 * later — generation failures, polling timeouts, payment errors, etc.
 *
 * Failures of the reporter itself are silently swallowed: we never want
 * to throw a second error while trying to report the first one.
 */

interface ReportErrorOptions {
  /** Short human-readable message — will appear in Railway logs */
  message: string;
  /** Free-form category, e.g. "GenerationFailure", "PaymentFailure" */
  errorType?: string;
  /** Optional Error object — its stack will be sent (truncated server-side) */
  error?: unknown;
  /** Extra context to attach (will be JSON-stringified into the message) */
  context?: Record<string, unknown>;
}

const LOG_ENDPOINT = '/api/log-error';

export async function reportError({
  message,
  errorType = 'BrowserError',
  error,
  context,
}: ReportErrorOptions): Promise<void> {
  // Build the message with any context appended for one-line searchability
  const fullMessage = context && Object.keys(context).length > 0
    ? `${message} | ${JSON.stringify(context)}`
    : message;

  const stack = error instanceof Error ? error.stack : undefined;

  // userId comes from localStorage if available — same key the auth service uses
  let userId: string | undefined;
  try {
    const stored = localStorage.getItem('current_user');
    if (stored) {
      const parsed = JSON.parse(stored) as { id?: string };
      userId = parsed?.id;
    }
  } catch { /* ignore */ }

  try {
    await fetch(LOG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: fullMessage,
        stack,
        url: typeof window !== 'undefined' ? window.location.href : undefined,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
        userId,
        timestamp: new Date().toISOString(),
        errorType,
      }),
    });
  } catch {
    // Reporter failure must never throw — the caller is already in an error path.
  }
}

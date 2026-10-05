// A trial session token is dead only when the server says so definitively. A transient
// failure (5xx, 429, network drop) must never throw away the session: losing it forces a new
// anonymous account, which the fingerprint limit can refuse.
export function isTrialSessionDead(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

export type AccountCreateFailure = 'signup' | 'verification' | 'generic';

/**
 * What to do when create-anonymous-account refuses. Only the fingerprint/quota refusal (429) means the
 * visitor cannot have a trial and belongs on the signup page. 403 (Turnstile rejected the token, e.g. a
 * spent one) and 503 (verification service down) are retryable with a fresh token; anything else is a
 * plain error. Never bounce a retryable failure out of the trial.
 */
export function classifyAccountCreateFailure(status: number | undefined): AccountCreateFailure {
  if (status === 429) return 'signup';
  if (status === 403 || status === 503) return 'verification';
  return 'generic';
}

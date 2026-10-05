import { describe, it, expect } from 'vitest';
import { classifyJobStatusHttp, pollBackoffMs, MAX_TRANSIENT_POLL_ERRORS } from '../../client/src/utils/trialPoll';
import { isTrialSessionDead, classifyAccountCreateFailure } from '../../client/src/utils/trialSession';

describe('W4 trial job-status polling policy', () => {
  it('5xx / 429 / 408 are transient, only definitive 4xx are terminal', () => {
    expect([200, 204].map(classifyJobStatusHttp)).toEqual(['ok', 'ok']);
    expect([500, 502, 503, 429, 408].map(classifyJobStatusHttp)).toEqual(['retry', 'retry', 'retry', 'retry', 'retry']);
    expect([401, 403, 404, 400].map(classifyJobStatusHttp)).toEqual(['failed', 'failed', 'failed', 'failed']);
  });
  it('backs off exponentially, capped, zero when healthy; bounded retries', () => {
    expect(pollBackoffMs(0)).toBe(0);
    expect(pollBackoffMs(1)).toBe(6000);
    expect(pollBackoffMs(2)).toBe(12000);
    expect(pollBackoffMs(8)).toBe(30000);
    expect(MAX_TRANSIENT_POLL_ERRORS).toBeGreaterThan(0);
  });
});

describe('W7 trial session death', () => {
  it('only 401/403/404 kill the session; 5xx/429 never do', () => {
    expect([401, 403, 404].every(isTrialSessionDead)).toBe(true);
    expect([200, 429, 500, 502, 503].some(isTrialSessionDead)).toBe(false);
  });
});

describe('W6 account-creation refusal handling', () => {
  it('only the 429 quota refusal bounces to signup; 403/503 are retryable verification failures', () => {
    expect(classifyAccountCreateFailure(429)).toBe('signup');
    expect(classifyAccountCreateFailure(403)).toBe('verification');
    expect(classifyAccountCreateFailure(503)).toBe('verification');
    expect(classifyAccountCreateFailure(500)).toBe('generic');
    expect(classifyAccountCreateFailure(400)).toBe('generic');
    expect(classifyAccountCreateFailure(undefined)).toBe('generic');
  });
});

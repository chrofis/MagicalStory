/**
 * Unit tests never reach the Jev decision API (2026-09-27).
 *
 * Jev became a third text auditor in textRefine.refineStoryText, so every test
 * that runs the text chain without injecting a Jev stub would make REAL paid
 * calls whenever the developer's shell has OPENROUTER_API_KEY set. This setup
 * file wraps globalThis.fetch for the whole unit run: a request to the Jev
 * endpoint throws before any network I/O. The Jev source then fails the way
 * a Jev outage does in production (logged error, no findings), which is what
 * those tests already expect. Tests that exercise Jev inject `callImpl` or
 * `fetchImpl` and never touch this.
 */
// @ts-ignore CommonJS
const { JEV_URL } = require('../../server/lib/jevAudit');

export const JEV_BLOCK_MESSAGE = 'Jev network call blocked in unit tests — inject callImpl/fetchImpl';

const realFetch = globalThis.fetch;
const g = globalThis as any;
g.__jevBlockedCalls = g.__jevBlockedCalls || 0;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);
  if (url.startsWith(JEV_URL)) {
    g.__jevBlockedCalls++;
    throw new Error(JEV_BLOCK_MESSAGE);
  }
  return realFetch(input, init);
}) as typeof fetch;

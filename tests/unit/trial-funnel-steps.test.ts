/**
 * The trial funnel's step names live in two places by necessity — the server
 * whitelist (server/routes/trial.js) and the client union
 * (client/src/utils/trialFunnel.ts) — and a drift between them fails SILENTLY:
 * the endpoint answers 204 to everything, so a renamed or mistyped step is
 * simply never recorded and the funnel grows a hole nobody notices.
 *
 * These tests parse both files as text rather than importing them (the server
 * module needs JWT_SECRET and a DB pool; the client one is Vite/ESM).
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(ROOT, 'server', 'routes', 'trial.js');
const CLIENT_UTIL = path.join(ROOT, 'client', 'src', 'utils', 'trialFunnel.ts');

function serverSteps(): string[] {
  const src = fs.readFileSync(SERVER_FILE, 'utf8');
  const block = src.match(/const TRIAL_FUNNEL_STEPS = \[([\s\S]*?)\];/);
  if (!block) throw new Error('TRIAL_FUNNEL_STEPS not found in server/routes/trial.js');
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

function clientSteps(): string[] {
  const src = fs.readFileSync(CLIENT_UTIL, 'utf8');
  const block = src.match(/export type TrialStep =([\s\S]*?);/);
  if (!block) throw new Error('TrialStep union not found in client/src/utils/trialFunnel.ts');
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/** Every step name passed to trackTrialStep() anywhere in the client. */
function calledSteps(): string[] {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        const src = fs.readFileSync(full, 'utf8');
        for (const m of src.matchAll(/trackTrialStep\(\s*'([a-z_]+)'/g)) found.add(m[1]);
      }
    }
  };
  walk(path.join(ROOT, 'client', 'src'));
  return [...found];
}

describe('trial funnel step names', () => {
  it('server whitelist and client union are identical, in the same order', () => {
    expect(clientSteps()).toEqual(serverSteps());
  });

  it('every trackTrialStep() call site uses a whitelisted step', () => {
    const allowed = new Set(serverSteps());
    expect(calledSteps().filter((s) => !allowed.has(s))).toEqual([]);
  });

  it('the steps the funnel exists to answer are all instrumented', () => {
    // Not every step strictly needs a call site, but these are the pre-account
    // stretch that was invisible — the whole reason for the table.
    const called = new Set(calledSteps());
    for (const step of ['landing', 'intro_start', 'consent_given', 'photo_selected', 'character_saved']) {
      expect(called.has(step), `${step} has no trackTrialStep() call site`).toBe(true);
    }
  });
});

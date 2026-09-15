import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * `account_created` is the terminal funnel step: it must mean a real account
 * exists. On the email path it was emitted on a 200 from
 * POST /api/trial/link-email, which stores the address plus a verification
 * token and leaves the user anonymous and unverified — so every address typed
 * counted as a conversion.
 */
describe('account_created means an account exists', () => {
  const trialPage = read('client/src/pages/TrialGenerationPage.tsx');
  const verifiedPage = read('client/src/pages/EmailVerified.tsx');
  const trialRoute = read('server/routes/trial.js');

  it('the email-submit handler emits email_submitted and NOT account_created', () => {
    const at = trialPage.indexOf("trackTrialStep('email_submitted')");
    expect(at).toBeGreaterThan(-1);
    const handler = trialPage.slice(at - 600, at + 600);
    expect(handler).not.toMatch(/account_created', \{ method: 'email' \}/);
  });

  it('the verification callback emits it instead', () => {
    expect(verifiedPage).toMatch(/trackTrialStep\('account_created', \{ method: 'email' \}\)/);
  });

  it('the Google path still emits it at its own completion point', () => {
    expect(trialPage).toMatch(/trackTrialStep\('account_created', \{ method: 'google' \}\)/);
  });

  it('link-email really does leave the user unverified — the premise of the fix', () => {
    expect(trialRoute).toMatch(/keep anonymous until verified/i);
  });
});

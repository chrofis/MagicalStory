import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

// The wizard shows the reserved credits as deducted the moment the job is
// created (updateCredits(creditsRemaining)). The server refunds them in the
// same transaction that marks the job failed/cancelled, and the failure screen
// says "your credits were not charged" — but the header kept the deducted
// balance until a full reload, because the status route only carried the
// balance for 'completed' and the client only read it there.
describe('credits shown after a failed or cancelled generation', () => {
  it('the status route carries the balance for every terminal state', () => {
    const src = read('server/routes/jobs.js');
    expect(src).not.toMatch(/let currentCredits = null;\s*\n\s*if \(job\.status === 'completed'\) \{/);
    expect(src).toMatch(/if \(job\.status === 'completed' \|\| job\.status === 'failed' \|\| job\.status === 'cancelled'\) \{\s*\n\s*const creditsResult = await getDbPool\(\)\.query\(\s*\n\s*'SELECT credits FROM users WHERE id = \$1'/);
  });

  it('the wizard poll applies that balance before it reports the failure', () => {
    const src = read('client/src/pages/StoryWizard.tsx');
    const i = src.indexOf("} else if (status.status === 'failed' || status.status === 'cancelled') {");
    expect(i).toBeGreaterThan(0);
    const branch = src.slice(i, src.indexOf('cancelledElsewhere = true;', i));
    expect(branch).toContain('updateCredits(status.currentCredits)');
    expect(branch.indexOf('updateCredits(status.currentCredits)')).toBeLessThan(branch.indexOf("throw new Error(status.error || 'Story generation failed')"));
  });
});

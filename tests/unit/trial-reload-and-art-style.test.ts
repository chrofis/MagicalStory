/**
 * Reload of /trial-generation must resume the visitor's existing trial job
 * (bug trial-waiting-page-reload-loses-story), the trial uses ONE art style
 * constant, and the prepare-title prewarm never seeds 'standard' from the
 * preview avatar (reversed policy, docs/decisions.md 2026-08-16).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-trial-reload';
const trial = require('../../server/routes/trial.js');
const styled = require('../../server/lib/styledAvatars.js');

describe('buildTrialUsedResponse', () => {
  it('carries the existing job id and status on a 409 TRIAL_USED', () => {
    const r = trial.buildTrialUsedResponse({ id: 'job_1', status: 'completed' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'Trial story already used', code: 'TRIAL_USED', jobId: 'job_1', status: 'completed' });
  });
  it('omits jobId when no job row exists (client then fails loudly)', () => {
    const r = trial.buildTrialUsedResponse(undefined);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('TRIAL_USED');
    expect('jobId' in r.body).toBe(false);
  });
});

describe('trial art style', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../server/routes/trial.js'), 'utf8');
  it('exports one constant and no code path hardcodes the style literal', () => {
    expect(trial.TRIAL_ART_STYLE).toBe('watercolor');
    const literals = src.match(/'watercolor'/g) || [];
    expect(literals).toHaveLength(1); // the constant definition
  });
});

describe('prepare-title never seeds standard from the preview', () => {
  it('the seeding helper is gone from styledAvatars and trial.js', () => {
    expect(styled._seedStandardFromPreview).toBeUndefined();
    const src = fs.readFileSync(path.resolve(__dirname, '../../server/routes/trial.js'), 'utf8');
    expect(src).not.toContain('_seedStandardFromPreview');
  });
  it('an untouched prewarm scope exports no standard entry', async () => {
    const chars = [{ name: 'Kid', avatars: { standard: 'data:image/png;base64,PREVIEW' } }];
    await styled.runInCacheScope('trial-test-user', async () => {
      const exp = styled.exportStyledAvatarsForPersistence(chars, trial.TRIAL_ART_STYLE);
      const kid = exp.get ? exp.get('Kid') : undefined;
      expect(JSON.stringify(kid || {})).not.toContain('PREVIEW');
    });
  });
});

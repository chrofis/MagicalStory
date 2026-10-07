/**
 * A spent trial resumes its job BEFORE create-story validates the request body.
 *
 * The waiting page resumes a story by POSTing create-story again (reload, the
 * wizard's "View your story" button, a direct visit) and those resumes carry no
 * topic (storyInput is {}). Until 2026-10-07 the handler answered 400
 * TOPIC_REQUIRED first, which the page shows as "Something went wrong" for a
 * story that exists and may be finished — at the one point of the funnel where
 * the visitor came back to read it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-trial-resume';
const trial = require('../../server/routes/trial.js');

type Row = Record<string, unknown>;
/** A pool that answers the users query, then the story_jobs query, in order. */
function fakePool(users: Row[], jobs: Row[]) {
  const calls: string[] = [];
  return {
    calls,
    query: async (sql: string) => {
      calls.push(sql);
      if (/FROM users/.test(sql)) return { rows: users };
      if (/FROM story_jobs/.test(sql)) return { rows: jobs };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

describe('existingTrialJobResponse', () => {
  it('a spent trial answers 409 TRIAL_USED with the newest job, status included', async () => {
    const pool = fakePool([{ stories_generated: 1 }], [{ id: 'job_9', status: 'completed' }]);
    const r = await trial.existingTrialJobResponse(pool, 'u1');
    expect(r).toEqual({ status: 409, body: { error: 'Trial story already used', code: 'TRIAL_USED', jobId: 'job_9', status: 'completed' } });
  });

  it('an unused trial returns null and never looks at story_jobs', async () => {
    const pool = fakePool([{ stories_generated: 0 }], [{ id: 'job_should_not_be_read', status: 'processing' }]);
    expect(await trial.existingTrialJobResponse(pool, 'u1')).toBeNull();
    expect(pool.calls.some(sql => /story_jobs/.test(sql))).toBe(false);
  });

  it('no trial account answers 404 ACCOUNT_NOT_FOUND', async () => {
    const pool = fakePool([], []);
    const r = await trial.existingTrialJobResponse(pool, 'ghost');
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('a spent trial with no job row still answers TRIAL_USED, without a jobId (the page fails loudly)', async () => {
    const pool = fakePool([{ stories_generated: 1 }], []);
    const r = await trial.existingTrialJobResponse(pool, 'u1');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('TRIAL_USED');
    expect('jobId' in r.body).toBe(false);
  });
});

describe('create-story consults the spent-trial answer before validating the body', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../server/routes/trial.js'), 'utf8');
  const handler = src.slice(src.indexOf("router.post('/create-story'"));
  it('existingTrialJobResponse runs before the TOPIC_REQUIRED check', () => {
    const resume = handler.indexOf('existingTrialJobResponse(pool, userId)');
    const topic = handler.indexOf("code: 'TOPIC_REQUIRED'");
    expect(resume).toBeGreaterThan(-1);
    expect(topic).toBeGreaterThan(-1);
    expect(resume).toBeLessThan(topic);
  });
  it('the resume request the waiting page sends (no topic, no category) is what the early return absorbs', () => {
    const page = fs.readFileSync(path.resolve(__dirname, '../../client/src/pages/TrialGenerationPage.tsx'), 'utf8');
    // storage recovery and the wizard's "View your story" both arrive with storyInput: {}
    expect(page).toContain('storyInput: {}');
    expect(page).toContain("data.code === 'TRIAL_USED' && data.jobId");
  });
});

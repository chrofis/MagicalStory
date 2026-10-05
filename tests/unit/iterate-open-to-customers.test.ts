// Owner decision 2026-10-05: "Nochmal" (page + cover iterate) is open to customers for the
// standard 2-credit retry; every developer knob stays admin-only. The route has no harness,
// so this pins the handler source: no admin-only 403, and the knobs are cleared for
// non-admin callers before anything reads them.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, '../../server/routes/regeneration.js'), 'utf8');
const start = src.indexOf("router.post('/:id/iterate/:pageNum'");
const body = src.slice(start, src.indexOf('router.', start + 20));

describe('iterate route is open to customers with admin-only knobs', () => {
  it('no longer refuses non-admins', () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).not.toContain('Iteration is only available in developer mode');
  });

  it('keeps the rate limit, ownership check and credit charge', () => {
    expect(body).toContain('imageRegenerationLimiter');
    expect(body).toContain('fetchStoryRowForUser(');
    expect(body).toContain('chargeCredits(');
  });

  it('clears every developer knob for non-admin callers before use', () => {
    const gate = body.indexOf("if (userRole !== 'admin' && !isImpersonating)");
    expect(gate).toBeGreaterThan(-1);
    const gateBlock = body.slice(gate, body.indexOf('}', gate));
    for (const knob of ['imageModel', 'sceneModel', 'blackoutIssues', 'evaluationFeedback', 'iterativePlacement',
      'previewOnly', 'customImagePrompt', 'freeIterate', 'referenceMode', 'singlePassScene']) {
      expect(gateBlock).toContain(`${knob} = undefined`);
    }
    // the knobs are only read after the gate
    expect(body.indexOf('fetchStoryRowForUser(')).toBeGreaterThan(gate);
  });
});

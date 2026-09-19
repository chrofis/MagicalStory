import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'fs';
import path from 'path';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');
const { createNotEvaluatedRecorder } = require_('../../server/lib/notEvaluated.js');

/**
 * Two ways an eval can be identity-blind: references were supplied and none
 * could be attached, or none were supplied at all. Only the first recorded a
 * notEvaluated entry, so the second was indistinguishable from an eval that
 * judged identity and found nothing wrong.
 */
describe('an identity-blind eval says so in both cases', () => {
  const SRC = fs.readFileSync(path.join(ROOT, 'server/lib/evalPipeline.js'), 'utf8');

  it('the some-unusable case records reference_photos_unusable', () => {
    expect(SRC).toMatch(/notEvaluated\.record\('identity', 'reference_photos_unusable'/);
  });

  it('the none-supplied case records no_reference_photos', () => {
    expect(SRC).toMatch(/notEvaluated\.record\('identity', 'no_reference_photos'/);
  });

  it('both reasons are machine-stable snake_case on the identity dimension', () => {
    const rec = createNotEvaluatedRecorder({ pageContext: 'p3' });
    rec.record('identity', 'no_reference_photos', 'no reference photo was supplied');
    rec.record('identity', 'no_reference_photos', 'a duplicate is not recorded twice');
    expect(rec.list()).toEqual([
      { dimension: 'identity', reason: 'no_reference_photos', detail: 'no reference photo was supplied', pageContext: 'p3' },
    ]);
  });
});

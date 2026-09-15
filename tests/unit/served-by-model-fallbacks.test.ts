import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'server/lib/evalPipeline.js'), 'utf8');

/**
 * `servedByModel` is the caller's only way to learn which model actually
 * answered; the Lab records it per arm (testlab.js). Lab #1241 asked for
 * gemini-3.7-flash, every call 400'd, the documented 2.5-flash fallback served
 * all 10 pages, and the experiment row still said 3.7 — an A/B comparing a model
 * with itself, caught only because the token counts came back byte-identical.
 *
 * The OpenRouter fallback reassigned modelId; the two Grok vision fallbacks
 * (HTTP error, safety block) did not.
 */
describe('every P1 inventory fallback reports the model that answered', () => {
  it('the OpenRouter fallback reassigns modelId', () => {
    expect(SRC).toMatch(/falling back to gemini-2\.5-flash[\s\S]{0,400}modelId = 'gemini-2\.5-flash';/);
  });

  it('both Grok vision fallbacks reassign modelId', () => {
    const assignments = SRC.match(/modelId = grokFallbackId;/g) || [];
    expect(assignments).toHaveLength(2);
  });

  it('each Grok fallback also carries its modelConfig, so a later branch sees the real provider', () => {
    const pairs = SRC.match(/modelId = grokFallbackId;\s*\n\s*modelConfig = grokFallbackModel;/g) || [];
    expect(pairs).toHaveLength(2);
  });

  it('servedByModel is reported from that same variable', () => {
    expect(SRC).toMatch(/servedByModel: modelId/);
  });
});

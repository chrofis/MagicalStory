import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const { MODEL_DEFAULTS } = require('../../server/config/models');

// Sonnet 5.5 defaults to effort high with hidden thinking billed as output
// tokens (beats_plan: 48-56k tokens, $0.575 for a ~1.1k reply). docs/decisions.md 2026-10-08.
describe('beats planner effort', () => {
  it('is one explicit constant', () => {
    expect(['low', 'medium']).toContain(MODEL_DEFAULTS.beatsPlanEffort);
  });
  it('beats_plan, beats_replan and beats_story_bible all send it', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../server/lib/beatsPipeline.js'), 'utf8');
    for (const label of ['beats_plan', 'beats_replan', 'beats_story_bible']) {
      expect(src).toContain(`usageLabel: '${label}', effort: MODEL_DEFAULTS.beatsPlanEffort`);
    }
  });
});

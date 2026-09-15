import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { buildStoryContextFields, getTeachingGuide } = require_('../../server/lib/promptBuilders.js');
const { loadPromptTemplates } = require_('../../server/services/prompts.js');

/**
 * The beats brief injected the topic guide as `guide.slice(0, 4000)` while the
 * unified writer's CATEGORY_GUIDELINES has always injected the whole thing. The
 * largest guide crosses that cut, so the beats chain got a guide that stops
 * mid-sentence — under a mandate saying every fact, date, name and sequence in
 * the story comes from it.
 */
describe('the topic guide reaches the beats brief whole', () => {
  it('the longest guide is not cut', async () => {
    await loadPromptTemplates();
    const topic = 'sage-heidi';
    const guide = getTeachingGuide('swiss-sagen', topic);
    expect(typeof guide).toBe('string');
    expect(guide.length).toBeGreaterThan(3500);

    const fields = buildStoryContextFields({
      storyCategory: 'swiss-sagen',
      storyTopic: topic,
      characters: [],
      pages: 12,
      language: 'de',
    });
    const section = String(fields.STORY_GUIDE_SECTION || '');
    expect(section).toContain(guide.slice(-120));  // the TAIL survives
    expect(section).toContain(guide);
  });
});

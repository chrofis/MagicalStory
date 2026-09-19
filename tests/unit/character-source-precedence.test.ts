import { describe, it, beforeAll, expect } from 'vitest';

const { buildArcCreatePrompt, buildArcRetellPrompt } = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

/**
 * Staging job_1789759147125_p08djwhbl. The commission staged a first meeting —
 * "Zwei fremde Buben — Max und Kiaan", "die vier Buben kennen sich nicht", and a
 * relationship matrix of twelve "Nicht bekannt mit". The saved character details,
 * under a heading calling them the source of truth, said "Max und Kiaan sind
 * seine guten Freunde". Nothing in 37k chars said which one the arc should
 * believe, and strangers-meeting was the story's whole engine.
 */
describe('the commission owns the situation, the profile owns the person', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  const input = () => ({
    pages: 18,
    language: 'de-CH',
    characters: [
      { id: 'a', name: 'Levin', age: 5, specialDetails: 'Max und Kiaan sind seine guten Freunde' },
      { id: 'b', name: 'Max', age: 3 },
    ],
    mainCharacters: ['a'],
    storyDetails: 'Zwei fremde Buben — Max und Kiaan — stehen auf der anderen Seite. Die vier Buben kennen sich nicht.',
  });

  it('states the precedence in the arc-create prompt', () => {
    const p = buildArcCreatePrompt(input(), 18, {});
    expect(p).toContain('the premise stands');
    expect(p).toContain('who knows whom here');
  });

  it('states the SAME precedence in the re-tell prompt', () => {
    const p = buildArcRetellPrompt(input(), 18, 'ARC 1: ...', '');
    expect(p).toContain('the premise stands');
    expect(p).toContain('who knows whom here');
  });

  it('is one constant, so the two prompts cannot drift apart', () => {
    const create = buildArcCreatePrompt(input(), 18, {});
    const retell = buildArcRetellPrompt(input(), 18, 'ARC 1: ...', '');
    const rule = (p: string) => p.slice(p.indexOf('# CHARACTER DETAILS'), p.indexOf('**Levin**'));
    expect(rule(create)).toBe(rule(retell));
  });

  it('no longer calls the saved profile the source of truth outright', () => {
    const p = buildArcCreatePrompt(input(), 18, {});
    expect(p).not.toContain('source of truth');
    // The trait half of the old heading survives.
    expect(p).toContain('Never contradict one, never invent one.');
  });

  it('leaves no unfilled placeholder', () => {
    expect(buildArcCreatePrompt(input(), 18, {})).not.toContain('{CHARACTER_SOURCE_RULE}');
    expect(buildArcRetellPrompt(input(), 18, 'ARC 1: ...', '')).not.toContain('{CHARACTER_SOURCE_RULE}');
  });
});

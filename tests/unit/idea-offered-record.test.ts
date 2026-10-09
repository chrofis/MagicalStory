import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
const { ideasOfferedDetail, normaliseIdeaEvent } = require('../../server/lib/ideaEvents.js');
const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8');

/** Owner 2026-10-09: "Save the ideas in future trials" — the texts offered were stored nowhere. */
describe('ideasOfferedDetail', () => {
  it('stores the texts exactly as sent, with title, kind, self-check, rerun flag and city only', () => {
    const d = ideasOfferedDetail([
      { armIndex: 0, text: '**Der Hafen**\nMia sucht das Schiff.', ideaKind: 'location', selfCheck: { ok: true, failure: null } },
      { armIndex: 1, text: 'Zweite Idee\nText', ideaKind: 'fantasy' },
    ], { rerun: true, city: ' Baden ' });
    expect(d.ideas).toHaveLength(2);
    expect(d.ideas[0]).toMatchObject({ armIndex: 0, title: 'Der Hafen', text: '**Der Hafen**\nMia sucht das Schiff.', ideaKind: 'location', selfCheck: { ok: true } });
    expect(d.ideas[1].selfCheck).toBeUndefined();
    expect(d.rerun).toBe(true);
    expect(d.city).toBe('Baden');
  });
  it('is bounded: two ideas, 4000 characters each', () => {
    const d = ideasOfferedDetail([{ armIndex: 0, text: 'x'.repeat(9000) }, { armIndex: 1, text: 'b' }, { armIndex: 2, text: 'c' }]);
    expect(d.ideas).toHaveLength(2);
    expect(d.ideas[0].text.length).toBe(4000);
    expect(d.rerun).toBe(false);
  });
  it('survives nothing offered', () => {
    expect(ideasOfferedDetail(undefined as any).ideas).toEqual([]);
  });
  it('rides on the existing idea_generated event row (no new event, no migration)', () => {
    const row = normaliseIdeaEvent({ event: 'idea_generated', userId: 'u', category: 'adventure', language: 'de', detail: ideasOfferedDetail([{ armIndex: 0, text: 'T\nb' }]) });
    expect(row.event).toBe('idea_generated');
    expect(row.detail.ideas[0].text).toBe('T\nb');
  });
});

describe('every idea route records what it offered', () => {
  it('trial stream, wizard stream and wizard single-call route', () => {
    expect(read('server/routes/trial.js')).toMatch(/ideasOfferedDetail\(\[offered\.story1, offered\.story2\]/);
    const wiz = read('server/routes/storyIdeas.js');
    expect((wiz.match(/ideasOfferedDetail\(/g) || []).length).toBe(2);
  });
});

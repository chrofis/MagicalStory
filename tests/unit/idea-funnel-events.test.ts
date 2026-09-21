import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// Both modules are CJS and are reached through node's registry (they require()
// their own dependencies), the same way every other server-side unit test here
// loads them.
const require_ = createRequire(import.meta.url);
const { normaliseIdeaEvent, castFacts, shapeRef } = require_('../../server/lib/ideaEvents');
const { tabulate, worldKeys, shapeKeys, ageBand } = require_('../../scripts/admin/idea-funnel');

describe('castFacts', () => {
  it('derives cast size and the youngest age', () => {
    expect(castFacts([{ age: '7' }, { age: 4 }, { age: '11' }]))
      .toEqual({ castSize: 3, youngestAge: 4 });
  });

  it('counts a cast whose ages are all unusable, but reports no youngest', () => {
    expect(castFacts([{ age: '' }, { name: 'x' }]))
      .toEqual({ castSize: 2, youngestAge: null });
  });

  it('is null/null for an absent cast rather than 0', () => {
    expect(castFacts(undefined)).toEqual({ castSize: null, youngestAge: null });
    expect(castFacts([])).toEqual({ castSize: null, youngestAge: null });
  });
});

describe('shapeRef', () => {
  it('keeps only the id and the name — never the definition paragraph', () => {
    expect(shapeRef({ id: 7, name: 'Swap', definition: 'a long paragraph', minAge: 5 }))
      .toEqual({ id: 7, name: 'Swap' });
  });

  it('drops a shape that identifies nothing', () => {
    expect(shapeRef({})).toBeNull();
    expect(shapeRef(null)).toBeNull();
  });
});

describe('normaliseIdeaEvent', () => {
  const base = { event: 'idea_generated', userId: 'u1', language: 'de', pages: 10 };

  it('drops an unknown event slug instead of writing free text', () => {
    expect(normaliseIdeaEvent({ event: 'idea_hovered' })).toBeNull();
    expect(normaliseIdeaEvent({})).toBeNull();
  });

  it('derives `regenerated` from the attempt counter, not from the flag', () => {
    expect(normaliseIdeaEvent({ ...base, attempt: 1, regenerate: true }).regenerated).toBe(false);
    expect(normaliseIdeaEvent({ ...base, attempt: 3, regenerate: false }).regenerated).toBe(true);
  });

  it('falls back to the client flag only when no attempt counter arrived', () => {
    expect(normaliseIdeaEvent({ ...base, regenerate: true }).regenerated).toBe(true);
    expect(normaliseIdeaEvent({ ...base }).regenerated).toBe(false);
  });

  it('defaults an absent world mode to auto, which is what the wizard shows', () => {
    expect(normaliseIdeaEvent(base).worldMode).toBe('auto');
    expect(normaliseIdeaEvent({ ...base, worldMode: 'fantasy' }).worldMode).toBe('fantasy');
  });

  it('keeps arm 0 distinct from a user-written premise', () => {
    expect(normaliseIdeaEvent({ ...base, event: 'idea_picked', armIndex: 0 }).armIndex).toBe(0);
    expect(normaliseIdeaEvent({ ...base, event: 'idea_picked', armIndex: null }).armIndex).toBeNull();
    expect(normaliseIdeaEvent({ ...base, event: 'idea_picked' }).armIndex).toBeNull();
  });

  it('reduces both arms’ shapes to references and drops an empty list', () => {
    expect(normaliseIdeaEvent({
      ...base,
      shapes: [{ id: 1, name: 'A', definition: 'x' }, { id: 2, name: 'B', definition: 'y' }],
    }).shapes).toEqual([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
    expect(normaliseIdeaEvent({ ...base, shapes: [] }).shapes).toBeNull();
    expect(normaliseIdeaEvent(base).shapes).toBeNull();
  });

  it('accepts a single shape object for a pick', () => {
    expect(normaliseIdeaEvent({ ...base, event: 'idea_picked', shapes: { id: 4, name: 'C' } }).shapes)
      .toEqual({ id: 4, name: 'C' });
  });

  it('records no cost rather than a zero one when the provider gave no usage', () => {
    expect(normaliseIdeaEvent(base).costUsd).toBeNull();
    expect(normaliseIdeaEvent({ ...base, costUsd: 0 }).costUsd).toBeNull();
    expect(normaliseIdeaEvent({ ...base, costUsd: 0.0123 }).costUsd).toBeCloseTo(0.0123);
  });

  it('trims a value to its column width instead of failing the insert', () => {
    const row = normaliseIdeaEvent({ ...base, topic: 'x'.repeat(400) });
    expect(row.topic).toHaveLength(120);
  });

  it('derives the cast columns rather than trusting a caller-supplied count', () => {
    const row = normaliseIdeaEvent({ ...base, characters: [{ age: 9 }, { age: 5 }] });
    expect(row.castSize).toBe(2);
    expect(row.youngestAge).toBe(5);
  });
});

describe('idea-funnel tabulate', () => {
  const gen = (worlds: string[], shapes: Array<{ id: number; name: string }>) =>
    ({ event: 'idea_generated', worlds, shapes });
  const pick = (world: string | null, shape: { id: number; name: string } | null) =>
    ({ event: 'idea_picked', worlds: world ? { world } : null, shapes: shape });

  const gens = [
    gen(['location', 'fantasy'], [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]),
    gen(['location', 'fantasy'], [{ id: 1, name: 'A' }, { id: 3, name: 'C' }]),
  ];
  const picks = [pick('location', { id: 1, name: 'A' })];

  it('counts a generation in BOTH cells it offered, and a pick in the one it chose', () => {
    const rows = tabulate(gens, picks, worldKeys);
    expect(rows).toEqual([
      { key: 'fantasy', offered: 2, picked: 0, rate: '0.0%' },
      { key: 'location', offered: 2, picked: 1, rate: '50.0%' },
    ]);
  });

  it('rates a shape against the generations that OFFERED it, not against all picks', () => {
    const rows = tabulate(gens, picks, shapeKeys);
    expect(rows.find(r => r.key === '1 A')).toEqual({ key: '1 A', offered: 2, picked: 1, rate: '50.0%' });
    expect(rows.find(r => r.key === '2 B')).toEqual({ key: '2 B', offered: 1, picked: 0, rate: '0.0%' });
    expect(rows.find(r => r.key === '3 C')).toEqual({ key: '3 C', offered: 1, picked: 0, rate: '0.0%' });
  });

  it('shows a dash, never a division by zero, for a cell only ever picked', () => {
    const rows = tabulate([], picks, worldKeys);
    expect(rows).toEqual([{ key: 'location', offered: 0, picked: 1, rate: '—' }]);
  });

  it('keeps a user-written premise out of every world and shape cell', () => {
    const rows = tabulate(gens, [pick(null, null)], worldKeys);
    expect(rows.every(r => r.picked === 0)).toBe(true);
  });
});

describe('idea-funnel ageBand', () => {
  it('bands the youngest character the way the plot modes do', () => {
    expect(ageBand(3)).toBe('0-4');
    expect(ageBand(4)).toBe('0-4');
    expect(ageBand(5)).toBe('5-6');
    expect(ageBand(6)).toBe('5-6');
    expect(ageBand(7)).toBe('7-9');
    expect(ageBand(9)).toBe('7-9');
    expect(ageBand(10)).toBe('10+');
    expect(ageBand(null)).toBe('(unknown)');
    expect(ageBand(undefined)).toBe('(unknown)');
  });
});

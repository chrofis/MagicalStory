import { describe, it, expect } from 'vitest';
import { summarizeClothingReview } from '../../client/src/utils/clothingReview';
import type { ClothingReviewReport } from '../../client/src/types/story';

/**
 * The wardrobe review's dev panel (StoryDisplay → renderClothingPanel) reads
 * one folded view of the stored report. These fixtures are REAL staging rows
 * (prompt stripped, nothing else invented):
 *   …riqncqg1i — 4 outfits, nothing rewritten
 *   …wkt20ckod — 4 outfits, one standard outfit rewritten
 *   …zly5rcdej — 5 outfits, four rewritten, three of them `costumed:pirate`
 *
 * The costumed case is the one the join can get wrong: `changed[].category` is
 * `costumed:<costume>` while `outfitsIn[]` splits the costume into its own
 * field, so a naive key leaves every costume rewrite unmatched.
 */
import noChanges from './fixtures/clothing-review-job_1789853503332_riqncqg1i.json';
import oneChange from './fixtures/clothing-review-job_1789681157795_wkt20ckod.json';
import costumeChanges from './fixtures/clothing-review-job_1789420511893_zly5rcdej.json';

const sum = (r: unknown) => summarizeClothingReview(r as ClothingReviewReport);

describe('summarizeClothingReview', () => {
  it('lists every outfit as unchanged when the review rewrote nothing', () => {
    const s = sum(noChanges)!;
    expect(s).not.toBeNull();
    expect(s.rows).toHaveLength(4);
    expect(s.changedCount).toBe(0);
    expect(s.rows.every(r => !r.changed && r.before === null)).toBe(true);
    expect(s.rows.map(r => r.name)).toEqual(['Levin', 'Julian', 'Max', 'Kiaan']);
    // The analysis is the whole point of a zero-change run: it can still fault.
    expect(s.analysis.length).toBeGreaterThan(0);
    expect(s.model).toBe('deepseek/deepseek-v4-pro');
  });

  it('marks the one rewritten outfit and keeps its pre-review text', () => {
    const s = sum(oneChange)!;
    expect(s.rows).toHaveLength(4);
    expect(s.changedCount).toBe(1);
    const max = s.rows.find(r => r.name === 'Max')!;
    expect(max.changed).toBe(true);
    expect(max.before).toContain('dark olive green wool twill trousers');
    expect(max.final).toContain('dark brown wool twill trousers');
    expect(max.before).not.toBe(max.final);
    // Everyone else stays unchanged, with no phantom before-text.
    expect(s.rows.filter(r => r.name !== 'Max').every(r => !r.changed && r.before === null)).toBe(true);
  });

  it('joins costumed rewrites, whose category carries the costume inline', () => {
    const s = sum(costumeChanges)!;
    expect(s.rows).toHaveLength(5);
    expect(s.changedCount).toBe(4);
    const emma = s.rows.find(r => r.name === 'Emma')!;
    expect(emma.category).toBe('costumed');
    expect(emma.costume).toBe('pirate');
    expect(emma.changed).toBe(true);
    expect(emma.before).toContain('peasant blouse');
    // The one outfit nobody touched is still listed.
    const daniel = s.rows.find(r => r.name === 'Daniel')!;
    expect(daniel.changed).toBe(false);
    expect(daniel.before).toBeNull();
    // Every row keeps the outfit that was actually drawn.
    expect(s.rows.every(r => r.final.length > 0)).toBe(true);
  });

  it('degrades to null when there is no report (older rows, trial stories)', () => {
    expect(summarizeClothingReview(null)).toBeNull();
    expect(summarizeClothingReview(undefined)).toBeNull();
    expect(summarizeClothingReview({} as ClothingReviewReport)).toBeNull();
    expect(summarizeClothingReview({ changed: [], outfitsIn: [], analysis: '  ' })).toBeNull();
  });

  it('still lists a rewrite whose outfit is missing from outfitsIn', () => {
    const s = summarizeClothingReview({
      model: 'm',
      outfitsIn: [],
      changed: [{ name: 'Emma', category: 'costumed:pirate', before: 'a', after: 'b' }],
    })!;
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ name: 'Emma', category: 'costumed', costume: 'pirate', before: 'a', final: 'b', changed: true });
  });

  it('carries the prompt only when the payload has one', () => {
    expect(sum(noChanges)!.prompt).toBeNull();
    expect(summarizeClothingReview({ outfitsIn: [], changed: [], prompt: 'PROMPT' })!.prompt).toBe('PROMPT');
  });
});

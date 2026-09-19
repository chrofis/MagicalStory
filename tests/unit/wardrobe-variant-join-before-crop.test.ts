import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * WARDROBE-VARIANT RACE — the join, not the wording.
 *
 * `streamingAvatarStylingPromise` is a rolling chain: every consumer awaits
 * whatever it holds at the moment it needs the sheets. Phase 4 REASSIGNS it
 * with the wardrobe-variant render, and that reassignment happens AFTER the
 * last of the three original joins (trial page, trial cover, pre-cover) — so
 * nothing awaited the variant work before `applyStoryCellRefs` cropped page
 * cells out of it. Whether the `--off:` sheet existed was decided by how long
 * the unrelated narrative work (translation, lector) happened to take.
 *
 * These pin: the join exists and sits between the kickoff and the crop; the
 * crop does not observe a missing variant while the render is in flight; a
 * FAILED variant settles the chain and falls through to the loud worn-sheet
 * fallback instead of hanging; the three base-styling joins are untouched.
 */
const { resolveSheetForRef } = require('../../server/lib/storyAvatars');

const PIPELINE = fs.readFileSync(path.join(process.cwd(), 'storyJobPipeline.js'), 'utf8');

describe('the styling chain is joined before page cells are cropped', () => {
  it('the variant kickoff is awaited somewhere after it is assigned', () => {
    const kickoff = PIPELINE.indexOf('prepareWardrobeVariantAvatars');
    expect(kickoff).toBeGreaterThan(0);
    const awaitsAfter = [...PIPELINE.matchAll(/await streamingAvatarStylingPromise/g)]
      .map(m => m.index as number)
      .filter(i => i > kickoff);
    expect(awaitsAfter.length).toBeGreaterThan(0);
  });

  it('that join runs before Phase 5a prepares page data (where the cells are cropped)', () => {
    const kickoff = PIPELINE.indexOf('prepareWardrobeVariantAvatars');
    const phase5a = PIPELINE.indexOf('Phase 5a: Preparing ${expandedScenes.length} pages');
    expect(phase5a).toBeGreaterThan(kickoff);
    const join = [...PIPELINE.matchAll(/await streamingAvatarStylingPromise/g)]
      .map(m => m.index as number)
      .find(i => i > kickoff && i < phase5a);
    expect(join).toBeDefined();
  });

  it('the three base-styling joins are unchanged — the chain still has four consumers', () => {
    const joins = [...PIPELINE.matchAll(/await streamingAvatarStylingPromise/g)].length;
    expect(joins).toBe(4);
    expect(PIPELINE).toContain('[TRIAL-PAGE]');
    expect(PIPELINE).toContain('[TRIAL-COVER] Waiting for avatar styling');
  });
});

// The runtime half: model the chain + the crop and show the join decides the
// outcome. No provider is called — the "render" is a timer that writes a slot.
const REF = () => ({ name: 'Levin', clothingCategory: 'standard', wornOffIds: ['CLO002'] });

// `story` is one character's entry from story.data.characterAvatars.
const cropSees = (story: Record<string, string>) =>
  resolveSheetForRef(story, REF())?.slotKey || null;

describe('a crop during an in-flight variant render', () => {
  it('without the join the crop misses the variant; with it, the variant is there', async () => {
    vi.useFakeTimers();
    try {
      const story: Record<string, string> = { 'styled-standard': 'data:image/png;base64,WORN' };
      let chain: Promise<void> | null = (async () => {
        await new Promise(r => setTimeout(r, 5000));
        story['styled-standard--off:CLO002'] = 'data:image/png;base64,OFF';
      })();

      // No join: the crop runs immediately and sees only the worn sheet.
      expect(cropSees(story)).toBe('styled-standard');

      // With the join: the crop waits for the chain to settle and sees the variant.
      const joined = (async () => { await chain; return cropSees(story); })();
      await vi.advanceTimersByTimeAsync(5000);
      expect(await joined).toBe('styled-standard--off:CLO002');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a FAILED variant settles the chain promptly — the crop falls back loudly, it does not hang', async () => {
    const story: Record<string, string> = { 'styled-standard': 'data:image/png;base64,WORN' };
    // The kickoff swallows a refusal / eval rejection / provider error into a
    // warn, so the chain RESOLVES on failure — the join is "has it finished
    // trying", never "did it succeed".
    const chain = (async () => {
      try { throw new Error('IMAGE_OTHER refusal'); } catch { /* logged as a warn */ }
    })();
    await expect(chain).resolves.toBeUndefined();
    expect(cropSees(story)).toBe('styled-standard');
  });
});

/**
 * EVERY CRITIC JUDGES THE SOURCE THE GENERATOR WAS GIVEN (standing rule,
 * docs/decisions.md 2026-09-26). Pinned here for the inputs added under it:
 *
 * - the plan check reads the planner's CHARACTER DETAILS block and its
 *   arc-master source rule;
 * - the arc-informed text audit reads the writer's CHARACTER DETAILS block and
 *   the writer's own statement of how to use it; the blind audit stays blind;
 * - the object entity grid gets the Visual Bible entry's reference image as
 *   cell R, its description and each page's state, and judges every crop.
 *
 * These pin the BEHAVIOUR (which value reaches which built prompt), never any
 * wording of a rule.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { loadPromptTemplates } = require_('../../server/services/prompts');
const PB = require_('../../server/lib/promptBuilders.js');
const { GoogleGenerativeAI } = require_('@google/generative-ai');
const entity = require_('../../server/lib/entityConsistency.js');
const { log } = require_('../../server/utils/logger');

const TRAIT = 'collects river stones and hums when nervous';
const inputData: any = {
  characters: [
    { id: 'c1', name: 'CharA', age: 8, gender: 'girl', personality: TRAIT },
    { id: 'c2', name: 'CharB', age: 5, gender: 'boy', personality: 'shy' },
  ],
  mainCharacters: ['c1'],
  language: 'en',
  languageLevel: 'medium',
  storyCategory: 'adventure',
  storyTheme: 'pirate',
  storyDetails: 'A day at the harbour.',
};
const ARC = 'The main character must find the lost map before the tide turns.';
const BEATS = [
  { pageNumber: 1, planLine: 'wide — CharA on the pier — she lifts the lantern — the lamp is lit' },
  { pageNumber: 2, planLine: 'close — CharB — he cups the flame — the flame holds' },
];
const PAGES = BEATS.map(b => ({ pageNumber: b.pageNumber, text: 'She lifted the lantern.', sceneBrief: 'The main character lifts a lantern.', planLine: b.planLine }));

beforeAll(async () => { await loadPromptTemplates(); });

describe('plan check reads the planner\'s CHARACTER DETAILS', () => {
  it('the same block and the same source rule the planner gets', () => {
    const details = PB.storyCharacterDetails(inputData);
    const sourceRule = PB.characterSourceRule({ master: 'arc' });
    expect(details).toContain(TRAIT);
    const planner = PB.buildBeatsPrompt(inputData, 2, { finalArc: ARC });
    const check = PB.buildPlanCheckPrompt(inputData, BEATS, ARC, '');
    for (const p of [planner, check]) {
      expect(p).toContain(details);
      expect(p).toContain(sourceRule);
    }
    expect(check).not.toMatch(/\{CHARACTER_(DETAILS|SOURCE_RULE)\}/);
  });

  it('withholding the cast withholds the details (the value is input, not boilerplate)', () => {
    const check = PB.buildPlanCheckPrompt({ ...inputData, characters: [inputData.characters[1]] }, BEATS, ARC, '');
    expect(check).not.toContain(TRAIT);
  });
});

describe('arc-informed text audit reads the writer\'s CHARACTER DETAILS; the blind audit does not', () => {
  it('writer and sighted audit carry the same block and the same use statement', () => {
    const details = PB.storyCharacterDetails(inputData);
    const writer = PB.buildStoryTextFromBeatsPrompt(inputData, BEATS, [], ARC, { arcHints: '' });
    const audit = PB.buildTextAuditPrompt(inputData, PAGES, ARC);
    for (const p of [writer, audit]) {
      expect(p).toContain(details);
      expect(p).toContain(PB.CHARACTER_DETAILS_USE);
      expect(p).not.toMatch(/\{CHARACTER_DETAILS(_USE)?\}/);
    }
  });

  it('the blind audit never sees them', () => {
    expect(PB.buildTextAuditBlindPrompt(inputData, PAGES)).not.toContain(TRAIT);
  });
});

describe('object entity grid: every crop judged, against the Visual Bible source', () => {
  it('balancedCropBatches places every crop, at most five per grid, no near-empty tail', () => {
    for (const n of [1, 5, 6, 9, 10, 11, 23]) {
      const crops = Array.from({ length: n }, (_, i) => ({ pageNumber: i + 1 }));
      const batches = entity.balancedCropBatches(crops);
      expect(batches.flat().map((c: any) => c.pageNumber)).toEqual(crops.map(c => c.pageNumber));
      expect(Math.max(...batches.map((b: any[]) => b.length))).toBeLessThanOrEqual(5);
      expect(Math.max(...batches.map((b: any[]) => b.length)) - Math.min(...batches.map((b: any[]) => b.length))).toBeLessThanOrEqual(1);
    }
  });

  const VB = {
    artifacts: [{
      id: 'ART001', name: 'wooden chest', description: 'a small oak chest with iron bands',
      referenceImageUrl: 'https://example.invalid/art001.jpg',
      states: [
        { id: 'ART001.1', name: 'closed', delta: 'lid shut', pages: [2] },
        { id: 'ART001.2', name: 'open', delta: 'lid thrown back, empty inside', pages: [5] },
      ],
    }],
    animals: [], vehicles: [], secondaryCharacters: [],
  };

  it('objectVbSource resolves the canonicalised entry: its reference image, description and each page\'s state', () => {
    const src = entity.objectVbSource(VB, [
      { pageNumber: 2, canonicalId: 'ART001', citedHandle: 'ART001.1' },
      { pageNumber: 5, canonicalId: 'ART001', citedHandle: 'ART001.2' },
    ]);
    expect(src.entry.id).toBe('ART001');
    expect(src.referenceImageUrl).toBe('https://example.invalid/art001.jpg');
    expect(src.description).toBe('a small oak chest with iron bands');
    expect(src.statesByPage[2]).toContain('lid shut');
    expect(src.statesByPage[5]).toContain('lid thrown back');
  });

  it('an uncanonicalised detection resolves to no entry (no second name matcher)', () => {
    const src = entity.objectVbSource(VB, [{ pageNumber: 2, canonicalId: null }]);
    expect(src.entry).toBeNull();
    expect(src.referenceImageUrl).toBeNull();
  });

  describe('the built object prompt', () => {
    let sentPrompt = '';
    const original = GoogleGenerativeAI.prototype.getGenerativeModel;
    beforeAll(() => {
      GoogleGenerativeAI.prototype.getGenerativeModel = () => ({
        generateContent: async (parts: unknown[]) => {
          sentPrompt = String(parts[0]);
          return { response: { text: () => JSON.stringify({ consistent: true, score: 10, fixable_issues: [], summary: 'ok' }) } };
        },
      });
    });
    afterAll(() => { GoogleGenerativeAI.prototype.getGenerativeModel = original; });

    const manifest = { cells: [{ letter: 'R', isReference: true }, { letter: 'A', pageNumber: 2, cropType: 'body' }, { letter: 'B', pageNumber: 5, cropType: 'body' }] };

    it('carries the reference cell, the description and each cell\'s state — and no clothing on an object', async () => {
      const spy = vi.spyOn(log, 'error');
      await entity.evaluateEntityConsistency(Buffer.from('x'), manifest, {
        entityType: 'object', entityName: 'wooden chest', cellCount: 2,
        referencePhoto: 'https://example.invalid/art001.jpg',
        vbDescription: 'a small oak chest with iron bands',
        cellStates: { 2: 'closed: lid shut', 5: 'open: lid thrown back, empty inside' },
      });
      expect(sentPrompt).toContain('Cell R is the Visual Bible reference image');
      expect(sentPrompt).toContain('a small oak chest with iron bands');
      expect(sentPrompt).toContain('"state": "closed: lid shut"');
      expect(sentPrompt).toContain('"state": "open: lid thrown back, empty inside"');
      expect(sentPrompt).not.toMatch(/"clothing": "/);
      expect(spy.mock.calls.map(c => String(c[0])).filter(m => m.includes('no clothing category'))).toEqual([]);
      spy.mockRestore();
    });

    it('without a reference image the judge is told only the description was given', async () => {
      await entity.evaluateEntityConsistency(Buffer.from('x'), { cells: [{ letter: 'A', pageNumber: 2 }] }, {
        entityType: 'object', entityName: 'lantern', cellCount: 1, referencePhoto: null,
        vbDescription: 'a dented brass lantern',
      });
      expect(sentPrompt).toContain('No reference image');
      expect(sentPrompt).toContain('a dented brass lantern');
    });
  });
});

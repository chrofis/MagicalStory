/**
 * wrong_state (owner, 2026-10-24, docs/decisions.md): an element drawn in a
 * different state than the one the page gave it (prod job_1792859316244_6429d0n83
 * p6: a picture book whose state is CLOSED, drawn open). Two halves:
 *   1. THE JUDGES ARE TOLD THE STATE - with the clause the generator got, from
 *      one derivation (visualBible.pageObjectStateClause), including the places
 *      the generator drops it (a contradicting instant, a receiver).
 *   2. ONE NEW TYPE registered at every site a scored type needs, routed to the
 *      page redo like wrong_action, with repair ADMISSION unchanged.
 * Everything runs the REAL builders; nothing asserts template wording beyond the
 * rule being present in the BUILT prompt.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require_ = createRequire(import.meta.url);
const { loadPromptTemplates, PROMPT_TEMPLATES, buildEvaluationPrompt } = require_('../../server/services/prompts.js');
const PB = require_('../../server/lib/promptBuilders.js');
const guard = require_('../../server/lib/vbIdGuard.js');
const { pageObjectStateClause } = require_('../../server/lib/visualBible.js');
const { buildEvalRequiredObjects } = require_('../../server/lib/evalPipeline.js');
const { buildSemanticPrompt, semanticDeclaredBlocks } = require_('../../server/lib/sceneValidator.js');
const eb = require_('../../server/lib/evalBuckets.js');
const sc = require_('../../server/lib/scoring.js');
const rl = require_('../../server/lib/repairLogic.js');

beforeAll(async () => { await loadPromptTemplates(); });

const CLOSED = 'the book is closed, its cover shut';
const BOOK = {
  id: 'ART002', name: 'picture book', description: 'a small cloth-bound picture book',
  states: [
    { id: 'ART002.1', name: 'closed', delta: CLOSED, held: false, pages: [6] },
    { id: 'ART002.2', name: 'opened', delta: 'the book lies open, two pages showing', held: false, pages: [10] },
  ],
};
const bible = () => ({
  mainCharacters: [{ id: 'CHR001', name: 'Ada' }], secondaryCharacters: [], animals: [], vehicles: [], clothing: [], locations: [],
  artifacts: [JSON.parse(JSON.stringify(BOOK))],
});
const meta = (objects: string[], interactions: any[] | null = null) => ({
  sceneIntent: 'test', characters: [{ name: 'Ada', position: 'center', depth: 'midground' }], shot: 'medium', objects,
  ...(interactions ? { interactions } : {}), textPosition: 'bottom-left',
});
const hint = (m: any) => `A quiet room.\n\n---METADATA---\n${JSON.stringify(m)}`;
const pagePrompt = (m: any, page: number, vb = bible()) => PB.buildImagePrompt(hint(m), { language: 'en' }, null, vb, page, null, {});
const generatorLine = (prompt: string) => {
  const sec = prompt.match(/\*\*REQUIRED OBJECTS[^*]*\*\*:?\s*([\s\S]*?)(?=\n\n|$)/i);
  return (sec ? sec[1] : '').split('\n').find(l => l.includes('picture book')) || '';
};
const judgeElementLine = (m: any, page: number, vb = bible()) =>
  guard.formatElementsBlock(m.objects, vb, { sceneMetadata: m, pageNumber: page }).split('\n').find((l: string) => l.startsWith('ART002')) || '';

describe('the judges are handed the state the generator got', () => {
  it('PAGE ELEMENTS carries the cited state clause, and it is the clause on the generator line', () => {
    const m = meta(['ART002.1']);
    expect(judgeElementLine(m, 6)).toBe(`ART002 — picture book (state: ${CLOSED})`);
    expect(generatorLine(pagePrompt(m, 6))).toContain(` — ${CLOSED}`);
  });
  it('the page table decides for a bare id, as for the generator; another page gets its own state', () => {
    expect(judgeElementLine(meta(['ART002']), 10)).toContain('two pages showing');
    expect(generatorLine(pagePrompt(meta(['ART002']), 10))).toContain('two pages showing');
  });
  it('a stated object whose instant contradicts the state: neither side carries the clause', () => {
    const m = meta(['ART002.1'], [{ character: 'Ada', object: 'ART002', where: 'holds it', hands: true }]);
    expect(generatorLine(pagePrompt(m, 6))).not.toContain(CLOSED);
    expect(judgeElementLine(m, 6)).toBe('ART002 — picture book');
  });
  it('the receiver of another row carries no clause on either side', () => {
    const m = meta(['ART002.1'], [{ character: 'Ada', object: 'the jug', where: 'pours', receiver: 'ART002', hands: true }]);
    expect(generatorLine(pagePrompt(m, 6))).not.toContain(CLOSED);
    expect(judgeElementLine(m, 6)).toBe('ART002 — picture book');
  });
  it('one derivation: the clause is pageObjectStateClause\'s', () => {
    const m = meta(['ART002.1']);
    const { clause } = pageObjectStateClause(bible().artifacts[0], 'ART002.1', 6, m, { visualBible: bible(), silent: true });
    expect(clause).toBe(CLOSED);
  });
  it('without metadata or page number the element is listed without a clause (old callers unchanged)', () => {
    expect(guard.formatElementsBlock(['ART002.1'], bible())).toBe('ART002 — picture book');
  });
  it('the semantic judge reads the state out of the brief it is given', () => {
    const blocks = semanticDeclaredBlocks({ sceneHint: hint(meta(['ART002.1'])), visualBible: bible(), pageNumber: 6 });
    expect(blocks.elementsBlock).toContain(`(state: ${CLOSED})`);
  });
  it('the quality judge REQUIRED OBJECTS carries the same clause after the unchanged names', () => {
    const m = meta(['ART002.1']);
    const prompt = pagePrompt(m, 6);
    const stated = buildEvalRequiredObjects({ pagePrompt: prompt, sceneMetadata: m, visualBible: bible(), pageNumber: 6 });
    expect(stated.block).toContain(`STATE GIVEN FOR EACH STATED OBJECT: picture book (state: ${CLOSED})`);
    expect(stated.block.startsWith('picture book')).toBe(true);
    const noStates = { ...bible(), artifacts: [{ ...BOOK, states: undefined }] };
    const plain = buildEvalRequiredObjects({ pagePrompt: null, sceneMetadata: meta(['ART002']), visualBible: noStates, pageNumber: 6 });
    expect(plain.block).not.toContain('STATE GIVEN');
  });
});

describe('the rule reaches the BUILT judge prompts', () => {
  it('semantic: PAGE ELEMENTS state clause and the wrong_state rule are in the filled prompt', () => {
    const elementsBlock = judgeElementLine(meta(['ART002.1']), 6);
    const out = buildSemanticPrompt(PROMPT_TEMPLATES.imageSemantic, { storyText: 't', sceneHint: 'h', imagePrompt: 'p', elementsBlock });
    expect(out).toContain(`(state: ${CLOSED})`);
    expect(out).toContain('type: wrong_state');
  });
  it('quality: REQUIRED OBJECTS state clause and D-35 are in the filled prompt', () => {
    const out = buildEvaluationPrompt({ originalPrompt: 'x', requiredObjects: `picture book. STATE GIVEN FOR EACH STATED OBJECT: picture book (state: ${CLOSED})` });
    expect(out).toContain(`(state: ${CLOSED})`);
    expect(out).toContain('D-35 `wrong_state`');
  });
});

describe('wrong_state is registered at every site', () => {
  const read = (p: string) => readFileSync(p, 'utf8');
  it('evaluator prompts, consolidator list, buckets, scoring, repair routing', () => {
    expect(read('prompts/image-semantic.txt')).toMatch(/`wrong_state` \(an element drawn in a different state/);
    expect(read('prompts/image-evaluation.txt')).toContain('D-35 `wrong_state`');
    expect(read('prompts/feedback-consolidator.txt')).toMatch(/`wrong_action` · `wrong_state` · `object_presence`/);
    expect(read('prompts/image-prompt-compliance.txt')).toMatch(/`wrong_action`, `wrong_state`,/);
    expect(eb.TYPE_TO_BUCKET.wrong_state).toBe('wrong_state');
    expect(eb.CONSOLIDATED_TYPES).toContain('wrong_state');
    expect(rl.NOT_INPAINTABLE_TYPES.has('wrong_state')).toBe(true);
    expect(rl.ITERATE_ROUTED_TYPES.has('wrong_state')).toBe(true);
  });
  it('a CRITICAL wrong_state is capped at MAJOR, and costs what a MAJOR wrong_action costs', () => {
    expect(sc.deductionPoints({ type: 'wrong_state', severity: 'CRITICAL' })).toBe(sc.deductionPoints({ type: 'wrong_state', severity: 'MAJOR' }));
    expect(sc.deductionPoints({ type: 'wrong_state', severity: 'MAJOR' })).toBe(sc.deductionPoints({ type: 'wrong_action', severity: 'MAJOR' }));
  });
  it('the sibling registry knows the generator/critic pair', () => {
    const reg = JSON.parse(read('scripts/admin/sibling-registry.json'));
    const set = reg.sets.find((s: any) => s.id === 'page-image-generator-vs-critics');
    expect(set.parity.ruleAnchors.some((a: any) => a.critic.includes('wrong_state'))).toBe(true);
  });
});

describe('repair admission is unchanged', () => {
  const p = (type: string, sources: string[]) => ({
    evaluated: true, finalScore: 83, fixableIssues: [],
    consolidatedPlan: { deduped_issues: [{ type, severity: 'MAJOR', sources, character: null, description: 'x' }], scene_fix: { requires_regeneration: false } },
  });
  it('a semantic MAJOR wrong_state on a page above the threshold is not admitted, exactly like action_interaction', () => {
    expect(rl.findBadPages({ 1: p('wrong_state', ['semantic']), 2: p('action_interaction', ['semantic']) })).toEqual([]);
  });
});

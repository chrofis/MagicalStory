/**
 * D-16b (the held-object swap) reaches the judge.
 *
 * The rule has existed since 2026-09-13 and could never fire: it read the page's
 * REQUIRED OBJECTS checklist out of ORIGINAL_PROMPT, but on the batch path —
 * the one the production pipeline runs — ORIGINAL_PROMPT is the scene
 * DESCRIPTION, deliberately (resolveEvalSceneDescription keeps the prompt tail
 * out so resolveEvalArtStyle's "no **ART STYLE block" invariant holds), and the
 * checklist is emitted into that same tail. So the block was never present and
 * the rule's own "skip when no REQUIRED OBJECTS block was supplied" clause
 * skipped it on every page of every story.
 *
 * These tests pin the fix as BEHAVIOUR: the checklist is resolved from what the
 * pipeline actually stores and lands in the built evaluation prompt as its own
 * input, the way ART STYLE and the CLOTHING CONTRACT already do.
 *
 * FIXTURE IS REAL. `eval-required-objects-job_1789348171785_9oxos7dwv.json` is a
 * verbatim pull of one staging page: its stored built `prompt`, its parsed
 * `sceneMetadata` (whose `objects[]` are VB ids — "LOC001", "ART001" — not
 * names) and the story's Visual Bible element pools. A hand-built fixture that
 * put plain names in `objects[]` would pass while the production shape failed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';


const require_ = createRequire(import.meta.url);
const FIXTURE = require_('./fixtures/eval-required-objects-job_1789348171785_9oxos7dwv.json');

const { buildEvalRequiredObjects } = require_('../../server/lib/evalPipeline');
const { loadPromptTemplates, PROMPT_TEMPLATES, buildEvaluationPrompt } = require_('../../server/services/prompts');

describe('REQUIRED OBJECTS is its own evaluator input (D-16b)', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the stored page prompt yields the checklist leads, verbatim', () => {
    // The real stored prompt's block is "* **dragon egg** (object)".
    const { block, source } = buildEvalRequiredObjects({
      pagePrompt: FIXTURE.prompt,
      sceneMetadata: FIXTURE.sceneMetadata,
      visualBible: FIXTURE.visualBible,
    });
    expect(source).toBe('prompt');
    expect(block).toBe('dragon egg');
  });

  it('with no stored prompt it falls back to sceneMetadata VB ids, resolved to labels and without the location', () => {
    // Real stored objects[]: ["LOC001", "ART001"]. LOC001 is a place, not a
    // prop — the checklist and its parser both drop locations, so this must.
    expect(FIXTURE.sceneMetadata.objects).toContain('LOC001');
    const { block, source } = buildEvalRequiredObjects({
      pagePrompt: null,
      sceneMetadata: FIXTURE.sceneMetadata,
      visualBible: FIXTURE.visualBible,
    });
    expect(source).toBe('sceneMetadata');
    expect(block).toBe('dragon egg');
    expect(block).not.toMatch(/LOC\d|ART\d/);
  });

  it('resolves nothing when there is nothing to resolve — D-16b then skips', () => {
    expect(buildEvalRequiredObjects({}).block).toBe('');
    expect(buildEvalRequiredObjects({ sceneMetadata: { objects: ['LOC001'] }, visualBible: FIXTURE.visualBible }).block).toBe('');
  });

  it('the template carries the input and the rule reads it, not the prompt tail', () => {
    const tpl = PROMPT_TEMPLATES.imageEvaluation;
    expect(tpl).toContain('{REQUIRED_OBJECTS}');
    const d16b = tpl.split('\n').find((l: string) => l.startsWith('**D-16b'));
    expect(d16b).toBeTruthy();
    // The rule must not go back to reading ORIGINAL_PROMPT's tail.
    expect(d16b).toContain('input 9');
    expect(d16b).not.toMatch(/REQUIRED OBJECTS block/);
  });

  it('the built evaluation prompt states the required objects, and states nothing when none were resolved', () => {
    const { block } = buildEvalRequiredObjects({ pagePrompt: FIXTURE.prompt });
    const live = buildEvaluationPrompt({
      originalPrompt: 'The main character stands in a market square.',
      requiredObjects: block,
    });
    expect(live).toContain('dragon egg');
    expect(live).not.toContain('{REQUIRED_OBJECTS}');

    const blind = buildEvaluationPrompt({ originalPrompt: 'The main character stands in a market square.' });
    expect(blind).not.toContain('dragon egg');
    expect(blind).not.toContain('{REQUIRED_OBJECTS}');
  });

  it('WIRING: the eval passes the list on both prompt builds, and the batch caller hands it the built page prompt', () => {
    // The rule was dead because nothing carried the list to the judge. These
    // two sites ARE the fix; a refactor that drops either makes D-16b inert
    // again with every unit test above still green.
    const fs = require_('fs');
    const evalSrc = fs.readFileSync('server/lib/evalPipeline.js', 'utf8');
    // Primary build and the safety-sanitisation retry build.
    expect(evalSrc.match(/requiredObjects:\s*requiredObjectsBlock/g)?.length).toBe(2);
    expect(evalSrc).toContain('buildEvalRequiredObjects({');
    const imagesSrc = fs.readFileSync('server/lib/images.js', 'utf8');
    expect(imagesSrc).toContain('pagePrompt: img.prompt || null');
  });
});

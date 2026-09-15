import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A Test Lab stage id lives in three places with no shared constant:
 *   - server/lib/testlab.js — STAGE_RUNNERS / STORY_STAGES / AVATAR_STAGES,
 *     exported together as STAGES (the source of truth: POST /experiments
 *     validates against it);
 *   - server/routes/admin/testlab.js — STAGE_TEMPLATE_KEYS, the stage →
 *     template-key map behind "Load current template";
 *   - client/src/services/testlabService.ts — TESTLAB_STAGES, the dropdown.
 * The client list cannot import the server registry (it maps ids to runner
 * functions), so this test is the guard: a stage added on one side only fails
 * here, naming the id and the side that lacks it.
 *
 * testlab.js is required for real (its top-level requires are logger,
 * samBlend, sceneReviewGuard, the two replay-input modules — ~40 MB RSS, no
 * beatsPipeline); the other two files are read as text because the route file
 * would mount express middleware and the client file is TypeScript.
 */
const require_ = createRequire(import.meta.url);
const root = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

function idsOf(text: string, re: RegExp): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(re)) out.add(m[1]);
  return out;
}

const serverIds: Set<string> = new Set(require_('../../server/lib/testlab').STAGES);

// `{ id: 'xyz', label: ...` — one per registered stage; retired stages are
// comments, and comments never carry that shape.
const clientIds = idsOf(read('client/src/services/testlabService.ts'), /^\s*\{ id: '([a-z_]+)'/gm);

// The object literal from `const STAGE_TEMPLATE_KEYS = {` to its closing `};`,
// keys at two-space indent — the same shape STAGE_RUNNERS uses.
const routesText = read('server/routes/admin/testlab.js');
const templateBlock = routesText.slice(routesText.indexOf('const STAGE_TEMPLATE_KEYS = {'));
const templateKeyIds = idsOf(templateBlock.slice(0, templateBlock.indexOf('\n};')), /^  ([a-z_]+):/gm);

// STAGE_TEMPLATE_VARIANTS: the param-dependent stages. Same two-space-indent
// key shape; the map is read for real below (the route file cannot be
// required — it mounts express middleware — so the block is text-parsed).
const variantBlock = routesText.slice(routesText.indexOf('const STAGE_TEMPLATE_VARIANTS = {'));
const variantIds = idsOf(variantBlock.slice(0, variantBlock.indexOf('\n};')), /^  ([a-z_]+): \{/gm);

// Client stages that declare a prompt box: `overridable: true` without
// `noTemplate: true` (freeform instruction box) — each needs a way to prefill.
const clientStageLines = read('client/src/services/testlabService.ts')
  .split('\n')
  .filter(l => /^\s*\{ id: '[a-z_]+'/.test(l));
const needsTemplate = clientStageLines
  .filter(l => l.includes('overridable: true') && !l.includes('noTemplate: true'))
  .map(l => (l.match(/\{ id: '([a-z_]+)'/) as RegExpMatchArray)[1]);
const builtPromptOverrideIds = new Set(
  clientStageLines.filter(l => l.includes('builtPromptOverride: true'))
    .map(l => (l.match(/\{ id: '([a-z_]+)'/) as RegExpMatchArray)[1])
);

// Every template key either map names, for the "does the prompt file still
// exist" check.
// Skips `param: '<name>'` — that names a param, not a template key.
const keysIn = (block: string) => [...block.matchAll(/(?<!param): '([A-Za-z0-9_]+)',/g)].map(m => m[1]);

describe('Test Lab stage ids are the same set in every file that lists them', () => {
  it('found all three lists', () => {
    expect(serverIds.size).toBeGreaterThan(40);
    expect(clientIds.size).toBeGreaterThan(40);
    expect(templateKeyIds.size).toBeGreaterThan(10);
  });

  it('client TESTLAB_STAGES == server STAGES', () => {
    const onlyServer = [...serverIds].filter(id => !clientIds.has(id));
    const onlyClient = [...clientIds].filter(id => !serverIds.has(id));
    expect(onlyServer, 'registered on the server but missing from client TESTLAB_STAGES').toEqual([]);
    expect(onlyClient, 'in client TESTLAB_STAGES but no server runner').toEqual([]);
  });

  it('every STAGE_TEMPLATE_KEYS entry names a registered stage', () => {
    const unknown = [...templateKeyIds].filter(id => !serverIds.has(id));
    expect(unknown, 'STAGE_TEMPLATE_KEYS names a stage no runner registers').toEqual([]);
  });

  it('server STAGES has no duplicate id across the three registries', () => {
    const { STAGES } = require_('../../server/lib/testlab');
    expect(STAGES.length).toBe(new Set(STAGES).size);
  });
});

describe('Every overridable stage can prefill its prompt box', () => {
  it('has a template key, a variants entry, or builtPromptOverride', () => {
    const orphans = needsTemplate.filter(
      id => !templateKeyIds.has(id) && !variantIds.has(id) && !builtPromptOverrideIds.has(id)
    );
    expect(
      orphans,
      'stage(s) marked overridable (and not noTemplate) with no way to prefill the box — each needs ' +
        'a STAGE_TEMPLATE_KEYS entry, a STAGE_TEMPLATE_VARIANTS entry, or builtPromptOverride: true ' +
        'in client TESTLAB_STAGES'
    ).toEqual([]);
  });

  it('every template key both maps name exists in PROMPT_TEMPLATES', async () => {
    const { loadPromptTemplates, PROMPT_TEMPLATES } = require_('../../server/services/prompts');
    await loadPromptTemplates();
    const staticKeys = keysIn(templateBlock.slice(0, templateBlock.indexOf('\n};')));
    const variantKeys = keysIn(variantBlock.slice(0, variantBlock.indexOf('\n};')));
    // story_scorecard derives its options from the EVALUATORS registry.
    const derived = Object.values(
      require_('../../server/lib/storyScorecard').EVALUATOR_PROMPT_KEYS
    ) as string[];
    const missing = [...new Set([...staticKeys, ...variantKeys, ...derived])]
      .filter(k => !PROMPT_TEMPLATES[k]);
    expect(missing, 'template key referenced by the Test Lab prefill maps but absent from PROMPT_TEMPLATES (renamed or deleted prompt file?)').toEqual([]);
  });
});

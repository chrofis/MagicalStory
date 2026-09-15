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

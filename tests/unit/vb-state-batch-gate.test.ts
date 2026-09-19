/**
 * Visual Bible state cells get BOTH gate questions
 * (server/lib/referenceSheets.js → checkStateBatch + the state-batch branch).
 *
 * Regression origin: staging story job_1789147573901_m3uam0nxi. ART001
 * "Levin's Velolampe" — a compact rectangular bicycle lamp with a handlebar
 * bracket — rendered as a broadcast/CCTV camera body in both of its state
 * cells, and the stored gate record was a PASS: "State cells pass: The object
 * is consistent in shape, color, and material, with the only difference being
 * the state of the lamp being off or lit." An entry with `states[]` was asked
 * only whether its cells agreed with each other, never whether it depicted the
 * described object; all five pages holding the reference copied the camera.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const cjs = createRequire(import.meta.url);
const { checkStateBatch, buildReferenceSheetPrompt } = cjs('../../server/lib/referenceSheets.js');
const SRC = readFileSync(new URL('../../server/lib/referenceSheets.js', import.meta.url), 'utf8');

const parent = {
  id: 'ART001',
  name: "Levin's Velolampe",
  type: 'bicycle lamp',
  description: 'A compact rectangular bicycle lamp, black matte plastic casing with a slightly convex circular lens.',
};
const cells = [
  { id: 'ART001.1', stateName: 'off', delta: 'lens dark' },
  { id: 'ART001.2', stateName: 'lit', delta: 'lens glowing' },
];

describe('checkStateBatch — both questions', () => {
  it('asks the identity question as well as the consistency question', async () => {
    const asked: string[] = [];
    const res = await checkStateBatch(['a', 'b'], parent, cells, 'watercolour', {
      checkIdentity: () => { asked.push('identity'); return Promise.resolve({ ok: true, reason: 'is a bicycle lamp' }); },
      checkConsistency: () => { asked.push('consistency'); return Promise.resolve({ ok: true, reason: 'same object' }); },
    });
    expect(asked.sort()).toEqual(['consistency', 'identity']);
    expect(res.ok).toBe(true);
  });

  it('asks identity ONCE, of the first (unaltered) cell, with the parent description', async () => {
    const seen: any[] = [];
    await checkStateBatch(['first-cell', 'second-cell'], parent, cells, 'watercolour', {
      checkIdentity: (cell: string, el: any) => { seen.push([cell, el]); return Promise.resolve({ ok: true, reason: '' }); },
      checkConsistency: () => Promise.resolve({ ok: true, reason: '' }),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe('first-cell');
    expect(seen[0][1].description).toBe(parent.description);
  });

  it('fails the batch when identity fails even though consistency passes (the ART001 case)', async () => {
    const res = await checkStateBatch(['a', 'b'], parent, cells, 'watercolour', {
      checkIdentity: () => Promise.resolve({ ok: false, reason: 'it reads as a broadcast camera, not a bicycle lamp' }),
      checkConsistency: () => Promise.resolve({ ok: true, reason: 'The object is consistent in shape, color, and material.' }),
    });
    expect(res.ok).toBe(false);
    expect(res.identity.ok).toBe(false);
    expect(res.consistency.ok).toBe(true);
    expect(res.reason).toContain('object identity');
    expect(res.reason).toContain('broadcast camera');
  });

  it('a re-render prompt built from that reason carries the identity failure', () => {
    const reason = 'object identity: it reads as a broadcast camera, not a bicycle lamp';
    const prompt = buildReferenceSheetPrompt(cells.map(c => ({ ...parent, ...c })), 'watercolour', null, reason);
    expect(prompt).toContain('PREVIOUS ATTEMPT REJECTED');
    expect(prompt).toContain('broadcast camera');
  });

  it('an errored check stays unchecked rather than failing the batch (fail-open)', async () => {
    const res = await checkStateBatch(['a', 'b'], parent, cells, 'watercolour', {
      checkIdentity: () => Promise.reject(new Error('HTTP 503')),
      checkConsistency: () => Promise.resolve({ ok: true, reason: 'same object' }),
    });
    expect(res.identity).toBeNull();
    expect(res.ok).toBe(true);
  });
});

describe('the state-batch branch wiring', () => {
  it('records each question under its own gate name, so a half-pass is not stored as a pass', () => {
    expect(SRC).toMatch(/pairs = \[\['element_cell', 'identity'\], \['state_cells', 'consistency'\]\]/);
    expect(SRC).toMatch(/record\(batch\[0\], \{\s*gate, ok: v\.ok/);
  });

  it('feeds the failing reason into the single re-render', () => {
    expect(SRC).toMatch(/rerenderSolo\(batch, verdict\.reason\)/);
  });

  it('still ships a batch that fails twice (fail-open preserved)', () => {
    expect(SRC).toMatch(/vb_state_cells_still_bad[\s\S]{0,140}accepted anyway/);
    expect(SRC).toMatch(/vb_element_cell_still_bad|vb_\$\{gateName\}_still_bad/);
  });
});

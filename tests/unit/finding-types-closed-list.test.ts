/**
 * Every type a judge's closed list may emit has its OWN row in TYPE_TO_BUCKET.
 * A type that only resolves through the compound splitter's first token routes
 * by accident (a spelling change drops it to `other`, which repairs by regen).
 * cutout_artifact is deliberately unmapped (zero-point, describes our crop).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { CONSOLIDATED_TYPES, ENTITY_CHECK_TYPES, TYPE_TO_BUCKET } = require_('../../server/lib/evalBuckets.js');

const UNMAPPED_BY_DESIGN = new Set(['cutout_artifact']);

// The semantic judge's closed list: the backticked tokens between "type MUST come
// from this closed list" and "Use ONE type per entry".
function semanticTypes(): string[] {
  const txt = readFileSync('prompts/image-semantic.txt', 'utf8');
  const start = txt.indexOf('MUST come from this closed list');
  const end = txt.indexOf('Use ONE type per entry', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = txt.slice(start, end);
  return [...block.matchAll(/`([a-z_]+)`/g)].map(m => m[1]).filter(t => t !== 'type');
}

describe('judge closed type lists are covered by the bucket table', () => {
  it('CONSOLIDATED_TYPES each have an explicit row', () => {
    const missing = CONSOLIDATED_TYPES.filter((t: string) => !UNMAPPED_BY_DESIGN.has(t) && !(t in TYPE_TO_BUCKET));
    expect(missing).toEqual([]);
  });
  it('ENTITY_CHECK_TYPES each have an explicit row', () => {
    const missing = ENTITY_CHECK_TYPES.filter((t: string) => !UNMAPPED_BY_DESIGN.has(t) && !(t in TYPE_TO_BUCKET));
    expect(missing).toEqual([]);
  });
  it('the semantic prompt closed list is parsed and each type has an explicit row', () => {
    const types = semanticTypes();
    expect(types.length).toBeGreaterThan(15);
    expect(types.filter(t => !(t in TYPE_TO_BUCKET))).toEqual([]);
  });
  it('the semantic prompt no longer emits the unlisted wrong_interaction / spec_conflict types', () => {
    const txt = readFileSync('prompts/image-semantic.txt', 'utf8');
    expect(txt).not.toContain('wrong_interaction');
    expect(txt).not.toContain('spec_conflict');
  });
  it('the semantic prompt rates the same defect one severity (SEVERITIES list wins)', () => {
    const txt = readFileSync('prompts/image-semantic.txt', 'utf8');
    expect(txt).toMatch(/Correct main action\?[^\n]*\*\*\[MAJOR\]\*\*/);
    expect(txt).toMatch(/Correct setting\/location\?[^\n]*\*\*\[MAJOR\]\*\*/);
    expect(txt).toMatch(/clothing category\?[^\n]*\*\*\[MODERATE\]\*\*/);
    expect(txt).toMatch(/flag as `action_interaction` — \*\*\[CRITICAL\]\*\*/);
  });
});

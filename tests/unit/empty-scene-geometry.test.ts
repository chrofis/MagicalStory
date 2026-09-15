import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// BEHAVIOUR PINNED: the plate generator is handed the SAME three composition
// facts validateEmptyScene grades it on (path/perspective direction, vanishing
// point / opening, lighting direction) — and nothing else from the scene prose.
// Pinned on the BUILT prompt via the real builder, never on template text.

const SCENE = [
  'Mira runs along the quay while Tomas waves from the deck of the Seebär.',
  'The cobbled quay runs diagonally from the lower-left foreground to the upper-right background.',
  'Late afternoon sunlight comes from the left, so every shadow falls to the right.',
  'The harbour mouth opens as a bright gap at the far-right of the horizon.',
  'Two soldiers laugh beside a stack of crates as the gull dives.',
].join(' ');

const CAST = ['Mira', 'Tomas'];

beforeAll(async () => {
  await require_('../../server/services/prompts.js').loadPromptTemplates();
});

function build(opts: any = {}) {
  const { buildEmptyScenePrompt } = require_('../../server/services/prompts.js');
  return buildEmptyScenePrompt({
    style: 'watercolour',
    description: '**SHOT:** wide\n\nAn empty stone quay beside the harbour.',
    mainScenePrompt: SCENE,
    castNames: CAST,
    ...opts,
  });
}

describe('empty-scene plate prompt carries the geometry it is graded on', () => {
  it('forwards path direction, opening position and light direction', () => {
    const p = build();
    expect(p).toContain('SCENE GEOMETRY');
    expect(p).toContain('diagonally from the lower-left foreground to the upper-right background');
    expect(p).toContain('sunlight comes from the left');
    expect(p).toContain('bright gap at the far-right of the horizon');
  });

  it('forwards no cast, no action and no props from the scene prose', () => {
    const p = build();
    for (const name of [...CAST, 'Seebär', 'soldiers', 'crates', 'gull']) {
      expect(p).not.toContain(name);
    }
  });

  it('a scene that is nothing but characters yields no geometry block and still demands an empty plate', () => {
    const p = build({
      mainScenePrompt: 'Mira hugs Tomas. The two soldiers cheer and the dog leaps between them. She laughs.',
    });
    expect(p).not.toContain('SCENE GEOMETRY');
    expect(p).not.toContain('Mira');
    expect(p).not.toContain('Tomas');
    expect(p).not.toContain('soldiers');
    expect(p).toMatch(/background environment/i);
    expect(p).toMatch(/do not add people, crowds, or figures/i);
  });

  it('every built plate prompt keeps the people-free rule and leaves no placeholder behind', () => {
    for (const p of [build(), build({ mainScenePrompt: null })]) {
      expect(p).toMatch(/none of them appear here/i);
      expect(p).not.toContain('{SCENE_GEOMETRY}');
      expect(p).not.toContain('{EMPTY_SCENE_DESCRIPTION}');
    }
  });

  it('the extractor drops a geometry sentence that also names a figure', () => {
    const { extractSceneGeometry } = require_('../../server/lib/sceneGeometry.js');
    const out = extractSceneGeometry({
      mainScenePrompt: 'The path climbs to the upper-right, where a guard stands in the lamplight.',
      castNames: [],
    });
    expect(out).toBe('');
  });
});

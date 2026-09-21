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

function geom() {
  return require_('../../server/lib/sceneGeometry.js');
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
});

describe('lighting reaches the author (owner priority)', () => {
  it('survives when the prose opens with three perspective sentences', () => {
    const p = build({
      mainScenePrompt: [
        'The road runs diagonally to the upper-right.',
        'The riverbank stretches toward the far horizon.',
        'A stair climbs the slope on the left.',
        'The lane recedes past the mill.',
        'Low dawn light comes from the right and throws long shadows to the left.',
      ].join(' '),
      castNames: [],
    });
    expect(p).toContain('dawn light comes from the right');
  });

  it('is salvaged from a sentence that also names a character', () => {
    const out = geom().extractSceneGeometry({
      mainScenePrompt: 'Lamplight falls from the upper-left, while Mira leans on the rail.',
      castNames: ['Mira'],
    });
    expect(out).toContain('Lamplight falls from the upper-left');
    expect(out).not.toContain('Mira');
    expect(out).not.toMatch(/\brail\b.*Mira/);
  });

  it('drops a geometry sentence whose only content is a figure clause', () => {
    const out = geom().extractSceneGeometry({
      mainScenePrompt: 'A guard stands in the lamplight.',
      castNames: [],
    });
    expect(out).toBe('');
  });

  it('the salvaged line never smuggles a person word through', () => {
    const out = geom().extractSceneGeometry({
      mainScenePrompt: 'The path climbs to the upper-right, where a guard stands in the lamplight holding a torch.',
      castNames: [],
    });
    expect(out).toContain('The path climbs to the upper-right');
    expect(out).not.toMatch(/\bguard\b/i);
  });
});

describe('stored scene prose shapes', () => {
  // Real pages store the brief prose with an Art Director METADATA tail and
  // bracketed Visual Bible ids; both name the cast and neither may reach a plate.
  const STORED = [
    'A wide view from the wet quay beside the large sailing ship.',
    'The heavy mooring rope lies taut [ART003.2] from the iron bollard in the lower foreground up to the ship’s railing.',
    'Cool morning light falls from the left across the cobblestones.',
    '---METADATA--- {"sceneIntent": "Emma refuses to board.", "emptyScenePrompt": "Preview: Emma grips the rail."}',
  ].join(' ');

  it('cuts the metadata tail and the VB ids, keeps the geometry', () => {
    const p = build({ mainScenePrompt: STORED, castNames: ['Emma'] });
    expect(p).toContain('Cool morning light falls from the left');
    expect(p).toContain('A wide view from the wet quay');
    expect(p).not.toContain('METADATA');
    expect(p).not.toContain('sceneIntent');
    expect(p).not.toContain('ART003.2');
    expect(p).not.toContain('Emma');
  });

  it('keeps a lighting clause that shares its sentence with the crowd', () => {
    const out = geom().extractSceneGeometry({
      mainScenePrompt: "The stretch of stone stands open between the bollard and the distant crowd, its wet cobbles gleaming under the cool gloomy light.",
      castNames: [],
    });
    expect(out).toContain('cool gloomy light');
    expect(out).not.toMatch(/\bcrowd\b/i);
  });
});

describe('author and judge describe the same three dimensions', () => {
  it('one shared constant writes both sides', () => {
    const { GEOMETRY_DIMENSIONS, buildGeometryJudgeChecks } = geom();
    expect(GEOMETRY_DIMENSIONS.map((d: any) => d.key)).toEqual(['path', 'opening', 'lighting']);
    const judge = buildGeometryJudgeChecks(5, ['path', 'opening', 'lighting']);
    const author = build();
    for (const d of GEOMETRY_DIMENSIONS) {
      const dimension = d.author.split('—')[0].trim();   // e.g. "Lighting direction"
      expect(author).toContain(dimension);
      expect(judge).toContain(dimension);
      expect(judge).toContain(d.judge);
    }
    expect(judge).toMatch(/^\n5\. Composition geometry/);
  });

  it('the judge asks about nothing the author was not told', () => {
    const { GEOMETRY_DIMENSIONS, buildGeometryJudgeChecks } = geom();
    const letters = buildGeometryJudgeChecks(5, ['path', 'opening', 'lighting']).match(/^ {3}[a-j]\. /gm) || [];
    expect(letters.length).toBe(GEOMETRY_DIMENSIONS.length);
  });
});

describe('only the dimensions the prose actually states reach either side', () => {
  // BEHAVIOUR PINNED 2026-09-21: every author line ends "named above", so a
  // line for a dimension no fact was found for orders the plate to match a
  // direction, a vanishing point or a light source the prompt never names.
  // Measured on a stored 18-page story: all three lines on every page.
  it('a lighting-only scene gets the lighting author line and no other', () => {
    const p = build({ mainScenePrompt: 'Warm afternoon light falls from the left across the empty square.', castNames: [] });
    expect(p).toContain('Lighting direction');
    expect(p).not.toContain('Path / perspective direction');
    expect(p).not.toContain('Vanishing point / opening position');
  });

  it('the judge asks exactly the dimensions the author was handed', () => {
    const { selectGeometryFacts, buildGeometryJudgeChecks } = geom();
    const prose = 'Warm afternoon light falls from the left across the empty square.';
    const { dims } = selectGeometryFacts({ mainScenePrompt: prose, castNames: [] });
    expect(dims).toEqual(['lighting']);
    const judge = buildGeometryJudgeChecks(5, dims);
    expect(judge).toContain('Lighting direction');
    expect(judge).not.toContain('Path / perspective direction');
    expect(judge).not.toContain('Vanishing point / opening position');
  });

  it('no dimension found means no author block and no judge block', () => {
    const { selectGeometryFacts, buildGeometryJudgeChecks } = geom();
    const prose = 'Mira hugs Tomas and the dog leaps between them.';
    const { dims } = selectGeometryFacts({ mainScenePrompt: prose, castNames: [] });
    expect(dims).toEqual([]);
    expect(buildGeometryJudgeChecks(5, dims)).toBe('');
  });

  it('dims[] is required — the judge may never be built blind', () => {
    const { buildGeometryJudgeChecks } = geom();
    expect(() => buildGeometryJudgeChecks(5)).toThrow(/dims/);
  });
});

describe('a garment clause is never geometry', () => {
  // BEHAVIOUR PINNED 2026-09-21: "a light grey shirt" hits the lighting word
  // list and names no person, so a costume clause reached an EMPTY plate.
  it('drops a wardrobe sentence whose only geometry word is a colour', () => {
    const out = geom().extractSceneGeometry({ mainScenePrompt: 'Wearing a yellow quilted gilet over a light grey shirt.', castNames: [] });
    expect(out).toBe('');
  });

  it('keeps the geometry clause and drops the garment clause from one sentence', () => {
    const out = geom().extractSceneGeometry({ mainScenePrompt: 'The steps descend steeply to the lower-left, and she is wearing a yellow gilet.', castNames: [] });
    expect(out).toContain('lower-left');
    expect(out).not.toMatch(/gilet|wearing/i);
  });

  it('a place word that merely contains a garment word survives', () => {
    const out = geom().extractSceneGeometry({ mainScenePrompt: 'The road runs to the upper-right through the neighbourhood.', castNames: [] });
    expect(out).toContain('upper-right');
  });
});

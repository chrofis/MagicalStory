import { describe, it, expect } from 'vitest';

const {
  splitBrief, parseProseMetadataFormat, stripSceneMetadata, extractSceneMetadata, findCastMissingFromMetadata,
} = require('../../server/lib/sceneMetadata');

// Page 7 of production job_1790107559778_fcmlfa8kn as the scene review
// returned it (stories.data.sceneReviewReport.pages[].after), shortened: prose,
// then the metadata in a trailing fenced block instead of after ---METADATA---.
// Before the fix stripSceneMetadata turned this into the single word "Objects:".
const PROSE_7 = 'The massive tower dominates the ultra-wide frame against the darkening twilight sky. '
  + 'Below its metal legs the steep forest path threads downward between dark trunks, crossed with exposed roots.';
const META_7 = {
  sceneIntent: 'The tower stands against a darkening sky above an empty, shadowed woodland stair.',
  characters: [], shot: 'ultra-wide', population: 'cast_only', landmarkView: 'close',
  era: 'present day', objects: ['LOC003.1'], interactions: [], wornItems: [],
};
const FENCED_7 = `${PROSE_7}\n\n\`\`\`json\n${JSON.stringify(META_7, null, 2)}\n\`\`\``;

// Page 3 shape: a cast page, where the old path emitted "- Manuel:, center midground, ...".
const PROSE_3 = 'Manuel — a young teen boy in a green robe — lifts his eyes from the screen toward the empty chair in the dim workshop.';
const META_3 = {
  sceneIntent: 'The boy looks up from the screen toward the chair.',
  characters: [{ name: 'Manuel', position: 'center midground', expression: 'eyes lifted' }],
  objects: [], interactions: [], wornItems: [],
};
const brief = (prose: string, meta: object, carrier: 'delimiter' | 'fence' | 'bare') => {
  const json = JSON.stringify(meta, null, 2);
  if (carrier === 'delimiter') return `${prose}\n\n---METADATA---\n${json}`;
  if (carrier === 'fence') return `${prose}\n\n\`\`\`json\n${json}\n\`\`\``;
  return `${prose}\n\n${json}`;
};

describe('splitBrief — the one prose/metadata split', () => {
  it.each(['delimiter', 'fence', 'bare'] as const)('recognises the %s carrier', (carrier) => {
    const sp = splitBrief(brief(PROSE_3, META_3, carrier));
    expect(sp.carrier).toBe(carrier);
    expect(sp.prose).toBe(PROSE_3);
    expect(JSON.parse(sp.metadataText)).toEqual(META_3);
    expect(sp.metadataStart).toBeGreaterThan(PROSE_3.length - 1);
  });

  it('prose alone has no carrier and keeps the whole text as prose', () => {
    expect(splitBrief(PROSE_3)).toMatchObject({ carrier: null, prose: PROSE_3, metadataText: '', metadataStart: -1 });
  });

  it('a fenced block that does not end the text is not a carrier', () => {
    const text = `${PROSE_3}\n\n\`\`\`json\n${JSON.stringify(META_3)}\n\`\`\`\n\n6. **Image Summary (Deutsch)**\nEin Junge ...`;
    expect(splitBrief(text).carrier).toBe(null);
  });
});

describe('the reviewed-brief shape keeps its prose (job_1790107559778_fcmlfa8kn)', () => {
  it('stripSceneMetadata returns the prose of a fenced brief, never a JSON rebuild', () => {
    const out = stripSceneMetadata(FENCED_7);
    expect(out).toBe(PROSE_7);
    expect(out).not.toMatch(/^Objects:/);
  });

  it.each(['delimiter', 'fence', 'bare'] as const)('the %s carrier strips to the same prose', (carrier) => {
    expect(stripSceneMetadata(brief(PROSE_3, META_3, carrier))).toBe(PROSE_3);
  });

  it('parseProseMetadataFormat reads the fenced carrier as prose + metadata', () => {
    const parsed = parseProseMetadataFormat(FENCED_7);
    expect(parsed).not.toBeNull();
    expect(parsed.prose).toBe(PROSE_7);
    expect(parsed.metadata.sceneIntent).toBe(META_7.sceneIntent);
  });

  it('extractSceneMetadata reads the same fields from every carrier', () => {
    const byCarrier = (['delimiter', 'fence', 'bare'] as const).map(c => extractSceneMetadata(brief(PROSE_3, META_3, c)));
    for (const m of byCarrier) {
      expect(m.characters).toEqual(['Manuel']);
      expect(m.characterPositions).toEqual({ Manuel: 'center midground' });
      expect(m.sceneIntent).toBe(META_3.sceneIntent);
      expect(m.imageSummary).toBe(PROSE_3);
    }
  });

  it('findCastMissingFromMetadata reads the prose of a fenced brief, not its JSON', () => {
    // "Lena" only appears inside the JSON; the prose does not stage her.
    const meta = { ...META_3, characters: [], note: 'Lena' };
    expect(findCastMissingFromMetadata(brief(PROSE_3, meta, 'fence'), ['Manuel', 'Lena'])).toEqual(['Manuel']);
  });
});

describe('prose is never silently rebuilt from JSON', () => {
  it('a bare JSON brief still converts through the JSON path', () => {
    const out = stripSceneMetadata(JSON.stringify({ imageSummary: 'A quiet meadow at dawn.', characters: [] }));
    expect(out).toContain('A quiet meadow at dawn.');
  });

  it('prose plus a JSON object in no recognised carrier throws instead of discarding the prose', () => {
    // A fenced metadata block followed by another trailing section — the shape
    // no carrier recognises.
    const text = `${PROSE_3}\n\n\`\`\`json\n${JSON.stringify(META_3)}\n\`\`\`\n\n---VISUAL BIBLE---\n\`\`\`json\n{"artifacts": []}\n\`\`\``;
    expect(() => stripSceneMetadata(text)).toThrow(/refusing to rebuild it from the JSON alone/);
  });
});

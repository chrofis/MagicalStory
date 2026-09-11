/**
 * The ART DIRECTOR authors the Visual Bible (owner, 2026-09-11).
 *
 * The all-pages scene-expansion call now emits `---VISUAL BIBLE---` and
 * `---COVER SCENE HINTS---` BEFORE page 1's heading, then the page briefs, so a
 * page's `objects[]` can only cite an id the same response already declared.
 * Before this the bible was written one stage earlier and had to guess page
 * assignment from plan-line prose: on job_1789147573901_m3uam0nxi that guess
 * left the story's central prop and the lettered signpost page 10 asks for at
 * `appearsInPages: []`, so neither got a reference cell.
 *
 * What this locks down is the PARSE path — both halves out of one response,
 * and a partial bible detected rather than shipped.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractBibleSections, AD_BIBLE_MARKERS, CLOTHING_MARKERS } = require('../../server/lib/beatsPipeline.js');
const { UnifiedStoryParser } = require('../../server/lib/outlineParser/unified.js');
const { parseRefinedText } = require('../../server/lib/promptBuilders.js');

const VB = {
  secondaryCharacters: [
    { id: 'CHR001', name: 'the keeper', pages: [2], age: 40, build: 'a man, broad-shouldered', hair: 'grey, cropped', face: 'brown eyes, full beard', clothing: 'a brown wool coat' },
  ],
  animals: [],
  artifacts: [
    { id: 'ART001', name: 'the signpost', pages: [3], type: 'wooden signpost', text: 'THIS WAY', description: 'a weathered oak board on a post' },
  ],
  locations: [
    { id: 'LOC001', name: 'the square', pages: [1, 2, 3], setting: 'outdoor, cobbled square', isRealLandmark: false, landmarkQuery: null },
  ],
  vehicles: [],
  clothing: [],
};

const bibleBlock = (vb: unknown) => [
  '---VISUAL BIBLE---',
  '```json',
  JSON.stringify(vb, null, 2),
  '```',
  '',
  '---COVER SCENE HINTS---',
  '**Title Page**',
  'Mood: quiet and curious',
  'Objects: LOC001, ART001',
  'Characters:',
  '- Mia (centre): standard, holds: ART001, priority: essential',
  '',
].join('\n');

const pageBlock = (n: number, objects: string[]) => [
  `## Page ${n}`,
  `The main character crosses the cobbled square in flat morning light.`,
  '',
  '---METADATA---',
  JSON.stringify({ sceneIntent: 'x', characters: [], shot: 'wide', objects, emptyScenePrompt: 'the square, empty' }),
  '',
].join('\n');

const fullResponse = bibleBlock(VB) + [1, 2, 3].map(n => pageBlock(n, n === 3 ? ['LOC001', 'ART001'] : ['LOC001'])).join('\n');

describe('an AD response carrying a bible plus pages parses both halves', () => {
  it('takes the two leading sections and stops at page 1s heading', () => {
    const sections = extractBibleSections(fullResponse, AD_BIBLE_MARKERS);
    expect(sections).toBeTruthy();
    expect(sections.found).toEqual(['---VISUAL BIBLE---', '---COVER SCENE HINTS---']);
    // The page briefs must NOT bleed into the cover-hints section — the
    // cover-hints regex is terminated by the next ---SECTION---, and a page
    // heading is not one, so an uncut body would swallow the whole story.
    expect(sections.body).not.toContain('## Page 1');
    expect(sections.body).not.toContain('cobbled square in flat morning light');
  });

  it('parses the Visual Bible and the cover hints out of that body', () => {
    const body = extractBibleSections(fullResponse, AD_BIBLE_MARKERS).body;
    const parser = new UnifiedStoryParser(body);
    const vb = parser.extractVisualBible();
    expect(vb.artifacts[0].id).toBe('ART001');
    expect(vb.artifacts[0].appearsInPages).toEqual([3]);
    expect(parser.extractCoverHints()).toBeTruthy();
  });

  it('parses every page brief out of the same response', () => {
    const parsed = parseRefinedText(fullResponse, [1, 2, 3], 'SCENES');
    expect(parsed.pages.map((p: any) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(parsed.missing).toEqual([]);
    // The bible must not have been swept into page 1's prose.
    expect(parsed.pages[0].text).not.toContain('secondaryCharacters');
  });

  it('every id a page cites exists in the bible the same response declared', () => {
    const vb = new UnifiedStoryParser(extractBibleSections(fullResponse, AD_BIBLE_MARKERS).body).extractVisualBible();
    const declared = new Set(
      Object.values(vb)
        .filter(Array.isArray)
        .flat()
        .map((e: any) => String(e.id).toUpperCase())
    );
    const parsed = parseRefinedText(fullResponse, [1, 2, 3], 'SCENES');
    for (const page of parsed.pages) {
      const meta = JSON.parse(page.text.split('---METADATA---')[1].trim());
      for (const id of meta.objects) expect(declared.has(id)).toBe(true);
    }
  });
});

describe('an incomplete AD response is detected, never half-shipped', () => {
  it('a response with pages but no bible section yields null', () => {
    const noBible = [1, 2, 3].map(n => pageBlock(n, ['LOC001'])).join('\n');
    expect(extractBibleSections(noBible, AD_BIBLE_MARKERS)).toBeNull();
    expect(parseRefinedText(noBible, [1, 2, 3], 'SCENES').pages).toHaveLength(3);
  });

  it('a reply cut mid-JSON gives NO bible rather than a partial one', () => {
    // The truncation signature: the marker and the fence opened, the JSON never
    // closed, no page heading ever reached. JSON.parse is the completeness test.
    const cut = bibleBlock(VB).slice(0, bibleBlock(VB).indexOf('"artifacts"'));
    const sections = extractBibleSections(cut, AD_BIBLE_MARKERS);
    expect(sections).toBeTruthy();           // the marker is there
    expect(new UnifiedStoryParser(sections.body).extractVisualBible()).toBeNull();  // …but nothing usable
  });

  it('a response truncated after page 2 loses the page, never the bible', () => {
    const cut = bibleBlock(VB) + pageBlock(1, ['LOC001']) + pageBlock(2, ['LOC001']).slice(0, 30);
    const vb = new UnifiedStoryParser(extractBibleSections(cut, AD_BIBLE_MARKERS).body).extractVisualBible();
    expect(vb.locations[0].id).toBe('LOC001');
    expect(parseRefinedText(cut, [1, 2, 3], 'SCENES').missing).toEqual([3]);
  });
});

describe('the wardrobe half is extracted with its own marker set', () => {
  it('reads CLOTHING REQUIREMENTS and nothing else', () => {
    const wardrobe = [
      '---CLOTHING REQUIREMENTS---',
      '```json',
      JSON.stringify({ clothingRequirements: { Mia: { standard: { used: true, description: 'a red coat' } } } }),
      '```',
      '',
    ].join('\n');
    const sections = extractBibleSections(wardrobe, CLOTHING_MARKERS);
    expect(sections.found).toEqual(['---CLOTHING REQUIREMENTS---']);
    expect(new UnifiedStoryParser(sections.body).extractClothingRequirements().Mia.standard.used).toBe(true);
  });

  it('concatenating the two halves rebuilds the transcript every reader re-parses', () => {
    const wardrobe = '---CLOTHING REQUIREMENTS---\n```json\n' +
      JSON.stringify({ clothingRequirements: { Mia: { standard: { used: true, description: 'a red coat' } } } }) + '\n```\n';
    const transcript = `${wardrobe.trimEnd()}\n\n${extractBibleSections(fullResponse, AD_BIBLE_MARKERS).body}`;
    const parser = new UnifiedStoryParser(transcript);
    expect(parser.extractClothingRequirements().Mia.standard.description).toBe('a red coat');
    expect(parser.extractVisualBible().artifacts[0].id).toBe('ART001');
    expect(parser.extractCoverHints()).toBeTruthy();
  });
});

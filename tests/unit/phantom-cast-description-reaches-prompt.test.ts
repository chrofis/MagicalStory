import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';

// Staging trial job_1791390810945_7yp1e0rh3 p6 (2026-10-07). "Mama" is on the
// page — the brief lists her with position, action, expression, and she holds
// the page's essential object — but the writer never declared her in the
// Visual Bible, so the phantom patch invented CHR003 for her. The patch model
// answers in the bible's FIELD shape (age/build/hair/face/signatureLook/
// clothing) and the patch pushed the entry as-is, WITHOUT the composed
// `description` string the parser gives every writer-declared entry. The
// page-side reader (collectSecondaryCastForPage) emits only entries that have
// one, and skipped her silently: the built prompt's CAST WITHOUT A REFERENCE
// IMAGE block named only CHR001 "Frau Carter", and the image model drew Mama as
// a second Frau Carter.
//
// Two fixtures are the run's own stored data, verbatim: the bible as the
// writer declared it (CHR001, CHR002), the patch model's answer for Mama
// (CHR003's stored fields), and page 6's brief. The model call is replaced by
// that stored answer — no network.
//
// The same page also had every cast line read "- Noah:, left, …" — the name
// sat inside the comma list. Pinned here on the same stored brief.

// The patch model's stored answer for Mama (CHR003's fields as the run stored
// them). The call is stubbed on the textModels module object — the server
// modules are plain CJS, which vi.mock does not reach.
const STORED_PATCH_ANSWER = [
  {
    phantom: 'Mama',
    name: 'Mama',
    age: 'a woman in her late thirties',
    build: 'medium height, softly rounded frame',
    hair: 'dark brown, shoulder-length, loosely wavy with a few strands escaping a low bun',
    face: 'warm hazel eyes, fair skin with light freckles across the nose, gentle smile lines',
    signatureLook: 'a faded blue gingham apron tied over her dress with a small daisy tucked behind one ear',
    clothing: 'cotton tea-length dress in muted sage green, white ankle socks, and brown lace-up Mary Janes',
  },
];

const req = createRequire(import.meta.url);
const textModels = req('../../server/lib/textModels');
const { detectAndPatchPhantomCharacters } = req('../../server/lib/phantomCharacters');
const { buildImagePrompt } = req('../../server/lib/promptBuilders');
const { buildTextFromJson } = req('../../server/lib/sceneMetadata');

let patchCall: any;
beforeAll(async () => {
  await req('../../server/services/prompts').loadPromptTemplates();
  patchCall = vi.spyOn(textModels, 'callClaudeAPI').mockResolvedValue({
    text: JSON.stringify(STORED_PATCH_ANSWER), usage: { input_tokens: 436, output_tokens: 152 }, modelId: 'qwen-plus',
  });
});
afterAll(() => { patchCall.mockRestore(); });

// The bible as the writer declared it — CHR001 and CHR002 carry the parser's
// composed `description`; Mama is not in it.
const FRAU_CARTER = {
  id: 'CHR001', name: 'Frau Carter', age: 'a woman in her forties',
  face: 'brown eyes, laugh lines at the corners, friendly closed mouth', hair: 'dark brown, tied in a low bun',
  build: 'medium height, sturdy and calm', pages: [1, 5, 6], appearsInPages: [1, 5, 6],
  clothing: 'mustard-yellow cardigan over a cream blouse, dark trousers, flat brown shoes', scaleClass: 'adult-height',
  signatureLook: 'a long red scarf with fringe',
  description: 'a woman in her forties. medium height, sturdy and calm. hair: dark brown, tied in a low bun. brown eyes, laugh lines at the corners, friendly closed mouth. Signature: a long red scarf with fringe. Clothing: mustard-yellow cardigan over a cream blouse, dark trousers, flat brown shoes',
};
const LILY = {
  id: 'CHR002', name: 'Lily', age: 'a girl of about five', face: 'brown eyes, round cheeks, a wide smile',
  hair: 'dark brown curls tied in two bunches with orange bands', build: 'small, sturdy, quick-moving',
  pages: [4, 5, 6], appearsInPages: [4, 5, 6], clothing: 'orange sweater, blue leggings, small green boots', scaleClass: 'waist-high',
  signatureLook: 'two orange hair bands on curly bunches',
  description: 'a girl of about five. small, sturdy, quick-moving. hair: dark brown curls tied in two bunches with orange bands. brown eyes, round cheeks, a wide smile. Signature: two orange hair bands on curly bunches. Clothing: orange sweater, blue leggings, small green boots',
};
const freshBible = () => ({
  mainCharacters: [], secondaryCharacters: [FRAU_CARTER, LILY], animals: [], artifacts: [
    { id: 'ART001', name: 'concrete play pipe', description: 'a grey concrete pipe', pages: [6] },
    { id: 'ART002', name: 'red car painting', description: 'a child\'s painting of a red car', pages: [6] },
  ], locations: [], backgrounds: [], genericObjects: [],
});

const NOAH = { id: 1791390792711, name: 'Noah', age: '4', gender: 'male', physical: { apparentAge: 'kindergartner', hairColor: 'light brown', eyeColor: 'blue', skinTone: 'fair' } };

// Page 6's brief, as stored in sceneImages[5].sceneDescription.
const PAGE6_BRIEF = JSON.stringify({ scene: {
  imageSummary: 'In the classroom corner Noah stands at the concrete pipe mouth and calls into it, his face turned toward the opening. Mama stands close behind him holding the red car painting, and Frau Carter waits by the open yard door. Warm midday light fills the room.',
  setting: { location: 'Kindergarten classroom [LOC002]', indoorOutdoor: 'indoor', description: 'Play corner with a mat, low shelves and the grey concrete pipe against the wall. The wooden yard door stands open at the side, showing autumn leaves outside.', lighting: 'Warm midday light from the open door on the right', camera: 'medium', depthLayers: 'Foreground: Noah at the pipe mouth and Mama beside him. Midground: the pipe and mat. Background: Frau Carter at the open door.' },
  timeOfDay: 'midday', weather: 'none',
  characters: [
    { id: null, name: 'Noah', position: 'left', action: 'stands at the pipe mouth and calls into the opening', expression: 'cheerful, mouth open mid-call', clothing: 'standard', depth: 'foreground', perspective: 'side' },
    { id: null, name: 'Mama', description: 'a woman in her thirties, medium build, shoulder-length light brown hair, kind face, wearing a green jacket and jeans', position: 'center', action: 'stands behind Noah holding the red car painting in both hands, looking at him', expression: 'soft smile', clothing: 'standard', depth: 'foreground', perspective: 'front' },
    { id: 'CHR001', name: 'Frau Carter', position: 'right', action: 'stands beside the open door, watching', expression: 'calm and friendly', clothing: 'standard', depth: 'midground', perspective: 'front' },
  ],
  objects: [
    { id: 'ART001', name: 'concrete play pipe', position: 'left-center, against the wall, mouth facing the room' },
    { id: 'ART002', name: 'red car painting', position: 'held by Mama' },
  ],
  interactions: [{ character: 'Mama', object: 'red car painting', where: 'holds the painting in both hands', priority: 'essential' }],
  background: 'classroom shelves and the open yard door', population: 'cast_only',
} });

// What the parser hands the phantom detector: the pages' characterClothing.
const storyPages = [
  { pageNumber: 6, text: 'Mama kam mit dem Bild in der Hand.', characterClothing: { Noah: 'standard', Mama: 'standard', 'Frau Carter': 'standard' } },
];

const castBlock = (prompt: string) => {
  const i = prompt.indexOf('CAST WITHOUT A REFERENCE IMAGE');
  expect(i).toBeGreaterThan(-1);
  return prompt.slice(i).split('\n\n')[0];
};

const buildPage6 = (visualBible: any) => buildImagePrompt(
  PAGE6_BRIEF,
  { characters: [NOAH], artStyle: 'watercolor', language: 'de', languageLevel: 'standard' },
  [NOAH], visualBible, 6, [{ name: 'Noah', clothingDescription: null }],
  { skipVisualBible: true, vbRefElementIds: ['ART001', 'ART002'] },
);

describe('a phantom-patched bible entry reaches the page prompt (staging job_1791390810945_7yp1e0rh3 p6)', () => {
  it('the patch composes the description every other producer gives an entry', async () => {
    const visualBible = freshBible();
    await detectAndPatchPhantomCharacters({ storyPages, visualBible, inputCharacters: [NOAH], modelId: 'qwen-plus' });
    const mama = visualBible.secondaryCharacters.find((e: any) => e.name === 'Mama');
    expect(mama).toBeTruthy();
    expect(mama.id).toBe('CHR003');
    expect(mama.pages).toEqual([6]);
    expect(mama.description).toMatch(/^a woman in her late thirties\. medium height, softly rounded frame\./);
    expect(mama.description).toContain('Signature: a faded blue gingham apron');
    expect(mama.description).toContain('Clothing: cotton tea-length dress in muted sage green');
  });

  it('page 6 then describes Mama beside Frau Carter in CAST WITHOUT A REFERENCE IMAGE', async () => {
    const visualBible = freshBible();
    await detectAndPatchPhantomCharacters({ storyPages, visualBible, inputCharacters: [NOAH], modelId: 'qwen-plus' });
    const block = castBlock(buildPage6(visualBible));
    expect(block).toContain('- Frau Carter: a woman in her forties.');
    expect(block).toContain('- Mama: a woman in her late thirties. medium height, softly rounded frame.');
    expect(block).toContain('cotton tea-length dress in muted sage green');
    // The commissioned child has a reference image; never doubled here.
    expect(block).not.toContain('- Noah:');
  });

  it('the stored bible (CHR003 without a description) still cannot describe her — the gap is reported, not hidden', () => {
    // The run's bible as it was stored: every field but `description`.
    const { phantom, ...storedFields } = STORED_PATCH_ANSWER[0];
    const visualBible = freshBible();
    visualBible.secondaryCharacters.push({ id: 'CHR003', pages: [6], ...storedFields });
    const errors: string[] = [];
    const { log } = req('../../server/utils/logger');
    const spy = vi.spyOn(log, 'error').mockImplementation((msg: string) => { errors.push(String(msg)); });
    try {
      const block = castBlock(buildPage6(visualBible));
      expect(block).not.toContain('- Mama:');
      expect(errors.some(m => /Page 6: bible entry CHR003 "Mama" is in this page's cast but has no description/.test(m))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the brief\'s cast lines (buildTextFromJson)', () => {
  it('read "- Name: position, action, expression" — the name is the label, not the first list item', () => {
    const lines = buildTextFromJson(JSON.parse(PAGE6_BRIEF).scene).split('\n');
    expect(lines).toContain('- Noah: left, stands at the pipe mouth and calls into the opening, cheerful, mouth open mid-call');
    expect(lines).toContain('- Mama: center, stands behind Noah holding the red car painting in both hands, looking at him, soft smile');
    expect(lines.some(l => /^- [^:]+:,/.test(l))).toBe(false);
  });

  it('a character with nothing but a name still gets a clean line', () => {
    const lines = buildTextFromJson({ characters: [{ name: 'Noah' }] }).split('\n');
    expect(lines).toContain('- Noah:');
    expect(buildPage6(freshBible())).not.toMatch(/^- [^:\n]+:,/m);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';

// bugs.json phantom-patch-after-main-cast-filter. Production job_1794498448758_ryuv0q8lb
// (and two siblings of one customer): the phantom patch wrote invented copies of the
// main-cast children "Noah" and "Tobias" into visualBible.secondaryCharacters, and the
// main-cast filter that runs BEFORE the patch could not remove them. The guard lives in
// the patch itself: a name the resolver maps to a cast member is never patched, and a
// name the resolver finds AMBIGUOUS is refused (log.error), never turned into a new person.
const req = createRequire(import.meta.url);
const textModels = req('../../server/lib/textModels');
const { detectAndPatchPhantomCharacters, findPhantomNames, classifyUnknownNames } = req('../../server/lib/phantomCharacters');

// The roster exactly as the customer's wizard stored it (name field carries relationship text).
const ROSTER = [
  { name: 'Noah, Freund von Louis und Tobias, Bruder von Tilo' },
  { name: 'Louis, Freund von Noah' },
  { name: 'Tobias, Freund von Noah' },
  { name: 'Tilo, jüngerer Bruder von Noah' },
];
const page = (names: string[], n = 1) => ({
  pageNumber: n, text: 'x', characterClothing: Object.fromEntries(names.map(k => [k, 'casual'])),
});

afterEach(() => vi.restoreAllMocks());

describe('phantom patch never invents main-cast people', () => {
  it('cast names written bare or with the relationship text are not phantoms', () => {
    const pages = [page(['Noah', 'Tobias', 'Tobias, Freund von Noah', 'Louis', 'Tilo'])];
    expect(findPhantomNames(pages, { secondaryCharacters: [] }, ROSTER)).toEqual([]);
  });

  it('an ambiguous name is not sent to the patch; a genuinely unknown one still is', () => {
    const roster = [{ name: 'Anna Schmid' }, { name: 'Anna Meier' }];
    const c = classifyUnknownNames([page(['Anna', 'Oma Frieda'])], { secondaryCharacters: [] }, roster);
    expect(c.phantoms).toEqual(['Oma Frieda']);
    expect(c.ambiguous.map((a: any) => a.name)).toEqual(['Anna']);
    expect(c.ambiguous[0].candidates.sort()).toEqual(['Anna Meier', 'Anna Schmid']);
  });

  it('detectAndPatch makes no model call and adds nothing for an ambiguous cast reference', async () => {
    const call = vi.spyOn(textModels, 'callClaudeAPI').mockResolvedValue({ text: '[]', usage: {} });
    const vb: any = { secondaryCharacters: [] };
    const out = await detectAndPatchPhantomCharacters({
      storyPages: [page(['Anna'])], visualBible: vb,
      inputCharacters: [{ name: 'Anna Schmid' }, { name: 'Anna Meier' }], modelId: 'stub',
    });
    expect(out).toBeNull();
    expect(call).not.toHaveBeenCalled();
    expect(vb.secondaryCharacters).toEqual([]);
  });

  it('the patch prompt lists only the unknown name, never an ambiguous cast name', async () => {
    const call = vi.spyOn(textModels, 'callClaudeAPI').mockResolvedValue({ text: '[]', usage: {} });
    await detectAndPatchPhantomCharacters({
      storyPages: [page(['Anna', 'Oma Frieda'])], visualBible: { secondaryCharacters: [] },
      inputCharacters: [{ name: 'Anna Schmid' }, { name: 'Anna Meier' }], modelId: 'stub',
    });
    const prompt = call.mock.calls[0][0] as string;
    expect(prompt).toContain('- Oma Frieda');
    expect(prompt).not.toMatch(/^- Anna$/m);
  });
});

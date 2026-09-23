/**
 * `outfit_misattributed` is DELETED from clothingCheck (2026-09-18). The rule —
 * "a garment belonging to character A is described on character B" — is a
 * language judgement, and the owner's ruling is that language belongs in the
 * prompt: it now lives in `prompts/scene-review.txt` as check 3c
 * `[clothing_owner]`. Same ruling, same week, as the `element_uncited` removal
 * (ea8e36198).
 *
 * MEASURED before removal over all 120 stored staging stories / 1,322 brief
 * pages — the 70 that kept `sceneReviewReport.briefsIn` replayed from the exact
 * pre-review briefs the check ran on: 9 fires, 9 FALSE, 0 true, and 0 in
 * production. Each fire cost a MANDATORY rewrite of a correct page, because
 * scene-review check 0 forbids declining a mechanical finding ("facts, not
 * opinions") — and a rewritten brief becomes the image prompt, so each one
 * changed a picture.
 *
 * This file was `clothing-misattribution-owner-named.test.ts`, the five tests
 * that pinned the `namedInProse` narrowing shipped the same day (e1bd11014).
 * That narrowing was a stopgap on the same rule; its stored evidence is kept
 * here verbatim and inverted — the pages it saved and the pages it did NOT
 * save are all silent now, from one deletion instead of one precondition.
 *
 * What is pinned here is BEHAVIOUR: which findings `checkPage` emits, and which
 * of them `renderFindingsBlock` sends to the reviewer. The reviewer rule's own
 * wording is free to change; only its check TAG is pinned, and only because the
 * template's OUTPUT FORMAT makes every tag part of the response contract.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const { checkPage, renderFindingsBlock } = require('../../server/lib/clothingCheck');
const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

type Finding = { type: string; character: string; slot: string | null; detail: string };
const typesOf = (f: Finding[]) => [...new Set(f.map(x => x.type))].sort();
const misattributions = (f: Finding[]) => f.filter(x => x.type === 'outfit_misattributed');

// ── job_1788681313413_xqmtk2gcs p11, verbatim from the stored brief ──────────
// The flagged name "Ethan" appears once, as the OBJECT of another figure's
// action ("the flame held by Ethan"). The sentence describes a third boy in an
// anorak; its evidence tokens were "boots", "single", "across" — his own
// lace-up boots, his own single kangaroo pocket, across the front.
const P11_PROSE =
  'On the right, facing left, a boy, slightly tall for his age, lean and upright, with light blond straight short hair, ' +
  'blue eyes, and no facial hair, wearing a blue waterproof anorak with a single kangaroo pocket across the front, ' +
  'dark grey straight-leg trousers, and black rubber-soled lace-up boots, leans down, holding the cylindrical wire frame ' +
  'of his wooden pole lantern in his left hand while dipping his unlit short white candle down directly into the small ' +
  'steady yellow-orange flame held by Ethan.';

const LILY_ETHAN_REQS = {
  Lily: {
    standard: {
      used: true,
      description:
        'A red quilted gilet over a white long-sleeved top, dark navy corduroy trousers, and brown leather ankle boots ' +
        'with a low block heel and a single buckle strap across the ankle.',
    },
  },
  Ethan: {
    standard: {
      used: true,
      description:
        'A green zip-up fleece hoodie over a grey long-sleeved top, dark brown straight-leg trousers, and dark navy ' +
        'trainers with flat white soles.',
    },
  },
};

const lilyEthanPage = (prose: string) => ({
  pageNumber: 11,
  prose,
  cast: [{ name: 'Lily' }, { name: 'Ethan' }],
  perCharClothing: { Lily: 'standard', Ethan: 'standard' },
  wornItems: [],
});

describe('outfit_misattributed is gone from clothingCheck', () => {
  it('stays silent where the owner is described by appearance and never named (xqmtk2gcs p11)', () => {
    expect(P11_PROSE).not.toMatch(/\bLily\b/);   // the shape 6 of the 9 fires had
    expect(misattributions(checkPage(lilyEthanPage(P11_PROSE), LILY_ETHAN_REQS))).toHaveLength(0);
  });

  it('stays silent on the SAME prose once the owner IS named — the case the narrowing kept firing on', () => {
    // e1bd11014's precondition let this through; the deletion does not. One
    // clause added, naming the owner elsewhere on the page, nothing else changed.
    const named = 'Lily waits at the rail. ' + P11_PROSE;
    expect(misattributions(checkPage(lilyEthanPage(named), LILY_ETHAN_REQS))).toHaveLength(0);
  });

  // ── job_1789147573901_m3uam0nxi p6, verbatim ────────────────────────────────
  // ONE sentence names two characters and describes a THIRD figure — a toddler
  // written by appearance. It faulted both of the named ones.
  const P6_PROSE =
    'Kiaan walks forward, looking at the dog, while a toddler, little boy—about four heads tall, curly light blonde hair, ' +
    'blue eyes, wearing a yellow T-shirt, soft grey jersey shorts, and blue sandals—stands quietly beside Levin, looking on.';

  const THREE_BOYS_REQS = {
    Julian: { standard: { used: true, description: 'A yellow T-shirt, soft grey jersey shorts, and blue sandals.' } },
    Levin: { standard: { used: true, description: 'A red short-sleeved cotton T-shirt, mid-blue denim shorts, white low-top canvas sneakers.' } },
    Kiaan: { standard: { used: true, description: 'An orange short-sleeved cotton T-shirt, black cotton cargo shorts, black high-top canvas sneakers.' } },
  };

  const p6Page = (prose: string) => ({
    pageNumber: 6,
    prose,
    cast: [{ name: 'Julian' }, { name: 'Levin' }, { name: 'Kiaan' }],
    perCharClothing: { Julian: 'standard', Levin: 'standard', Kiaan: 'standard' },
    wornItems: [],
  });

  it('stays silent where the owner is the unnamed figure being described (m3uam0nxi p6)', () => {
    expect(P6_PROSE).not.toMatch(/\bJulian\b/);
    expect(misattributions(checkPage(p6Page(P6_PROSE), THREE_BOYS_REQS))).toHaveLength(0);
  });

  // ── job_1788820396445_9erw6xc01 p11, verbatim ───────────────────────────────
  // THE SENTENCE SPLITTER. The rule gathered evidence per sentence, splitting on
  // `/(?<=[.!?])\s+/`. This brief writes a second figure's whole description
  // inside a parenthetical carrying an ellipsis, so the split cuts the figure in
  // half: her name stays on the left of the break and her garments go to the
  // right, into a fragment whose only name is the OTHER character's. One of the
  // three fires the narrowing did not reach, and untunable — the ellipsis is
  // normal prose.
  const SPLITTER_PROSE =
    'Saira stands on a high horizontal limestone ledge near the top of the dark rough cliff, cupping both hands around ' +
    'her mouth as she calls down toward Fiona far below. Saira — a young adult young woman with average build, brown ' +
    'eyes, dark brown straight shoulder-length loose hair parted on the right — tilts her head back, her gaze fixed ' +
    'sharply on the bright sky above the cliff edge. She wears her mustard yellow linen sleeveless vest over a white ' +
    'linen short-sleeve undershirt, wide dark brown leather belt, black straight-cut trousers, and flat brown leather ' +
    'cross-strap sandals, with her beaded band bracelets catching the light. Roughly a fourth her size in the lower ' +
    'left foreground, Fiona (adult woman with average build, adult proportions about 7.5-8 heads tall... light brown ' +
    'straight neck-length hair, blue eyes; dressed in her deep blue linen long-sleeve shirt, dark red wool captain’s ' +
    'coat, light brown leather wide belt, dark brown straight-cut trousers, black leather knee-high boots, silver heart ' +
    'pendant, and silver bracelet) stands in back view, head tilted up toward Saira. Between them, the thin unbroken ' +
    'sheet of the waterfall drops straight down the dark grey-green rock face. Wide shot, vertical composition.';

  const SPLITTER_REQS = {
    Saira: {
      costumed: {
        used: true,
        description:
          'a mustard yellow linen sleeveless vest with a V-neckline and two open front panels, a plain white linen ' +
          'short-sleeve undershirt beneath it, a wide dark brown leather belt fastened with a plain rectangular brass ' +
          'buckle, black straight-cut trousers ending at the ankle, flat brown leather sandals with two cross-straps ' +
          'over the foot; beaded and plain band bracelets on the left wrist, small beaded bracelet on the right wrist',
      },
    },
    Fiona: {
      costumed: {
        used: true,
        description:
          'a deep blue linen long-sleeve shirt with a wide open collar, a light brown leather wide belt cinched at the ' +
          'waist with a plain square brass clasp, dark brown straight-cut trousers ending just below the knee, a long ' +
          'dark red wool captain’s coat with wide lapels and two front panels, black leather knee-high boots with a low ' +
          'stacked heel and a folded-down cuff at the top; silver necklace with a heart pendant at the collarbone, ' +
          'silver bracelet on the wrist',
      },
    },
  };

  const splitterPage = () => ({
    pageNumber: 11,
    prose: SPLITTER_PROSE,
    cast: [{ name: 'Saira' }, { name: 'Fiona' }],
    perCharClothing: { Saira: 'costumed', Fiona: 'costumed' },
    wornItems: [],
  });

  it('stays silent where an ellipsis inside a parenthetical splits a figure in two (9erw6xc01 p11)', () => {
    // The premise of the old fire: the split produces a fragment carrying the
    // OTHER character's name and this character's garments.
    const fragments = SPLITTER_PROSE.split(/(?<=[.!?])\s+/);
    const orphan = fragments.find(s => /\bdeep blue linen long-sleeve shirt\b/.test(s));
    expect(orphan).toBeDefined();
    expect(orphan).not.toMatch(/\bFiona\b/);       // her garments, her name gone
    expect(orphan).toMatch(/\bSaira\b/);           // and the other character named
    expect(misattributions(checkPage(splitterPage(), SPLITTER_REQS))).toHaveLength(0);
  });

  it('no page shape produces the type at all, however the prose is arranged', () => {
    const pages = [
      lilyEthanPage(P11_PROSE),
      lilyEthanPage('Lily waits at the rail. ' + P11_PROSE),
      lilyEthanPage('Ethan crouches by the wall wearing a red quilted gilet, dark navy corduroy trousers and brown leather ankle boots with a single buckle strap.'),
      p6Page(P6_PROSE),
      splitterPage(),
    ];
    const reqs = [LILY_ETHAN_REQS, LILY_ETHAN_REQS, LILY_ETHAN_REQS, THREE_BOYS_REQS, SPLITTER_REQS];
    for (let i = 0; i < pages.length; i++) {
      expect(typesOf(checkPage(pages[i] as any, reqs[i]))).not.toContain('outfit_misattributed');
    }
  });

  it('the deletion took nothing else — the surviving types still fire on the same pages', () => {
    // A page whose prose says nothing about one character's clothes is still
    // `outfit_missing`; a page that recolours a contracted garment is still
    // `garment_colour_wrong`. Both are diagnostics of the same module and both
    // must be unaffected by removing rule 2.
    const silent = checkPage(
      { ...lilyEthanPage('Lily and Ethan stand together at the rail, looking out.'), pageNumber: 4 } as any,
      LILY_ETHAN_REQS,
    );
    expect(typesOf(silent)).toContain('outfit_missing');

    const recoloured = checkPage(
      lilyEthanPage('Lily, wearing a red quilted gilet over a white long-sleeved top and dark navy corduroy trousers with black leather ankle boots, waits at the rail.') as any,
      LILY_ETHAN_REQS,
    );
    const colour = recoloured.filter((f: Finding) => f.type === 'garment_colour_wrong');
    expect(colour.length).toBeGreaterThan(0);
    expect(colour[0].character).toBe('Lily');
  });
});

describe('renderFindingsBlock no longer sends the type to the reviewer', () => {
  it('a page carrying only the removed type renders an empty block', () => {
    const stale = [{
      pageNumber: 3, type: 'outfit_misattributed', character: 'A', slot: null,
      detail: 'a garment of one character described on another',
    }];
    expect(renderFindingsBlock(new Map([[3, stale]]))).toBe('');
  });

  it('a removal_unstated finding on the same page still renders — the block is not dead', () => {
    const live = [{
      pageNumber: 3, type: 'removal_unstated', character: 'A', slot: 'headwear', artifactId: 'ART001',
      detail: 'ART001 has no wornItems entry for it.',
    }];
    const block = renderFindingsBlock(new Map([[3, live]]));
    expect(block).toMatch(/MECHANICAL CLOTHING FAULTS/);
    expect(block).toMatch(/\[removal_unstated\]/);
    expect(block).not.toMatch(/outfit_misattributed/);
  });

  it('the block no longer instructs a garment move it can never ask for', () => {
    // The trailing instruction listed fixes for faults that are not sendable.
    // Only the missing-field fault reaches the reviewer now.
    const block = renderFindingsBlock(new Map([[3, [{
      pageNumber: 3, type: 'removal_unstated', character: 'A', slot: null, artifactId: 'ART001', detail: 'x',
    }]]]));
    expect(block).not.toMatch(/rightful owner/);
  });
});

describe('the reviewer carries the replacement check', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  // Only the TAG is pinned. The template's OUTPUT FORMAT requires one tagged
  // line per check ("Open each answer with that tag"), so a tag is part of the
  // response contract the parser and the reviewer share — not prose styling.
  it('the built scene-review prompt asks for a [clothing_owner] answer', () => {
    const prompt = PB.buildSceneReviewPrompt(
      { title: 'A Story', language: 'de', characters: [{ id: 1, name: 'A' }], mainCharacters: [1] },
      [{ pageNumber: 1, brief: 'A character stands at a rail.' }],
      { beats: [{ pageNumber: 1, planLine: 'wide — a character at a rail — she looks out — the rail is established' }] },
    );
    expect(prompt).toBeTruthy();
    expect(prompt).toContain('[clothing_owner]');
    expect(prompt).not.toMatch(/\{[A-Z_]+\}/);   // no placeholder survived
  });

  it('the mechanical-faults check no longer promises a garment move', () => {
    const prompt = PB.buildSceneReviewPrompt(
      { title: 'A Story', language: 'de', characters: [{ id: 1, name: 'A' }], mainCharacters: [1] },
      [{ pageNumber: 1, brief: 'A character stands at a rail.' }],
      // Check 0 is sent only with the section it is about (2026-09-23).
      { clothingFindings: '# MECHANICAL CLOTHING FAULTS\n- Page 1: a fault' },
    );
    const check0 = String(prompt).split('[page_repetition]')[0];
    expect(check0).toContain('[clothing_mechanical]');
    expect(check0).not.toMatch(/rightful owner/);
  });
});

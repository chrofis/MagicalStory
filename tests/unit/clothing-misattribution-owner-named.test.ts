/**
 * `outfit_misattributed` may only fire when the OWNER is named in the prose.
 *
 * WHY (measured 2026-09-18 over every stored staging brief page — 70 stories,
 * 941 pages, replayed from `stories.data.sceneReviewReport.briefsIn`, the exact
 * pre-review briefs the check ran on):
 *
 * The rule concludes "these words describe `other`, not `owner`" from ONE
 * fact — the sentence carries `other`'s name and not `owner`'s. The Art
 * Director routinely introduces a figure by appearance instead of by name
 * ("the preschooler little girl of average build … wearing a red quilted
 * gilet"), and when the owner's name is nowhere on the page that test is
 * vacuous: every sentence passes it, including the one that describes the
 * owner themselves. `ATTACHES` does not rescue it — it only shows that
 * SOMEBODY's clothing is attached in the sentence, never whose.
 *
 * The rule sent 9 findings across all stored staging stories. 6 of them had
 * the owner's name nowhere in the page prose:
 *   job_1788681313413_xqmtk2gcs p9, p11, p12, p14   (Lily ⇄ Ethan)
 *   job_1789147573901_m3uam0nxi p6 (×2)             (Levin, Kiaan ← Julian)
 * All 6 faulted a page whose clothing was correct, and all 6 forced a page
 * rewrite — the scene review's check 0 forbids re-judging a mechanical fault
 * ("they are facts, not opinions"). Every one of the 9 is in `changedPages`.
 *
 * The three fires that survive this fix are unaffected by it and stay
 * reportable; the two prose cases below are the real stored ones.
 */
import { describe, it, expect } from 'vitest';

const { checkPage } = require('../../server/lib/clothingCheck');

type Finding = { type: string; character: string; detail: string };
const misattributions = (findings: Finding[]) => findings.filter(f => f.type === 'outfit_misattributed');

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

describe('outfit_misattributed — the owner must be named in the prose', () => {
  it('stays silent when the owner is described by appearance and never named (xqmtk2gcs p11)', () => {
    expect(P11_PROSE).not.toMatch(/\bLily\b/);   // the premise: the owner is not on the page by name
    expect(P11_PROSE).toMatch(/\bEthan\b/);
    const findings = checkPage(lilyEthanPage(P11_PROSE), LILY_ETHAN_REQS);
    expect(misattributions(findings)).toHaveLength(0);
  });

  it('still fires on the same prose once the owner IS named on the page', () => {
    // One clause added, naming Lily elsewhere on the page. Nothing else changes:
    // the fix narrows the PRECONDITION, it does not weaken the rule.
    const named = 'Lily waits at the rail. ' + P11_PROSE;
    const findings = checkPage(lilyEthanPage(named), LILY_ETHAN_REQS);
    const mis = misattributions(findings);
    expect(mis.length).toBeGreaterThan(0);
    expect(mis[0].character).toBe('Ethan');
  });

  // ── job_1789147573901_m3uam0nxi p6, verbatim ────────────────────────────────
  // ONE sentence names Kiaan and Levin and describes a THIRD figure — the
  // toddler who is Julian, written by appearance. It faulted both of them.
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

  it('stays silent when the owner is the unnamed toddler being described (m3uam0nxi p6)', () => {
    expect(P6_PROSE).not.toMatch(/\bJulian\b/);
    const findings = checkPage(p6Page(P6_PROSE), THREE_BOYS_REQS);
    expect(misattributions(findings)).toHaveLength(0);
  });

  it('a page where no cast member is named at all produces no misattribution', () => {
    const anonymous = 'The little girl in a red quilted gilet, dark navy corduroy trousers and brown leather ankle boots '
      + 'with a low block heel and a single buckle strap across the ankle stands by the door.';
    expect(misattributions(checkPage(lilyEthanPage(anonymous), LILY_ETHAN_REQS))).toHaveLength(0);
  });

  it('the precondition is per owner, not per page — a named owner still fires beside an unnamed one', () => {
    // Ethan IS named; Lily is not. Only the Lily→Ethan direction is suppressed.
    const findings = checkPage(lilyEthanPage(
      'Ethan crouches by the wall. ' + P11_PROSE.replace('held by Ethan', 'held by the boy in the green hoodie'),
    ), LILY_ETHAN_REQS);
    // Nothing names Lily, so no finding can claim Lily's garments moved.
    expect(misattributions(findings).filter(f => /Lily/.test(f.detail))).toHaveLength(0);
  });
});

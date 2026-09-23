import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

// CJS registry, not vitest's ESM graph — the prompt store is plain require().
const require_ = createRequire(import.meta.url);
const { loadPromptTemplates, PROMPT_TEMPLATES } = require_('../../server/services/prompts');
const { buildFeedbackInput } = require_('../../server/lib/feedbackConsolidator');

/**
 * A single-instance object has exactly one holder.
 *
 * Evidence — staging story job_1789348171785_9oxos7dwv page 7, a book whose plot
 * prop is ONE object. The v0 consolidated plan carried two `action_interaction`
 * findings naming two DIFFERENT characters as its holder and wrote a fix for
 * each; round 2's inpaint instruction obeyed both verbatim ("Add red egg in this
 * character's hands" AND "Adjust this character's pose so both arms encircle the
 * red egg"), the page rendered two copies of the one prop, and the resulting
 * eval's CRITICAL landed in `unrepairedCritical` and SHIPPED because the repair
 * passes were exhausted. `spec_conflicts` was `[]` in all three rounds.
 *
 * Every fixture value below is copied verbatim from that stored page: the scene
 * description as it reached the consolidator (prose + ---METADATA---), and the
 * two findings from the v0 plan's `deduped_issues`.
 */

// stories.data->sceneImages[6]->sceneDescription, verbatim.
const SCENE_DESCRIPTION = `Seen from behind, Julian — the toddler in his yellow vest, white shirt, blue dungarees, and white sneakers — walks at the front on a lower step, both arms wrapped around the heavy red stone-like egg, Ofeli. Seen from behind, Levin, in his red hoodie, dark grey trousers, and brown boots, takes the steps carefully behind him. Seen from behind, Max, in his green pullover, orange corduroy trousers, and grey velcro-strap sneakers, follows at the same slow rhythm. Seen from behind, Kiaan, in his purple anorak, brown trousers, and dark brown leather ankle boots, follows close to Max, while the scruffy terrier mix dog pads along on the step beside Max. The wide shot, angled slightly downward from the top of the stairs, watches the friends depart toward the lower town.
---METADATA---
{
  "sceneIntent": "The group walks away down the steep stone stairs, seen from behind. Julian leads slowly, carrying the egg, while Levin, Max, Kiaan, and the dog follow his pace.",
  "characters": [
    {"name": "Julian", "clothing": "standard", "position": "center midground", "depth": "midground", "perspective": "back view", "looksAt": "away", "expression": "face not visible"},
    {"name": "Levin", "clothing": "standard", "position": "left foreground", "depth": "foreground", "perspective": "back view", "looksAt": "away", "expression": "face not visible"},
    {"name": "Max", "clothing": "standard", "position": "center foreground", "depth": "foreground", "perspective": "back view", "looksAt": "away", "expression": "face not visible"},
    {"name": "Kiaan", "clothing": "standard", "position": "right foreground", "depth": "foreground", "perspective": "back view", "looksAt": "away", "expression": "face not visible"}
  ],
  "shot": "wide",
  "landmarkView": "exterior",
  "era": "present day",
  "objects": ["Lindenhof square with big linden tree", "dragon egg", "Nia", "Ofeli"],
  "interactions": [
    {"character": "Levin + Julian + Max + Kiaan", "object": "the stairs", "where": "walk down the stone stairs", "action": "walking", "storyRelevant": false, "priority": "normal"}
  ],
  "wornItems": [],
  "emptyScenePrompt": "Steep stone steps descend away from the camera, leading down from a high park area into the lower town. Wrought iron handrails run down the sides, and dry autumn leaves litter the grey stone treads under a darkening late afternoon sky."
}`;

// The two conflicting findings, verbatim from the v0 plan's deduped_issues.
// Both came from the compliance evaluator, which is how they reach
// buildFeedbackInput's compliance section.
const CONFLICTING_FINDINGS = [
  {
    severity: 'CRITICAL',
    type: 'action_interaction',
    description: 'Kiaan is declared to carry Ofeli but inventory shows hands empty',
  },
  {
    severity: 'MAJOR',
    type: 'action_interaction',
    description: 'Julian holds red egg with only left hand; prompt requires both arms wrapped around it',
  },
];

describe('single-instance object — the consolidator can see the conflict', () => {
  const input = () => buildFeedbackInput({
    sceneDescription: SCENE_DESCRIPTION,
    complianceIssues: CONFLICTING_FINDINGS,
    characterDescriptions: {},
  });

  it('shows the consolidator the declared holder of the single prop', () => {
    const text = input();
    // The declaration is in the scene PROSE and the scene intent — not in the
    // interactions list, whose only entry on this page is "walking". A rule that
    // read interactions[] alone would have nothing to key on.
    expect(text).toContain('both arms wrapped around the heavy red stone-like egg, Ofeli');
    expect(text).toContain('Julian leads slowly, carrying the egg');
    const interactions = text.slice(text.indexOf('"interactions"'), text.indexOf('"wornItems"'));
    expect(interactions).toMatch(/"action":\s*"walking"/);
    expect(interactions).not.toMatch(/carr(y|ies|ying)|hold(s|ing)?\b/i);
  });

  it('shows both conflicting findings, naming different holders of that prop', () => {
    const text = input();
    for (const f of CONFLICTING_FINDINGS) expect(text).toContain(f.description);
    // The two findings name the prop DIFFERENTLY — its story name in one, a
    // plain description in the other. Matching finding wording detects nothing;
    // only the declared spec ties them to the same object.
    const kiaan = CONFLICTING_FINDINGS[0].description;
    const julian = CONFLICTING_FINDINGS[1].description;
    expect(kiaan).toContain('Ofeli');
    expect(kiaan).not.toContain('egg');
    expect(julian).toContain('egg');
    expect(julian).not.toContain('Ofeli');
    // ...and the spec supplies the tie: it names both together.
    expect(SCENE_DESCRIPTION).toMatch(/egg, Ofeli/);
  });
});

describe('single-instance object — two conflicting holder findings are one conflict, not two jobs', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const tpl = () => String(PROMPT_TEMPLATES.feedbackConsolidator || '');

  it('routes the pair into the spec check instead of into fixes', () => {
    const t = tpl();
    // The spec check is the mechanism: everything it lists gets NO fix and is
    // recorded as a spec_conflict. The single-instance-object shape must be
    // inside that section, after the body-part shape it generalises.
    const specStart = t.indexOf('## Spec check (required)');
    const specEnd = t.indexOf('## Deduplicated issues');
    expect(specStart).toBeGreaterThan(-1);
    expect(specEnd).toBeGreaterThan(specStart);
    const section = t.slice(specStart, specEnd);
    expect(section).toMatch(/single-instance object/i);
    expect(section).toMatch(/two DIFFERENT characters as its holder, carrier or wearer/);
    expect(section).toMatch(/emit NO fix for either/i);
    expect(section).toMatch(/record both in `dropped_issues` with reason `"spec_conflict"`/);
  });

  it('keys the object on the declared spec, not on matching finding wording', () => {
    const t = tpl();
    const section = t.slice(t.indexOf('## Spec check (required)'), t.indexOf('## Deduplicated issues'));
    // CLAUDE.md forbids working out what a finding means from its prose; the two
    // real findings name the prop differently, so wording-matching is also
    // useless here. The spec is the arbiter, and the holder may be declared in
    // the prose or the scene intent rather than the interactions list.
    expect(section).toMatch(/never by matching the findings' wording/i);
    expect(section).toMatch(/scene prose and the scene intent as well as the interactions list/i);
    // A finding contradicting the spec is not evidence of a second prop.
    expect(section).toMatch(/not a second prop/i);
  });

  it('carries a generic worked pair in the spec_conflicts output example', () => {
    const t = tpl();
    expect(t).toMatch(/"why":\s*"the spec gives the one prop to the first child; two holders would draw it twice"/);
    // Prompt-genericity: the example must not leak the story that motivated it.
    for (const leak of ['Ofeli', 'Kiaan', 'Julian', 'dragon egg', 'red egg']) {
      expect(t).not.toContain(leak);
    }
  });
});

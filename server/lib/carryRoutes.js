/**
 * WHERE A FINDING GOES (owner, 2026-08-25).
 *
 * Naming an issue is only half the job — a finding also has to say which stage
 * can fix it. Each audit's faults are handed to its own reviewer first; when
 * that reviewer does not resolve them, they ride into the NEXT call that
 * already happens and that can act on them, instead of being logged once and
 * dropped. Free: the call is being made either way.
 *
 * A stage only qualifies as a destination if it REWRITES the faulted material.
 * That is why briefs have no entry here — every stage after the scene review
 * was checked and none of them rewrites brief metadata (`story_text` consumes
 * the final briefs, but as read-only ILLUSTRATION blocks it must follow and
 * never writes back; `scene_translation` produces UI text that never
 * returns to the image path; `prompt_compress` shortens prose and only when the
 * prompt is over budget), so brief faults get a targeted second review round
 * instead. See docs/decisions.md 2026-08-25.
 *
 * Each destination gets an instruction matched to what it can actually change:
 * the Art Director rewrites the page's brief, the text writer cannot alter a
 * beat at all and can only avoid repeating its mistake.
 */
const CARRY_ROUTES = {
  // Arc faults → the beats plan, which is the stage that divides the arc into pages.
  arc: {
    label: 'ARC AUDIT',
    intro: 'An audit of the draft arc raised the faults below. The approved arc may already answer some of them. Where one still stands, resolve it in the page plan.',
  },
  // Beats faults → the Art Director, which writes each page's brief...
  beatsToArtDirector: {
    label: 'BEATS AUDIT',
    intro: 'An audit of the draft beats raised the faults below. The reviewed beats may already answer some of them. Where one still stands and it is visual, resolve it in the brief you write for that page.',
  },
  // ...and → the text writer, which cannot change a beat, only how it reads.
  beatsToStoryText: {
    label: 'BEATS AUDIT',
    intro: 'An audit of the draft beats raised the faults below. The reviewed beats may already answer some of them. Where one still stands, write the page so a reader does not meet the inconsistency: do not restate the contradicted detail and do not draw attention to it. Never contradict a beat that is sound, and never add plot to paper over one.',
  },
};

/**
 * Append a routed findings block to a built prompt. Empty findings change nothing.
 *
 * `reviewerLedger` is the analysis of the reviewer those findings were first
 * handed to, carried WITH them so a downstream stage sees the rulings, not just
 * the raw faults. Without it, a fault the reviewer ruled "stands, with a
 * reason" gets re-litigated by a stage that never saw the reason — the exact
 * mechanism behind the travelogue-opener defect in the 2026-08-25 provenance
 * trace (the beats review ruled a page-turn TRANSITION fault "stands"; the text
 * stage had no memory of that ledger and wrote the travel anyway).
 */
function withCarriedFindings(prompt, findings, route, reviewerLedger = '') {
  const body = String(findings || '').trim();
  if (!prompt || !body || !route) return prompt;
  const ledger = String(reviewerLedger || '').trim();
  const ledgerBlock = ledger
    ? `\n\n---${route.label}: REVIEWER'S RULINGS---\nThe reviewer of that material answered these faults below; its ledger is at the end. A fault it fixed is satisfied. A fault it ruled to stand, with a reason, stays as ruled: do not re-open it.\n\n${ledger}`
    : '';
  return `${prompt}\n\n${route.intro}\n\n---${route.label}---\n${body}${ledgerBlock}`;
}

module.exports = { CARRY_ROUTES, withCarriedFindings };

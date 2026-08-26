/**
 * WHAT TRAVELS FORWARD AFTER A REVIEW (owner, 2026-08-26 — supersedes the
 * 2026-08-25 fault-carry design).
 *
 * The first version carried the AUDIT FAULT LIST forward into downstream
 * prompts. Measured on the first production run (job_1787689073034), that was
 * noise at best and harmful at worst: all 10 carried arc faults were already
 * marked fixed, and the one carry with a real effect handed the text writer a
 * reviewer ruling that ITSELF was the defect ("three shapes rise" — the flying
 * fix) with instructions not to re-open it. Whether a fix held is now the job
 * of the RE-AUDIT (the same blind audit run again on the reviewed artifact,
 * beatsPipeline/textRefine), which catches botched fixes AND review-introduced
 * faults — something a carried fault list can never do, because an
 * introduction has no finding to carry.
 *
 * What still must travel is the RULINGS: a fault the reviewer ruled to stand,
 * with a reason, is a settled trade-off. A later stage that never saw the
 * reason will re-litigate it — the exact mechanism behind the
 * travelogue-opener defect in the 2026-08-25 provenance trace. So the
 * reviewer's ledger rides along, framed as precedent, not as work.
 */
const CARRY_ROUTES = {
  arc: { label: 'ARC REVIEW RULINGS' },
  beatsToArtDirector: { label: 'BEATS REVIEW RULINGS' },
  beatsToStoryText: { label: 'BEATS REVIEW RULINGS' },
};

/**
 * Append a reviewer's ledger to a downstream prompt as settled precedent.
 * Empty ledgers change nothing. `ledgers` accepts a string or an array of
 * strings (first review + re-review), joined in order.
 */
function withCarriedRulings(prompt, ledgers, route) {
  const body = (Array.isArray(ledgers) ? ledgers : [ledgers])
    .map(s => String(s || '').trim()).filter(Boolean).join('\n\n');
  if (!prompt || !body || !route) return prompt;
  return `${prompt}\n\nAn earlier review of this material answered an audit; its ledger follows. Only the rulings bind you: a fault ruled to stand, with a reason, is settled — do not re-open it and do not write against it. Entries recording fixes are history, not instructions.\n\n---${route.label}---\n${body}`;
}

module.exports = { CARRY_ROUTES, withCarriedRulings };

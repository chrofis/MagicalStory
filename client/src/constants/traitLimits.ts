/**
 * How many traits a parent may pick per list (owner, 2026-09-19).
 *
 * The picker was uncapped. Staging story job_1789759147125_p08djwhbl shipped a
 * five-year-old carrying 25 strengths and 7 flaws — effectively the whole
 * vocabulary — and a second child with 20 strengths. Every one of them reached
 * the arc prompt, under a rule that asks each character's nature to cause a
 * problem or solve one. A character who is cheerful, friendly, helpful,
 * protective, forgiving, loyal, fair, honest, trustworthy, patient, curious,
 * imaginative, clever, creative, attentive, resourceful, adventurous, fast,
 * strong, hard-working, a leader, brave, generous, confident and funny has no
 * nature at all, and the story cannot turn on one.
 *
 * ONE constant, every trait-edit entry point: the new-character step and the
 * full/edit layout of CharacterForm, and the trial wizard's own picker. A cap
 * that reaches one of them and not the others is not a cap.
 *
 * Characters saved before this keep everything they have — the limit blocks
 * ADDING past it and never deletes a choice a parent already made. Deselecting
 * is always allowed, so such a character comes back under the limit by hand.
 */
export const MAX_STRENGTHS = 5;
export const MAX_FLAWS = 3;

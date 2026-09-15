import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS lib
const { applyLectorFindings, locateQuote } = require('../../server/lib/textRefine.js');

/**
 * THE DEFECT THIS PINS (prod job_1789227389389_z18dmvnt6 p15, 2026-09-13).
 *
 * The lector quoted the shortest span containing the fault and corrected
 * agreement only inside it. On p15 it emitted a CORRECT gender fix —
 * `la doudou toute dégoulinante` → `le doudou tout dégoulinant` — and the
 * preposition one word to its left was outside the span, so applying it turned
 * `de la doudou` into `de le doudou`. French contracts `de + le` to `du`; the
 * proofreader shipped a new error of its own making.
 *
 * The contract is now the whole SENTENCE, so the preposition travels inside the
 * span. These tests pin the applier's behaviour under that contract — not the
 * prompt's wording.
 */

const P15 = 'Sarah s’agenouille et enroule sa grande écharpe orange autour des deux enfants et de la doudou toute dégoulinante. «Je suis allée dans le noir, dit Liz, et je suis revenue.»';

describe('lector span contract — the sentence, not the fault', () => {
  it('REGRESSION: a fault-only span strands the preposition and ships "de le"', () => {
    const { pages } = applyLectorFindings(
      [{ pageNumber: 15, text: P15 }],
      [{ pageNumber: 15, quote: 'la doudou toute dégoulinante', correction: 'le doudou tout dégoulinant' }],
    );
    // This is what production did. The applier is faithful; the span was wrong.
    expect(pages[0].text).toContain('de le doudou');
  });

  it('the same fix quoted as the whole sentence carries the contraction and is clean', () => {
    const sentence = 'Sarah s’agenouille et enroule sa grande écharpe orange autour des deux enfants et de la doudou toute dégoulinante.';
    const corrected = 'Sarah s’agenouille et enroule sa grande écharpe orange autour des deux enfants et du doudou tout dégoulinant.';
    const { pages, applied, dropped } = applyLectorFindings(
      [{ pageNumber: 15, text: P15 }],
      [{ pageNumber: 15, quote: sentence, correction: corrected }],
    );
    expect(dropped).toHaveLength(0);
    expect(applied).toHaveLength(1);
    expect(pages[0].text).toContain('du doudou tout dégoulinant');
    expect(pages[0].text).not.toContain('de le');
    // The rest of the page is untouched.
    expect(pages[0].text).toContain('«Je suis allée dans le noir');
  });

  it('a sentence-length quote still matches across a re-wrapped line break', () => {
    const text = 'Sarah s’agenouille\nautour de la doudou toute dégoulinante. Fin.';
    const span = locateQuote(text, 'Sarah s’agenouille autour de la doudou toute dégoulinante.');
    expect(span).not.toBeNull();
    expect(text.slice(span.start, span.end)).toContain('doudou');
  });

  it('WHY ONE LINE PER SENTENCE: two findings inside one sentence collide and the second is dropped', () => {
    const text = 'La doudou est tombée et la fille a pleuré.';
    const { applied, dropped } = applyLectorFindings(
      [{ pageNumber: 1, text }],
      [
        { pageNumber: 1, quote: 'La doudou est tombée et la fille a pleuré.', correction: 'Le doudou est tombé et la fille a pleuré.' },
        { pageNumber: 1, quote: 'la fille a pleuré', correction: 'la fille a pleuré fort' },
      ],
    );
    expect(applied).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toBe('overlap');
  });

  it('a sentence quote that does not match the page is dropped, never half-applied', () => {
    const { pages, applied, dropped } = applyLectorFindings(
      [{ pageNumber: 15, text: P15 }],
      [{ pageNumber: 15, quote: 'A sentence that is not on this page at all.', correction: 'Anything.' }],
    );
    expect(applied).toHaveLength(0);
    expect(dropped[0].reason).toBe('quote-absent');
    expect(pages[0].text).toBe(P15);
  });

  it('two sentences on one page each get their own correction', () => {
    const text = 'La doudou est tombée. La fille a pleuré.';
    const { pages, applied } = applyLectorFindings(
      [{ pageNumber: 2, text }],
      [
        { pageNumber: 2, quote: 'La doudou est tombée.', correction: 'Le doudou est tombé.' },
        { pageNumber: 2, quote: 'La fille a pleuré.', correction: 'La fille a pleuré fort.' },
      ],
    );
    expect(applied).toHaveLength(2);
    expect(pages[0].text).toBe('Le doudou est tombé. La fille a pleuré fort.');
  });
});

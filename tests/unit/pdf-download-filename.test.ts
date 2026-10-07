import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

/**
 * The three PDF download routes (GET /stories/:id/pdf, GET /stories/:id/print-pdf,
 * POST /generate-book-pdf) each had their own filename sanitiser. All three deleted
 * every non-ASCII letter outright, so a French or Italian title lost letters
 * ("Léa et la forêt" → "La_et_la_fort.pdf"), and the book route did not even
 * transliterate umlauts ("Bär" → "Br.pdf"). One helper now serves them: accents drop
 * only their mark in the ASCII fallback and the real title travels in filename*.
 */
const nodeRequire = createRequire(import.meta.url);
const { pdfContentDisposition } = nodeRequire('../../server/lib/pdf.js');

const asciiName = (h: string) => h.match(/filename="([^"]*)"/)![1];
const utf8Name = (h: string) => decodeURIComponent(h.match(/filename\*=UTF-8''(.*)$/)![1]);

describe('pdfContentDisposition', () => {
  it('French and Italian accented letters keep their base letter', () => {
    const h = pdfContentDisposition('Léa et la forêt de Noël');
    expect(asciiName(h)).toBe('Lea_et_la_foret_de_Noel.pdf');
    expect(asciiName(pdfContentDisposition('Così è la città'))).toBe('Cosi_e_la_citta.pdf');
  });

  it('German umlauts, ß and the French œ transliterate', () => {
    expect(asciiName(pdfContentDisposition('Bär und Straße – Übung'))).toBe('Baer_und_Strasse_-_Uebung.pdf');
    expect(asciiName(pdfContentDisposition("L'œuf d'or"))).toBe('Loeuf_dor.pdf');
  });

  it('the real title travels in filename* and the suffix lands on both', () => {
    const h = pdfContentDisposition('Léa et la forêt', '-print');
    expect(asciiName(h)).toBe('Lea_et_la_foret-print.pdf');
    expect(utf8Name(h)).toBe('Léa_et_la_forêt-print.pdf');
  });

  it('an empty or symbol-only title falls back to story.pdf', () => {
    expect(asciiName(pdfContentDisposition(''))).toBe('story.pdf');
    expect(asciiName(pdfContentDisposition('«»'))).toBe('story.pdf');
  });

  it('the header value carries no quote, slash or control character', () => {
    const h = pdfContentDisposition('a"b/c\\d\n e');
    expect(h).not.toMatch(/[\n\r]/);
    expect(asciiName(h)).toBe('abcd_e.pdf');
    expect(utf8Name(h)).toBe('abcd_e.pdf');
  });
});

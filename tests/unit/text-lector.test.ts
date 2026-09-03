import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS lib
import { parseLectorFindings, sanitizeLectorFindings } from '../../server/lib/textRefine.js';

/**
 * The lector (prompts/story-text-proofread.txt) emits one line per objective
 * language fault: `PAGE <n>: '<quoted>' → '<corrected>'`. Two things must hold
 * for the application pass to be mechanical rather than a second proofread:
 * the line parses into a page + a span + its replacement, and a finding whose
 * quote is not verbatim on the page it names is DROPPED, never applied.
 *
 * The quoted lines below are the real gemini-3.1-pro output from the 6-model
 * A/B on job_1788380714660_4p9mr11xszu (scratchpad piraterun4/lector-ab).
 */
const AB_OUTPUT = [
  "PAGE 1: 'alt: das Papier' → 'alt: Das Papier'",
  "PAGE 9: 'beugte den Kopf in den Nacken' → 'legte den Kopf in den Nacken'",
  "PAGE 11: 'schwamm die Leine zurück' → 'schwamm mit der Leine zurück'",
  "PAGE 11: 'schwamm er es durch die Brandung' → 'zog er es schwimmend durch die Brandung' (oder 'schwamm er damit')",
  "PAGE 15: 'war einen Moment lang traurig für sie' → 'hatte einen Moment lang Mitleid mit ihr' (oder 'tat ihr einen Moment lang leid')",
  "PAGE 15: 'schwamm die Leine' → 'schwamm mit der Leine'",
].join('\n');

describe('parseLectorFindings', () => {
  it('parses page, quoted span and replacement from the measured A/B output', () => {
    const f = parseLectorFindings(AB_OUTPUT);
    expect(f).toHaveLength(6);
    expect(f[0]).toMatchObject({ pageNumber: 1, quote: 'alt: das Papier', correction: 'alt: Das Papier' });
    expect(f[2]).toMatchObject({ pageNumber: 11, quote: 'schwamm die Leine zurück' });
  });

  it('keeps only the first correction when the model offers an alternative', () => {
    const f = parseLectorFindings(AB_OUTPUT);
    expect(f[3].correction).toBe('zog er es schwimmend durch die Brandung');
    expect(f[4].correction).toBe('hatte einen Moment lang Mitleid mit ihr');
  });

  it('ignores everything that is not a finding line', () => {
    const noise = [
      'Let me work through this carefully page by page.',
      'NONE',
      '',
      "PAGE 4: 'kniete hin' → 'kniete sich hin'",
      'FAULTS: 1',
    ].join('\n');
    const f = parseLectorFindings(noise);
    expect(f).toHaveLength(1);
    expect(f[0].pageNumber).toBe(4);
  });

  it('accepts guillemets, list bullets and an ASCII arrow', () => {
    const f = parseLectorFindings("- PAGE 7: «Bei erstem Tageslicht» -> «Beim ersten Tageslicht»");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ pageNumber: 7, quote: 'Bei erstem Tageslicht', correction: 'Beim ersten Tageslicht' });
  });

  it('drops a line whose correction equals the quote', () => {
    expect(parseLectorFindings("PAGE 2: 'das Boot' → 'das Boot'")).toHaveLength(0);
  });
});

describe('sanitizeLectorFindings — verbatim-quote guard', () => {
  const pages = [
    { pageNumber: 1, text: 'Die Karte ist alt: das Papier ist dünn.' },
    { pageNumber: 11, text: 'Er schwamm die Leine zurück zum Schiff.' },
  ];

  it('keeps a finding that quotes its page verbatim', () => {
    const { kept, dropped } = sanitizeLectorFindings(
      "PAGE 11: 'schwamm die Leine zurück' → 'schwamm an der Leine zurück'", pages);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it('drops a finding whose quote is not on the page it names', () => {
    // The hallucination class: the previous proofreader claimed two distinct
    // cast members were the same person and suggested writing ß — neither
    // quotes anything the page contains.
    const { kept, dropped } = sanitizeLectorFindings(
      "PAGE 1: 'die Karte war grösser' → 'die Karte war größer'", pages);
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });

  it('drops a finding pointing at a page that does not exist', () => {
    const { kept, dropped } = sanitizeLectorFindings(
      "PAGE 99: 'das Papier ist dünn' → 'das Papier war dünn'", pages);
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });

  it('matches when the page wraps the quoted span across a line break', () => {
    const wrapped = [{ pageNumber: 11, text: 'Er schwamm die\nLeine zurück zum Schiff.' }];
    const { kept } = sanitizeLectorFindings(
      "PAGE 11: 'schwamm die Leine zurück' → 'schwamm an der Leine zurück'", wrapped);
    expect(kept).toHaveLength(1);
  });
});

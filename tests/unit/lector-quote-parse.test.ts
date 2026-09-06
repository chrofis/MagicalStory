import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS lib
const { parseLectorFindings, quotedSpan, applyLectorFindings } = require('../../server/lib/textRefine.js');

/**
 * REGRESSION (2026-09-06, job_1788681313413_xqmtk2gcs): the quoted-span reader
 * closed on the NEXT quote character instead of the LAST one on its side, so
 * any span containing an apostrophe was truncated — `'the boy's pole lantern'`
 * parsed as `the boy`. Downstream the `quote === correction` guard then
 * discarded the finding silently. Every case below is a shape the lector and
 * the diff pass actually emit.
 */
describe('quotedSpan', () => {
  it('reads first-to-LAST, so apostrophes inside a span survive', () => {
    expect(quotedSpan("'the boy's pole lantern'")).toBe("the boy's pole lantern");
  });
  it('returns null when the side is not quoted at all', () => {
    expect(quotedSpan('bare words')).toBeNull();
  });
  it('returns false when a quote is opened and never closed', () => {
    expect(quotedSpan("'unclosed span")).toBe(false);
  });
  it('reads an explicitly empty quoted side as an empty string', () => {
    expect(quotedSpan("''")).toBe('');
  });
});

describe('parseLectorFindings', () => {
  it('parses a plain span with no apostrophe (unchanged behaviour)', () => {
    const [f] = parseLectorFindings("PAGE 3: 'a bridge of stone' -> 'a stone bridge'");
    expect(f).toMatchObject({ pageNumber: 3, quote: 'a bridge of stone', correction: 'a stone bridge' });
  });

  it('keeps a possessive inside the QUOTE', () => {
    const [f] = parseLectorFindings("PAGE 4: 'the boy's pole lantern went dark' -> 'the boy's lantern went dark'");
    expect(f.quote).toBe("the boy's pole lantern went dark");
    expect(f.correction).toBe("the boy's lantern went dark");
  });

  it('keeps a possessive inside the CORRECTION only', () => {
    const [f] = parseLectorFindings("PAGE 2: 'everyone' -> 'everyone else's'");
    expect(f.quote).toBe('everyone');
    expect(f.correction).toBe("everyone else's");
  });

  it('keeps possessives in BOTH sides', () => {
    const [f] = parseLectorFindings("PAGE 5: 'everyone's' -> 'everyone else's'");
    expect(f.quote).toBe("everyone's");
    expect(f.correction).toBe("everyone else's");
  });

  it('keeps contractions', () => {
    const fs = parseLectorFindings([
      "PAGE 1: 'dont go' -> 'don't go'",
      "PAGE 6: 'its cold outside' -> 'it's cold outside'",
    ].join('\n'));
    expect(fs.map((f: any) => f.correction)).toEqual(["don't go", "it's cold outside"]);
  });

  it('accepts both the ASCII arrow and the unicode arrow', () => {
    const a = parseLectorFindings("PAGE 7: 'the boy's cap' → 'the boy's hat'");
    const b = parseLectorFindings("PAGE 7: 'the boy's cap' -> 'the boy's hat'");
    // Same finding either way; only the echoed `raw` line differs.
    expect(a.map(({ raw, ...f }: any) => f)).toEqual(b.map(({ raw, ...f }: any) => f));
    expect(a[0].quote).toBe("the boy's cap");
    expect(a[0].correction).toBe("the boy's hat");
  });

  it('drops a finding whose correction is explicitly empty (no deletions)', () => {
    expect(parseLectorFindings("PAGE 3: 'the extra words' -> ''")).toHaveLength(0);
  });

  it('strips a trailing parenthetical alternative before reading the span', () => {
    const [f] = parseLectorFindings("PAGE 9: 'the boy's cap' -> 'the boy's hat' (oder 'the boy's hood')");
    expect(f.quote).toBe("the boy's cap");
    expect(f.correction).toBe("the boy's hat");
  });

  it('rejects a malformed line rather than mis-parsing it', () => {
    expect(parseLectorFindings("PAGE 3: 'unclosed span -> 'a fix'")).toHaveLength(0);
    expect(parseLectorFindings("PAGE 3: 'a span' -> 'unclosed fix")).toHaveLength(0);
    expect(parseLectorFindings('no page marker here -> nothing')).toHaveLength(0);
  });

  it('still drops a no-op finding where quote equals correction', () => {
    expect(parseLectorFindings("PAGE 3: 'the boy's cap' -> 'the boy's cap'")).toHaveLength(0);
  });

  it('the possessive span now reaches the page and is applied', () => {
    const pages = [{ pageNumber: 4, text: "Then the boy's pole lantern went dark like the rest." }];
    const findings = parseLectorFindings("PAGE 4: 'the boy's pole lantern went dark' -> 'the boy's lantern went dark'");
    const res = applyLectorFindings(pages, findings);
    expect(res.dropped).toHaveLength(0);
    expect(res.pages[0].text).toBe("Then the boy's lantern went dark like the rest.");
  });
});

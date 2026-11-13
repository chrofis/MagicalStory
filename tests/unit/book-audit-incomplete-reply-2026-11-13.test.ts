/**
 * Pipeline review 2026-11-13, finding 4: a review reply cut off by the vendor (finish reason
 * not stop), or one whose FAULT lines do not add up to its own "FAULTS: <count>" line, used to
 * be read as written. The unread tail scored as clean and those pages were never repaired.
 * Now such a reply is not a review: auditStoryBook fails (the book review then retries and
 * records the failure).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-ignore - CJS module
import { assertCompleteAuditReply } from '../../server/lib/bookAudit.js';

const IMG = 'data:image/jpeg;base64,/9j/AAAA';
const L1 = 'FAULT[IMG][MAJOR][scale][TOUCHUP]: p1 — Draw the cat smaller than the boy.';
const L2 = 'FAULT[TEXT][MINOR]: p2 — Say that the wand is in her hand.';

describe('assertCompleteAuditReply', () => {
  it('accepts a complete reply whose lines match its count', () => {
    expect(() => assertCompleteAuditReply({ text: `${L1}\n${L2}\nFAULTS: 2`, truncated: null }, 'c')).not.toThrow();
  });

  it('accepts a clean book that says so', () => {
    expect(() => assertCompleteAuditReply({ text: 'FAULTS: 0', truncated: null }, 'c')).not.toThrow();
  });

  it('rejects a reply the vendor cut off, even if what is there looks consistent', () => {
    expect(() => assertCompleteAuditReply({ text: `${L1}\nFAULTS: 1`, truncated: 'length' }, 'c')).toThrow(/cut off/);
  });

  it('rejects a reply with no closing count line (a list cut before its end)', () => {
    expect(() => assertCompleteAuditReply({ text: L1, truncated: null }, 'c')).toThrow(/no closing/);
  });

  it('rejects a reply whose count does not match its FAULT lines', () => {
    expect(() => assertCompleteAuditReply({ text: `${L1}\nFAULTS: 3`, truncated: null }, 'c')).toThrow(/declares 3 fault\(s\) but 1/);
  });
});

describe('auditStoryBook end to end with a faked vendor', () => {
  afterEach(() => vi.restoreAllMocks());

  async function runWith(text: string, finishReason: string) {
    const bookAudit: any = await import('../../server/lib/bookAudit.js');
    const prompts: any = await import('../../server/services/prompts.js');
    prompts.PROMPT_TEMPLATES.bookAudit = 'PAGES: {{PAGE_LIST}} {{TEXT_NOT_A_CHECKLIST}}';
    process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text }] }, finishReason }], usageMetadata: {} }),
    } as any);
    return bookAudit.auditStoryBook(
      { id: 's1', sceneImages: [{ pageNumber: 1, text: 't', imageData: IMG }, { pageNumber: 2, text: 't', imageData: IMG }] },
      { imageLoader: async () => IMG });
  }

  it('a complete reply is read and its faults counted', async () => {
    const r = await runWith(`${L1}\n${L2}\nFAULTS: 2`, 'STOP');
    expect(r).not.toBeNull();
    expect(r.faults).toBe(2);
  });

  it('a truncated reply is NOT reported as a (partly) clean book', async () => {
    const r = await runWith(L1, 'MAX_TOKENS');
    expect(r).toBeNull();
  });

  it('a reply missing lines against its own count is NOT reported as a review', async () => {
    const r = await runWith(`${L1}\nFAULTS: 2`, 'STOP');
    expect(r).toBeNull();
  });
});

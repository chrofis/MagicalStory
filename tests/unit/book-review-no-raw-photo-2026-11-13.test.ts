/**
 * Pipeline review 2026-11-13, finding 2: when a cast member had no avatar, the shared resolver
 * fell through to the customer's REAL photo (body / face) and the book review sent that photo of a
 * child to the reviewer as a "CAST REFERENCE". Only avatars are reference pictures now; a cast
 * member with only a real photo counts as "no picture" and is left out (logged as an error).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const bookAudit = require_('../../server/lib/bookAudit.js');
const sharp = require_('sharp');

async function jpeg(color: string) {
  const buf = await sharp({ create: { width: 32, height: 32, channels: 3, background: color } }).jpeg().toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}
const page = (n: number) => ({ pageNumber: n, text: `page ${n} text`, imageData: 'data:image/jpeg;base64,AAAA' });

async function reviewCall(characters: any[]) {
  const calls: any[] = [];
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = async (_u: any, init: any) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'FAULTS: 0' }] }, finishReason: 'STOP' }], usageMetadata: {} }) } as any;
  };
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
  try {
    await bookAudit.auditStoryBook({ id: 's1', characters, sceneImages: [page(1)] },
      { objectScale: false, modelId: 'gemini-2.5-flash', bookReview: { title: 'T' } });
  } finally { (globalThis as any).fetch = original; }
  return calls[0].contents[0].parts;
}

describe('the book review never sends a real photo as a cast reference', () => {
  it('a cast member with only a body photo gets no reference; the avatar of the other one is sent', async () => {
    const parts = await reviewCall([
      { id: 'c1', name: 'Anna', avatars: { standard: await jpeg('red') } },
      { id: 'c2', name: 'Ben', photos: { body: await jpeg('green'), face: await jpeg('green') } },
    ]);
    const caps = parts.filter((p: any) => (p.text || '').startsWith('CAST REFERENCE')).map((p: any) => p.text);
    expect(caps).toEqual(['CAST REFERENCE: Anna']);
    // one reference picture + one page, nothing else
    expect(parts.filter((p: any) => p.inline_data).length).toBe(2);
  });

  it('a cast of photos only sends no pictures and keeps the no-reference rule', async () => {
    const parts = await reviewCall([{ id: 'c2', name: 'Ben', photos: { face: await jpeg('green') } }]);
    expect(parts.some((p: any) => (p.text || '').startsWith('CAST REFERENCE'))).toBe(false);
    expect(parts[0].text).toContain('No reference pictures of the characters are given to you');
    expect(parts.filter((p: any) => p.inline_data).length).toBe(1);
  });
});

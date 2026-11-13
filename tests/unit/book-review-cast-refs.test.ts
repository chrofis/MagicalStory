import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const bookAudit = require_('../../server/lib/bookAudit.js');
const sharp = require_('sharp');

/**
 * THE BOOK REVIEW GETS THE CAST'S REFERENCE PICTURES (owner, 2026-11-13; docs/decisions.md).
 * Without them the whole-book review cannot tell two copies of one cast child apart. One captioned picture per cast
 * member, in every review call, and none when the book has no cast pictures or the call is the plain audit.
 */
async function jpeg(color: string) {
  const buf = await sharp({ create: { width: 32, height: 32, channels: 3, background: color } }).jpeg().toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}
const page = (n: number) => ({ pageNumber: n, text: `page ${n} text`, imageData: 'data:image/jpeg;base64,AAAA' });

async function run(story: any, opts: any) {
  const calls: any[] = [];
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = async (_u: any, init: any) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'FAULTS: 0' }] }, finishReason: 'STOP' }], usageMetadata: {} }) } as any;
  };
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
  try { await bookAudit.auditStoryBook(story, { objectScale: false, modelId: 'gemini-2.5-flash', ...opts }); } finally { (globalThis as any).fetch = original; }
  return calls;
}

describe('book review cast reference pictures', () => {
  it('attaches one captioned reference per cast member to the review call, after the instructions and before the pages', async () => {
    const characters = [
      { id: 'c1', name: 'Anna', avatars: { standard: await jpeg('red') } },
      { id: 'c2', name: 'Ben', avatars: { standard: await jpeg('blue') } },
    ];
    const calls = await run({ id: 's1', characters, sceneImages: [page(1), page(2)] }, { bookReview: { title: 'T' } });
    const parts = calls[0].contents[0].parts;
    const caps = parts.map((p: any, i: number) => (p.text || '').startsWith('CAST REFERENCE: ') ? i : -1).filter((i: number) => i >= 0);
    expect(caps.map((i: number) => parts[i].text)).toEqual(['CAST REFERENCE: Anna', 'CAST REFERENCE: Ben']);
    for (const i of caps) expect(parts[i + 1].inline_data).toBeTruthy();
    expect(caps[0]).toBeGreaterThan(0);
    expect(caps[1]).toBeLessThan(parts.findIndex((p: any) => (p.text || '').startsWith('PAGE 1 TEXT')));
    expect(parts[0].text).toContain('duplicate_character');
    expect(parts.filter((p: any) => p.inline_data).length).toBe(2 + 2);
  });

  it('sends none, and keeps the no-reference rule, when the book has no cast pictures', async () => {
    const calls = await run({ id: 's1', characters: [{ id: 'c1', name: 'Anna' }], sceneImages: [page(1)] }, { bookReview: { title: 'T' } });
    const parts = calls[0].contents[0].parts;
    expect(parts.some((p: any) => (p.text || '').startsWith('CAST REFERENCE'))).toBe(false);
    expect(parts[0].text).toContain('No reference pictures of the characters are given to you');
    expect(parts.filter((p: any) => p.inline_data).length).toBe(1);
  });

  it('the plain audit (no bookReview) never carries them', async () => {
    const characters = [{ id: 'c1', name: 'Anna', avatars: { standard: await jpeg('red') } }];
    const calls = await run({ id: 's1', characters, sceneImages: [page(1)] }, {});
    expect(calls[0].contents[0].parts.some((p: any) => (p.text || '').startsWith('CAST REFERENCE'))).toBe(false);
  });
});

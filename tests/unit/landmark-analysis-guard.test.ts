/**
 * A failed analysis must never be recorded as "this place has no photo".
 *
 * On 2026-08-29 those two were the same thing. `analyzeImageQuality` returns
 * null on an API error, an empty reply, or unparseable JSON — while a genuinely
 * bad photo comes back as a low SCORE. A thinking-budget misconfiguration made
 * gemini-2.5-flash spend its whole token cap on reasoning, so every reply was a
 * truncated `{"photoQuality": 8` fragment, every call returned null, and
 * `findBestLandmarkImage` announced "No good images found" for landmark after
 * landmark. 405 real Swiss places — Caumasee, Vanil de l'Ecri, Bahnhof
 * Versam-Safien — were written into the staging index as photoless, and nothing
 * downstream could tell that guess from a measured fact.
 *
 * These tests pin the distinction from both sides. No network, no API key, $0.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const GEMINI = 'generativelanguage.googleapis.com';

/** Two candidate photos, served entirely from memory. */
function stubWikimedia(url: string) {
  if (url.includes('list=categorymembers')) {
    return {
      query: {
        categorymembers: [
          { title: 'File:Caumasee_1.jpg' },
          { title: 'File:Caumasee_2.jpg' },
        ],
      },
    };
  }
  if (url.includes('prop=imageinfo')) {
    return {
      query: {
        pages: {
          '1': {
            imageinfo: [{
              url: 'https://upload.wikimedia.org/x/Caumasee.jpg',
              user: 'Someone', width: 1600, height: 1200,
            }],
          },
        },
      },
    };
  }
  // Wikidata P373 ("Commons category") → the category to pull photos from.
  if (url.includes('wikidata.org')) {
    return {
      entities: {
        Q1: { claims: { P373: [{ mainsnak: { datavalue: { value: 'Caumasee' } } }] } },
      },
    };
  }
  return {};
}

/** finishReason MAX_TOKENS + a cut-off JSON fragment: the real 2026-08-29 reply. */
const TRUNCATED = {
  candidates: [{
    finishReason: 'MAX_TOKENS',
    content: { parts: [{ text: '```json\n{\n  "photoQuality": 8' }] },
  }],
  usageMetadata: { thoughtsTokenCount: 284, candidatesTokenCount: 12 },
};

/** A complete, well-formed verdict that the photos are simply not usable. */
const HONEST_REJECTION = {
  candidates: [{
    finishReason: 'STOP',
    content: { parts: [{ text: JSON.stringify({
      photoQuality: 2, isLandmarkPhoto: false, isPhoto: true, isActualPhoto: true,
      isExterior: true, locationMatch: 1, description: 'a blurry unrelated snapshot', score: 2,
    }) }] },
  }],
  usageMetadata: { thoughtsTokenCount: 0, candidatesTokenCount: 60 },
};

function mockFetch(geminiReply: unknown) {
  return vi.fn(async (input: any) => {
    const url = String(input);
    // The photo download itself: the analyser base64s these bytes before it
    // can ask anything about them.
    if (url.startsWith('https://upload.wikimedia.org/')) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xdb]).buffer,
        headers: { get: () => 'image/jpeg' },
      } as any;
    }
    const body = url.includes(GEMINI) ? geminiReply : stubWikimedia(url);
    return { ok: true, status: 200, json: async () => body } as any;
  });
}

describe('landmark photo analysis — failure is not a verdict', () => {
  const realFetch = global.fetch;
  const realKey = process.env.GEMINI_API_KEY;

  beforeEach(() => { process.env.GEMINI_API_KEY = 'unit-test-key'; });
  afterEach(() => {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = realKey;
  });

  it('refuses to conclude "no photos" when every analysis failed', async () => {
    global.fetch = mockFetch(TRUNCATED);
    const { findBestLandmarkImage } = require('../../server/lib/landmarkPhotos.js');

    await expect(
      findBestLandmarkImage('Caumasee', 'Lake', 'de', null, 'Q1', 'Graubünden', 'Switzerland')
    ).rejects.toMatchObject({ analysisUnavailable: true });
  });

  it('still returns null when the analyser worked and the photos are genuinely unusable', async () => {
    global.fetch = mockFetch(HONEST_REJECTION);
    const { findBestLandmarkImage } = require('../../server/lib/landmarkPhotos.js');

    const result = await findBestLandmarkImage(
      'Caumasee', 'Lake', 'de', null, 'Q1', 'Graubünden', 'Switzerland'
    );
    expect(result).toBeNull();
  });
});

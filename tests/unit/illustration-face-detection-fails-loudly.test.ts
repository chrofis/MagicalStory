/**
 * Owner 2026-10-07 ("fail loudly too"): a failed illustration face pass is an
 * error, not an empty face list. detectIllustrationFaces throws on every
 * analyzer failure; both callers report it at ERROR + failure_log and keep their
 * own boxes instead of treating the page as faceless.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ec = require('../../server/lib/entityConsistency.js');
const realFetch = globalThis.fetch;
const reply = (status: number, body: any) => async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { globalThis.fetch = realFetch; });

describe('detectIllustrationFaces', () => {
  it('returns the faces on success, and [] only when the detectors found none', async () => {
    globalThis.fetch = reply(200, { success: true, total_faces: 0, faces: [] }) as any;
    await expect(ec.detectIllustrationFaces('data:image/png;base64,AA')).resolves.toEqual([]);
    globalThis.fetch = reply(200, { success: true, total_faces: 1, faces: [{ source: 'anime' }] }) as any;
    await expect(ec.detectIllustrationFaces('data:image/png;base64,AA')).resolves.toHaveLength(1);
  });
  it('throws on a non-2xx analyzer answer', async () => {
    globalThis.fetch = reply(500, { success: false, error: 'illustration face detection failed: boom' }) as any;
    await expect(ec.detectIllustrationFaces('x')).rejects.toThrow(/HTTP 500/);
  });
  it('throws on success:false', async () => {
    globalThis.fetch = reply(200, { success: false, error: 'Failed to decode image' }) as any;
    await expect(ec.detectIllustrationFaces('x')).rejects.toThrow(/Failed to decode image/);
  });
  it('throws when the analyzer is unreachable', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as any;
    await expect(ec.detectIllustrationFaces('x')).rejects.toThrow(/unavailable: ECONNREFUSED/);
  });
});

describe('both callers report the failure loudly', () => {
  const src = (f: string) => fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'lib', f), 'utf8');
  it('bbox detection reports and marks the result', () => {
    const s = src('bboxDetection.js');
    expect(s).toMatch(/reportCascadeFailure\('\[BBOX-DETECT\]', pageLabel, cascadeErr\)/);
    expect(s).toMatch(/cascadeFaceError,/);
    expect(s).not.toMatch(/Cascade merge skipped/);
  });
  it('entity collection reports', () => {
    const s = src('entityConsistency.js');
    expect(s).toMatch(/reportCascadeFailure\('\[ENTITY-COLLECT\]'/);
    expect(s).not.toMatch(/Cascade face detection skipped/);
  });
});

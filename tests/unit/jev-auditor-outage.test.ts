import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * THE TWO JEV AUDITORS GET THE SAME OUTAGE POLICY AS THE DECISIONS (2026-09-30).
 *
 * The decision layer waits out a Jev outage (retry up to 5 min, then the story's
 * backup); the arc cast check and the text audit failed on the FIRST error, so a
 * short outage silently dropped their findings. Now:
 *   - both retry through jevDecisions.callJevWaiting by default;
 *   - a missing key is configuration, never retried;
 *   - a story already on the Jev-outage backup is not asked again (no second wait).
 */
// @ts-ignore CommonJS
const J = require('../../server/lib/jevAudit');
// @ts-ignore CommonJS
const D = require('../../server/lib/jevDecisions');

const ARC_BLOCK = 'STORY LOGIC:\nWANT: the egg\n\nFINAL ARC:\n1. Levin finds an egg.\n2. Julian carries it.\n3. They bring it home.';
const PAGES = [{ pageNumber: 1, text: 'Mia ging in den Garten.', planLine: '' }];
const FALLBACK = { step: 'landmarks', reason: 'down', at: '2026-09-30T00:00:00Z' };

const originalCall = J.callJev;
const savedOutage = { ...D.JEV_OUTAGE };
let calls = 0;

/** Every question answered yes; fails `failFirst` times with `error` first. */
function stubJev(failFirst: number, error = 'jevAudit: HTTP 503: upstream down') {
  calls = 0;
  J.callJev = async ({ questions }: any) => {
    calls++;
    if (calls <= failFirst) throw new Error(error);
    const answers: any = {};
    for (const id of Object.keys(questions)) answers[id] = { type: 'noul', noul: 0.9 };
    return { answers, cost: 0, usage: {}, model: 'stub' };
  };
}

beforeEach(() => { Object.assign(D.JEV_OUTAGE, { waitMs: 5000, maxBackoffMs: 5 }); });
afterEach(() => { J.callJev = originalCall; Object.assign(D.JEV_OUTAGE, savedOutage); });

describe('arc cast check', () => {
  it('waits out a short outage instead of dropping the check', async () => {
    stubJev(2);
    const r = await J.jevCastBeatVoice(ARC_BLOCK, ['Levin', 'Julian']);
    expect(r.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('a missing key is not an outage: no retry', async () => {
    stubJev(99, 'jevAudit: OPENROUTER_API_KEY is not set');
    const r = await J.jevCastBeatVoice(ARC_BLOCK, ['Levin']);
    expect(r.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('gives up after the wait, as the decisions do', async () => {
    Object.assign(D.JEV_OUTAGE, { waitMs: 30 });
    stubJev(Infinity);
    const r = await J.jevCastBeatVoice(ARC_BLOCK, ['Levin']);
    expect(r.ok).toBe(false);
    expect(calls).toBeGreaterThan(1);
  });

  it('a story already on the backup is not asked again', async () => {
    stubJev(0);
    const { jevCast } = await J.arcRepairFindingsWithCastCheck(
      { critique: '', reviewedArc: ARC_BLOCK, panel: [], castNames: ['Levin'] }, { jevFallback: FALLBACK });
    expect(calls).toBe(0);
    expect(jevCast.skipped).toContain('backup from step "landmarks"');
  });
});

describe('text audit', () => {
  it('waits out a short outage instead of dropping every Jev finding', async () => {
    stubJev(1);
    const r = await J.runJevTextSource({ language: 'de-ch' }, PAGES, { concurrency: 1 });
    expect(r.ok).toBe(true);
    expect(calls).toBeGreaterThan(1);
  });

  it('a story already on the backup is not asked again', async () => {
    stubJev(0);
    const r = await J.runJevTextSource({ language: 'de-ch' }, PAGES, { jevFallback: FALLBACK });
    expect(calls).toBe(0);
    expect(r).toMatchObject({ ok: false, skipped: expect.stringContaining('backup') });
  });
});

describe('the model id lives with every other model', () => {
  it('jevAudit reads MODEL_DEFAULTS.jevModel', () => {
    const { MODEL_DEFAULTS } = require('../../server/config/models');
    expect(J.JEV_MODEL).toBe(MODEL_DEFAULTS.jevModel);
    expect(MODEL_DEFAULTS.jevModel).toBe('typesafe/jev-1.13');
  });
});

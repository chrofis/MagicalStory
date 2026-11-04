import { describe, it, expect } from 'vitest';

// A name the scan alone finds is a candidate; Jev rules whether it is DRAWN.
// Evidence: prod job_1793736454070_0ir5y6hlh p8 (garment owner stored as page cast),
// job_1789207854566_l43qgl34w p7 (real cast described in prose only).
const { rejectedScanCandidates } = require('../../server/lib/jevPagePresence');
const { unionPageCast } = require('../../server/lib/sceneMetadata');

const CAST = [{ name: 'Lia' }, { name: 'Oma Nicole' }, { name: 'Opa Dirk' }];
const brief = (prose: string, characters: string[]) =>
  `${prose}\n\n---METADATA---\n${JSON.stringify({ sceneIntent: 'x', characters: characters.map(name => ({ name, position: 'center', depth: 'foreground' })), objects: [] })}`;

const FOX = 'Fridolin leaps onto the snow, his bushy tail wrapped in Oma Nicole\'s fringed red wool scarf.';
const stub = (p: number, seen: any[] = []) => async (req: any) => {
  seen.push(req);
  const answers: any = {};
  for (const k of Object.keys(req.questions)) answers[k] = { noul: p };
  return { answers, cost: 0.00004, usage: {}, model: 'stub' };
};
const names = (xs: any[]) => xs.map(c => c.name);

describe('rejectedScanCandidates', () => {
  it('garment owner named in the prose of a cast-less brief is rejected and leaves the page cast', async () => {
    const d = brief(FOX, []);
    const notDrawn = await rejectedScanCandidates(d, [], CAST, { callImpl: stub(0.03) });
    expect(names([...notDrawn])).toEqual(['Oma Nicole']);
    expect(unionPageCast(d, [], CAST, { notDrawn })).toEqual([]);
    // without the decision the old behaviour stands (this is what failed before the fix)
    expect(names(unionPageCast(d, [], CAST))).toEqual(['Oma Nicole']);
  });

  it('real cast described only in prose stays', async () => {
    const d = brief('Lia and Opa Dirk stand at the rim of the shaft.', []);
    const notDrawn = await rejectedScanCandidates(d, [], CAST, { callImpl: stub(0.98) });
    expect(notDrawn.size).toBe(0);
    expect(names(unionPageCast(d, [], CAST, { notDrawn })).sort()).toEqual(['Lia', 'Opa Dirk']);
  });

  it('never drops what the hint commissioned, even when Jev says no', async () => {
    const d = brief('Lia waves at Oma Nicole.', []);
    const seen: any[] = [];
    const notDrawn = await rejectedScanCandidates(d, ['Oma Nicole'], CAST, { callImpl: stub(0.01, seen) });
    expect(Object.keys(seen[0].questions)).toHaveLength(1); // only Lia was asked
    expect(names(unionPageCast(d, ['Oma Nicole'], CAST, { notDrawn })).sort()).toEqual(['Oma Nicole']);
  });

  it('makes no call when the brief lists its own cast', async () => {
    const seen: any[] = [];
    const d = brief(FOX, ['Lia']);
    const notDrawn = await rejectedScanCandidates(d, [], CAST, { callImpl: stub(0, seen) });
    expect(seen).toHaveLength(0);
    expect(names(unionPageCast(d, [], CAST, { notDrawn }))).toEqual(['Lia']);
  });

  it('makes no call when the scan found nobody', async () => {
    const seen: any[] = [];
    await rejectedScanCandidates(brief('A fox leaps.', []), [], CAST, { callImpl: stub(0, seen) });
    expect(seen).toHaveLength(0);
  });

  it('the question text carries the name only as a filled-in slot', async () => {
    const seen: any[] = [];
    await rejectedScanCandidates(brief(FOX, []), [], CAST, { callImpl: stub(0.9, seen) });
    expect(seen[0].questions.PRESENT0.instructions).toContain('Oma Nicole is physically present');
    expect(seen[0].state).not.toContain('---METADATA---');
  });

  it('a Jev failure throws JevDecisionError and returns no scan result', async () => {
    const fail = async () => { throw new Error('jevAudit: OPENROUTER_API_KEY is not set'); };
    await expect(rejectedScanCandidates(brief(FOX, []), [], CAST, { callImpl: fail })).rejects.toMatchObject({ name: 'JevDecisionError' });
  });
});

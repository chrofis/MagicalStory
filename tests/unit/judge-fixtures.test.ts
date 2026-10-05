/**
 * Judge regression fixtures (2026-09-26) — the scoring that turns a replayed
 * judge answer into TP / FN / TN / FP, the per-judge recall / precision / flip
 * aggregation, the committed fixture file's validity, and the Lab stage's
 * dispatch (the judge stubbed: no DB row beyond a stub, no network, no model).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require_ = createRequire(import.meta.url);
const JF = require_('../../server/lib/judgeFixtures');

const f = (type: string, severity: string | null, text = '', extra: any = {}) =>
  ({ type, severity, text, character: null, pages: [], fields: {}, ...extra });

describe('scoreFixture', () => {
  it('flag: a matching finding is a TP, none is an FN', () => {
    const exp = { verdict: 'flag', types: ['setting'], minSeverity: 'MAJOR' };
    expect(JF.scoreFixture(exp, [f('setting', 'CRITICAL')]).outcome).toBe('TP');
    expect(JF.scoreFixture(exp, [f('setting', 'MODERATE')]).outcome).toBe('FN');
    expect(JF.scoreFixture(exp, [f('clothing', 'CRITICAL')]).outcome).toBe('FN');
    expect(JF.scoreFixture(exp, []).outcome).toBe('FN');
  });

  it('pass: a matching finding is an FP, none is a TN', () => {
    const exp = { verdict: 'pass', types: ['setting'], minSeverity: 'MAJOR', fields: { landmark_element: true } };
    expect(JF.scoreFixture(exp, [f('setting', 'CRITICAL', 'Eiffel Tower', { fields: { landmark_element: true } })]).outcome).toBe('FP');
    // a setting finding that is not about the landmark does not answer this fixture
    expect(JF.scoreFixture(exp, [f('setting', 'CRITICAL', 'wrong room', { fields: { landmark_element: false } })]).outcome).toBe('TN');
    expect(JF.scoreFixture(exp, []).outcome).toBe('TN');
  });

  it('a finding with no severity never meets a severity bound; without a bound any type match counts', () => {
    expect(JF.scoreFixture({ verdict: 'flag', types: ['text'], minSeverity: 'MINOR' }, [f('text', null)]).outcome).toBe('FN');
    expect(JF.scoreFixture({ verdict: 'flag', types: ['text'] }, [f('text', null, 'signature')]).outcome).toBe('TP');
  });

  it('about is an any-of word locator on the finding text, case-insensitive', () => {
    const exp = { verdict: 'flag', types: ['setting'], about: ['fog', 'sun'] };
    expect(JF.scoreFixture(exp, [f('setting', 'MAJOR', 'The FOG is missing')]).outcome).toBe('TP');
    expect(JF.scoreFixture(exp, [f('setting', 'MAJOR', 'wrong street')]).outcome).toBe('FN');
  });

  it('page and character scope a story-level finding', () => {
    const findings = [f('missing_character', 'MAJOR', 'Manuel absent', { pages: [7], character: 'Manuel' })];
    expect(JF.scoreFixture({ verdict: 'pass', page: 7, about: ['manuel'] }, findings).outcome).toBe('FP');
    expect(JF.scoreFixture({ verdict: 'pass', page: 8, about: ['manuel'] }, findings).outcome).toBe('TN');
    expect(JF.scoreFixture({ verdict: 'flag', character: 'manuel' }, findings).outcome).toBe('TP');
  });

  it('minPanelists counts distinct panelists raising a matching finding', () => {
    const one = [f('PLACE', 'MAJOR', 'door', { fields: { panelist: 'a' } }), f('PLACE', 'MINOR', 'door', { fields: { panelist: 'a' } })];
    expect(JF.scoreFixture({ verdict: 'flag', types: ['PLACE'], minPanelists: 2 }, one).outcome).toBe('FN');
    const two = [...one, f('PLACE', 'MAJOR', 'door', { fields: { panelist: 'b' } })];
    expect(JF.scoreFixture({ verdict: 'flag', types: ['PLACE'], minPanelists: 2 }, two).outcome).toBe('TP');
  });

  it('rejects an expectation without a verdict and an unknown severity', () => {
    expect(() => JF.scoreFixture({ types: ['x'] }, [])).toThrow(/verdict/);
    expect(() => JF.scoreFixture({ verdict: 'flag', minSeverity: 'HUGE' }, [f('x', 'MAJOR')])).toThrow(/minSeverity/);
  });
});

describe('normalizeFindings — one shape per judge', () => {
  it('semantic keeps type, severity, character and the landmark flag', () => {
    const out = JF.normalizeFindings('semantic', { semanticIssues: [{ type: 'setting', severity: 'critical', description: 'd', landmark_element: true, sources: ['semantic'] }] });
    expect(out[0]).toMatchObject({ type: 'setting', severity: 'CRITICAL', text: 'd', fields: { landmark_element: true, sources: ['semantic'] } });
  });

  it('quality and lettering split evaluateImageQuality output on the lettering check', () => {
    const r = { fixableIssues: [
      { type: 'rendered_text', severity: 'CRITICAL', source: 'lettering-check', description: 'caption' },
      { type: 'extra_character', severity: 'CRITICAL', sources: ['final_checks'], description: 'two children' },
      { type: 'rendered_text', severity: 'MAJOR', sources: ['quality'], description: 'caption' },
    ] };
    expect(JF.normalizeFindings('quality', r).map((x: any) => x.type)).toEqual(['extra_character', 'rendered_text']);
    expect(JF.normalizeFindings('lettering', r).map((x: any) => x.severity)).toEqual(['CRITICAL']);
  });

  it('plate_qc findings are check keys with no severity', () => {
    expect(JF.normalizeFindings('plate_qc', { qc: { findings: [{ check: 'text', issue: 'signature' }] } }))
      .toEqual([{ type: 'text', severity: null, text: 'signature', character: null, pages: [], fields: {} }]);
  });

  it('entity names each issue after its character and keeps its pages', () => {
    const out = JF.normalizeFindings('entity', { report: { characters: { Lorena: { issues: [{ type: 'face_drift', severity: 'critical', description: 'vitiligo absent', pagesToFix: [2, 5] }] } } } });
    expect(out[0]).toMatchObject({ character: 'Lorena', severity: 'CRITICAL', pages: [2, 5] });
  });

  it('book_audit reads both routes with the page and the whole line', () => {
    const out = JF.normalizeFindings('book_audit', { byRoute: { IMG: [{ page: 7, severity: 'MAJOR', type: 'missing_character', line: 'FAULT[IMG] p7 Manuel absent' }], TEXT: [] } });
    expect(out[0]).toMatchObject({ type: 'missing_character', pages: [7], fields: { route: 'IMG' }, text: 'FAULT[IMG] p7 Manuel absent' });
  });

  it('arc_panel reads each ok panelist, lens as type', () => {
    const out = JF.normalizeFindings('arc_panel', { runs: [
      { ok: true, model: 'm1', findings: [{ lens: 'REPLACEABLE', severity: 'MAJOR', text: 't', sentences: [7] }] },
      { ok: false, model: 'm2', error: 'x' },
    ] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'REPLACEABLE', fields: { panelist: 'm1' } });
  });

  it('an unknown judge throws', () => {
    expect(() => JF.normalizeFindings('nope', {})).toThrow(/unknown judge/);
  });
});

describe('summarize', () => {
  it('counts every replay, keeps errors out of the rates, and finds flips', () => {
    const s = JF.summarize([
      { fixtureId: 'a', judge: 'semantic', outcome: 'TP' },
      { fixtureId: 'a', judge: 'semantic', outcome: 'FN' },
      { fixtureId: 'b', judge: 'semantic', outcome: 'TN' },
      { fixtureId: 'b', judge: 'semantic', outcome: 'TN' },
      { fixtureId: 'c', judge: 'semantic', outcome: 'FP' },
      { fixtureId: 'd', judge: 'semantic', error: 'boom' },
      { fixtureId: 'e', judge: 'plate_qc', outcome: 'TP' },
    ]);
    const j = s.judges.semantic;
    expect(j).toMatchObject({ fixtures: 4, runs: 5, tp: 1, fn: 1, tn: 2, fp: 1, errors: 1, repeated: 2, flipped: 1 });
    expect(j.recall).toBe(0.5);
    expect(j.precision).toBe(0.5);
    expect(j.falseAlarmRate).toBeCloseTo(1 / 3);
    expect(j.flipRate).toBe(0.5);
    expect(s.judges.plate_qc.precision).toBe(1);
    expect(s.judges.plate_qc.flipRate).toBeNull();
    expect(s.overall).toMatchObject({ tp: 2, runs: 6, errors: 1 });
  });

  it('a judge with no positives has no recall rather than a zero', () => {
    const s = JF.summarize([{ fixtureId: 'a', judge: 'x', outcome: 'TN' }]);
    expect(s.judges.x.recall).toBeNull();
    expect(s.judges.x.precision).toBeNull();
  });
});

describe('the committed fixture file', () => {
  const doc = JSON.parse(readFileSync(resolve(__dirname, '../judge-fixtures/fixtures.json'), 'utf8'));
  it('is valid, and holds negatives as well as positives for the judges it samples most', () => {
    expect(JF.validateFixtures(doc.fixtures)).toEqual([]);
    for (const judge of ['semantic', 'plate_qc']) {
      const verdicts = new Set(doc.fixtures.filter((x: any) => x.judge === judge).map((x: any) => x.expect.verdict));
      expect(verdicts).toEqual(new Set(['flag', 'pass']));
    }
  });

  it('validateFixtures catches the mistakes a hand-written entry makes', () => {
    const problems = JF.validateFixtures([
      { id: 'Bad Id', judge: 'semantic', target: { storyId: 's' }, expect: { verdict: 'maybe' }, source: '' },
      { id: 'p', judge: 'plate_qc', target: { storyId: 's', pageNumber: 1 }, input: { imageUrl: 'https://x/p.jpg' }, expect: { verdict: 'flag', minSeverity: 'MAJOR' }, source: 's' },
    ]);
    expect(problems.join('\n')).toMatch(/kebab-case/);
    expect(problems.join('\n')).toMatch(/pageNumber required/);
    expect(problems.join('\n')).toMatch(/imageUrl/);
    expect(problems.join('\n')).toMatch(/flag\|pass/);
    expect(problems.join('\n')).toMatch(/source note/);
    expect(problems.join('\n')).toMatch(/no severity/);
  });
});

describe('estimateCostUsd', () => {
  it('prices measured usage and labels flat estimates as estimates', () => {
    expect(JF.estimateCostUsd('book_audit', { cost: 0.031 })).toEqual({ usd: 0.031, basis: 'measured (stage cost)' });
    expect(JF.estimateCostUsd('plate_qc', {}).basis).toMatch(/estimate/);
    const sem = JF.estimateCostUsd('semantic', { usage: { input_tokens: 14000, output_tokens: 1000, thinking_tokens: 2000, tokens: 17000 }, semanticIssues: [] });
    expect(sem.basis).toMatch(/measured/);
    expect(sem.usd).toBeGreaterThan(0.004);
    expect(sem.usd).toBeLessThan(0.02);
  });
});

describe('judge_fixture stage dispatch (judges stubbed)', () => {
  const database = require_('../../server/services/database');
  const images = require_('../../server/lib/images');
  const r2 = require_('../../server/lib/r2');
  const PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const scene = { pageNumber: 4, text: 'x', sceneDescription: 'a park', sceneMetadata: { fullData: { shot: 'wide', characters: [] } } };
  database.dbQuery = async () => [{ scene_text: JSON.stringify(scene), art_style: 'watercolor', layout: { textInImage: false }, visual_bible: null, clothing_reqs: null, characters_json: '[]', character_avatars: null }];
  database.getActiveVersion = async () => 0;
  r2.bytesFromAnyImage = async () => PX;
  const { runJudgeFixtureStage } = require_('../../server/lib/testlab');

  it('plate_qc: judges the fixture image with the page QC set and scores it', async () => {
    const seen: any[] = [];
    images.validateEmptyScene = async (img: string, textPos: any, label: string, opts: any) => {
      seen.push({ img, textPos, opts });
      return { pass: false, issues: ['signature bottom right'], findings: [{ check: 'text', issue: 'signature bottom right' }] };
    };
    const res = await runJudgeFixtureStage(
      { storyId: 's', pageNumber: 4, fixture: 'plate-x' },
      { experimentId: 1, params: { judge: 'plate_qc', imageUrl: 'https://x/p.jpg', expect: { verdict: 'flag', types: ['text'] } } },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].img).toMatch(/^data:image\/png;base64,/);
    expect(seen[0].textPos).toBeNull();
    expect(seen[0].opts.artStyle).toBeTruthy();
    expect(res).toMatchObject({ judge: 'plate_qc', fixtureId: 'plate-x', verdict: { outcome: 'TP' } });
    expect(res.cost.basis).toMatch(/estimate/);
  });

  it('refuses an unknown judge and a missing expectation', async () => {
    await expect(runJudgeFixtureStage({ storyId: 's' }, { params: { judge: 'nope', expect: { verdict: 'pass' } } })).rejects.toThrow(/unknown judge/);
    await expect(runJudgeFixtureStage({ storyId: 's' }, { params: { judge: 'semantic' } })).rejects.toThrow(/expect/);
  });
});

describe('sheet_kept (Lab-only kept-garment check, 2026-10-05)', () => {
  const checks = [
    { garment: 'brown leather baldric', visible: false, reason: 'cells 5-8 show no strap' },
    { garment: 'wide brown leather belt', visible: true, reason: 'all four' },
  ];
  it('a kept garment that is not visible is one finding of type kept; visible ones are none', () => {
    const found = JF.normalizeFindings('sheet_kept', { checks });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ type: 'kept', fields: { garment: 'brown leather baldric' } });
    expect(JF.scoreFixture({ verdict: 'flag', types: ['kept'], about: ['baldric'] }, found).outcome).toBe('TP');
    expect(JF.scoreFixture({ verdict: 'pass' }, JF.normalizeFindings('sheet_kept', { checks: [checks[1]] })).outcome).toBe('TN');
  });
  it('a fixture without a kept list or an image URL is invalid', () => {
    const base = { id: 'k-x', judge: 'sheet_kept', target: { storyId: 's' }, expect: { verdict: 'pass' }, source: 'x' };
    expect(JF.validateFixtures([{ ...base, input: { imageUrl: 'https://a/b.jpg', keptGarments: [{ type: 'tunic', colour: 'red', details: 'wool' }] } }])).toEqual([]);
    expect(JF.validateFixtures([{ ...base, input: { imageUrl: 'https://a/b.jpg' } }]).join()).toMatch(/keptGarments/);
    expect(JF.validateFixtures([{ ...base, input: { keptGarments: [{ type: 'tunic', colour: 'red', details: 'wool' }] } }]).join()).toMatch(/imageUrl/);
  });
});

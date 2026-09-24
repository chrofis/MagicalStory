/**
 * The verification registry (tasks/verify.json): the push gate's decision core,
 * verify-run's classification, and a few check functions against synthetic runs.
 *
 * WHY — owner, 2026-09-24: "we do 20 changes that need a new story. When we
 * rerun it we should ensure if all 20 are tested or not." The gate makes a
 * behaviour change register how a run will prove it; verify-run.js reads a
 * stored run and must never report a pass for a change the run's build lacks
 * or a run shape the run does not have.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { analyze, parseTrailers, changedEntries } = require('../../scripts/admin/check-verify-coupling.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WATCHED } = require('../../scripts/admin/check-doc-coupling.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { judge } = require('../../scripts/admin/verify-run.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checks, evalRunShape } = require('../../scripts/admin/verify-checks.js');

const commit = (sha: string, message: string, files: string[]) => ({ sha: sha.padEnd(40, '0'), message, files });
const opts = (over: any = {}) => ({ watched: WATCHED, registryChanged: [], knownIds: new Set(['emotion-enum']), ...over });

describe('check-verify-coupling: decision core', () => {
  it('blocks a behaviour commit with no entry and no trailer', () => {
    const r = analyze([commit('a1', 'fix(prompt): x', ['prompts/scene-review.txt'])], opts());
    expect(r.blocks).toHaveLength(1);
  });

  it('ignores a commit that touches no watched file', () => {
    const r = analyze([commit('a2', 'test: y', ['tests/unit/x.test.ts', 'scripts/admin/foo.js'])], opts());
    expect(r.blocks).toEqual([]);
    expect(r.passes).toEqual([]);
  });

  it('passes every behaviour commit when the push range registers an entry', () => {
    const r = analyze([
      commit('a3', 'feat: a', ['storyJobPipeline.js']),
      commit('a4', 'feat: b', ['prompts/text-refine.txt']),
    ], opts({ registryChanged: ['new-entry'] }));
    expect(r.blocks).toEqual([]);
    expect(r.passes).toHaveLength(2);
  });

  it('accepts Verify: none (<reason>) and Verify: <known id>', () => {
    const r = analyze([
      commit('a5', 'refactor: z\n\nVerify: none (byte-identical prompt, replayed)', ['prompts/x.txt']),
      commit('a6', 'fix: w\n\nVerify: emotion-enum', ['server/lib/evalPipeline.js']),
    ], opts());
    expect(r.blocks).toEqual([]);
  });

  it('blocks a reason-less none, an unknown id, and garbage', () => {
    const r = analyze([
      commit('a7', 'x\n\nVerify: none', ['prompts/x.txt']),
      commit('a8', 'x\n\nVerify: no-such-entry', ['prompts/x.txt']),
      commit('a9', 'x\n\nVerify: I checked it', ['prompts/x.txt']),
    ], opts());
    expect(r.blocks).toHaveLength(3);
  });

  it('parses trailers anywhere in the message body', () => {
    expect(parseTrailers('s\n\nbody\nVerify: none (docs only)\nCo-Authored-By: x')).toEqual({ none: ['docs only'], ids: [], bad: [] });
  });

  it('counts added or re-specified entries, never evidence-only changes', () => {
    const base = { entries: [{ id: 'a', title: 't', claim: 'c', commits: ['1'], runShape: ['any'], check: { kind: 'human', what: 'w' }, status: 'pending', evidence: [] }] };
    const evidenceOnly = JSON.parse(JSON.stringify(base));
    evidenceOnly.entries[0].evidence.push({ storyId: 's' });
    evidenceOnly.entries[0].status = 'confirmed';
    expect(changedEntries(JSON.stringify(base), JSON.stringify(evidenceOnly))).toEqual([]);
    const reclaimed = JSON.parse(JSON.stringify(base));
    reclaimed.entries[0].claim = 'c2';
    reclaimed.entries.push({ id: 'b', claim: 'new' });
    expect(changedEntries(JSON.stringify(base), JSON.stringify(reclaimed)).sort()).toEqual(['a', 'b']);
    expect(changedEntries(null, JSON.stringify(base))).toEqual(['a']);
  });
});

describe('verify-run: classification', () => {
  const entry = { id: 'e', commits: ['abc1234'], runShape: ['full-story'], check: { kind: 'auto', fn: 'charFixNoJudgeText' } };
  const run = (versions: any[]) => ({ build: 'f'.repeat(40), data: { trialMode: false, sceneImages: [{ pageNumber: 1, imageVersions: versions }] } });
  const has = () => true;

  it('is NOT COVERED when the run recorded no build', () => {
    expect(judge(entry, { ...run([]), build: null }, has).result).toBe('NOT COVERED');
  });

  it('is NOT COVERED when the build lacks the commit, but still shows the old-code reading', () => {
    const j = judge(entry, run([{ source: 'char-fix-round-1', prompt: 'Issues to fix: judge prose' }]), () => false);
    expect(j.result).toBe('NOT COVERED');
    expect(j.oldCode).toBe(true);
    expect(j.r.pass).toBe(false);
  });

  it('is NOT COVERED when the run shape is absent — never a pass', () => {
    expect(judge(entry, run([{ source: 'original', prompt: 'x' }]), has).result).toBe('NOT COVERED');
  });

  it('FAILED and CONFIRMED follow the check on a covering run', () => {
    expect(judge(entry, run([{ source: 'char-fix-round-1', prompt: 'Issues to fix: the canonical dark-eyed boy' }]), has).result).toBe('FAILED');
    expect(judge(entry, run([{ source: 'char-fix-round-1', prompt: 'Defect to fix: the face does not read as this character' }]), has).result).toBe('CONFIRMED');
  });

  it('a human-kind entry is HUMAN, never CONFIRMED', () => {
    const h = { id: 'h', commits: [], runShape: ['any'], check: { kind: 'human', what: 'look' } };
    expect(judge(h, run([]), has).result).toBe('HUMAN');
  });
});

describe('verify-checks: run shapes and checks', () => {
  it('age-band takes one age or an alternation', () => {
    const ctx = { data: { trialMode: true, characters: [{ name: 'A', age: '12' }] } };
    expect(evalRunShape(['trial', 'age-band:8|12'], ctx).ok).toBe(true);
    expect(evalRunShape(['trial', 'age-band:4'], ctx).ok).toBe(false);
    expect(evalRunShape(['no-such-shape'], ctx).ok).toBe(false);
  });

  it('iterateCastFromRewrite flags figures the rewrite did not list', () => {
    const ctx = { data: { sceneImages: [{ pageNumber: 17, imageVersions: [
      { source: 'original' },
      { source: 'iterate-round-1', sceneMetadata: { fullData: { characters: [{ name: 'Turi' }] } }, sceneCharacters: [{ name: 'Levin' }] },
    ] }] } };
    const r = checks.iterateCastFromRewrite(ctx);
    expect(r.covered).toBe(true);
    expect(r.pass).toBe(false);
  });

  it('wornOffGrid passes only when the off page sits in an --off: grid', () => {
    const page = { pageNumber: 11, sceneMetadata: { fullData: { wornItems: [{ id: 'ART004', owner: 'Kiaan', state: 'off' }] } } };
    const grid = (key: string) => ({ characters: { Kiaan: { byClothing: { [key]: { appearances: [{ pageNumber: 11 }] } } } } });
    expect(checks.wornOffGrid({ data: { sceneImages: [page], finalChecksReport: { entity: grid('standard--off:ART004') } } }).pass).toBe(true);
    expect(checks.wornOffGrid({ data: { sceneImages: [page], finalChecksReport: { entity: grid('standard') } } }).pass).toBe(false);
  });

  it('sizeComparisons counts comparisons in arc, plan and German text', () => {
    const ctx = { data: {
      arcReviewReport: { finalArc: 'An egg as big as a football lies there.' },
      beatsReviewReport: { pagePlan: 'Page 1: close-up — the egg' },
      sceneImages: [{ pageNumber: 1, text: 'Das Ei war so gross wie ein Teller.' }],
    } };
    const r = checks.sizeComparisons(ctx);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/arc 1/);
    expect(r.detail).toMatch(/text 1/);
  });
});

describe('tasks/verify.json', () => {
  const reg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'tasks', 'verify.json'), 'utf8'));
  it('every entry is well-formed and every auto check exists', () => {
    const ids = new Set();
    for (const e of reg.entries) {
      expect(ids.has(e.id)).toBe(false);
      ids.add(e.id);
      expect(['pending', 'confirmed', 'failed', 'superseded']).toContain(e.status);
      expect(typeof e.claim).toBe('string');
      expect(Array.isArray(e.commits)).toBe(true);
      expect(Array.isArray(e.runShape)).toBe(true);
      expect(Array.isArray(e.evidence)).toBe(true);
      if (e.check.kind === 'auto') expect(typeof checks[e.check.fn]).toBe('function');
      else expect(e.check.kind).toBe('human');
    }
  });
});

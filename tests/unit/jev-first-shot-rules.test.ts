/**
 * JEV FIRST: WHO OWNS THE SHOT, AND THE DECIDED FIELDS ON A REWRITE (owner,
 * 2026-09-28; answers Q6 and the shot-rule reconciliation in
 * tasks/jev-first-briefs-2026-09-28.md). On a page whose shot the decision
 * layer fixed, the rules that used to set or widen a shot are worded for the
 * staging inside it; covers and the Jev-outage backup keep the old wording. An
 * iterate rewrite keeps every decided field (strict) or every one but the shot
 * (free). Pins behaviour, never wording.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'fs';
import path from 'path';

const req = createRequire(import.meta.url);
const PB = req('../../server/lib/promptBuilders');
const SV = req('../../server/lib/shotVocabulary');
const JD = req('../../server/lib/jevDecisions');
const { loadPromptTemplates } = req('../../server/services/prompts');
const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

beforeAll(async () => { await loadPromptTemplates(); });

describe('the shot rules per path', () => {
  it('a fixed shot: no rule tells the author to set or widen `shot`', () => {
    const f = PB.shotRuleFills({ fixedShot: true });
    expect(f.GAP_ACTION_FRAMING).not.toMatch(/set `shot`/);
    expect(f.GAP_ACTION_FRAMING).toMatch(/fixed `shot` decides the framing/);
    expect(f.CLOSEUP_KEPT).toBe(SV.CLOSEUP_KEPT_FIXED_SHOT_RULE);
    expect(f.CLOSEUP_KEPT).not.toMatch(/`medium`/);
    expect(f.GROUP_STAGING).toBe(SV.GROUP_STAGING_FIXED_SHOT_RULE);
    expect(f.GROUP_STAGING).not.toMatch(/wider shot/);
    expect(f.CLOSEUP_WAIST_SHOT).not.toMatch(/is a `medium` shot/);
  });
  it('the author\'s own shot (covers, the backup): the old wording, unchanged', () => {
    const f = PB.shotRuleFills({ fixedShot: false });
    expect(f.CLOSEUP_KEPT).toBe(SV.CLOSEUP_KEPT_RULE);
    expect(f.GROUP_STAGING).toBe(SV.GROUP_STAGING_RULE);
    expect(f.GAP_ACTION_FRAMING).toMatch(/set `shot` to `over-the-shoulder`/);
  });
  it('the Jev-path page-brief call gets the fixed wording; the backup call the old one', () => {
    const input = { language: 'en', characters: [{ name: 'Ana' }] };
    const beats = [{ pageNumber: 1, planLine: 'close-up — Ana — she waves — hello' }];
    const jev = String(PB.buildSceneBriefsAllPrompt(input, beats, { jevBackup: false }));
    const backup = String(PB.buildSceneBriefsAllPrompt(input, beats, { jevBackup: true }));
    expect(jev).toContain(SV.GROUP_STAGING_FIXED_SHOT_RULE);
    expect(jev).not.toContain(SV.GROUP_STAGING_RULE);
    expect(backup).toContain(SV.GROUP_STAGING_RULE);
    expect(jev).toContain(JD.JEV_FIXED_FIELDS_RULE);
    expect(backup).toContain(JD.JEV_BACKUP_SHOT_RULE);
    // The Visual Bible call is told the pages' shots are fixed, so a vantage holds them.
    expect(String(PB.buildVisualBibleCallPrompt(input, beats, { jevBackup: false }))).toContain(JD.vantageShotRule(false));
  });
});

describe('an iterate rewrite keeps the decided fields (Q6)', () => {
  it('free iterate drops only the shot from the pin; strict pins every field', () => {
    const b = `The prose.\n\n---METADATA---\n${JSON.stringify({ sceneIntent: 'x', characters: [{ name: 'Ana', looksAt: 'away' }], shot: 'wide', objects: ['LOC002'], population: 'crowd' })}`;
    const fixed = { shot: 'medium', location: 'LOC001', population: 'cast_only', looksAt: { Ana: 'LOC001' } };
    const strict = JD.pinBrief(b, fixed).changes.map((c: any) => c.field).sort();
    const free = JD.pinBrief(b, { ...fixed, shot: undefined }).changes.map((c: any) => c.field).sort();
    expect(strict).toEqual(['location', 'looksAt', 'population', 'shot']);
    expect(free).toEqual(['location', 'looksAt', 'population']);
  });
  it('iteratePageCore pins from the stored page, and words the strict prompt for the fixed shot (source scan)', () => {
    const src = read('server/lib/images.js');
    expect(src).toContain('const jevFixedOfPage = savedScene && savedScene.jevFixed;');
    expect(src).toContain('pinBrief(newSceneDescription, freeIterate ? { ...jevFixedOfPage, shot: undefined } : jevFixedOfPage)');
    expect(src).toContain('fixedShot: !freeIterate && !!(savedScene && savedScene.jevFixed && savedScene.jevFixed.shot)');
  });
  it('the decided fields are stored on every page record the run writes (source scan)', () => {
    const src = read('storyJobPipeline.js');
    expect((src.match(/jevFixed: img\.scene\?\.jevFixed \|\| null,/g) || []).length).toBe(2);
    expect(read('server/lib/beatsPipeline.js')).toContain('...(b.jevFixed ? { jevFixed: b.jevFixed } : {}),');
  });
});

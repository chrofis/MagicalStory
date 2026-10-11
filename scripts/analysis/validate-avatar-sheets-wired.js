#!/usr/bin/env node
'use strict';

/**
 * Validate the avatar sheet (ONE Grok 2.0 call, ONE judge, one redo; docs/decisions.md 2026-10-10 "avatar sheets are ONE Grok 2 call")
 * through the WIRED functions on stored staging characters: the standard sheet and one costume sheet each, both through
 * styledAvatars.prepareStyledAvatars (the function the full story and the trial job call; the trial endpoints add the persist step on
 * top of it, which is stubbed out here: nothing is written). Reports wall time per sheet (call + judge + redo), the judge's flags, the
 * redo outcome, and writes every final sheet and its waiting-page slides (cut by the production cutter) for viewing.
 *
 *   node scripts/analysis/validate-avatar-sheets-wired.js --out <dir> --cap-usd 0.80 [--plan "Emma:wizard,Noah:wizard,Lukas:ninja:characters_<userId>,..."]
 *
 * The characters come from the staging family row (Emma 4, Noah 7, Daniel 38, Sarah 36, Hans 68: wizard avatar, body cut-out and face
 * photo stored) and are run as a full-story cast would be: photos, avatars, declared age. Paid: one Grok 2.0 call (USD 0.04) + one
 * judge call (about USD 0.003) per sheet, the same again for a redo. Stops at the cap.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const out = arg('out');
const dry = process.argv.includes('--dry'); // no paid call: a stored sheet stands in for the Grok call and the judge answers clean (wiring check)
const cap = Number(arg('cap-usd', 0.8));
if (!out) throw new Error('--out <dir> is required');
fs.mkdirSync(out, { recursive: true });
const ROW = 'characters_680c30fd-2839-4c23-b00c-b91603352a6d';
const PLAN = (arg('plan', 'Emma:wizard,Noah:wizard,Daniel:wizard,Hans:wizard')).split(',').map(s => s.split(':'));
const GROK_USD = 0.04;
const JUDGE_USD = 0.0033;
let spent = 0;

async function main() {
  await require('../../server/services/prompts').loadPromptTemplates();
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const styled = require('../../server/lib/styledAvatars');
  const avatarSlides = require('../../server/lib/avatarSlides');
  const sheetLib = require('../../server/lib/character2x4Sheet');
  const judgeLib = require('../../server/lib/avatarSheetJudge');
  const { seasonOutfitGuidance } = require('../../server/lib/season');
  const { getTrialCostume } = require('../../server/config/trialCostumes');

  // Count every paid call through the module objects the wired code calls at run time.
  const counts = { grok: 0, judge: 0 };
  const rawGen = dry
    ? async () => ({ imageData: `data:image/png;base64,${fs.readFileSync(arg('dry-sheet')).toString('base64')}`, usage: null, modelId: 'dry', prompt: 'dry' })
    : sheetLib.generateOneCallSheet;
  sheetLib.generateOneCallSheet = async (...a) => { if (spent + GROK_USD > cap) throw new Error(`spend cap USD ${cap} reached`); counts.grok++; spent += GROK_USD; return rawGen(...a); };
  const rawJudge = dry
    ? async () => ({ parsed: judgeLib.parseAvatarSheetVerdict({ cells: [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ cell: n, headgear: 'none', hairVisible: 'full', hairColour: 'brown', hairStyle: 'down', head: 'present', top: 'x', extras: 'none', heldObject: 'none' })), ...Object.fromEntries(judgeLib.DEFECT_TYPES.map(t => [t, { verdict: 'ok', cells: [] }])), evidence: 'dry' }), raw: {}, prompt: 'dry' })
    : judgeLib.judgeAvatarSheet;
  judgeLib.judgeAvatarSheet = async (...a) => { if (spent + JUDGE_USD > cap) throw new Error(`spend cap USD ${cap} reached`); counts.judge++; spent += JUDGE_USD; return rawJudge(...a); };

  const rows = new Map();
  const characterOf = async (name, rowId) => {
    const id = rowId || ROW;
    if (!rows.has(id)) {
      const res = await pool.query('SELECT data FROM characters WHERE id = $1', [id]);
      rows.set(id, typeof res.rows[0].data === 'string' ? JSON.parse(res.rows[0].data) : res.rows[0].data);
    }
    return rows.get(id).characters.find(c => c.name === name);
  };
  const summary = [];
  const records = [];
  for (const [name, costumeKey, rowId] of PLAN) {
    const stored = await characterOf(name, rowId);
    if (!stored) throw new Error(`no stored character ${name}`);
    const costume = getTrialCostume(costumeKey, 'adventure', stored.gender || 'male');
    if (!costume) throw new Error(`no trial costume ${costumeKey}`);
    const run = async (label, requirements, clothingRequirements, opts) => {
      const t0 = Date.now();
      const character = JSON.parse(JSON.stringify(stored));
      return styled.runInCacheScope(`validate-${name}-${label}`, async () => {
        try {
          await styled.prepareStyledAvatars([character], 'watercolor', requirements, clothingRequirements, null, null, opts);
        } catch (err) { return { label, error: err.message, wallMs: Date.now() - t0 }; }
        const exported = styled.exportStyledAvatarsForPersistence([character], 'watercolor').get(name);
        const logEntries = styled.getStyledAvatarGenerationLog().filter(e => e.sheetCheck);
        styled.clearStyledAvatarCache();
        return { label, exported, check: logEntries.map(e => e.sheetCheck), wallMs: Date.now() - t0 };
      });
    };
    // the standard and the costumed sheet of one character run side by side, as the trial runs them
    const [std, cost] = await Promise.all([
      run('standard', [{ pageNumber: 'pre-cover', clothingCategory: 'standard', characterNames: [name] }],
        { [name]: { standard: { used: true, signature: 'none' }, costumed: { used: false } } }, { seasonOutfit: seasonOutfitGuidance({}) }),
      run('costume', [{ pageNumber: 'cover', clothingCategory: `costumed:${costume.costumeType}`, characterNames: [name] }],
        { [name]: { standard: { used: true, signature: 'none' }, costumed: { used: true, costume: costume.costumeType, description: costume.description } } }, { seasonOutfit: seasonOutfitGuidance({ storyCategory: 'adventure' }) }),
    ]);
    const row = { name, age: stored.age, costume: costume.costumeType, standardWallS: Math.round(std.wallMs / 100) / 10, costumeWallS: Math.round(cost.wallMs / 100) / 10, errors: [std.error, cost.error].filter(Boolean) };
    summary.push(row);
    for (const [r, key] of [[std, 'standard'], [cost, 'costume']]) {
      if (!r.exported) continue;
      const sheet = key === 'standard' ? r.exported.standard : Object.values(r.exported.costumed || {})[0];
      const buf = Buffer.from(sheet.split(',')[1], 'base64');
      const base = `${name}-${stored.age}-${key}`;
      fs.writeFileSync(path.join(out, `${base}.jpg`), buf);
      const slides = await avatarSlides.slidesFromSheet(sheet, key);
      for (const [i, s] of slides.entries()) fs.writeFileSync(path.join(out, `${base}-slide${i + 1}.jpg`), Buffer.from(s.split(',')[1], 'base64'));
      row[`${key}Slides`] = slides.length;
      records.push({ name, kind: key, wallMs: r.wallMs, ...(r.check[0] || {}) });
    }
    console.log(JSON.stringify(row), `spent so far USD ${spent.toFixed(4)}`);
  }
  await pool.end();

  const redone = records.filter(r => r.redone).length;
  const result = {
    sheets: records.length, redone, redoRate: records.length ? redone / records.length : null,
    redoShipped: records.filter(r => r.shipped === 'second').length,
    judgeErrors: records.filter(r => r.judgeError).length,
    shippedFlagged: records.filter(r => (r.shipped === 'second' ? r.secondFlags : r.firstFlags)?.length > 0).length,
    wallMs: records.map(r => r.wallMs), spentUsd: Number(spent.toFixed(4)), counts, summary, records,
  };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ ...result, records: undefined, summary: undefined }));
  for (const r of records) console.log(`${r.name}/${r.kind}: wall ${Math.round(r.wallMs / 100) / 10}s redone=${r.redone} shipped=${r.shipped} first=[${(r.firstFlags || []).map(d => `${d.type}:${d.word}${JSON.stringify(d.cells)}`)}] second=[${(r.secondFlags || []).map(d => `${d.type}:${d.word}${JSON.stringify(d.cells)}`)}] judgeMs=${r.judgeMs} err=${r.judgeError || ''}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

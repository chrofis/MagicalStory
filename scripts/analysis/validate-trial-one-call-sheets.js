#!/usr/bin/env node
'use strict';

/**
 * Validate the trial's one-call avatar sheets through the WIRED functions (docs/decisions.md 2026-10-10 "one-call sheets in the trial").
 * For each stored staging trial character: the standard sheet and one costumed sheet, both through trialSheets.styleAndPersistTrialSheets
 * with the options the prepare endpoints pass (oneCall: true) and a persist stub (nothing is written to the database), exactly as the
 * trial draws them (the two sheets of a character run side by side). Reports wall time per sheet (call, judge, redo), the redo rate and
 * the final judge verdict, writes every final sheet and its slides (cut by the production cutter) for viewing.
 *
 *   node scripts/analysis/validate-trial-one-call-sheets.js --out <dir> --cap-usd 0.55 [--users <id,id,...>] [--costume ninja]
 *
 * Paid: one Grok call (USD 0.02) + one judge call (about USD 0.0033) per sheet, the same again for a redo. Stops at the cap.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const sharp = require('sharp');

const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const out = arg('out');
const cap = Number(arg('cap-usd', 0.55));
if (!out) throw new Error('--out <dir> is required');
fs.mkdirSync(out, { recursive: true });

// userId -> trial costume key (null = the character's own stored costume)
const DEFAULT_SET = [
  ['6912628b-9a7f-499c-82fe-2e0b4a8ebe9c', null], // Lukas 8, ninja (the owner's staging trial)
  ['5658addc-76fb-4f0b-a516-35327c343845', null], // Emma 5, knight
  ['43774997-a601-4f12-b3c1-576c285beef8', null], // Noah 4, wizard
  ['12e91e78-ec4f-4031-8be3-af9930f63298', null], // Lily 7, wizard
  ['28ad6bf5-3cc3-4ccc-a369-02851a25e96d', 'pirate'], // Omar 3 (no stored costume)
  ['abf5b2b6-df3d-4647-b7bd-ed06cd83713c', null], // Rohan 8, detective
];

const GROK_USD = 0.02;
const JUDGE_USD = 0.0033;
let spent = 0;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  await require('../../server/services/prompts').loadPromptTemplates();
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const trialSheets = require('../../server/lib/trialSheets');
  const avatarSlides = require('../../server/lib/avatarSlides');
  const sheetLib = require('../../server/lib/character2x4Sheet');
  const judgeLib = require('../../server/lib/avatarSheetJudge');
  const oneCall = require('../../server/lib/oneCallSheet');
  const { seasonOutfitGuidance } = require('../../server/lib/season');
  const { getTrialCostume } = require('../../server/config/trialCostumes');

  // Count every paid call and every judge answer through the module objects the wired code calls at run time.
  const counts = { grok: 0, judge: 0 };
  const rawGen = sheetLib.generateOneCallSheet;
  sheetLib.generateOneCallSheet = async (...a) => { if (spent + GROK_USD > cap) throw new Error(`spend cap USD ${cap} reached`); counts.grok++; spent += GROK_USD; return rawGen(...a); };
  const rawJudge = judgeLib.judgeAvatarSheet;
  judgeLib.judgeAvatarSheet = async (...a) => { if (spent + JUDGE_USD > cap) throw new Error(`spend cap USD ${cap} reached`); counts.judge++; spent += JUDGE_USD; return rawJudge(...a); };
  const records = [];
  const rawWired = oneCall.generateJudgedOneCallSheet;
  oneCall.generateJudgedOneCallSheet = async (character, opts, deps) => {
    const t0 = Date.now();
    const r = await rawWired(character, opts, deps);
    records.push({ name: character.name, kind: opts.kind, wallMs: Date.now() - t0, ...r.sheetJudge });
    return r;
  };

  const users = (arg('users') ? arg('users').split(',').map(u => [u, arg('costume')]) : DEFAULT_SET);
  const summary = [];
  for (const [userId, costumeKey] of users) {
    const rowRes = await pool.query('SELECT data FROM characters WHERE id = $1', [`characters_${userId}`]);
    const data = typeof rowRes.rows[0].data === 'string' ? JSON.parse(rowRes.rows[0].data) : rowRes.rows[0].data;
    const main = data.characters[0];
    const character = { id: main.id, name: main.name, age: main.age, gender: main.gender, isMainCharacter: true, photos: main.photos || {}, avatars: {}, physical: main.physical || {}, physicalTraitsSource: main.physicalTraitsSource || {} };
    const costume = getTrialCostume(costumeKey || main.preGeneratedCostumeType, 'adventure', main.gender || 'male');
    if (!costume) throw new Error(`no trial costume for ${main.name}`);
    const stdReqs = [{ pageNumber: 'pre-cover', clothingCategory: 'standard', characterNames: [character.name] }];
    const stdClothing = { [character.name]: { standard: { used: true, signature: 'none' }, costumed: { used: false } } };
    const costReqs = [{ pageNumber: 'cover', clothingCategory: `costumed:${costume.costumeType}`, characterNames: [character.name] }];
    const costClothing = { [character.name]: { standard: { used: true, signature: 'none' }, costumed: { used: true, costume: costume.costumeType, description: costume.description } } };

    const run = async (label, requirements, clothingRequirements, styleOptions) => {
      const t0 = Date.now();
      let exported = null;
      try {
        await trialSheets.styleAndPersistTrialSheets({
          userId: `validate-${userId}-${label}`, characterId: `characters_${userId}`, character: { ...character }, requirements, clothingRequirements, styleOptions,
        }, { persist: async (args) => { exported = args.exported; return []; } });
      } catch (err) { return { label, error: err.message, wallMs: Date.now() - t0 }; }
      return { label, exported, wallMs: Date.now() - t0 };
    };
    // the standard and the costumed sheet of one trial run side by side
    const [std, cost] = await Promise.all([
      run('standard', stdReqs, stdClothing, { skipQualityEval: true, seasonOutfit: seasonOutfitGuidance({}), oneCall: true }),
      run('costume', costReqs, costClothing, { seasonOutfit: seasonOutfitGuidance({ storyCategory: 'adventure' }), oneCall: true }),
    ]);
    const row = { user: userId.slice(0, 8), name: main.name, age: main.age, costume: costume.costumeType, standardWallS: Math.round(std.wallMs / 100) / 10, costumeWallS: Math.round(cost.wallMs / 100) / 10, errors: [std.error, cost.error].filter(Boolean) };
    summary.push(row);
    for (const [r, key] of [[std, 'standard'], [cost, 'costume']]) {
      if (!r.exported) continue;
      const avatars = r.exported[character.name];
      const sheet = key === 'standard' ? avatars.standard : Object.values(avatars.costumed)[0];
      const buf = Buffer.from(sheet.split(',')[1], 'base64');
      const base = `${row.user}-${main.name}-${key}`;
      fs.writeFileSync(path.join(out, `${base}.jpg`), buf);
      const slides = await avatarSlides.slidesFromSheet(sheet, key);
      for (const [i, s] of slides.entries()) fs.writeFileSync(path.join(out, `${base}-slide${i + 1}.jpg`), Buffer.from(s.split(',')[1], 'base64'));
      row[`${key}Slides`] = slides.length;
    }
    console.log(JSON.stringify(row), `spent so far USD ${spent.toFixed(4)}`);
    await wait(500);
  }
  await pool.end();

  const redone = records.filter(r => r.redone).length;
  const result = {
    sheets: records.length, redone, redoRate: records.length ? redone / records.length : null,
    judgeErrors: records.filter(r => r.judgeError).length,
    shippedFlagged: records.filter(r => (r.shipped === 'second' ? r.secondDefects : r.firstDefects)?.length > 0).length,
    wallMs: records.map(r => r.wallMs), spentUsd: Number(spent.toFixed(4)), counts, summary, records,
  };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ ...result, records: undefined, summary: undefined }));
  for (const r of records) console.log(`${r.name}/${r.kind}: wall ${Math.round(r.wallMs / 100) / 10}s redone=${r.redone} shipped=${r.shipped} first=[${(r.firstDefects || []).map(d => `${d.type}:${d.verdict}${JSON.stringify(d.cells)}`)}] second=[${(r.secondDefects || []).map(d => `${d.type}:${d.verdict}${JSON.stringify(d.cells)}`)}] judgeMs=${r.judgeMs} err=${r.judgeError || ''}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

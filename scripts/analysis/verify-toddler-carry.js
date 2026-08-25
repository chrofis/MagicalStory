#!/usr/bin/env node
/**
 * Verify the 2026-08-25 review fixes actually fired on a stored story:
 *
 *   1. {TODDLER_MODE} reaches the arc review and the beats review prompts
 *      (previously only the planner and the trial got it).
 *   2. The carried findings travel WITH the reviewer's rulings — the
 *      `REVIEWER'S RULINGS` block appears in the downstream prompt that
 *      received an audit's faults.
 *
 * Both are prompt-level facts, so this reads the stored prompts rather than
 * judging the prose. Usage:
 *
 *   node scripts/analysis/verify-toddler-carry.js <storyId> [--prod]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const storyId = process.argv[2];
const useProd = process.argv.includes('--prod');
if (!storyId) {
  console.error('Usage: node scripts/analysis/verify-toddler-carry.js <storyId> [--prod]');
  process.exit(1);
}

const conn = useProd ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;

function mark(ok) { return ok ? '✅' : '❌'; }

(async () => {
  const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  const r = await pool.query('SELECT id, data FROM stories WHERE id = $1', [storyId]);
  if (r.rows.length === 0) {
    console.error(`No story ${storyId} on ${useProd ? 'production' : 'staging'}`);
    await pool.end();
    process.exit(1);
  }
  const d = r.rows[0].data || {};
  console.log(`Story: ${d.title || '(untitled)'}  [${storyId}]`);
  console.log('='.repeat(70));

  const arc = d.arcReviewReport || null;
  const beats = d.beatsReviewReport || null;

  // ── 1. Toddler mode in the two review prompts ───────────────────────────
  console.log('\n1. TODDLER MODE reaches the reviewers');
  const arcHas = !!(arc?.prompt || '').includes('# TODDLER MODE');
  const beatsHas = !!(beats?.prompt || '').includes('# TODDLER MODE');
  console.log(`   ${mark(!!arc)} arcReviewReport stored${arc ? '' : ' — arc stage did not run'}`);
  console.log(`   ${mark(arcHas)} arc review prompt carries # TODDLER MODE`);
  console.log(`   ${mark(!!beats)} beatsReviewReport stored${beats ? '' : ' — beats review did not run'}`);
  console.log(`   ${mark(beatsHas)} beats review prompt carries # TODDLER MODE`);
  // An unfilled placeholder means the builder never passed the field.
  for (const [name, p] of [['arc', arc?.prompt], ['beats', beats?.prompt]]) {
    if (p && p.includes('{TODDLER_MODE}')) console.log(`   ❌ ${name} review prompt has an UNFILLED {TODDLER_MODE} placeholder`);
  }

  // ── 2. Carried findings + the reviewer's rulings ────────────────────────
  console.log("\n2. Carried findings travel WITH the reviewer's rulings");
  const arcAudit = String(arc?.audit || '').trim();
  const beatsAudit = String(beats?.audit || '').trim();
  const arcFaults = (arcAudit.match(/^FAULT:/gm) || []).length;
  const beatsFaults = (beatsAudit.match(/^FAULT:/gm) || []).length;
  console.log(`   arc audit: ${arcFaults} fault(s)   beats audit: ${beatsFaults} fault(s)`);

  // The Art Director prompt is stored per page and is the one carry destination
  // whose prompt is persisted (sceneDescriptionPrompt).
  const scenes = Array.isArray(d.sceneImages) ? d.sceneImages : [];
  const adPrompt = scenes.map(s => s.sceneDescriptionPrompt).find(p => p && p.includes('---BEATS AUDIT---'));
  if (beatsFaults === 0) {
    console.log('   ⚠️  beats audit found no faults — the carry block is correctly absent, feature UNEXERCISED');
  } else if (!adPrompt) {
    console.log('   ❌ beats audit had faults but NO stored Art Director prompt carries ---BEATS AUDIT---');
  } else {
    const hasRulings = adPrompt.includes("REVIEWER'S RULINGS");
    console.log(`   ✅ Art Director prompt carries the ---BEATS AUDIT--- findings block`);
    console.log(`   ${mark(hasRulings)} ...and the REVIEWER'S RULINGS block (the fix under test)`);
    if (hasRulings) {
      const i = adPrompt.indexOf("REVIEWER'S RULINGS");
      console.log('\n   --- carried rulings block (first 400 chars) ---');
      console.log(adPrompt.slice(i - 20, i + 400).split('\n').map(l => '   ' + l).join('\n'));
    }
  }

  // ── 3. Did the reviewers respect toddler mode? (prose signal, advisory) ──
  console.log('\n3. Toddler rules in the shipped book (advisory — read the pages too)');
  const pages = scenes.length;
  console.log(`   pages: ${pages}`);
  const beatsChanged = beats?.changedPages || [];
  console.log(`   beats review rewrote ${beatsChanged.length} page(s): ${beatsChanged.join(', ') || 'none'}`);
  console.log(`   arc review ${arc?.changed ? 'rewrote the arc' : 'left the arc unchanged'}`);

  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });

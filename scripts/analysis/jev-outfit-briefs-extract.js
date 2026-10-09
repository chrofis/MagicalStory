#!/usr/bin/env node
/**
 * Extract for the Jev outfit_missing (brief re-ask) measurement, 2026-10-09: staging stories with a briefCheckReport
 * (briefsIn = the Art Director briefs the check ran on). Per brief and per cast member with a clothing category:
 * the contract outfit text, the brief prose, and the CURRENT clothingCheck.checkPage outfit_missing verdict.
 * Writes evals/runs/2026-10-09_jev-outfit-briefs/cases.json.
 */
const path = require('path'); const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { checkPage, splitSlots } = require('../../server/lib/clothingCheck');
const { extractSceneMetadata, splitBrief } = require('../../server/lib/sceneMetadata');
const { lookupByName } = require('../../server/lib/castResolver');
const { resolveCharacterReqs } = require('../../server/lib/clothingCategories');
const OUT = path.join(ROOT, 'evals/runs/2026-10-09_jev-outfit-briefs');
(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const rows = (await pool.query(`SELECT id, data->'briefCheckReport'->'briefsIn' b, data->'clothingRequirements' cr FROM stories WHERE data->'briefCheckReport' ? 'briefsIn' AND data ? 'clothingRequirements' ORDER BY created_at DESC LIMIT 120`)).rows;
  const cases = [];
  for (const r of rows) {
    for (const x of r.b || []) {
      if (!(x.pageNumber > 0)) continue;
      const brief = typeof x.brief === 'string' ? x.brief : '';
      const m = extractSceneMetadata(brief) || {}; const full = m.fullData || m;
      const prose = splitBrief(brief).prose;
      const cast = (full.characters || m.characters || []).map(c => (typeof c === 'string' ? c : c?.name)).filter(Boolean);
      const per = m.characterClothing || {};
      const findings = checkPage({ pageNumber: x.pageNumber, prose, cast, perCharClothing: per, wornItems: m.wornItems || [] }, r.cr, {});
      for (const name of cast) {
        const category = (lookupByName(per, name, null) || {}).value || null; if (!category) continue;
        const reqs = resolveCharacterReqs(r.cr, name);
        const entry = reqs && (reqs[category] || (String(category).startsWith('costumed') ? reqs.costumed : null));
        const text = entry && (entry.signature && entry.signature !== 'none' ? entry.signature : entry.description);
        if (!text) continue;
        cases.push({ sid: r.id.slice(-9), page: x.pageNumber, name, category, outfit: text, prose, old: findings.some(f => f.type === 'outfit_missing' && f.character === name) });
      }
    }
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'cases.json'), JSON.stringify(cases));
  console.log('stories', rows.length, 'cases', cases.length, 'old outfit_missing', cases.filter(c => c.old).length);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });

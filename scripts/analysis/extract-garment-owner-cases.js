#!/usr/bin/env node
/**
 * Extract for the "is this roster member actually DRAWN on this page" measurement
 * (bug garment-owner-name-enters-page-cast, 2026-11-04). Read-only over stored rows.
 *
 * One case per (page, roster member whose name is a whole word of the brief prose).
 * Label (never read by the production code; reading labels from structured fields):
 *   drawn = the member is in the brief's metadata characters[] OR in the plan line's who column
 *   not drawn = in neither
 * Pages are tagged `trigger` when the metadata cast resolves to nobody (the only state in which the
 * production name scan runs).
 *
 *   node --max-old-space-size=1024 scripts/analysis/extract-garment-owner-cases.js [--days=120]
 * Writes evals/runs/2026-11-04_garment-owner-jev/cases.json (gitignored: story text, GDPR).
 */
const path = require('path'); const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { Pool } = require('pg');
const { extractSceneMetadata, stripSceneMetadata } = require('../../server/lib/sceneMetadata');
const { buildCastIndex, entriesMentioned } = require('../../server/lib/castResolver');
const OUT = path.join(ROOT, 'evals/runs/2026-11-04_garment-owner-jev');
const days = Number((process.argv.find(a => a.startsWith('--days=')) || '--days=120').split('=')[1]);

const SQL = `SELECT id, created_at,
  (SELECT jsonb_agg(c->>'name') FROM jsonb_array_elements(data->'characters') c) AS names,
  (SELECT jsonb_agg(jsonb_build_object('n', p->>'pageNumber', 'plan', p->>'outlineExtract', 'brief', p->>'sceneDescription'))
     FROM jsonb_array_elements(data->'sceneImages') p WHERE p->>'sceneDescription' IS NOT NULL) AS pages
  FROM stories WHERE created_at > now() - ($1 || ' days')::interval AND jsonb_typeof(data->'sceneImages') = 'array'
  AND jsonb_typeof(data->'characters') = 'array' ORDER BY created_at`;

function planWho(plan) {
  const t = String(plan || '').replace(/^PLAN:\s*/i, '');
  const parts = t.split(' — ');
  return parts.length >= 2 ? parts[1] : '';
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cases = [];
  let pagesSeen = 0, stories = 0;
  for (const [env, label] of [['DATABASE_URL', 'prod'], ['STAGING_DATABASE_URL', 'staging']]) {
    const pool = new Pool({ connectionString: process.env[env], ssl: { rejectUnauthorized: false } });
    const { rows } = await pool.query(SQL, [String(days)]);
    await pool.end();
    for (const r of rows) {
      const roster = (r.names || []).filter(Boolean).map(name => ({ name }));
      if (!roster.length || !r.pages) continue;
      stories++;
      const index = buildCastIndex({ characters: roster }, null);
      const byEntry = (text) => new Set(entriesMentioned(text, index, { firstToken: true }).map(e => e.entry.name));
      for (const p of r.pages) {
        pagesSeen++;
        const brief = p.brief; if (typeof brief !== 'string') continue;
        let prose;
        try { prose = stripSceneMetadata(brief); } catch (e) { continue; } // old-format brief with no carrier
        const mentioned = byEntry(prose);
        if (!mentioned.size) continue;
        const md = extractSceneMetadata(brief);
        const mdList = Array.isArray(md?.characters) ? md.characters : [];
        const mdNames = byEntry(mdList.map(x => typeof x === 'string' ? x : x?.name).join(' | '));
        const who = byEntry(planWho(p.plan));
        for (const name of mentioned) {
          cases.push({ story: r.id, env: label, page: Number(p.n), name, roster: roster.map(c => c.name),
            drawn: mdNames.has(name) || who.has(name), inMetadata: mdNames.has(name), inPlanWho: who.has(name),
            trigger: mdNames.size === 0, plan: p.plan || '', prose });
        }
      }
    }
  }
  fs.writeFileSync(path.join(OUT, 'cases.json'), JSON.stringify(cases));
  const sum = (f) => cases.filter(f).length;
  console.log({ stories, pagesSeen, cases: cases.length, drawn: sum(c => c.drawn), notDrawn: sum(c => !c.drawn),
    triggerPages_notDrawn: sum(c => c.trigger && !c.drawn), trigger_drawn: sum(c => c.trigger && c.drawn) });
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });

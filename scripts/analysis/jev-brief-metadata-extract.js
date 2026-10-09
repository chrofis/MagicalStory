#!/usr/bin/env node
/**
 * Extract for the Jev brief-metadata measurement (2026-10-09): per staging story since the
 * brief check existed, the brief-check findings (what triggered the re-ask) and, per page,
 * the Art Director's authored per-figure metadata. Writes items to the run folder (gitignored data stays local).
 *   node scripts/analysis/jev-brief-metadata-extract.js
 */
const path = require('path'); const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const OUT = path.join(ROOT, 'evals/runs/2026-10-09_jev-brief-metadata');
(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query(`SELECT id, created_at, data->'briefCheckReport' bcr, data->'sceneImages' si, data->'beatsReviewReport' brr, data->'visualBible' vb, data->>'language' lang FROM stories WHERE created_at > now() - interval '24 days' AND data ? 'briefCheckReport' ORDER BY created_at`);
  fs.mkdirSync(OUT, { recursive: true });
  const stories = rows.map(r => ({
    sid: r.id.slice(-9), date: r.created_at.toISOString().slice(0, 10), lang: r.lang, arc: String(r.brr?.arc || ''),
    findingsBefore: (r.bcr?.findingsBefore || []).map(f => ({ page: f.pageNumber, type: f.type, detail: String(f.detail || '').slice(0, 300), character: f.character, characters: f.characters })),
    reaskPages: r.bcr?.reask?.pages || r.bcr?.pages?.map?.(p => p.pageNumber) || null,
    reask: r.bcr?.reask ? { model: r.bcr.reask.model, pages: r.bcr.reask.pages } : null,
    briefsIn: (r.bcr?.briefsIn || []).map(b => ({ pageNumber: b.pageNumber, brief: b.brief })),
    pages: (r.si || []).map(p => ({ n: p.pageNumber, text: String(p.text || ''), plan: p.outlineExtract || '', fd: p.sceneMetadata?.fullData || null })),
    vbEntities: ['animals','secondaryCharacters','artifacts','vehicles'].flatMap(k => (r.vb?.[k] || []).map(e => ({ id: e.id, name: e.properName || e.name }))),
  }));
  fs.writeFileSync(path.join(OUT, 'stories.json'), JSON.stringify(stories));
  console.log(stories.length, 'stories');
  const types = {}; let reasks = 0;
  for (const s of stories) { if (s.reask) reasks++; for (const f of s.findingsBefore) types[f.type] = (types[f.type] || 0) + 1; }
  console.log('reasks', reasks, types);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });

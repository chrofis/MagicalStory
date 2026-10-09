#!/usr/bin/env node
/**
 * Extract for the Jev plan-line measurement (2026-10-09): staging pages whose plan line (sceneImages[].outlineExtract)
 * has a who column naming none of the story's characters, i.e. the pages planCounters can only call peopled via
 * PERSON_WORDS, and the INTERACTION_DRAMA_WORDS verdict for them. Writes evals/runs/2026-10-09_jev-planline/cases.json.
 */
const path = require('path'); const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const PC = require('../../server/lib/planCounters');
const OUT = path.join(ROOT, 'evals/runs/2026-10-09_jev-planline');
(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const ids = (await pool.query(`SELECT id FROM stories WHERE data ? 'sceneImages' ORDER BY created_at DESC LIMIT 200`)).rows;
  const cases = []; let pagesSeen = 0;
  for (const { id } of ids) {
    const r = await pool.query(`SELECT data->'sceneImages' si, data->'characters' ch FROM stories WHERE id=$1`, [id]);
    const names = (r.rows[0].ch || []).map(c => String(c.name || '').trim()).filter(Boolean);
    const first = names.flatMap(n => [n, n.split(/\s+/)[0]]).map(s => s.toLowerCase());
    for (const p of r.rows[0].si || []) {
      if (!(p.pageNumber > 0) || !p.outlineExtract) continue;
      pagesSeen++;
      const line = String(p.outlineExtract);
      const segs = PC.planSegments(line);
      if (segs.length < 3) continue;
      const who = PC.whoColumn(line);
      const lw = who.toLowerCase();
      if (first.some(n => n && new RegExp(`(^|[^\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\p{L}]|$)`, 'u').test(lw))) continue;
      cases.push({ sid: id.slice(-9), page: p.pageNumber, line, who, names });
    }
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'cases.json'), JSON.stringify(cases));
  console.log('stories', ids.length, 'pages', pagesSeen, 'who-names-nobody', cases.length);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });

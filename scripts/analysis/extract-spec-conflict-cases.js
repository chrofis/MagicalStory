#!/usr/bin/env node
// Extracts stored interaction pairs (B targets A by name) for the spec-conflict measurement. Free (DB read).
const path = require('path'); const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { Pool } = require('pg');
const { extractSceneMetadata } = require('../../server/lib/storyHelpers');
const { nameRegExp } = require('../../server/lib/castResolver');
(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query("select id, data->'sceneDescriptions' as sd from stories where data ? 'sceneDescriptions' order by created_at desc limit 200");
  const pairs = []; let scenes = 0;
  for (const row of r.rows) {
    const sd = row.sd || [];
    for (const s of sd) {
      const text = typeof s === 'string' ? s : (s && s.description) || '';
      const meta = extractSceneMetadata(text);
      const ints = meta && meta.interactions;
      if (!Array.isArray(ints) || ints.length < 2) continue;
      scenes++;
      for (let i = 0; i < ints.length; i++) for (let j = 0; j < ints.length; j++) {
        if (i === j) continue;
        const A = ints[i] || {}, B = ints[j] || {}; const aName = String(A.character || '').trim(); if (!aName) continue;
        const bText = `${B.where || ''} ${B.object || ''}`;
        const t = String(B.object || '').trim() === aName || new RegExp(`${nameRegExp(aName).source}['’]s`, 'iu').test(bText);
        if (t && i < j) pairs.push({ sid: row.id, page: (s && s.pageNumber) || sd.indexOf(s) + 1, A: { character: A.character, where: A.where, object: A.object, action: A.action }, B: { character: B.character, where: B.where, object: B.object, action: B.action } });
      }
    }
  }
  console.log('stories', r.rows.length, 'scenes with >=2 interactions', scenes, 'target pairs', pairs.length);
  fs.writeFileSync(path.join(__dirname, '../../evals/runs/2026-10-09_jev-specconflict/pairs.json'), JSON.stringify(pairs, null, 1));
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });

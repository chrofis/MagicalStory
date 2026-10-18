#!/usr/bin/env node
/**
 * REPLAY the page LIGHT line and SEASON line of every stored story page (rung 1: stored briefs, no model call, free).
 *
 *   node scripts/analysis/replay-no-daylight-light.js --out=<file.json> [--flag=<storyIdSuffix>:<LOCid>[,...]]
 *
 * Per page: the declared light of the stored brief, the LIGHT line (sceneLight.buildLightLine) and the SEASON line
 * (season.buildSeasonNote, with the indoor / skyless flags the page prompt passes). Run it on two trees (before and
 * after a change) and compare the lines: an Earth page must not change. `--flag` marks a stored location
 * `noDaylight: true` the way the Visual Bible would, and pins it on the pages there (jevBriefFields.noDaylightPages),
 * to show what a space-station story's pump-room pages get. Reads DATABASE_URL and STAGING_DATABASE_URL.
 * see docs/decisions.md 2026-10-18 "A place with no daylit sky"
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { Pool } = require('pg');
const SL = require('../../server/lib/sceneLight');
const { buildSeasonNote } = require('../../server/lib/season');
const { extractSceneMetadata } = require('../../server/lib/sceneMetadata');
const JBF = require('../../server/lib/jevBriefFields');
const argv = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));
const flags = String(argv.flag || '').split(',').filter(Boolean).map(f => f.split(':'));

(async () => {
  const out = [];
  for (const [env, url] of [['prod', process.env.DATABASE_URL], ['staging', process.env.STAGING_DATABASE_URL]]) {
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
    const r = await pool.query(`select id, data->>'season' season, data->'sceneDescriptions' sd, data->'visualBible' vb from stories where jsonb_typeof(data->'sceneDescriptions') = 'array'`);
    await pool.end();
    for (const d of r.rows) {
      const vb = JSON.parse(JSON.stringify(d.vb || {}));
      const flag = flags.find(([suffix]) => d.id.endsWith(suffix));
      if (flag) for (const l of (vb.locations || [])) if (l.id === flag[1]) l.noDaylight = true;
      const locOf = new Map();
      for (const l of (vb.locations || [])) for (const n of (l.pages || l.appearsInPages || [])) if (Number(n) > 0) locOf.set(Number(n), l.id);
      const dayless = new Set(JBF.noDaylightPages ? JBF.noDaylightPages(vb, locOf, new Map()).map(w => w.pageNumber) : []);
      for (const p of (d.sd || [])) {
        const meta = extractSceneMetadata(String(p.description || ''));
        const light = SL.declaredLight(meta);
        if (dayless.has(Number(p.pageNumber)) && !SL.isSkylessLight(light.timeOfDay)) light.noDaylight = true;
        out.push({ env, id: d.id, page: p.pageNumber, timeOfDay: light.timeOfDay, weather: light.weather, noDaylight: light.noDaylight === true,
          lightLine: SL.buildLightLine(light), seasonLine: buildSeasonNote({ season: d.season }, { skyless: SL.isSkylessLight(light.timeOfDay), indoor: light.weather === 'none', noDaylight: light.noDaylight === true }) });
      }
    }
  }
  if (argv.out) fs.writeFileSync(argv.out, JSON.stringify(out, null, 1));
  console.log(`${out.length} pages, ${new Set(out.map(o => o.id)).size} stories, ${out.filter(o => o.noDaylight).length} marked noDaylight`);
})().catch(e => { console.error(e); process.exit(1); });

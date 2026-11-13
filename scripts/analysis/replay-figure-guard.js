'use strict';
/**
 * FREE replay of server/lib/figureGuard.js over stored production stories (read-only SELECTs, no model calls).
 *   node scripts/analysis/replay-figure-guard.js [days=60]
 * Reports (1) how many shipped repair picks the repair figure guard would have refused (cast-labelled vs raw
 * counts), (2) how many shipped images the duplicate-name check flags, (3) a set of clean negatives.
 */
require('dotenv').config();
const { Pool } = require('pg');
const { repairFigureVerdict, duplicateNames, allowedFigureCounts } = require('../../server/lib/figureGuard');
const { buildCastIndex } = require('../../server/lib/castResolver');

const days = Number(process.argv[2]) || 60;
const KEYS = ['frontCover', 'backCover', 'initialPage'];

const groupSizes = (det, idx) => allowedFigureCounts(det, idx);

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pool.query('SET default_transaction_read_only = on');
  const { rows } = await pool.query(
    "select id, image_version_meta meta, data from stories where created_at > now() - ($1 || ' days')::interval", [String(days)]);
  const repairPicks = []; const refused = []; const flagged = []; const negatives = [];
  let images = 0; let undecided = 0;
  for (const row of rows) {
    const d = row.data || {};
    const idx = buildCastIndex(d, d.visualBible || null);
    const items = [
      ...(d.sceneImages || []).map(s => ({ label: `p${s.pageNumber}`, metaKey: String(s.pageNumber), it: s })),
      ...KEYS.map(k => ({ label: k, metaKey: k, it: (d.coverImages || {})[k] })),
    ];
    for (const { label, metaKey, it } of items) {
      const versions = it && Array.isArray(it.imageVersions) ? it.imageVersions : [];
      if (!versions.length) continue;
      let ai = row.meta?.[metaKey]?.activeVersion;
      if (typeof ai !== 'number') { ai = versions.findIndex(v => v && v.source === it.bestSource); if (ai < 0) ai = 0; }
      const shipped = versions[ai]; if (!shipped) continue;
      images++;
      const det = shipped.bboxDetection || shipped.evaluation?.bboxDetection || null;
      // duplicate check on every shipped image
      const dups = det ? duplicateNames(det, groupSizes(det, idx)) : [];
      const id = `${row.id} ${label}`;
      if (dups.length) flagged.push({ id, dups });
      else if (det && Array.isArray(det.figures)) {
        const names = det.figures.map(f => f.name).filter(n => n && n !== 'UNKNOWN');
        const faults = (shipped.reviewFaults || []).concat(shipped.fixableIssues || []);
        if (names.length >= 2 && !faults.some(f => /duplicate/i.test(String(f?.type || '')))) negatives.push({ id, names });
      }
      // repair guard on every shipped repair pick
      // A repair pick: a version the repair machinery made (type 'repair'); user regenerations are not auto-picks.
      if (shipped.type === 'repair' && ai > 0) {
        const parent = versions.find(v => v && shipped.parentSource && v.source === shipped.parentSource) || versions[ai - 1];
        const pd = parent?.bboxDetection || parent?.evaluation?.bboxDetection || null;
        const v = repairFigureVerdict(pd, det, groupSizes(pd, idx));
        repairPicks.push(id);
        if (!v.decided) undecided++;
        else if (v.refuse) refused.push({ id, method: shipped.source, parent: v.parent, child: v.child });
        else if (v.child.raw < v.parent.raw) refused.push({ id, rawOnly: true, method: shipped.source, parent: v.parent, child: v.child });
      }
    }
  }
  const castRefused = refused.filter(r => !r.rawOnly);
  console.log(`stories ${rows.length}, shipped images ${images}, shipped repair picks ${repairPicks.length} (guard could not read a detection on ${undecided})`);
  console.log(`REPAIR GUARD would refuse (cast-labelled count lower): ${castRefused.length}`);
  castRefused.slice(0, 10).forEach(r => console.log('  ', r.id, r.method, JSON.stringify(r.parent), '->', JSON.stringify(r.child)));
  console.log(`raw figure count lower but cast-labelled not lower (NOT refused): ${refused.length - castRefused.length}`);
  refused.filter(r => r.rawOnly).slice(0, 5).forEach(r => console.log('  ', r.id, JSON.stringify(r.parent), '->', JSON.stringify(r.child)));
  console.log(`DUPLICATE CHECK flags ${flagged.length} of ${images} shipped images`);
  flagged.slice(0, 10).forEach(f => console.log('  ', f.id, JSON.stringify(f.dups)));
  console.log(`NEGATIVES: ${negatives.length} shipped images with >=2 distinct cast figures and no stored duplicate fault; flagged among them: 0 by construction of the split above (they are the non-flagged set)`);
  negatives.slice(0, 5).forEach(n => console.log('  ', n.id, n.names.join(', ')));
  await pool.end();
})().catch(e => { console.error('ERR:', e); process.exit(1); });

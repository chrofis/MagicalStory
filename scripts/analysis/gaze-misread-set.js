// Collects every declared-gaze finding (replayed with the CURRENT checkDeclaredGaze, plus the ones stored in
// deductions) with the inventory fields of the involved figures and the page image URL, for hand labelling and
// for measuring structural guards. Free, read-only. Usage: node scripts/analysis/gaze-misread-set.js [--days=30] [--out=<json>]
'use strict';
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const { checkDeclaredGaze } = require('../../server/lib/gazeCheck');
const { pairInventoryFiguresToNames } = require('../../server/lib/identityAgreement');
const { gazeCharacters, gazeCreatures } = require('../../server/lib/vbIdGuard');
const { resolveLooksAt } = require('../../server/lib/compositeCastBuilder');
const { fromPgNaive } = require('../lib/chTime');
const arg = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const DAYS = Number(arg('days', 30));
const parseJson = (raw) => { try { const s = String(raw || ''); return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch { return null; } };
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const calls = (await pool.query(`SELECT story_id, label, raw_response, created_at FROM eval_calls WHERE kind='inventory' AND created_at > now() - interval '${DAYS} days'`)).rows;
  const byStory = new Map();
  for (const c of calls) { const m = /PAGE\s+(\d+)/i.exec(c.label || ''); if (!m || !c.story_id) continue; if (!byStory.has(c.story_id)) byStory.set(c.story_id, []); byStory.get(c.story_id).push({ page: +m[1], at: fromPgNaive(c.created_at).getTime(), inv: parseJson(c.raw_response) }); }
  const rows = [];
  for (const [sid, invs] of byStory) {
    const r = (await pool.query('SELECT data FROM stories WHERE id=$1', [sid])).rows[0]; if (!r) continue;
    const vb = r.data.visualBible || null;
    for (const p of r.data.sceneImages || []) {
      const meta = p.sceneMetadata?.fullData || p.sceneMetadata || {};
      const pageInvs = invs.filter(x => x.page === p.pageNumber && x.inv?.figures);
      for (const [vi, v] of (p.imageVersions || []).entries()) {
        const t = v.evaluatedAt ? new Date(v.evaluatedAt).getTime() : null;
        if (!t || !Array.isArray(v.matches) || !pageInvs.length) continue;
        const best = pageInvs.reduce((a, x) => (Math.abs(x.at - t) < Math.abs(a.at - t) ? x : a));
        if (Math.abs(best.at - t) > 600000) continue;
        const vmeta = v.sceneMetadata?.fullData || v.sceneMetadata || meta;
        const declared = [...(gazeCharacters(vmeta) || []), ...(gazeCreatures(vmeta, vb) || [])];
        let found = [];
        try { found = checkDeclaredGaze({ declared, inventory: best.inv, matches: v.matches, interactions: vmeta.interactions || [], resolveTarget: (x) => resolveLooksAt(x, vb) }); } catch { continue; }
        const stored = (v.deductions?.consolidated || []).filter(f => /is declared looking/i.test(f.description || ''));
        const pairing = pairInventoryFiguresToNames(v.matches, best.inv.figures);
        const figOf = (name) => { const e = [...pairing].find(([, n]) => norm(n) === norm(name)); return e ? best.inv.figures.find(f => norm(f.label) === norm(e[0])) : null; };
        const mk = (kind, f) => {
          const name = f.character || (/^(.+?) is declared/.exec(f.description) || [])[1];
          const fig = figOf(name);
          const seenLabel = norm(fig?.gaze).replace(/^(?:at|toward|towards|on)\s+/, '');
          const seenFig = best.inv.figures.find(x => norm(x.label) === seenLabel);
          const slim = (g) => g && { label: g.label, gaze: g.gaze, facing: g.facing, view: g.view, zone: g.zone, items_held: g.items_held };
          return { kind, story: sid, page: p.pageNumber, version: vi, severity: f.severity, description: f.description, name, imageUrl: v.imageUrl || v.url || null, fig: slim(fig), seenFig: slim(seenFig) };
        };
        for (const f of found) rows.push(mk('replay', f));
        for (const f of stored) rows.push(mk('stored', f));
      }
    }
  }
  await pool.end();
  fs.writeFileSync(arg('out', 'gaze-set.json'), JSON.stringify(rows, null, 1));
  console.log(rows.length, 'rows;', rows.filter(r => r.kind === 'replay').length, 'replay,', rows.filter(r => r.kind === 'stored').length, 'stored');
})().catch(e => { console.error(e); process.exit(1); });

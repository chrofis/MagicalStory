// Re-runs the CURRENT declared-gaze check (gazeCheck.checkDeclaredGaze: detection + severity) on STORED staging data:
// the blind inventory comes from eval_calls (kind 'inventory', label 'PAGE N'), joined to the page version evaluated
// closest in time; the pairing (`matches`) and the brief come from stories.data. Free, read-only, no model call.
// Usage: node scripts/analysis/gaze-full-replay.js [--days=21] [--out=<json>]
'use strict';
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const { checkDeclaredGaze } = require('../../server/lib/gazeCheck');
const { gazeCharacters, gazeCreatures } = require('../../server/lib/vbIdGuard');
const { resolveLooksAt } = require('../../server/lib/compositeCastBuilder');
const arg = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const DAYS = Number(arg('days', 21));
const OLD = /is declared looking/i;
const { fromPgNaive } = require('../lib/chTime');
const parseJson = (raw) => { try { const s = String(raw || ''); const a = s.indexOf('{'), b = s.lastIndexOf('}'); return JSON.parse(s.slice(a, b + 1)); } catch { return null; } };
(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const calls = (await pool.query(`SELECT story_id, label, raw_response, created_at FROM eval_calls WHERE kind='inventory' AND created_at > now() - interval '${DAYS} days'`)).rows;
  const byStory = new Map();
  for (const c of calls) { const m = /PAGE\s+(\d+)/i.exec(c.label || ''); if (!m || !c.story_id) continue; const k = c.story_id; if (!byStory.has(k)) byStory.set(k, []); byStory.get(k).push({ page: Number(m[1]), at: fromPgNaive(c.created_at).getTime(), inv: parseJson(c.raw_response) }); }
  const out = { inventoryCalls: calls.length, stories: byStory.size, joined: 0, declaredLooks: 0, oldFindingsOnJoined: 0, newFindings: { CRITICAL: 0, MAJOR: 0, MINOR: 0, other: 0 }, examples: [] };
  for (const [sid, invs] of byStory) {
    const r = (await pool.query('SELECT data FROM stories WHERE id=$1', [sid])).rows[0]; if (!r) continue;
    const d = r.data; const vb = d.visualBible || null;
    for (const p of d.sceneImages || []) {
      const meta = p.sceneMetadata?.fullData || p.sceneMetadata || {};
      const pageInvs = invs.filter(x => x.page === p.pageNumber && x.inv?.figures);
      for (const [vi, v] of (p.imageVersions || []).entries()) {
        const t = v.evaluatedAt ? new Date(v.evaluatedAt).getTime() : null;
        if (!t || !Array.isArray(v.matches) || !pageInvs.length) continue;
        const best = pageInvs.reduce((a, x) => (Math.abs(x.at - t) < Math.abs(a.at - t) ? x : a));
        if (Math.abs(best.at - t) > 10 * 60 * 1000) continue; // not this version's call
        out.joined++;
        const vmeta = v.sceneMetadata?.fullData || v.sceneMetadata || meta;
        const declared = [...(gazeCharacters(vmeta) || []), ...(gazeCreatures(vmeta, vb) || [])];
        out.declaredLooks += declared.filter(c => c.looksAt).length;
        out.oldFindingsOnJoined += (v.deductions?.consolidated || []).filter(f => OLD.test(f.description || '')).length;
        let found = [];
        try { found = checkDeclaredGaze({ declared, inventory: best.inv, matches: v.matches, interactions: vmeta.interactions || [], resolveTarget: (x) => resolveLooksAt(x, vb) }); }
        catch (e) { out.errors = (out.errors || 0) + 1; continue; }
        for (const f of found) {
          const s = String(f.severity || '').toUpperCase();
          out.newFindings[s in out.newFindings ? s : 'other']++;
          out.examples.push({ story: sid, page: p.pageNumber, version: vi, source: v.source, severity: s, description: f.description });
        }
      }
    }
  }
  await pool.end();
  const f = arg('out', null); if (f) fs.writeFileSync(f, JSON.stringify(out, null, 1));
  const { examples, ...summary } = out;
  console.log(JSON.stringify(summary));
  for (const e of examples) console.log(e.severity.padEnd(8), e.story.slice(-9), 'p' + e.page, 'v' + e.version, e.source, '|', e.description.slice(0, 150));
})().catch(e => { console.error(e); process.exit(1); });

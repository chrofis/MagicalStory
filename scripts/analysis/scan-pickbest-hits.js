#!/usr/bin/env node
/**
 * Free, read-only scan: how often does today's pick-best rule ship a version that
 * carries a CRITICAL while another scoreable version of the same page has none,
 * and how often does scoring.sideBySideTrigger fire?
 *
 *   ENV_FILE=<.env> node scripts/analysis/scan-pickbest-hits.js --env=staging|prod --since=2026-09-26 \
 *     [--download=<dir>] [--max-download=10]
 *
 * For every story created since --since, every scene and cover with >= 2 versions:
 *   todayPick  = scoring.pickBestVersionIndex(versions, {tieBreak:'earliest'}) (the recompute rule)
 *   recorded   = the active version in stories.image_version_meta (mapped via arrayIndexForDb)
 *   hit        = the version today's rule picks carries a charged CRITICAL class while another
 *                scoreable version has a KNOWN empty CRITICAL set
 *   trigger    = scoring.sideBySideTrigger
 * No model call is made. Images are fetched (R2/DB) only for the --download hits.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: process.env.ENV_FILE || path.join(__dirname, '../../.env') });
const { Pool } = require('pg');
const scoring = require('../../server/lib/scoring');
const { arrayIndexForDb } = require('../../server/lib/versionManager');

const arg = (n, d) => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || d;
const env = arg('env', 'staging');
const since = arg('since', '2026-09-26');
const url = env === 'prod' ? process.env.DATABASE_PUBLIC_URL : process.env.STAGING_DATABASE_URL;

const VERSION_FIELDS = `jsonb_build_object('source', v->'source', 'finalScore', v->'finalScore', 'evalScore', v->'evalScore',
  'entityPenalty', v->'entityPenalty', 'score', v->'score', 'qualityScore', v->'qualityScore', 'deductions', v->'deductions',
  'letteringInventory', v->'letteringInventory', 'evaluation', jsonb_build_object('letteringInventory', v->'evaluation'->'letteringInventory'),
  'dbVersionIndex', v->'dbVersionIndex', 'imageUrl', v->'imageUrl')`;

(async () => {
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const stories = (await pool.query(`SELECT id, created_at FROM stories WHERE created_at >= $1 ORDER BY created_at`, [since])).rows;
  let pages = 0, multi = 0, scoreableMulti = 0, storiesWithMulti = new Set();
  const hits = [], triggers = [], mismatches = [];
  const critText = (v) => {
    const out = [];
    for (const [b, list] of Object.entries(v.deductions || {})) for (const f of list || []) {
      if (scoring.deductionPoints(f, { entity: b === 'entity' }) >= 25) out.push(`[${f.severity}] ${f.type}${f.name ? ' ' + f.name : ''}: ${String(f.description || '').slice(0, 140)}`);
    }
    return out;
  };
  for (const s of stories) {
    const row = (await pool.query(
      `SELECT image_version_meta AS meta,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('key', e->'pageNumber', 'type', 'scene', 'versions',
           (SELECT COALESCE(jsonb_agg(${VERSION_FIELDS} ORDER BY o), '[]') FROM jsonb_array_elements(e->'imageVersions') WITH ORDINALITY t(v, o)))), '[]')
           FROM jsonb_array_elements(COALESCE(data->'sceneImages', '[]')) e) AS scenes,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('key', to_jsonb(k), 'type', k, 'versions',
           (SELECT COALESCE(jsonb_agg(${VERSION_FIELDS} ORDER BY o), '[]') FROM jsonb_array_elements(COALESCE(data->'coverImages'->k->'imageVersions', '[]')) WITH ORDINALITY t(v, o)))), '[]')
           FROM unnest(ARRAY['frontCover','initialPage','backCover']) k) AS covers
       FROM stories WHERE id = $1`, [s.id])).rows[0];
    const meta = row.meta || {};
    for (const unit of [...row.scenes, ...row.covers]) {
      const vs = unit.versions || [];
      pages++;
      if (vs.length < 2) continue;
      multi++; storiesWithMulti.add(s.id);
      const scoreable = vs.filter(v => scoring.computeFinalScore(v) != null).length;
      if (scoreable < 2) continue;
      scoreableMulti++;
      const keyStr = String(unit.key);
      const m = meta[keyStr];
      const today = scoring.pickBestVersionIndex(vs, { tieBreak: 'earliest' });
      if (today < 0) continue;
      const recorded = m && m.activeVersion != null ? arrayIndexForDb(vs, m.activeVersion, unit.type) : null;
      const keysOf = i => scoring.chargedCriticalKeys(vs[i]);
      const todayKeys = keysOf(today);
      const cleanOthers = vs.map((v, i) => i).filter(i => i !== today && scoring.computeFinalScore(vs[i]) != null && keysOf(i) && keysOf(i).size === 0);
      const rec = { story: s.id, created: s.created_at, page: unit.key, type: unit.type, versions: vs.length, today, recorded, pinned: !!m?.pinned };
      if (recorded != null && recorded !== today && !m?.pinned) mismatches.push(rec);
      if (todayKeys && todayKeys.size > 0 && cleanOthers.length) {
        hits.push({ ...rec, cleanOthers, todayFindings: critText(vs[today]), cleanScores: cleanOthers.map(i => scoring.computeFinalScore(vs[i])), todayScore: scoring.computeFinalScore(vs[today]), sources: vs.map(v => v.source) });
      }
      const trig = scoring.sideBySideTrigger(vs, { tieBreak: 'earliest' });
      if (trig) triggers.push({ ...rec, trigger: trig, topFindings: critText(vs[trig.top]), partnerFindings: critText(vs[trig.partner]), scores: [scoring.computeFinalScore(vs[trig.top]), scoring.computeFinalScore(vs[trig.partner])], sources: vs.map(v => v.source) });
    }
  }
  const summary = { env, since, stories: stories.length, storiesWithMultiVersionPages: storiesWithMulti.size, pagesAndCovers: pages, multiVersion: multi, scoreableMulti,
    hitsTodayShipsCriticalWhileAnotherCleanExists: hits.length, triggerFires: triggers.length, recordedActiveMismatchesUnpinned: mismatches.length };
  console.log(JSON.stringify(summary));
  const out = { summary, hits, triggers, mismatches };
  const outFile = arg('out', path.join(__dirname, `../../evals/runs/2026-10-04_pickbest-scan-${env}.json`));
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));

  const dl = arg('download');
  if (dl) {
    const { getStoryImage } = (() => { const d = require('../../server/services/database'); process.env.DATABASE_URL = url; process.env.STORAGE_MODE = 'database'; d.initializePool(); return d; })();
    const { fetchImageBytes } = require('../../server/lib/r2');
    fs.mkdirSync(dl, { recursive: true });
    const picks = [...triggers, ...hits.filter(h => !triggers.some(t => t.story === h.story && t.page === h.page))].slice(0, Number(arg('max-download', '10')));
    const cards = [];
    for (const [n, h] of picks.entries()) {
      const unitType = h.type, pageNo = unitType === 'scene' ? Number(h.page) : null;
      const [aIdx, bIdx] = h.trigger ? [h.trigger.top, h.trigger.partner] : [h.today, h.cleanOthers[0]];
      const files = [];
      for (const [label, idx] of [['top', aIdx], ['other', bIdx]]) {
        try {
          const r = await getStoryImage(h.story, unitType === 'scene' ? 'scene' : unitType, pageNo, idx);
          let buf = null;
          if (r?.imageData) buf = Buffer.from(String(r.imageData).replace(/^data:image\/\w+;base64,/, ''), 'base64');
          else if (r?.imageUrl) buf = await fetchImageBytes(r.imageUrl);
          if (buf) { const f = `hit${n + 1}_${label}_v${idx}.jpg`; fs.writeFileSync(path.join(dl, f), buf); files.push({ label, idx, f }); }
          else files.push({ label, idx, f: null });
        } catch (e) { files.push({ label, idx, f: null, err: e.message }); }
      }
      cards.push({ n: n + 1, h, files });
    }
    fs.writeFileSync(path.join(dl, 'cards.json'), JSON.stringify(cards, null, 1));
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const html = `<!doctype html><html><head><meta charset=utf-8><title>pickbest hits since ${since}</title><style>body{font-family:system-ui;max-width:1400px;margin:20px auto;background:#111;color:#eee;padding:0 16px}.c{border:1px solid #444;border-radius:8px;padding:14px;margin-bottom:26px;background:#1a1a1a}.p{display:flex;gap:20px}.col{flex:1}.col img{width:100%;border-radius:4px}.m{color:#999;font-size:12px}li{font-size:13px}</style></head><body><h1>pick-best hits since ${since} (${env})</h1>${cards.map(({ n, h, files }) => `<div class=c><h2>Hit ${n} — ${esc(h.story)} — ${h.type} ${esc(h.page)} — created ${esc(h.created)}</h2><p class=m>versions ${h.versions}, today's rule picks v${h.today}, recorded active v${h.recorded}${h.pinned ? ' (pinned)' : ''}; sources: ${esc((h.sources || []).join(', '))}${h.trigger ? '; side-by-side trigger fires' : ''}</p><div class=p>${files.map(f => `<div class=col><h3>${f.label === 'top' ? 'TOP (today picks) v' : 'OTHER v'}${f.idx}</h3>${f.f ? `<img src="${f.f}">` : '<p>image unavailable</p>'}<ul>${((f.label === 'top' ? (h.topFindings || h.todayFindings) : (h.partnerFindings || ['no CRITICAL'])) || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('')}</div></div>`).join('')}</body></html>`;
    fs.writeFileSync(path.join(dl, 'index.html'), html);
    console.log('downloaded', cards.length, 'to', dl);
  }
  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

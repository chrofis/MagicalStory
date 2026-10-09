/**
 * Replay of the character-name matchers (docs/decisions.md 2026-10-09, "name matchers")
 * over STORED staging stories: the OLD matcher (a git-archive copy of server/ at the
 * pre-change commit, OLD_ROOT) against the CURRENT one, same inputs, same process. Free: reads
 * stories.data and eval_calls, makes no model call. Prints every case whose resolved cast differs.
 *
 *   OLD_ROOT=<dir holding the old server/> NODE_PATH=<repo>/node_modules \
 *     node scripts/analysis/replay-name-matchers.js [--days=21] [--max=60]
 *
 * Plan lines are not stored in stories.data (nothing keeps them), so the plan-line matcher
 * (planCounters.namesIn) is replayed over stored page text and brief image summaries instead:
 * the same function on real prose, not on plan lines. Said plainly in the report.
 */
require('dotenv').config();
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '../..');
const OLD_ROOT = process.env.OLD_ROOT;
if (!OLD_ROOT) { console.error('set OLD_ROOT to the directory holding the old server/ copy'); process.exit(1); }
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const DAYS = Number(arg('days', 21));
const MAX = Number(arg('max', 60));

const load = (root, rel) => require(path.join(root, rel));
const mods = (root) => ({
  sm: load(root, 'server/lib/sceneMetadata.js'),
  pc: load(root, 'server/lib/planCounters.js'),
  cc: load(root, 'server/lib/clothingCheck.js'),
  sg: load(root, 'server/lib/sceneGeometry.js'),
  sb: load(root, 'server/lib/sceneBriefCheck.js'),
  scc: load(root, 'server/lib/sceneConsistencyCheck.js'),
  ic: load(root, 'server/lib/imageCompositing.js'),
});
const OLD = mods(OLD_ROOT);
const NEW = mods(ROOT);
const CR = require(path.join(ROOT, 'server/lib/castResolver.js'));

const diffs = {};
const totals = {};
function record(kind, id, page, oldV, newV, context) {
  totals[kind] = totals[kind] || { n: 0, differ: 0 };
  totals[kind].n++;
  const a = JSON.stringify(oldV); const b = JSON.stringify(newV);
  if (a === b) return;
  totals[kind].differ++;
  (diffs[kind] = diffs[kind] || []).push({ id, page, old: oldV, new: newV, context: String(context || '').slice(0, 160) });
}
const safe = (fn) => { try { return fn(); } catch (e) { return `ERR ${e.message}`; } };

(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const ids = (await pool.query(`select id from stories where created_at > now() - interval '${DAYS} days' and data ? 'sceneDescriptions' order by created_at desc limit ${MAX}`)).rows.map(r => r.id);
  console.log(`stories: ${ids.length}`);
  let pages = 0;
  for (const id of ids) {
    const d = (await pool.query(`select data->'characters' as characters, data->'visualBible' as vb, data->'sceneDescriptions' as sd, data->'sceneImages' as si, data->'coverHints' as ch, data->'clothingRequirements' as cr from stories where id=$1`, [id])).rows[0];
    const chars = (d.characters || []).filter(c => c && c.name);
    if (!chars.length) continue;
    const vb = d.vb || {};
    const castNames = chars.map(c => c.name);
    const everyone = [...castNames, ...(vb.secondaryCharacters || []).map(c => c.name), ...(vb.animals || []).map(c => c.name)].filter(Boolean);
    const sd = d.sd || [];
    const si = d.si || [];
    for (const s of sd) {
      const desc = String(s.description || '');
      if (!desc) continue;
      pages++;
      const p = s.pageNumber;
      const names = (list) => (list || []).map(c => c.name);
      // sceneMetadata: the roster of a brief (metadata list, parser, text scan) and the union with the hint
      record('sceneMetadata.getCharactersInScene', id, p, names(safe(() => OLD.sm.getCharactersInScene(desc, chars))), names(safe(() => NEW.sm.getCharactersInScene(desc, chars))), desc.slice(0, 80));
      const meta = safe(() => NEW.sm.extractSceneMetadata(desc)) || {};
      const hint = (meta.characters || []).map(c => (typeof c === 'string' ? c : c && c.name)).filter(Boolean);
      record('sceneMetadata.unionPageCast', id, p, names(safe(() => OLD.sm.unionPageCast(desc, hint, chars))), names(safe(() => NEW.sm.unionPageCast(desc, hint, chars))), hint.join(','));
      record('sceneMetadata.findCastMissingFromMetadata', id, p, safe(() => OLD.sm.findCastMissingFromMetadata(desc, everyone)), safe(() => NEW.sm.findCastMissingFromMetadata(desc, everyone)), '');
      const prose = safe(() => NEW.sm.splitBrief(desc).prose) || '';
      // planCounters.namesIn over stored prose (plan lines are not stored)
      const stored = String((si.find(x => x.pageNumber === p) || {}).text || '');
      for (const [label, text] of [['page text', stored], ['brief prose', prose]]) {
        record(`planCounters.namesIn (${label})`, id, p, safe(() => OLD.pc.namesIn(text, everyone)), safe(() => NEW.pc.namesIn(text, everyone)), text.slice(0, 80));
      }
      // clothingCheck.characterWindow
      for (const n of castNames) record('clothingCheck.characterWindow', id, p, safe(() => OLD.cc.characterWindow(prose, n, castNames)), safe(() => NEW.cc.characterWindow(prose, n, castNames)), n);
      // sceneGeometry.selectGeometryFacts
      record('sceneGeometry.selectGeometryFacts', id, p, safe(() => OLD.sg.selectGeometryFacts({ mainScenePrompt: prose, castNames: everyone })), safe(() => NEW.sg.selectGeometryFacts({ mainScenePrompt: prose, castNames: everyone })), '');
      // sceneBriefCheck population / uncited
      const full = (meta && meta.fullData) || meta || {};
      const page = { pageNumber: p, brief: desc, planLine: '' };
      record('sceneBriefCheck.checkPopulationContradiction', id, p, safe(() => OLD.sb.checkPopulationContradiction(page, meta, castNames)), safe(() => NEW.sb.checkPopulationContradiction(page, meta, castNames)), '');
      record('sceneBriefCheck.checkElementUncited', id, p, safe(() => OLD.sb.checkElementUncited(page, full, vb, castNames)), safe(() => NEW.sb.checkElementUncited(page, full, vb, castNames)), '');
      // sceneConsistencyCheck
      const cp = [{ pageNumber: p, sceneProse: prose, sceneHint: JSON.stringify(full) }];
      record('sceneConsistencyCheck.checkSceneConsistency', id, p, safe(() => OLD.scc.checkSceneConsistency(cp, null, { knownCharacterNames: everyone })), safe(() => NEW.scc.checkSceneConsistency(cp, null, { knownCharacterNames: everyone })), '');
      // imageCompositing.stripCharacterNames (case sensitive replace of names by identifiers)
      const vid = new Map(everyone.map(n => [n.toLowerCase(), `the ${n.length}-letter figure`]));
      record('imageCompositing.stripCharacterNames', id, p, safe(() => OLD.ic.stripCharacterNames(prose, { names: everyone, vidByName: vid })), safe(() => NEW.ic.stripCharacterNames(prose, { names: everyone, vidByName: vid })), '');

      // storyJobPipeline / coverIterate / entityConsistency inline sites: the old code is a substring test
      // over lower-cased text; the new one is castResolver.entriesMentioned. Same text (the brief).
      const lower = desc.toLowerCase();
      const oldSub = chars.filter(c => lower.includes(c.name.toLowerCase())).map(c => c.name);
      const newWhole = CR.entriesMentioned(desc, CR.buildCastIndex({ characters: chars }, null)).map(e => e.name);
      const snippet = (names) => names.map((n) => { const i = lower.indexOf(n.toLowerCase()); return i < 0 ? n : `"...${desc.slice(Math.max(0, i - 25), i + n.length + 25).replace(/\s+/g, ' ')}..."`; }).join(' | ');
      record('substring vs whole word: cast names in a brief (storyJobPipeline background, coverIterate fallback)', id, p, oldSub, newWhole, snippet(oldSub.filter(n => !newWhole.includes(n))));
      const oldVb = [...(vb.animals || []), ...(vb.secondaryCharacters || [])].filter(e => e && e.name && lower.includes(e.name.toLowerCase())).map(e => e.name);
      const vIdx = CR.buildCastIndex(null, vb);
      const newVb = [...CR.entriesMentioned(desc, vIdx, { kinds: ['animal'] }), ...CR.entriesMentioned(desc, vIdx, { kinds: ['secondary'] })].map(e => e.name);
      record('substring vs whole word: VB animals + secondary in a brief (entityConsistency)', id, p, oldVb, newVb, snippet(oldVb.filter(n => !newVb.includes(n))));

      // structured: the brief's characters[] names resolved against the cast (storyJobPipeline page.characters)
      const idx = CR.buildCastIndex({ characters: chars }, null);
      const oldResolve = [];
      for (const parsed of hint) {
        const parsedLower = parsed.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim();
        const m = chars.find(ch => { const nl = ch.name.toLowerCase().trim(); return parsedLower === nl || parsedLower === nl.split(' ')[0]; });
        if (m && !oldResolve.includes(m.name)) oldResolve.push(m.name);
      }
      const newResolve = [];
      for (const parsed of hint) { const e = CR.resolveEntity(parsed, idx); if (e && !newResolve.includes(e.name)) newResolve.push(e.name); }
      record('structured: brief characters[] resolved to the cast (storyJobPipeline page.characters)', id, p, oldResolve, newResolve, hint.join(','));
    }
    // covers: coverHints characters vs the roster (storyJobPipeline exact lowercase match)
    for (const [key, h] of Object.entries(d.ch || {})) {
      // stored hints write "Lukas (center)"; the trial cover scene the pipeline reads carries {name}
      const listed = ((h && h.characters) || []).map(c => (typeof c === 'string' ? c : c && c.name)).map(n => String(n || '').replace(/\s*\([^)]*\)\s*$/, '').trim());
      const oldC = chars.filter(c => listed.map(x => String(x || '').toLowerCase()).includes(c.name.toLowerCase())).map(c => c.name);
      const idx = CR.buildCastIndex({ characters: chars }, null);
      const hit = new Set(listed.map(n => CR.resolveEntity(n, idx)).filter(Boolean).map(e => e.entry));
      record('structured: cover characters resolved to the cast (storyJobPipeline)', id, key, oldC, chars.filter(c => hit.has(c)).map(c => c.name), listed.join(','));
    }
    // clothingRequirements key lookup (storyJobPipeline avatarRequirementsFor / basicCoverRequirements)
    const reqs = d.cr || {};
    for (const c of chars) {
      const lower = String(c.name).toLowerCase(); const trimmed = c.name.trim();
      const oldHit = reqs[c.name] || reqs[trimmed] || reqs[lower] || Object.entries(reqs).find(([k]) => k.trim().toLowerCase() === lower)?.[1];
      const newHit = (CR.lookupByName(reqs, c.name, CR.buildCastIndex({ characters: chars }, null)) || {}).value;
      record('structured: clothingRequirements lookup by character name', id, c.name, !!oldHit, !!newHit, '');
    }
    // bboxDetection: names in stored evaluator issue text
    const ev = (await pool.query("select page_number, raw_response from eval_calls where story_id=$1 and kind in ('quality','semantic') limit 40", [id])).rows;
    for (const r of ev) {
      const texts = [...String(r.raw_response || '').matchAll(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
      for (const t of texts) {
        const oldN = castNames.filter(n => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[\u2019']s)?\\b`, 'i').test(t.toLowerCase()));
        const newN = CR.namesMentioned(t, castNames);
        record('bboxDetection.extractCharacterNames over stored evaluator issue text', id, r.page_number, oldN, newN, t);
      }
    }
  }
  console.log(`pages replayed: ${pages}\n`);
  for (const [k, t] of Object.entries(totals)) console.log(`${String(t.n).padStart(6)} cases  ${String(t.differ).padStart(4)} differ  ${k}`);
  for (const [k, list] of Object.entries(diffs)) {
    console.log(`\n=== ${k}: ${list.length} differing`);
    for (const x of list.slice(0, 12)) console.log(`- ${x.id} p${x.page}\n    old: ${JSON.stringify(x.old).slice(0, 220)}\n    new: ${JSON.stringify(x.new).slice(0, 220)}\n    ctx: ${x.context}`);
    if (list.length > 12) console.log(`  ... ${list.length - 12} more`);
  }
  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

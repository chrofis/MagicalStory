#!/usr/bin/env node
/**
 * RUNG 1 OF "THE ART DIRECTOR STOPS WRITING WHAT CODE DECIDES" (owner,
 * 2026-10-05; docs/decisions.md 2026-10-05). Free: replays the production merge
 * (jevDecisions.pinBrief, via jevBriefFields.assembleBriefs) over the STORED
 * Art Director reply of a story, with the copied fields stripped out of each
 * brief the way the new template asks the Art Director to leave them, and
 * checks the assembled metadata equals what the run pinned before this change.
 *
 *   node scripts/analysis/replay-ad-assembly.js <storyId> [<storyId> ...] [--dotenv=<path>]
 *
 * The page's decisions are read back from its FIXED block in the stored
 * call-2 prompt (sceneExpansionReport.prompts[0].prompt) — the same text the
 * Art Director read — so nothing here is re-decided.
 *
 * Exports `fixedOfBlock`, `stripDecided` and `replayStory` for the unit test.
 * Loads leaf modules only (never beatsPipeline). Reads with a pg Pool and
 * closes it.
 */
const path = require('path');
const ROOT = path.join(__dirname, '../..');

const baseId = id => String(id || '').trim().toUpperCase().split('.')[0];
const isLoc = id => /^LOC\d+/i.test(String(id));
const ID_RE = /\b([A-Z]{3}\d{3}(?:\.\d+)?)\b/g;

/**
 * The jevFixed object of one story page, read back from its FIXED block (the
 * lines jevDecisions.fixedBlock wrote). `decidedIds` / `aboardIds` come from the
 * Visual Bible exactly as decideBriefFields derived them.
 */
function fixedOfBlock(block, { decidedIds, aboardIds }) {
  const line = key => (String(block).match(new RegExp(`^- ${key}: (.*)$`, 'm')) || [])[1];
  const f = { decidedIds, aboardIds };
  const shot = line('shot');
  if (shot) f.shot = shot;
  const light = line('timeOfDay');
  if (light) { f.timeOfDay = light.split(';')[0].trim(); f.indoor = /indoors/.test(light); }
  const objects = line('objects');
  if (objects !== undefined) {
    const ids = objects === 'none' ? [] : [...objects.matchAll(ID_RE)].map(m => m[1]);
    // The FIXED line labels an id with its name in brackets; a label can carry
    // digits, never a three-letter id, so the id regex reads only ids.
    const loc = ids.find(isLoc);
    if (loc) f.location = loc;
    f.cites = ids.filter(i => !isLoc(i));
  }
  const aboard = line('aboard');
  if (aboard !== undefined) f.aboard = aboard === 'none' ? null : (aboard.match(ID_RE) || [])[0];
  const pop = line('population');
  if (pop) f.population = pop.trim();
  const gaze = line('looksAt');
  if (gaze) {
    f.looksAt = Object.fromEntries(gaze.split('; ').map((part) => {
      const [name, target] = part.split(' → ');
      return [name.trim(), /^away\b/.test(target) ? 'away' : (target.match(ID_RE) || [target.trim()])[0]];
    }));
  }
  return f;
}

/** The location-only FIXED block of a cover. */
function coverFixedOfBlock(block) {
  const m = String(block).match(/^- location: .*?\b([A-Z]{3}\d{3}(?:\.\d+)?)\b/m);
  return m ? { location: m[1], coverPlace: true } : null;
}

/**
 * The brief as the new template asks the Art Director to write it: the decided
 * fields left out. Story page: shot, timeOfDay, population, aboard, every
 * character's looksAt (the roster the FIXED block lists), `weather` when
 * indoors, and the objects the block lists (decided ids and locations).
 * Cover: the location only.
 */
function stripDecided(brief, fixed) {
  const { parseProseMetadataFormat } = require('../../server/lib/sceneMetadata');
  const parsed = parseProseMetadataFormat(String(brief || ''));
  if (!parsed) return null;
  const m = { ...parsed.metadata };
  const decided = new Set((fixed.decidedIds || []).map(baseId));
  if (fixed.coverPlace) {
    m.objects = (m.objects || []).filter(o => !isLoc(o));
  } else {
    for (const k of ['shot', 'timeOfDay', 'population', 'aboard']) delete m[k];
    if (fixed.indoor === true) delete m.weather;
    m.objects = (m.objects || []).filter(o => !isLoc(o) && !decided.has(baseId(o)));
    if (fixed.looksAt && Array.isArray(m.characters)) {
      m.characters = m.characters.map((c) => {
        if (!c || typeof c !== 'object' || !(c.name in fixed.looksAt)) return c;
        const { looksAt, ...rest } = c;
        return rest;
      });
    }
  }
  return { text: `${parsed.prose}\n\n---METADATA---\n${JSON.stringify(m)}`, metadata: m };
}

const sorted = o => (Array.isArray(o) ? o.map(sorted) : o && typeof o === 'object'
  ? Object.fromEntries(Object.keys(o).sort().map(k => [k, sorted(o[k])])) : o);

/**
 * @returns {{pages:Array, bytesBefore:number, bytesAfter:number}} per page:
 *   equal (assembled metadata deep-equals today's pinned metadata), and the two
 *   objects when not.
 */
function replayStory(d) {
  const { parseRefinedText, BRIEF_TRAILING_MARKERS } = require('../../server/lib/promptBuilders');
  const { parseProseMetadataFormat } = require('../../server/lib/sceneMetadata');
  const JD = require('../../server/lib/jevDecisions');
  const se = d.sceneExpansionReport;
  const prompt = se.prompts[0].prompt;
  const vb = d.visualBible || {};
  const commissioned = (d.characters || []).map(c => c && c.name).filter(Boolean);
  const els = JD.vbElements(vb, commissioned);
  const ctx = { decidedIds: els.map(e => e.id), aboardIds: els.filter(e => e.type === 'vehicle').map(e => e.id) };
  const nums = [...prompt.matchAll(/^## Page (-?\d+)$/gm)].map(m => Number(m[1]));
  const byPage = new Map();
  for (const r of se.replies) {
    for (const p of parseRefinedText(r.text, nums, 'SCENES', BRIEF_TRAILING_MARKERS).pages) if (!byPage.has(p.pageNumber)) byPage.set(p.pageNumber, p.text);
  }
  const pages = [];
  let bytesBefore = 0;
  let bytesAfter = 0;
  for (const [n, raw] of byPage) {
    const block = (prompt.split(new RegExp(`^## Page ${n}$`, 'm'))[1] || '').split(/^## Page /m)[0];
    const fixed = n <= 0 ? coverFixedOfBlock(block) : fixedOfBlock(block, ctx);
    if (!fixed || !parseProseMetadataFormat(raw)) { pages.push({ pageNumber: n, skipped: true }); continue; }
    const today = parseProseMetadataFormat(JD.pinBrief(raw, fixed).brief).metadata;
    const stripped = stripDecided(raw, fixed);
    const assembled = parseProseMetadataFormat(JD.pinBrief(stripped.text, fixed).brief).metadata;
    bytesBefore += raw.length;
    bytesAfter += stripped.text.length;
    const equal = JSON.stringify(sorted(today)) === JSON.stringify(sorted(assembled));
    pages.push({ pageNumber: n, equal, ...(equal ? {} : { today, assembled }) });
  }
  return { pages, bytesBefore, bytesAfter };
}

module.exports = { fixedOfBlock, coverFixedOfBlock, stripDecided, replayStory };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const ids = argv.filter(a => !a.startsWith('--'));
  const dotenv = (argv.find(a => a.startsWith('--dotenv=')) || '').slice(9) || path.join(ROOT, '.env');
  require('dotenv').config({ path: dotenv });
  const { Pool } = require('pg');
  (async () => {
    const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    let bad = 0;
    for (const id of ids) {
      const r = await pool.query('select data from stories where id = $1', [id]);
      if (!r.rows[0]) { console.log(`${id}: not found`); bad++; continue; }
      const out = replayStory(r.rows[0].data);
      const checked = out.pages.filter(p => !p.skipped);
      const diff = checked.filter(p => !p.equal);
      bad += diff.length;
      console.log(`${id}: ${checked.length} page(s) replayed, ${out.pages.length - checked.length} skipped, ${diff.length} differ; reply ${out.bytesBefore} -> ${out.bytesAfter} chars (${(100 * (1 - out.bytesAfter / out.bytesBefore)).toFixed(1)}% smaller)`);
      for (const p of diff) {
        const keys = [...new Set([...Object.keys(p.today), ...Object.keys(p.assembled)])].filter(k => JSON.stringify(sorted(p.today[k])) !== JSON.stringify(sorted(p.assembled[k])));
        for (const k of keys) console.log(`  p${p.pageNumber} ${k}: today ${JSON.stringify(p.today[k])} | new ${JSON.stringify(p.assembled[k])}`);
      }
    }
    await pool.end();
    process.exit(bad ? 1 : 0);
  })().catch((e) => { console.error(e); process.exit(1); });
}

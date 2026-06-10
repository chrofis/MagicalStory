#!/usr/bin/env node
/**
 * Measure whether the unified story call degrades as output grows
 * ("Sonnet overload" hypothesis) — v2.
 *
 * Key structure facts (verified against raw outputs):
 *   - ---STORY DRAFT--- holds ALL pages as "**Draft N**" blocks.
 *   - ---STORY PAGES--- holds ONLY the patched pages ("--- Page N ---").
 *   - Production merges: patched version if present, else draft.
 *
 * Signals measured:
 *   A. CHR-id-as-name: characters[].name / prose using "CHR###" instead of the
 *      real name — compared DRAFT vs PATCH for the same page (fatigue test:
 *      patches are emitted ~25-35k tokens deeper into the output).
 *   B. Metadata contract violations on the MERGED story by page position.
 *   C. Patch volume: how many pages re-emitted (output duplication).
 *   D. Output composition: chars per section.
 *
 * Usage: node scripts/analysis/measure-unified-load.js [--limit=10]
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const LIMIT = parseInt((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '10', 10);

const SECTION_ORDER = ['CHARACTER ARCS', 'PLOT STRUCTURE', 'STORY DRAFT', 'ANALYSIS', 'TITLE', 'CLOTHING REQUIREMENTS', 'VISUAL BIBLE', 'COVER SCENE HINTS', 'SCENE PLAN', 'STORY PAGES'];

function sectionSpans(text) {
  // Collect ALL occurrences of every marker (SCENE PLAN sometimes appears
  // twice: once inside STORY DRAFT, once in its proper slot).
  const spans = [];
  for (const name of SECTION_ORDER) {
    const re = new RegExp(`---\\s*${name}\\s*---`, 'gi');
    let m;
    while ((m = re.exec(text)) !== null) {
      spans.push({ name, start: m.index, bodyStart: m.index + m[0].length });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  for (let i = 0; i < spans.length; i++) spans[i].end = i + 1 < spans.length ? spans[i + 1].start : text.length;
  return spans;
}
// Region from a marker to the next occurrence of a TERMINATOR marker —
// ignores nested markers in between (e.g. SCENE PLAN inside STORY DRAFT).
function regionBetween(text, name, terminators) {
  const m = new RegExp(`---\\s*${name}\\s*---`, 'i').exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  let end = text.length;
  for (const t of terminators) {
    const re = new RegExp(`---\\s*${t}\\s*---`, 'gi');
    let m2;
    while ((m2 = re.exec(text)) !== null) {
      if (m2.index > start && m2.index < end) { end = m2.index; break; }
    }
  }
  return text.slice(start, end);
}

// "--- Page N ---" blocks (patch section)
function patchBlocks(sectionText) {
  if (!sectionText) return [];
  const out = []; const re = /---\s*Page\s+(\d+)\s*---/gi;
  let m, prev = null;
  while ((m = re.exec(sectionText)) !== null) {
    if (prev) out.push({ page: prev.page, text: sectionText.slice(prev.end, m.index) });
    prev = { page: parseInt(m[1], 10), end: m.index + m[0].length };
  }
  if (prev) out.push({ page: prev.page, text: sectionText.slice(prev.end) });
  return out;
}
// "**Draft N**" / "**Draft Page N**" blocks (spec says "**Draft [Page number]**",
// which Sonnet renders either way)
function draftBlocks(sectionText) {
  if (!sectionText) return [];
  const out = []; const re = /\*\*Draft\s+(?:Page\s+)?(\d+)\*?\*?/gi;
  let m, prev = null;
  while ((m = re.exec(sectionText)) !== null) {
    if (prev) out.push({ page: prev.page, text: sectionText.slice(prev.end, m.index) });
    prev = { page: parseInt(m[1], 10), end: m.index + m[0].length };
  }
  if (prev) out.push({ page: prev.page, text: sectionText.slice(prev.end) });
  return out;
}

// Tolerant METADATA JSON extractor
function extractMetadata(blockText) {
  const idx = blockText.search(/METADATA\s*:/i);
  if (idx === -1) return { found: false };
  const rest = blockText.slice(idx);
  const braceStart = rest.indexOf('{');
  if (braceStart === -1) return { found: true, parsed: null };
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = braceStart; i < rest.length; i++) {
    const c = rest[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return { found: true, parsed: null, truncated: true };
  let raw = rest.slice(braceStart, end + 1);
  try { return { found: true, parsed: JSON.parse(raw), strict: true }; } catch { /* tolerant retry */ }
  raw = raw.replace(/,\s*([}\]])/g, '$1').replace(/^\s*\/\/.*$/gm, '');
  try { return { found: true, parsed: JSON.parse(raw), strict: false }; }
  catch { return { found: true, parsed: null, parseError: true }; }
}

const LEFT = new Set(['top-left', 'bottom-left']);
const RIGHT = new Set(['top-right', 'bottom-right']);
const CHRID = /^(CHR|ANI)\d+$/i;

function scorePage(page, blockText) {
  const meta = extractMetadata(blockText);
  const md = meta.parsed;
  const rec = {
    page, hasMeta: meta.found, jsonHardFail: !!meta.parseError || !!meta.truncated,
    jsonLoose: meta.found && md && meta.strict === false,
    missing: [], parityViol: false, chrIdNames: 0, chrIdInProse: 0,
  };
  // CHR ids used as names in the SCENE prose
  const proseCut = blockText.search(/METADATA\s*:/i);
  const prose = proseCut === -1 ? blockText : blockText.slice(0, proseCut);
  rec.chrIdInProse = (prose.match(/\b(CHR|ANI)\d+\b/g) || []).length;
  if (!md) return rec;
  for (const f of ['sceneIntent', 'textPosition', 'textZoneDescription', 'emptyScenePrompt', 'era']) {
    if (!md[f]) rec.missing.push(f);
  }
  const tp = md.textPosition || '';
  if (LEFT.has(tp) && page % 2 === 0) rec.parityViol = true;
  if (RIGHT.has(tp) && page % 2 === 1) rec.parityViol = true;
  for (const c of (Array.isArray(md.characters) ? md.characters : [])) {
    if (c?.name && CHRID.test(String(c.name).trim())) rec.chrIdNames++;
  }
  for (const i of (Array.isArray(md.interactions) ? md.interactions : [])) {
    if (i?.character && CHRID.test(String(i.character).trim())) rec.chrIdNames++;
  }
  return rec;
}

(async () => {
  const rows = (await pool.query(`
    SELECT id, data->>'outline' AS outline,
           (data->>'pages')::int AS pages,
           data->'outlineUsage' AS usage
    FROM stories
    WHERE jsonb_array_length(COALESCE(data->'sceneImages','[]'::jsonb)) >= 10
      AND length(data->>'outline') > 20000
    ORDER BY created_at DESC
    LIMIT $1`, [LIMIT])).rows;

  console.log(`Analyzing ${rows.length} stories\n`);
  const draftRecs = [], patchRecs = [], mergedRecs = [];
  const compo = {};
  let totPages = 0, totPatched = 0;

  console.log('STORY                          | pgs | outChars | patched | draft chrId(name/prose) | patch chrId(name/prose)');
  for (const row of rows) {
    const o = row.outline;
    const spans = sectionSpans(o);
    for (const s of spans) { compo[s.name] = (compo[s.name] || 0) + (s.end - s.start); }
    const drafts = draftBlocks(regionBetween(o, 'STORY DRAFT', ['ANALYSIS']));
    const patches = patchBlocks(regionBetween(o, 'STORY PAGES', ['FINAL CHECKLIST']));
    const patchByPage = new Map(patches.map(b => [b.page, b]));
    totPages += drafts.length; totPatched += patches.length;

    const dR = drafts.map(b => scorePage(b.page, b.text));
    const pR = patches.map(b => scorePage(b.page, b.text));
    draftRecs.push(...dR); patchRecs.push(...pR);
    // merged view = patch if present else draft
    for (const b of drafts) {
      const src = patchByPage.get(b.page) || b;
      mergedRecs.push({ ...scorePage(b.page, src.text), fromPatch: patchByPage.has(b.page) });
    }
    const dn = dR.reduce((s, r) => s + r.chrIdNames, 0), dp = dR.reduce((s, r) => s + r.chrIdInProse, 0);
    const pn = pR.reduce((s, r) => s + r.chrIdNames, 0), pp = pR.reduce((s, r) => s + r.chrIdInProse, 0);
    console.log(`${row.id.padEnd(30)} | ${String(drafts.length).padStart(3)} | ${String(o.length).padStart(8)} | ${String(patches.length).padStart(7)} | ${String(dn).padStart(10)}/${String(dp).padEnd(11)} | ${String(pn).padStart(10)}/${String(pp).padEnd(10)}`);
  }

  const rate = (arr, f) => arr.length ? (100 * arr.filter(f).length / arr.length).toFixed(1) : '—';
  const avg = (arr, f) => arr.length ? (arr.reduce((s, x) => s + f(x), 0) / arr.length).toFixed(2) : '—';

  console.log(`\n=== A. FATIGUE TEST: same metric, DRAFT (early output) vs PATCH (late output) ===`);
  console.log(`                          |  n   | chrId-as-name/pg | chrId-in-prose/pg | metaMissing/pg | jsonHardFail% | parityViol%`);
  for (const [label, arr] of [['DRAFT pages', draftRecs], ['PATCH pages', patchRecs]]) {
    console.log(`${label.padEnd(25)} | ${String(arr.length).padStart(4)} | ${avg(arr, r => r.chrIdNames).padStart(16)} | ${avg(arr, r => r.chrIdInProse).padStart(17)} | ${avg(arr, r => r.missing.length).padStart(14)} | ${rate(arr, r => r.jsonHardFail).padStart(13)} | ${rate(arr, r => r.parityViol).padStart(11)}`);
  }

  console.log(`\n=== B. MERGED story (what production renders) by page position ===`);
  const buckets = { 'p1-4': [], 'p5-8': [], 'p9-12': [], 'p13+': [] };
  for (const r of mergedRecs) {
    const b = r.page <= 4 ? 'p1-4' : r.page <= 8 ? 'p5-8' : r.page <= 12 ? 'p9-12' : 'p13+';
    buckets[b].push(r);
  }
  console.log('bucket |  n  | fromPatch% | chrIdName/pg | metaMissing/pg | parityViol%');
  for (const [b, arr] of Object.entries(buckets)) {
    if (!arr.length) continue;
    console.log(`${b.padEnd(6)} | ${String(arr.length).padStart(3)} | ${rate(arr, r => r.fromPatch).padStart(10)} | ${avg(arr, r => r.chrIdNames).padStart(12)} | ${avg(arr, r => r.missing.length).padStart(14)} | ${rate(arr, r => r.parityViol).padStart(11)}`);
  }

  console.log(`\n=== C. PATCH VOLUME === ${totPatched}/${totPages} pages re-emitted (${(100 * totPatched / totPages).toFixed(0)}% duplication)`);

  console.log(`\n=== D. OUTPUT COMPOSITION (chars, pooled over ${rows.length} stories) ===`);
  const tot = Object.values(compo).reduce((a, b) => a + b, 0);
  for (const [name, chars] of Object.entries(compo).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name.padEnd(22)} ${String(chars).padStart(9)} (${(100 * chars / tot).toFixed(1)}%)`);
  }
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); console.error(e.stack); process.exit(1); });

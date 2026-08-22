#!/usr/bin/env node
/**
 * Rewrite `landmark_index.wikipedia_extract` to remove abbreviations, via Haiku.
 *
 * WHY: the extract is handed to the story writer as DESCRIPTION, so anything in
 * it can reach a page a child reads — a production story opened with "zur
 * SZU-Station". The mechanical strip only removes the parenthetical form
 * "Full Name (ABBR)"; it cannot touch a bare acronym like SNCF or ZVV without
 * leaving a sentence with no subject. A model can rephrase instead.
 *
 * UNESCO and NASA are KEPT (owner, 2026-08-22): they are widely enough known to
 * read as words. Every other acronym goes — expanded to its full name, or the
 * clause rewritten around it.
 *
 * Roman numerals are not abbreviations and are left alone.
 *
 * Usage:
 *   node scripts/admin/rewrite-landmark-extracts.js --dry-run --limit=16
 *   node scripts/admin/rewrite-landmark-extracts.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

const MODEL = 'claude-haiku-4-5-20251001';
const BATCH = 8;
const KEEP = new Set(['UNESCO', 'NASA']);
const ROMAN = /^[IVXLCDM]+$/;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/** Acronyms still present in a text, ignoring Roman numerals and the keep-list. */
function acronymsIn(text) {
  return [...String(text || '').matchAll(/\b[A-ZÄÖÜ]{2,8}\b/g)]
    .map(m => m[0])
    .filter(t => !ROMAN.test(t) && !KEEP.has(t));
}

const PROMPT = `Rewrite each landmark description so it contains no abbreviations or acronyms.

Rules:
- Replace an acronym with its full name, or rewrite the clause so it is not needed.
- KEEP the acronyms UNESCO and NASA exactly as they are. They are the only two allowed.
- Keep the same language as the input. Keep the meaning and the facts. Do not add anything.
- Keep roughly the same length. Do not summarise.
- Roman numerals (II, XIX) are not abbreviations — leave them.
- Cantonal codes in place names (Gossau ZH, Baden AG) — write the canton out (Gossau im Kanton St. Gallen) or drop the code if the sentence still reads.

Return ONLY a JSON array of the rewritten strings, in the same order, same length as the input array. No other text.`;

async function rewriteBatch(texts) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: `${PROMPT}\n\n${JSON.stringify(texts, null, 1)}` }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const raw = (data.content || []).map(c => c.text || '').join('').trim();
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) throw new Error(`no JSON array in reply: ${raw.slice(0, 150)}`);
  const out = JSON.parse(m[0]);
  if (!Array.isArray(out) || out.length !== texts.length) {
    throw new Error(`expected ${texts.length} strings, got ${Array.isArray(out) ? out.length : typeof out}`);
  }
  return { out, usage: data.usage || {} };
}

async function main() {
  const { rows } = await pool.query(
    'SELECT id, name, wikipedia_extract FROM landmark_index WHERE wikipedia_extract IS NOT NULL ORDER BY id');
  let todo = rows.filter(r => acronymsIn(r.wikipedia_extract).length > 0);
  if (limit) todo = todo.slice(0, limit);
  console.log(`Extracts with an abbreviation: ${todo.length}${dryRun ? '  (DRY RUN — no writes)' : ''}`);
  console.log(`Model: ${MODEL}, batch ${BATCH}\n`);

  let written = 0, cleaned = 0, stillDirty = 0, inTok = 0, outTok = 0;
  const samples = [];

  for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH);
    let result;
    try {
      result = await rewriteBatch(slice.map(r => r.wikipedia_extract));
    } catch (err) {
      console.error(`  [ERROR] batch at ${i}: ${err.message} — left unchanged`);
      continue;
    }
    inTok += result.usage.input_tokens || 0;
    outTok += result.usage.output_tokens || 0;

    for (let k = 0; k < slice.length; k++) {
      const before = slice[k].wikipedia_extract;
      const after = String(result.out[k] || '').trim();
      if (!after || after.length < before.length * 0.5) continue;   // refuse a truncation
      const left = acronymsIn(after);
      if (left.length === 0) cleaned++; else stillDirty++;
      if (samples.length < 8 && before !== after) {
        samples.push({ name: slice[k].name, before, after });
      }
      if (!dryRun && before !== after) {
        await pool.query('UPDATE landmark_index SET wikipedia_extract = $1 WHERE id = $2', [after, slice[k].id]);
        written++;
      }
    }
    if ((i / BATCH) % 10 === 0) console.log(`  ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
  }

  console.log(`\n  clean after rewrite : ${cleaned}`);
  console.log(`  still has an acronym: ${stillDirty}`);
  if (!dryRun) console.log(`  rows written        : ${written}`);
  const cost = (inTok / 1e6) * 1 + (outTok / 1e6) * 5;
  console.log(`  tokens: ${inTok} in / ${outTok} out  ≈ $${cost.toFixed(3)}`);

  console.log('\n  samples:');
  samples.slice(0, 4).forEach(s => {
    console.log(`\n    ${s.name}`);
    console.log(`      BEFORE: ${s.before.slice(0, 190)}`);
    console.log(`      AFTER : ${s.after.slice(0, 190)}`);
  });
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });

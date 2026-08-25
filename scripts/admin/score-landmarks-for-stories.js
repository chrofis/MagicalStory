#!/usr/bin/env node
/**
 * Judge each landmark on how good it is AS A SETTING IN A CHILDREN'S BOOK, by
 * LOOKING AT ITS PHOTO — because every numeric proxy in the index ranks the
 * wrong things (see migrations/029_landmark_story_score.sql for the measurements).
 *
 * The photo matters more than the name: "Ruine Dübelstein" sounds like a castle
 * and photographs as knee-high foundation stones in gravel; "The Hall" is filed
 * in Dübendorf and its photo is Zürich's Limmat waterfront with the Grossmünster,
 * which would render the wrong city into a personalised book. Neither is
 * detectable from metadata.
 *
 * Cheap on purpose: Haiku, one small image, ~40 output tokens per landmark, and
 * only rows the ranker can actually offer (class 2 backdrop types) are worth
 * judging — the rest are already ordered below them.
 *
 *   node scripts/admin/score-landmarks-for-stories.js --city=Dübendorf [--staging] [--all-classes] [--dry-run]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const { callClaudeAPI } = require('../../server/lib/textModels');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const STAGING = args.includes('--staging');
const ALL = args.includes('--all-classes');
const cityArg = args.find(a => a.startsWith('--city='));
const CITY = cityArg ? cityArg.split('=').slice(1).join('=') : null;

const BACKDROP = ['Cathedral', 'Church', 'Abbey', 'Monastery', 'Castle', 'Palace', 'Museum',
  'Bridge', 'Tower', 'Fountain', 'Square', 'Theatre', 'Park', 'Monument', 'Library'];

const PROMPT = (l) => `You are choosing real places to set scenes in a picture book for a child under about eight.

This place is called "${l.name}". Wikipedia calls it a ${l.type || 'place'}${l.municipality ? `, in ${l.municipality}` : ''}.
${l.wikipedia_extract ? `Wikipedia: ${String(l.wikipedia_extract).slice(0, 400)}` : ''}

The image is the photo we would give the illustrator as the reference for this place.

Score 0-100 on ONE question: how good is this as a place a small child visits in a story?

High: somewhere a child could actually go and would find interesting to look at — a castle, a zoo, a museum with things in it, an old church or bridge with real character, a fountain, a playground, a boat, a tower they could climb.
Low: infrastructure, offices, research institutes, schools, apartment blocks, railway or bus stations, roads, and anything whose photo is a car park, a construction site, an office facade, or a grey street.
Zero: the photo plainly does not show the named place, or shows a different town.

Judge what the PHOTO shows, not what the name promises. A ruin that photographs as low stones in gravel is not a castle to a child.

Reply as exactly: SCORE|one short reason`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Wikimedia rate-limits bulk fetches (429) — a full-index run WILL hit it, and
// without a retry those rows would be silently skipped and look "unjudged"
// forever. Back off and try again rather than losing them.
async function fetchImageBase64(url) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'MagicalStory/1.0 (https://magicalstory.ch; rogerfischer@hotmail.com) landmark-QA' },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`photo ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`photo ${res.status}`), { fatal: true });
      const buf = Buffer.from(await res.arrayBuffer());
      const sharp = require('sharp');
      const small = await sharp(buf).resize(700, 700, { fit: 'inside' }).jpeg({ quality: 72 }).toBuffer();
      return `data:image/jpeg;base64,${small.toString('base64')}`;
    } catch (e) {
      lastErr = e;
      if (e.fatal) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
  throw lastErr;
}

(async () => {
  const url = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  const where = ['photo_url IS NOT NULL'];
  const params = [];
  if (CITY) {
    params.push(CITY);
    where.push(`LOWER(translate(nearest_city, 'üùäàâöôéèêëîïçñß', 'uuaaaooeeeeiicns')) = LOWER(translate($${params.length}, 'üùäàâöôéèêëîïçñß', 'uuaaaooeeeeiicns'))`);
  }
  if (!ALL) where.push(`type = ANY('{${BACKDROP.join(',')}}')`);
  // Resume by default: a full-index run is ~1000 rows and must survive being
  // interrupted without paying to re-judge what is already done.
  if (!args.includes('--rescore')) where.push('story_score IS NULL');

  const rows = (await pool.query(
    `SELECT id, name, type, municipality, wikipedia_extract, photo_url, score, story_score
       FROM landmark_index WHERE ${where.join(' AND ')} ORDER BY id`, params)).rows;

  console.log(`${STAGING ? 'STAGING' : 'PROD'}: ${rows.length} landmark(s) to judge${CITY ? ` in ${CITY}` : ''}${ALL ? '' : ' (backdrop types only)'}`);

  const results = [];
  for (const l of rows) {
    let img;
    try { img = await fetchImageBase64(l.photo_url); }
    catch (e) { console.log(`  ${l.name}: photo unavailable (${e.message}) — skipped`); continue; }

    let raw;
    try {
      raw = await callClaudeAPI(PROMPT(l), 120, 'claude-haiku-4-5-20251001', { images: [img] });
    } catch (e) { console.log(`  ${l.name}: judge failed (${e.message})`); continue; }

    const text = String(raw?.text || raw || '').trim();
    const m = text.match(/(\d{1,3})\s*\|\s*(.+)/s);
    if (!m) { console.log(`  ${l.name}: unparsable → ${text.slice(0, 60)}`); continue; }
    const score = Math.max(0, Math.min(100, parseInt(m[1], 10)));
    const reason = m[2].replace(/\s+/g, ' ').trim().slice(0, 300);
    results.push({ ...l, story_score: score, reason });
    console.log(`  ${String(score).padStart(3)}  ${l.name.slice(0, 46).padEnd(48)} ${reason.slice(0, 60)}`);

    if (!DRY) {
      await pool.query(
        'UPDATE landmark_index SET story_score = $2, story_score_reason = $3, story_score_at = NOW() WHERE id = $1',
        [l.id, score, reason]);
    }
    await sleep(600);
  }

  results.sort((a, b) => b.story_score - a.story_score);
  console.log(`\n${DRY ? '[dry-run] ' : ''}judged ${results.length}. Best for a story:`);
  results.slice(0, 5).forEach(r => console.log(`  ${String(r.story_score).padStart(3)}  ${r.name}`));
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

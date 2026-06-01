#!/usr/bin/env node
/**
 * Classify landmark photos by camera angle using Gemini Vision.
 *
 * Categories (single token, lowercase):
 *   distant    — wide / contextual view of the landmark in its surroundings
 *   close      — close-up of the landmark exterior, fills most of the frame
 *   interior   — inside the building/structure
 *   view_from  — looking OUT from the landmark (not at it)
 *   bad        — engraving, B&W, painting, wrong subject, unusable for ads
 *
 * Updates the DB: adds a `photo_type` per slot (photo_type, photo_type_2 … photo_type_6).
 * Re-orders slots so the highest-quality slot wins photo_url-position-1.
 *
 * Usage:
 *   node scripts/admin/classify-landmark-photos.js --test         # 3 landmarks, dry-run, prints results
 *   node scripts/admin/classify-landmark-photos.js --city=baden   # all Baden landmarks, real DB writes
 *   node scripts/admin/classify-landmark-photos.js --all          # entire landmark_index (1745 rows)
 */

require('dotenv').config();
const { Pool } = require('pg');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
}));
const TEST_MODE = args.test === 'true';
const CITY = (args.city || '').toLowerCase();
const ALL = args.all === 'true';
const LIMIT = parseInt(args.limit || (TEST_MODE ? '3' : '50'), 10);

const VALID_CATEGORIES = ['distant', 'close', 'interior', 'view_from', 'bad'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

const USER_AGENT = 'MagicalStoryLandmarkClassifier/1.0 (https://magicalstory.ch; admin@magicalstory.ch)';

async function fetchImageWithRetry(url, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': USER_AGENT },
    });
    if (res.ok) return res;
    if (res.status === 429) {
      const wait = 5000 * Math.pow(2, i); // 5s, 10s, 20s
      await sleep(wait);
      continue;
    }
    return res;
  }
  return { ok: false, status: 429 };
}

async function classifyPhoto(url, landmarkName) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');

  await sleep(800); // throttle Wikimedia
  const imgRes = await fetchImageWithRetry(url);
  if (!imgRes.ok) {
    if (imgRes.status === 429) return { category: '__retry__', reason: 'rate_limited (after 3 retries)' };
    return { category: 'bad', reason: `HTTP ${imgRes.status}` };
  }
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';

  const prompt = `Classify this photo of "${landmarkName}" into EXACTLY ONE of these categories. Respond with ONLY the single lowercase word, no other text.

  distant    — a wide / contextual exterior shot where the landmark sits in its surroundings (cityscape, valley, panorama). Other buildings, sky, or terrain take up significant frame area.
  close      — a close-up exterior shot of the landmark itself, the landmark fills most of the frame.
  interior   — taken INSIDE the landmark (nave, hall, room, courtyard enclosed by walls).
  view_from  — taken FROM the landmark looking OUT (the landmark itself is NOT the subject; the view from it is).
  bad        — engraving, illustration, painting, black-and-white historic photo, blurred, construction-site image, or shows a DIFFERENT landmark than "${landmarkName}".

Respond with just one word: distant, close, interior, view_from, or bad.`;

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const apiRes = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { text: prompt },
        { inlineData: { mimeType, data: buf.toString('base64') } },
      ] }],
      generationConfig: { maxOutputTokens: 20, temperature: 0.0 },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!apiRes.ok) return { category: 'bad', reason: `Gemini ${apiRes.status}` };
  const data = await apiRes.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toLowerCase();
  const cleaned = (raw || '').replace(/[^a-z_]/g, '');
  if (!VALID_CATEGORIES.includes(cleaned)) return { category: 'bad', reason: `unparseable: "${raw}"` };
  return { category: cleaned, reason: 'classified' };
}

async function loadLandmarks(pool) {
  let where = '';
  if (CITY) where = `WHERE LOWER(nearest_city) = '${CITY}'`;
  else if (!ALL) where = `WHERE LOWER(nearest_city) IN ('baden','aarau','winterthur','zurich','zürich')`;
  const sql = `
    SELECT id, name, nearest_city,
      photo_url, photo_url_2, photo_url_3, photo_url_4, photo_url_5, photo_url_6
    FROM landmark_index
    ${where}
    AND photo_url IS NOT NULL
    ORDER BY score DESC NULLS LAST, name
    LIMIT ${LIMIT}
  `.replace(/^\s+AND/m, where ? 'AND' : 'WHERE');
  const r = await pool.query(sql);
  return r.rows;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const landmarks = await loadLandmarks(pool);
    console.log(`Loaded ${landmarks.length} landmarks (test=${TEST_MODE}, city=${CITY || '(ad cities)'}, all=${ALL})\n`);

    const summary = { distant: 0, close: 0, interior: 0, view_from: 0, bad: 0 };

    for (const lm of landmarks) {
      console.log(`━━━ ${lm.name} (${lm.nearest_city}) ─ id=${lm.id}`);
      const slots = [];
      for (let i = 1; i <= 6; i++) {
        const url = lm[`photo_url${i === 1 ? '' : '_' + i}`];
        if (!url) continue;
        process.stdout.write(`  slot ${i}: ${url.split('/').pop().slice(0, 60)} → `);
        try {
          const { category, reason } = await classifyPhoto(url, lm.name);
          console.log(category.padEnd(10), `(${reason})`);
          summary[category] = (summary[category] || 0) + 1;
          slots.push({ slot: i, url, category });
        } catch (e) {
          console.log('ERROR', e.message);
          slots.push({ slot: i, url, category: 'bad' });
        }
      }

      if (!TEST_MODE) {
        // Re-rank: order by category priority (close > distant > interior > view_from > bad)
        const priority = { close: 4, distant: 3, interior: 2, view_from: 1, bad: 0 };
        const sorted = slots.sort((a, b) => (priority[b.category] || 0) - (priority[a.category] || 0));
        const updates = [];
        const vals = [];
        for (let i = 0; i < 6; i++) {
          const s = sorted[i];
          const urlCol = i === 0 ? 'photo_url' : `photo_url_${i + 1}`;
          const typeCol = i === 0 ? 'photo_type' : `photo_type_${i + 1}`;
          updates.push(`${urlCol} = $${vals.length + 1}, ${typeCol} = $${vals.length + 2}`);
          vals.push(s?.url || null);
          vals.push(s?.category || null);
        }
        vals.push(lm.id);
        await pool.query(`UPDATE landmark_index SET ${updates.join(', ')} WHERE id = $${vals.length}`, vals);
        console.log(`  ✓ updated DB (new primary: ${sorted[0]?.category || 'none'})`);
      }
      console.log();
    }

    console.log('━━━ Summary ━━━');
    Object.entries(summary).forEach(([k, v]) => console.log(`  ${k.padEnd(12)} ${v}`));
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });

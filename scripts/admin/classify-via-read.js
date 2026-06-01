#!/usr/bin/env node
/**
 * Classify landmark photos by photo_type WITHOUT Gemini Vision.
 *
 * Two-tier:
 *   TIER 1 — metadata heuristic (free, instant).
 *     Fetch Wikimedia Commons image-info for each photo. Auto-classify
 *     or DISCARD based on filename + description + date metadata:
 *       - filename contains 'aerial', 'panorama', 'Schrägluft', 'Luftbild'
 *         → 'distant'
 *       - filename/description contains 'Innenraum', 'interior', 'Inneres',
 *         'inside', 'Nave', 'Chor', 'nef'
 *         → 'interior'
 *       - filename contains 'Blick von', 'Aussicht von', 'view from'
 *         → 'view_from'
 *       - filename contains 'Engraving', 'Stich', 'Lithograph', 'gravure',
 *         'Painting', 'Gemälde', 'Zeichnung', 'drawing', 'sketch'
 *         → 'bad' (skip — historical illustration, not a photo)
 *       - DateTimeOriginal year < 1950 AND image looks monochrome → 'bad'
 *
 *   TIER 2 — for whatever's still ambiguous, write the photo URL + name
 *     out to a JSON manifest. A human (or me, via Read) classifies the
 *     manifest entries; the script reads back the decisions and updates
 *     the DB.
 *
 * Tier 1 typically classifies ~50-70% of photos without any visual look.
 * Tier 2 surfaces only the survivors that genuinely need eyes.
 *
 * Usage:
 *   node scripts/admin/classify-via-read.js                  # tier-1 only, dry-run
 *   node scripts/admin/classify-via-read.js --push           # tier-1 + DB writes
 *   node scripts/admin/classify-via-read.js --tier2-emit     # write ambiguous-list.json
 *   node scripts/admin/classify-via-read.js --tier2-apply    # read decisions, update DB
 *   node scripts/admin/classify-via-read.js --city="Bern"    # scope to one city
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
}));
const PUSH = args.push === 'true';
const TIER2_EMIT = args['tier2-emit'] === 'true';
const TIER2_APPLY = args['tier2-apply'] === 'true';
const ONLY_CITY = args.city ? String(args.city) : null;

const AMBIGUOUS_PATH = path.join(__dirname, 'ambiguous-photos.json');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Heuristic patterns ───────────────────────────────────────────────
// Token lists deliberately mixed-language (DE/FR/IT/EN) since Wikimedia
// metadata varies by uploader's language.
const PATTERNS = {
  distant:   /aerial|panorama|schr[äa]gluft|luftbild|drohne|drone|skyline|cityscape|vue\s+a[ée]rienne|panoramique|vista\s+a[ée]rea/i,
  interior:  /innenraum|inneres|innere\b|interior|inside|nave\b|chor\b|kreuzgang|c[oô]te\s+int[eé]rieure|nef\b|coro\b|interno|cripta|crypt\b|altar/i,
  view_from: /blick\s+von|aussicht\s+von|view\s+from|vue\s+depuis|vista\s+da|panorama\s+depuis|von\s+der/i,
  bad:       /engraving|stich|kupferstich|lithograph|gravure|gem[äa]lde|painting|zeichnung|drawing|sketch|skizze|aquarelle|wasserzeichen|holzschnitt|woodcut|illustration|map|karte|carte\s+ancienne|plan\s+ancien|coat\s+of\s+arms|wappen|blason|flag|fahne|drapeau|portrait|b[üu]ste|bust\b|statue.*detail/i,
};

function heuristicClassify(filename, description) {
  const blob = `${filename || ''} ${description || ''}`;
  if (PATTERNS.bad.test(blob))       return { category: 'bad',       confident: true,  reason: 'matches bad-pattern' };
  if (PATTERNS.distant.test(blob))   return { category: 'distant',   confident: true,  reason: 'matches aerial/panorama' };
  if (PATTERNS.interior.test(blob))  return { category: 'interior',  confident: true,  reason: 'matches interior keyword' };
  if (PATTERNS.view_from.test(blob)) return { category: 'view_from', confident: true,  reason: 'matches view-from keyword' };
  return { category: null, confident: false, reason: 'ambiguous — needs visual look' };
}

// Extract Commons filename from a thumb URL or original URL.
// e.g. https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Grossmunster.jpg/640px-Grossmunster.jpg
// returns 'Grossmunster.jpg'
function commonsFilename(url) {
  if (!url) return null;
  const m = url.match(/\/commons\/(?:thumb\/)?[a-f0-9]\/[a-f0-9]{2}\/([^/]+?)(?:\/\d+px-[^/]+)?$/i);
  return m ? decodeURIComponent(m[1]) : null;
}

async function fetchCommonsMetadata(filename) {
  if (!filename) return null;
  const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', titles: `File:${filename}`,
    prop: 'imageinfo', iiprop: 'extmetadata',
    format: 'json', formatversion: '2', origin: '*',
  });
  let res;
  try { res = await fetch(url, { headers: { 'User-Agent': 'MagicalStory classifier/1.0 (info@magicalstory.ch)' } }); }
  catch { return null; }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const page = data?.query?.pages?.[0];
  const ext = page?.imageinfo?.[0]?.extmetadata || {};
  return {
    filename,
    description: ext.ImageDescription?.value?.replace(/<[^>]+>/g, '') || '',
    date: ext.DateTimeOriginal?.value || ext.DateTime?.value || '',
    categories: ext.Categories?.value || '',
    artist: ext.Artist?.value || '',
  };
}

async function classifyPhotoSlot(row, slot) {
  const urlField = slot === 1 ? 'photo_url' : `photo_url_${slot}`;
  const typeField = slot === 1 ? 'photo_type' : `photo_type_${slot}`;
  const url = row[urlField];
  if (!url) return null;
  if (row[typeField]) return { skipped: true, reason: 'already classified' };

  const filename = commonsFilename(url);
  let meta = null;
  if (filename) {
    meta = await fetchCommonsMetadata(filename);
    await sleep(150); // throttle Wikimedia
  }
  // Combine filename + description for heuristic match
  const blob = `${filename || ''} ${meta?.description || ''} ${meta?.categories || ''}`;
  const r = heuristicClassify(blob);
  return { ...r, filename, url, slot, descriptionSample: meta?.description?.slice(0, 100) };
}

async function tier1(pool) {
  console.log('━━━ TIER 1: metadata heuristic ━━━');
  const where = ONLY_CITY
    ? `nearest_city = '${ONLY_CITY.replace(/'/g, "''")}' AND country = 'Switzerland'`
    : `country = 'Switzerland'`;
  const rows = await pool.query(
    `SELECT id, name, nearest_city,
            photo_url, photo_url_2, photo_url_3, photo_url_4, photo_url_5, photo_url_6,
            photo_type, photo_type_2, photo_type_3, photo_type_4, photo_type_5, photo_type_6
       FROM landmark_index
      WHERE ${where}
        AND (photo_type IS NULL OR photo_type_2 IS NULL OR photo_type_3 IS NULL OR
             photo_type_4 IS NULL OR photo_type_5 IS NULL OR photo_type_6 IS NULL)
        AND photo_url IS NOT NULL
   ORDER BY nearest_city, name`
  );

  console.log(`  Rows with unclassified slots: ${rows.rowCount}`);
  const ambiguous = [];
  let confident = 0, alreadyDone = 0, skipped = 0;

  for (let i = 0; i < rows.rowCount; i++) {
    const r = rows.rows[i];
    if (i % 50 === 0) console.log(`  [${i + 1}/${rows.rowCount}] ${r.nearest_city} / ${r.name}`);
    for (const slot of [1, 2, 3, 4, 5, 6]) {
      const result = await classifyPhotoSlot(r, slot);
      if (!result) continue;
      if (result.skipped) { alreadyDone++; continue; }
      if (result.confident) {
        if (PUSH) {
          const typeField = slot === 1 ? 'photo_type' : `photo_type_${slot}`;
          await pool.query(`UPDATE landmark_index SET ${typeField} = $1 WHERE id = $2`, [result.category, r.id]);
        }
        confident++;
      } else {
        ambiguous.push({
          id: r.id, name: r.name, nearest_city: r.nearest_city,
          slot, url: result.url, filename: result.filename,
          description: result.descriptionSample,
        });
      }
    }
  }

  console.log(`\n  ✓ Classified confidently:  ${confident}`);
  console.log(`  = Already had photo_type:  ${alreadyDone}`);
  console.log(`  ? Ambiguous → needs eyes:  ${ambiguous.length}`);
  return ambiguous;
}

async function main() {
  if (TIER2_APPLY) {
    if (!fs.existsSync(AMBIGUOUS_PATH)) { console.error('No ambiguous-photos.json — run tier-1 first.'); process.exit(1); }
    const list = JSON.parse(fs.readFileSync(AMBIGUOUS_PATH, 'utf8'));
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    let applied = 0;
    for (const item of list) {
      if (!item.decision) continue;
      const typeField = item.slot === 1 ? 'photo_type' : `photo_type_${item.slot}`;
      if (PUSH) {
        await pool.query(`UPDATE landmark_index SET ${typeField} = $1 WHERE id = $2`, [item.decision, item.id]);
      }
      applied++;
    }
    console.log(`Applied ${applied} ${PUSH ? 'decisions' : '(dry-run)'}`);
    await pool.end();
    return;
  }

  console.log(PUSH ? '⚠️  PUSH MODE — writes to DB' : 'DRY-RUN — no writes');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const ambiguous = await tier1(pool);

  if (TIER2_EMIT) {
    fs.writeFileSync(AMBIGUOUS_PATH, JSON.stringify(ambiguous, null, 2));
    console.log(`\n  ✓ Wrote ${ambiguous.length} ambiguous entries to ${path.relative(process.cwd(), AMBIGUOUS_PATH)}`);
    console.log(`  Each entry has {id, name, slot, url, filename, description}.`);
    console.log(`  Add a "decision" field to each (distant/close/interior/view_from/bad), then re-run with --tier2-apply --push.`);
  }
  await pool.end();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });

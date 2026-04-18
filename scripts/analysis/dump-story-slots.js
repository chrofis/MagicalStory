/**
 * Dump the Grok reference slot images for every page of a story so we can
 * visually verify what was actually sent to Grok.
 *
 *   node scripts/analysis/dump-story-slots.js <storyId> [pageNum]
 *
 * Reads stories.data.sceneImages[*].grokRefImages (or imageVersions[*].grokRefImages
 * if present), saves each slot as JPEG into tests/fixtures/slot-dump/<storyId>/.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const sharp = require('sharp');

async function main() {
  const STORY_ID = process.argv[2];
  const PAGE_FILTER = process.argv[3] ? parseInt(process.argv[3], 10) : null;
  if (!STORY_ID) {
    console.error('Usage: node scripts/analysis/dump-story-slots.js <storyId> [pageNum]');
    process.exit(1);
  }
  const OUT = path.join(__dirname, '../../tests/fixtures/slot-dump', STORY_ID);
  fs.mkdirSync(OUT, { recursive: true });

  const pool = new Pool({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const r = await pool.query('SELECT data FROM stories WHERE id = $1', [STORY_ID]);
  if (r.rows.length === 0) { console.error('Story not found'); process.exit(1); }
  const story = r.rows[0].data;
  await pool.end();

  console.log(`Title: ${story.title}`);
  console.log(`Scene images: ${story.sceneImages?.length || 0}`);

  const scenes = story.sceneImages || [];
  for (const scene of scenes) {
    const page = scene.pageNumber;
    if (PAGE_FILTER && page !== PAGE_FILTER) continue;

    // Look for grokRefImages on the active version OR each version
    const candidates = [];
    if (Array.isArray(scene.grokRefImages)) {
      candidates.push({ tag: `p${page}_active`, refs: scene.grokRefImages });
    }
    if (Array.isArray(scene.imageVersions)) {
      scene.imageVersions.forEach((v, i) => {
        if (Array.isArray(v.grokRefImages)) {
          candidates.push({ tag: `p${page}_v${i}`, refs: v.grokRefImages, source: v.source || v.method || 'unknown' });
        }
      });
    }

    if (candidates.length === 0) {
      console.log(`  page ${page}: no grokRefImages stored`);
      continue;
    }

    for (const { tag, refs, source } of candidates) {
      console.log(`  ${tag}${source ? ` (${source})` : ''}: ${refs.length} slots`);
      for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        if (!ref || typeof ref !== 'string') continue;
        const base64 = ref.replace(/^data:image\/\w+;base64,/, '');
        const buf = Buffer.from(base64, 'base64');
        try {
          const meta = await sharp(buf).metadata();
          const file = `${tag}_slot${i + 1}_${meta.width}x${meta.height}.jpg`;
          fs.writeFileSync(path.join(OUT, file), buf);
          console.log(`    slot${i + 1}: ${meta.width}x${meta.height} (aspect ${(meta.width / meta.height).toFixed(3)}) -> ${file}`);
        } catch (e) {
          console.log(`    slot${i + 1}: failed to decode (${e.message})`);
        }
      }
    }
  }

  console.log(`\nSaved to ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });

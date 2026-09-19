/**
 * Which avatar reference did each page actually receive?
 *
 * Apparent-age drift across pages of one story points at the reference the
 * image model was handed, not at the prompt: the age cue is emitted per page
 * and is identical everywhere. If a page resolves to no styled avatar it can
 * fall back to a raw photo or a cutout, which carries a different apparent
 * age than the styled sheet — so print the resolved source per page.
 *
 * Usage: node tests/manual/check-page-avatars.js <storyId> [--prod]
 */
require('dotenv').config();
const { Pool } = require('pg');

const storyId = process.argv[2];
const useProd = process.argv.includes('--prod');
if (!storyId) {
  console.error('usage: node tests/manual/check-page-avatars.js <storyId> [--prod]');
  process.exit(1);
}

const pool = new Pool({
  connectionString: useProd ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const tail = (s, n = 3) => (s || '').toString().split('?')[0].split('/').slice(-n).join('/');

(async () => {
  const rows = await pool.query('select data from stories where id=$1', [storyId]);
  if (!rows.rows.length) { console.error('story not found'); process.exit(1); }
  const d = rows.rows[0].data;

  console.log('story:', d.title, '| artStyle:', d.artStyle);
  console.log('characterAvatars:', JSON.stringify(d.characterAvatars));
  console.log('');

  for (const s of d.sceneImages || []) {
    console.log('=== page', s.pageNumber);
    const refs = s.referencePhotos || [];
    if (!refs.length) console.log('   !! NO referencePhotos — nothing anchored this page');
    for (const r of refs) {
      const src = r.photoUrl || r.imageData || '';
      const kind = /^data:/.test(src) ? '[inline base64]' : tail(src);
      console.log(`   ${r.name}: photoType=${r.photoType} clothing=${r.clothingCategory} src=${kind}`);
    }
    console.log('   grokRefImages:', (s.grokRefImages || []).length);
  }
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });

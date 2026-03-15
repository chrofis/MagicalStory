const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: 'postgresql://postgres:CkudCnsnCYbUdHxztMaHklimyMZCJAqJ@turntable.proxy.rlwy.net:26087/railway',
  ssl: { rejectUnauthorized: false }
});

const STORY_ID = 'job_1772743903607_af1ot97bs';
const OUTPUT_DIR = path.join(__dirname, '..', 'fixtures', 'grok-test', 'input');

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const res = await pool.query("SELECT data->'characters' as chars FROM stories WHERE id = $1", [STORY_ID]);
  if (res.rows.length === 0) {
    console.log('Story not found');
    return;
  }

  const chars = res.rows[0].chars;
  console.log('Characters found:', chars.length);

  for (const char of chars) {
    const name = char.name || 'unknown';
    console.log('\n' + name + ':');

    if (!char.avatars) {
      console.log('  No avatars');
      continue;
    }

    const categories = ['standard', 'winter', 'summer', 'formal'];
    for (const cat of categories) {
      const avatar = char.avatars[cat];
      if (!avatar) continue;

      const base64 = avatar.replace(/^data:image\/\w+;base64,/, '');
      const filename = name.toLowerCase().replace(/\s+/g, '-') + '-' + cat + '.jpg';
      fs.writeFileSync(path.join(OUTPUT_DIR, filename), Buffer.from(base64, 'base64'));
      const kb = Math.round(Buffer.from(base64, 'base64').length / 1024);
      console.log('  Saved: ' + filename + ' (' + kb + 'KB)');
    }

    if (char.avatars.faceThumbnails && char.avatars.faceThumbnails.standard) {
      const base64 = char.avatars.faceThumbnails.standard.replace(/^data:image\/\w+;base64,/, '');
      const filename = name.toLowerCase().replace(/\s+/g, '-') + '-face.jpg';
      fs.writeFileSync(path.join(OUTPUT_DIR, filename), Buffer.from(base64, 'base64'));
      console.log('  Saved: ' + filename);
    }
  }

  console.log('\nDone! Output in: tests/fixtures/grok-test/');
  await pool.end();
}

main().catch(e => { console.error(e.message); pool.end(); });

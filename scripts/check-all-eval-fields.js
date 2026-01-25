require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const storyId = process.argv[2] || 'job_1769360030111_ufyj3zi84';

  const result = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
  const story = result.rows[0].data;

  console.log('Story:', story.title);
  console.log('\n=== Checking ALL fields in sceneImages ===\n');

  const scene = story.sceneImages[0];
  console.log('Page 1 - All keys:');
  for (const key of Object.keys(scene)) {
    const val = scene[key];
    if (val === null || val === undefined) {
      console.log(`  ${key}: null`);
    } else if (typeof val === 'string' && val.length > 100) {
      console.log(`  ${key}: string (${val.length} chars)`);
    } else if (typeof val === 'object') {
      console.log(`  ${key}: ${Array.isArray(val) ? 'array' : 'object'} - ${JSON.stringify(val).substring(0, 100)}...`);
    } else {
      console.log(`  ${key}: ${val}`);
    }
  }

  // Look for any field containing "eval", "quality", "box", "check"
  console.log('\n=== Fields with eval/quality/box/check ===\n');
  for (const key of Object.keys(scene)) {
    if (key.toLowerCase().includes('eval') ||
        key.toLowerCase().includes('quality') ||
        key.toLowerCase().includes('box') ||
        key.toLowerCase().includes('check') ||
        key.toLowerCase().includes('reasoning')) {
      console.log(`${key}:`);
      const val = scene[key];
      if (typeof val === 'string') {
        try {
          const parsed = JSON.parse(val);
          console.log('  Keys:', Object.keys(parsed).join(', '));
        } catch (e) {
          console.log('  Value:', val.substring(0, 200));
        }
      } else if (val) {
        console.log('  Keys:', Object.keys(val).join(', '));
      }
    }
  }

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });

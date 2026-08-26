// Rebuilds the blend prompt from exp 848's REAL metadata and measures it
// against the recorded safe/unsafe lengths. No API calls.
require('dotenv').config();
const { Pool } = require('pg');
const { buildBlendEditPrompt, buildBlendMetadata } = require('../../server/lib/sceneComposite');

(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const e = await pool.query('SELECT results FROM testlab_experiments WHERE id = 848');
  const r = (e.rows[0].results || [])[0] || {};
  const cast = r.cast || [];

  const st = await pool.query('SELECT data FROM stories WHERE id = $1', ['job_1786780194082_s980g4s9a']);
  const img = (st.rows[0].data.sceneImages || []).find(x => x.pageNumber === 6);
  const fd = img.sceneMetadata?.fullData || {};

  const meta = buildBlendMetadata(fd, img, null);
  // occlusion flags come from the paste step; exp 848 marked Daniel occluded
  meta.occludedBy = { Daniel: true };
  meta.artStyle = 'realistic';
  meta.description = fd.imageSummary || img.sceneDescription || '';

  const prompt = buildBlendEditPrompt(meta, cast);
  console.log('================ NEW BLEND PROMPT ================\n');
  console.log(prompt);
  console.log('\n=================================================');
  console.log('chars           :', prompt.length);
  console.log('was (exp 848)   : 5451');
  console.log('recorded safe   : 1810 held the framing exactly');
  console.log('recorded unsafe : 3063 zoomed enough to cut feet');
  console.log('verdict         :',
    prompt.length <= 1810 ? 'INSIDE the length that held framing'
      : prompt.length < 3063 ? 'between safe and the known-zoom point'
        : 'STILL past the known-zoom point');
  console.log('\nchecks:');
  console.log('  no DO-NOT list        :', !/DO NOT/.test(prompt));
  console.log('  no "cinematic"        :', !/cinematic/i.test(prompt));
  console.log('  no portrait-grid ref  :', !/portrait grid/i.test(prompt));
  console.log('  occluder NOT named    :', !/parapet|railing crosses|bridge crosses/i.test(prompt));
  console.log('  action stated once    :', (prompt.split('kneels at the gap').length - 1) <= 1);
  console.log('  no mid-word truncation:', !/\b[a-z]{1,2}$/m.test(prompt.split('\n')[3] || ''));
  await pool.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

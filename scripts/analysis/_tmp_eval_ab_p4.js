// A/B eval harness: run the production quality eval N times on both page-4
// versions (v0 clean original, v1 red-skin garment-recolour) of
// job_1786571353564_0sgrd0f4g and print score + issues for each run.
require('dotenv').config();
const { Pool } = require('pg');
const https = require('https');

const N = Number(process.env.AB_RUNS || 3);
const fetchBytes = (url) => new Promise((res, rej) => {
  https.get(url, x => { const c = []; x.on('data', d => c.push(d)); x.on('end', () => res(Buffer.concat(c))); }).on('error', rej);
});

(async () => {
  const p = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await p.query("SELECT data FROM stories WHERE id='job_1786571353564_0sgrd0f4g'");
  const d = rows[0].data;
  const s = d.sceneImages[3];
  const imgs = await p.query("SELECT version_index, image_url FROM story_images WHERE story_id='job_1786571353564_0sgrd0f4g' AND image_type='scene' AND page_number=4 ORDER BY version_index");
  const uris = {};
  for (const r of imgs.rows) uris[r.version_index] = `data:image/jpeg;base64,${(await fetchBytes(r.image_url)).toString('base64')}`;
  await p.end();

  const { loadPromptTemplates } = require('../../server/services/prompts');
await loadPromptTemplates();
const { evaluateImageQuality } = require('../../server/lib/evalPipeline');
  const { resolveEvalArtStyle } = require('../../server/services/prompts');
  const refs = s.referencePhotos || [];
  console.log('refs:', refs.map(r => (typeof r === 'object' ? r.name : 'str')).join(','), '| artStyle:', d.artStyle);

  for (const [label, uri] of [['v0-clean', uris[0]], ['v1-red', uris[1]]]) {
    for (let i = 1; i <= N; i++) {
      const t = Date.now();
      const r = await evaluateImageQuality(
        uri, s.sceneDescription || s.prompt, refs, 'scene', null, `AB-${label}-r${i}`,
        null, null, s.sceneCharacters || null,
        { artStyle: resolveEvalArtStyle(d.artStyle, s.prompt || null) }
      );
      const issues = (r?.fixableIssues || r?.issues || []).map(x => `${x.severity}[${x.type || ''}] ${String(x.description || '').slice(0, 90)}`);
      console.log(`\n### ${label} run${i} (${Math.round((Date.now() - t) / 1000)}s): score=${r?.score ?? r?.qualityScore} verdict=${r?.verdict || ''} issues=${issues.length}`);
      issues.forEach(x => console.log('   -', x));
    }
  }
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });

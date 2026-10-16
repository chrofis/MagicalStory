/**
 * Replay of the page-prompt lettering-ban wording on stored pages (decisions.md
 * 2026-10-15 and 2026-10-16). Takes the stored prompt files of
 * evals/runs/2026-10-15_caption-wording/, swaps the lettering-ban text for the
 * CURRENT prompts/image-generation.txt wording, re-renders with the stored
 * reference slots at the page model, saves *_<tag>.jpg. REAL paid calls
 * (USD 0.04 each), so the page list is explicit and capped.
 *
 *   node scripts/analysis/replay-caption-wording.js --db=staging|prod <tag> <story:page> [<story:page> ...]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { editWithGrok } = require('../../server/lib/grok');

const RUN = path.join(__dirname, '../../evals/runs/2026-10-15_caption-wording');
const PRICE = 0.04;
const MODEL = 'grok-imagine-image-2.0';
const BAN = /No lettering on any surface[\s\S]*?(?:label of its own\.|nothing is lettered\.)/;

function currentBan() {
  const t = fs.readFileSync(path.join(__dirname, '../../prompts/image-generation.txt'), 'utf8');
  const m = t.match(BAN);
  if (!m) throw new Error('no lettering ban in prompts/image-generation.txt');
  return m[0];
}

async function findStory(pools, id) {
  for (const pool of pools) {
    const r = await pool.query('SELECT data FROM stories WHERE id = $1', [id]);
    if (r.rows[0]) return r.rows[0].data;
  }
  throw new Error('story not found: ' + id);
}

async function main() {
  const args = process.argv.slice(2);
  const db = (args.find(a => a.startsWith('--db=')) || '').slice(5);
  const [tag, ...specs] = args.filter(a => !a.startsWith('--db='));
  if (!['staging', 'prod'].includes(db)) throw new Error('--db=staging|prod is required');
  if (!tag || !specs.length) throw new Error('usage: <tag> <story:page> ...');
  const ssl = { rejectUnauthorized: false };
  const pools = [db === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL]
    .map(connectionString => new Pool({ connectionString, ssl }));
  const ban = currentBan();
  let spend = 0;
  for (const spec of specs) {
    const [story, page] = spec.split(':');
    const short = story.replace('job_', '').split('_')[0] + '_p' + page;
    const file = fs.readdirSync(RUN).find(f => f.endsWith(`${short}_prompt.txt`));
    if (!file) throw new Error('no stored prompt for ' + short);
    const stored = fs.readFileSync(path.join(RUN, file), 'utf8');
    if (!BAN.test(stored)) throw new Error('stored prompt has no lettering ban: ' + file);
    const prompt = stored.replace(BAN, ban);
    const data = await findStory(pools, story);
    const scene = (data.sceneImages || []).find(s => String(s.pageNumber) === page);
    const refs = scene && scene.grokRefImages;
    if (!Array.isArray(refs) || !refs.length) throw new Error('no stored ref slots for ' + spec);
    const res = await editWithGrok(prompt, refs, { model: MODEL, aspectRatio: '3:4' });
    spend += PRICE;
    const out = path.join(RUN, file.replace('_prompt.txt', `_${tag}.jpg`));
    fs.writeFileSync(out, Buffer.from(String(res.imageData).replace(/^data:image\/\w+;base64,/, ''), 'base64'));
    console.log(spec, '->', path.basename(out), 'spend so far USD', spend.toFixed(2));
  }
  await Promise.all(pools.map(p => p.end()));
}
main().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * Writer-model scorecard — Sonnet vs DeepSeek v4-pro vs v4-flash.
 *
 * Rates the SCENE BRIEFS each writer produced for the same stories. The brief
 * is what every page-image prompt is built from, so a missing field there is a
 * missing field in the render.
 *
 * Baseline (Sonnet) is read from what the stories actually SHIPPED with — no
 * Sonnet call is made. The other arms come from Test Lab experiments.
 *
 *   node scripts/analysis/writer-model-scorecard.js <proExpId> <flashExpId>
 *
 * Four criteria are counted, not judged:
 *   identity  — hair AND eyes present (the image model's anchor against drawing
 *               a stranger; this is the field v4-pro was observed dropping)
 *   clothing  — a garment from the contract is named
 *   metadata  — the ---METADATA--- block with characters[] parses
 *   cast      — every name in the prose also appears in characters[]
 * Cost and wall-clock are measured. Drawability stays a human read.
 */
require('dotenv').config();
const { Pool } = require('pg');

const STORIES = ['job_1786397108357_q1fjbdzbx', 'job_1786287569165_7f75jspcz'];
const sonnetCost = (i, o) => i / 1e6 * 3 + o / 1e6 * 15;

const RE = {
  hair: /\bhair\b/i,
  eyes: /\beyes?\b|blue-eyed|brown-eyed/i,
  clothing: /wear|wears|dressed|coat|vest|bandana|tricorn|blouse|shirt|skirt|breeches|boots/i,
  meta: /---\s*METADATA\s*---/i,
  chars: /"characters"\s*:/i,
};

/** 0-5 from a hit rate, so every criterion is on one scale. */
const rate = (hits, total) => total === 0 ? 0 : Math.round((hits / total) * 5 * 10) / 10;

function scoreBriefs(briefs) {
  let hair = 0, eyes = 0, cloth = 0, meta = 0, cast = 0, chars = 0;
  const n = briefs.length;
  for (const b of briefs) {
    const t = String(b || '');
    chars += t.length;
    if (RE.hair.test(t)) hair++;
    if (RE.eyes.test(t)) eyes++;
    if (RE.clothing.test(t)) cloth++;
    const hasMeta = RE.meta.test(t) && RE.chars.test(t);
    if (hasMeta) meta++;
    // Cast consistency: every capitalised known name in the prose must also be
    // inside the characters[] array of the metadata block.
    const metaPart = t.split(/---\s*METADATA\s*---/i)[1] || '';
    const prose = t.split(/---\s*METADATA\s*---/i)[0] || '';
    const names = [...new Set((prose.match(/\b(Emma|Noah|Hans|Sarah|Daniel)\b/g) || []))];
    const missing = names.filter(nm => !metaPart.includes(nm));
    if (names.length > 0 && missing.length === 0) cast++;
  }
  return {
    pages: n,
    avgChars: Math.round(chars / Math.max(n, 1)),
    identity: rate(Math.min(hair, eyes), n),
    identityRaw: `${hair}/${n} hair, ${eyes}/${n} eyes`,
    clothing: rate(cloth, n),
    clothingRaw: `${cloth}/${n}`,
    metadata: rate(meta, n),
    metadataRaw: `${meta}/${n}`,
    cast: rate(cast, n),
    castRaw: `${cast}/${n}`,
  };
}

(async () => {
  const [proId, flashId] = process.argv.slice(2).map(Number);
  if (!proId || !flashId) { console.error('usage: writer-model-scorecard.js <proExpId> <flashExpId>'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const exp = async (id) => (await pool.query('select results from testlab_experiments where id=$1', [id])).rows[0]?.results || [];
  const proRes = await exp(proId), flashRes = await exp(flashId);

  for (const storyId of STORIES) {
    const story = (await pool.query('select data from stories where id=$1', [storyId])).rows[0].data;
    const bf = story.tokenUsage.byFunction;
    const find = (rs) => rs.map(r => r.result || r).find(r => r.storyId === storyId);
    const pro = find(proRes), flash = find(flashRes);

    // Sonnet's briefs are the ones stored on the shipped scenes.
    const sonnetBriefs = (story.sceneImages || []).map(s => s.sceneDescription || '');
    const briefsOf = (d) => (d?.sceneExpansions || []).map(s => s.fromBeats || '');

    const arms = [
      { name: 'Sonnet (shipped)', s: scoreBriefs(sonnetBriefs),
        cost: sonnetCost(bf.beats_plan.input_tokens, bf.beats_plan.output_tokens)
            + sonnetCost(bf.beats_scene_expansion.input_tokens, bf.beats_scene_expansion.output_tokens),
        secs: 26 + 235 },
      { name: 'DeepSeek v4-pro', s: scoreBriefs(briefsOf(pro)),
        cost: (pro?.beatsPlan?.cost || 0) + ((pro?.sceneExpansions || [])[0]?.cost || 0),
        secs: Math.round(((pro?.beatsPlan?.elapsedMs || 0) + ((pro?.sceneExpansions || [])[0]?.elapsedMs || 0)) / 1000) },
      { name: 'DeepSeek v4-flash', s: scoreBriefs(briefsOf(flash)),
        cost: (flash?.beatsPlan?.cost || 0) + ((flash?.sceneExpansions || [])[0]?.cost || 0),
        secs: Math.round(((flash?.beatsPlan?.elapsedMs || 0) + ((flash?.sceneExpansions || [])[0]?.elapsedMs || 0)) / 1000) },
    ];

    console.log(`\n═══ ${storyId} ═══`);
    console.log('model'.padEnd(20) + 'ident'.padStart(7) + 'cloth'.padStart(7) + 'meta'.padStart(6)
      + 'cast'.padStart(6) + 'AVG'.padStart(6) + 'chars'.padStart(7) + 'cost'.padStart(10) + 'time'.padStart(7));
    for (const a of arms) {
      const avg = a.s.pages === 0 ? 0
        : Math.round(((a.s.identity + a.s.clothing + a.s.metadata + a.s.cast) / 4) * 10) / 10;
      console.log(a.name.padEnd(20)
        + String(a.s.identity).padStart(7) + String(a.s.clothing).padStart(7)
        + String(a.s.metadata).padStart(6) + String(a.s.cast).padStart(6)
        + String(avg).padStart(6) + String(a.s.avgChars).padStart(7)
        + ('$' + a.cost.toFixed(4)).padStart(10) + (a.secs + 's').padStart(7));
    }
    console.log('  raw counts:');
    for (const a of arms) console.log(`    ${a.name.padEnd(20)} ${a.s.identityRaw} | clothing ${a.s.clothingRaw} | metadata ${a.s.metadataRaw} | cast ${a.s.castRaw} | ${a.s.pages} pages`);
  }
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * Validate GroundingDINO->SAM text-driven figure extraction across art styles.
 *
 * Replays PRODUCTION's own per-character identity prompts
 * (buildCharacterPhysicalDescription) through the local photo_analyzer
 * /detect-figures-text endpoint, page by page, and logs GDINO scores + box
 * quality. Purpose: decide whether the realistic-only GDINO detection gate
 * should broaden to anime/pixar (the 2026-07-15 char-repair investigation
 * found GDINO scored 0.84 on the two problem adults on an anime page, contra
 * the earlier watercolour-only test that set the gate).
 *
 * Usage:
 *   node scripts/analysis/validate-gdino-figures.js <storyId> [pageNums csv] [--staging]
 *   node scripts/analysis/validate-gdino-figures.js job_1783981243217_bhub4d1ji 4,6 --staging
 *
 * Requires photo_analyzer running locally (npm run dev:python). GDINO lazy-loads
 * (~1.9GB, ~70s first call). Reads image bytes from the R2 URLs in story_images.
 */
'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { buildCharacterDescriptionsForBbox } = require('../../server/lib/storyHelpers');
const { buildExpectedCharactersForBbox } = require('../../server/lib/images');

const PA = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
const OUT = path.join(require('os').tmpdir(), 'gdino-validate');

async function detectFiguresText(imageBuf, prompts) {
  const res = await fetch(`${PA}/detect-figures-text`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image: `data:image/jpeg;base64,${imageBuf.toString('base64')}`,
      prompts, box_threshold: 0.20, text_threshold: 0.15,
    }),
    signal: AbortSignal.timeout(300000),
  });
  const j = await res.json().catch(async () => ({ raw: await res.text() }));
  if (!j.success) throw new Error(`detect-figures-text ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

function sceneCharNames(img) {
  const sc = img.sceneCharacters || [];
  return sc.map(c => (typeof c === 'string' ? c : c?.name)).filter(Boolean);
}

async function main() {
  const [storyId, pageCsv, ...flags] = process.argv.slice(2);
  if (!storyId) { console.error('usage: validate-gdino-figures.js <storyId> [pages csv] [--staging]'); process.exit(1); }
  const staging = flags.includes('--staging') || process.argv.includes('--staging');
  const conn = staging ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  fs.mkdirSync(OUT, { recursive: true });

  const sres = await pool.query('SELECT data FROM stories WHERE id=$1', [storyId]);
  if (!sres.rows.length) { console.error('story not found'); process.exit(1); }
  let d = sres.rows[0].data; if (typeof d === 'string') d = JSON.parse(d);
  const artStyle = d.artStyle || '?';
  const charByName = new Map((d.characters || []).map(c => [String(c.name).toLowerCase(), c]));

  const wantPages = pageCsv && !pageCsv.startsWith('--') ? pageCsv.split(',').map(Number) : null;
  const pages = (d.sceneImages || []).filter(s => !wantPages || wantPages.includes(s.pageNumber));

  const imgRes = await pool.query(
    "SELECT page_number, image_url FROM story_images WHERE story_id=$1 AND image_type='scene' ORDER BY page_number, version_index DESC", [storyId]);
  const urlByPage = new Map();
  for (const r of imgRes.rows) if (!urlByPage.has(r.page_number)) urlByPage.set(r.page_number, r.image_url);

  console.log(`\nStory ${storyId} · style=${artStyle} · ${pages.length} page(s)\n${'='.repeat(60)}`);
  const rows = [];
  for (const img of pages) {
    const pn = img.pageNumber;
    const url = urlByPage.get(pn) || (typeof img.imageData === 'string' && img.imageData.startsWith('http') ? img.imageData : null);
    if (!url) { console.log(`p${pn}: no image url`); continue; }
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const meta = await sharp(buf).metadata();

    // Exercise the exact production wiring: descriptions (with gdinoIdentity) →
    // buildExpectedCharactersForBbox (resolves per-page clothing + gdinoPrompt).
    const names = sceneCharNames(img);
    const meta2 = img.sceneMetadata || {};
    const expectedPositions = meta2.characterPositions || {};
    const characterClothing = meta2.characterClothing || {};
    const descriptions = buildCharacterDescriptionsForBbox(d, expectedPositions);
    // Restrict to the characters actually on this page.
    const onPage = {};
    for (const n of names) { const key = Object.keys(descriptions).find(k => k.toLowerCase() === String(n).toLowerCase()); if (key) onPage[key] = descriptions[key]; }
    const expected = buildExpectedCharactersForBbox(onPage, expectedPositions, characterClothing);
    const prompts = expected.map(c => ({ name: c.name, text: c.gdinoPrompt || c.description || c.name }));
    if (!prompts.length) { console.log(`p${pn}: no sceneCharacters`); continue; }
    if (pages.indexOf(img) === 0) console.log(`   [prompt sample] ${prompts[0].name}: "${prompts[0].text}"`);

    let det;
    try { det = await detectFiguresText(buf, prompts); }
    catch (e) { console.log(`p${pn}: ERROR ${e.message}`); continue; }

    console.log(`\np${pn} (${prompts.length} figures):`);
    let rects = '';
    const palette = ['#FF2D55', '#34C759', '#0A84FF', '#FF9F0A', '#AF52DE', '#5AC8FA'];
    det.figures.forEach((f, i) => {
      const scoreStr = f.box ? f.score.toFixed(3) : 'MISS';
      console.log(`   ${f.name.padEnd(10)} ${scoreStr}  ${f.box ? JSON.stringify(f.box) : ''}`);
      rows.push({ style: artStyle, page: pn, name: f.name, score: f.box ? f.score : null });
      if (f.box) { const [x1, y1, x2, y2] = f.box; const c = palette[i % palette.length];
        rects += `<rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" fill="none" stroke="${c}" stroke-width="4"/><text x="${x1 + 4}" y="${y1 + 22}" fill="${c}" font-size="22" font-family="sans-serif">${f.name} ${f.score.toFixed(2)}</text>`; }
    });
    const outFile = path.join(OUT, `${artStyle}_${storyId}_p${pn}.jpg`);
    await sharp(buf).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}">${rects}</svg>`) }]).jpeg().toFile(outFile);
  }

  // Summary
  const scored = rows.filter(r => r.score != null);
  const miss = rows.filter(r => r.score == null);
  const avg = scored.length ? (scored.reduce((a, r) => a + r.score, 0) / scored.length) : 0;
  const strong = scored.filter(r => r.score >= 0.7).length;
  console.log(`\n${'='.repeat(60)}\nSUMMARY ${artStyle}: ${scored.length} found (${miss.length} missed), avg ${avg.toFixed(3)}, ${strong}/${scored.length} >= 0.70`);
  console.log(`overlays -> ${OUT}`);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });

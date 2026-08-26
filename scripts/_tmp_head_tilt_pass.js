#!/usr/bin/env node
/**
 * Head-tilt inpaint pass: take the most recent composite-* test folder
 * (or --input=PATH) and run Grok edit with a focused "look up" prompt.
 */
'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

function arg(name, dflt = null) {
  const m = process.argv.find(a => a.startsWith(`--${name}=`));
  return m ? m.split('=')[1] : dflt;
}

const ROOT = path.resolve(__dirname, '..');
const INPUT = arg('input', null);
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

async function main() {
  // Default input: most recent composite-* dir's 02a-grok-blended.jpg or 01-manual-composite.jpg
  let inputPath = INPUT;
  if (!inputPath) {
    const dirs = fs.readdirSync(path.join(ROOT, 'tests'))
      .filter(d => d.startsWith('composite-'))
      .map(d => ({ d, full: path.join(ROOT, 'tests', d), m: fs.statSync(path.join(ROOT, 'tests', d)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (dirs.length === 0) { console.error('no composite-* test dir found'); process.exit(1); }
    const top = dirs[0].full;
    // Prefer the manual composite (Grok edit operates on it cleanly without any prior style mush)
    const candidates = ['01-manual-composite.jpg', '02a-grok-blended.jpg'];
    for (const c of candidates) {
      const p = path.join(top, c);
      if (fs.existsSync(p)) { inputPath = p; break; }
    }
    if (!inputPath) { console.error(`no usable image in ${top}`); process.exit(1); }
  }
  console.log(`📥 input: ${inputPath}`);
  const buf = fs.readFileSync(inputPath);
  const meta = await sharp(buf).metadata();
  console.log(`   ${meta.width}×${meta.height} (${(buf.length/1024).toFixed(0)} KB)`);

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) { console.error('XAI_API_KEY not set'); process.exit(1); }

  const prompt = `Edit this image: TILT EVERY CHARACTER'S HEAD UPWARD so all seven figures are looking up at the wooden pole and feathered hat at the top-centre of the image. Chin raised, neck angled back, gaze fixed on the hat. This is a HEAD POSE CHANGE — not just eyes. Every face must read as "looking up". Keep everything else in the image identical: same characters in the same positions, same clothing, same landmark, same lighting, same watercolor style. Only the head poses change.`;

  console.log(`📤 calling Grok edit (head-tilt only)...`);
  const t0 = Date.now();
  const resp = await fetch('https://api.x.ai/v1/images/edits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'grok-imagine-image',
      prompt,
      response_format: 'b64_json',
      aspect_ratio: '3:4',
      image: { url: `data:image/jpeg;base64,${buf.toString('base64')}`, type: 'image_url' },
    }),
    signal: AbortSignal.timeout(180000),
  });
  const elapsed = Date.now() - t0;
  if (!resp.ok) {
    console.error(`❌ Grok ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
    process.exit(1);
  }
  const data = await resp.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) { console.error('❌ no image'); process.exit(1); }

  const outDir = path.dirname(inputPath);
  const outPath = path.join(outDir, `03-head-tilt-pass.jpg`);
  fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
  console.log(`✅ ${(elapsed/1000).toFixed(1)}s → ${outPath}`);
  fs.writeFileSync(path.join(outDir, 'head-tilt-prompt.txt'), prompt);
}

main().catch(e => { console.error('💥', e.message); process.exit(1); });

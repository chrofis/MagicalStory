/**
 * Local prompt-tuning probe. Fetch ONE image from R2 once, then run several
 * short eval prompt variants against it via Gemini in parallel. Print what
 * each variant catches so we can pick the wording that surfaces anatomy +
 * scene-integrity defects (the prod prompt currently misses them).
 *
 * Usage:
 *   node scripts/analysis/eval-prompt-bake-off.js [--url=<r2 url>]
 *
 * Default URL is the v3 cover from job_1778268595639_n3v7erasi (the case
 * the user reported: "arms and roofs are missing — eval said clean").
 */
require('dotenv').config();

const args = process.argv.slice(2);
const URL_ARG = args.find(a => a.startsWith('--url='))?.split('=')[1]
  || 'https://images.magicalstory.ch/stories/job_1778268595639_n3v7erasi/frontCover/cover/v3.jpg';
const MODEL = args.find(a => a.startsWith('--model='))?.split('=')[1] || 'gemini-2.5-flash';

const VARIANTS = {
  // Baseline-ish — what prod is doing today (very abbreviated). Established
  // false-negative; included as control.
  baseline: `You are a QA reviewer for a children's-book cover. List every visible defect: anatomy, missing body parts, missing buildings, broken architecture, wrong-rendered text, character mismatches. Output a bullet list. Be concise.`,

  // Force a list-of-bodyparts answer per figure. No JSON to keep it short.
  enumerate: `For each person in this image, write one line:
  "<name or 'figure 1'>: head=<seen|missing|cropped>, torso=<seen|missing|cropped>, left arm=<seen|missing|cropped>, right arm=<seen|missing|cropped>, left leg=<seen|missing|cropped>, right leg=<seen|missing|cropped>"
Then for each building: "<building>: roof=<intact|missing|broken>, walls=<intact|broken>"
Then list any other defects in one sentence each.`,

  // Adversarial — assume defects exist, find them.
  adversarial: `This image has at least one rendering defect. Find it. Examples to check: missing limbs, melted hands, missing roof on a building, walls that float, eyes pointing different ways, fused bodies, characters duplicated. List every defect you find, one per line. If you find nothing after a careful look, say "NONE — confident".`,

  // Critic frame — pretend you're rejecting it.
  critic: `You are a children's-book editor about to reject this cover. Write a one-paragraph rejection note listing exactly why. Focus on anatomy (limbs, hands), scene integrity (buildings, walls, props), and any rendering glitch. Be specific and concrete; no praise.`,

  // Two-pass mental model: scan, then list.
  scan_then_list: `STEP 1: Silently scan the image left-to-right, top-to-bottom. Note every figure and every man-made object.
STEP 2: For every figure, count visible limbs (2 arms expected, 2 legs expected). Mark missing.
STEP 3: For every building, check the roof and walls.
STEP 4: Output as JSON:
{ "figures": [{ "id": 1, "missing_parts": [...] }],
  "buildings": [{ "label": "...", "issues": [...] }],
  "other_defects": [...] }`,

  // Tight — minimum viable. Test if a 3-line prompt is enough.
  tight: `List every visible rendering defect in this children's-book cover image. Be specific: which character is missing what limb, which building is missing its roof, which prop floats. One bullet per defect. If clean, write "CLEAN".`,
};

async function fetchImageBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

async function runGemini(prompt, imageBuf, modelId) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: 'image/jpeg', data: imageBuf.toString('base64') } },
        { text: prompt },
      ],
    }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const cand = j.candidates?.[0];
  const text = cand?.content?.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
  const finishReason = cand?.finishReason || 'unknown';
  return { text: text || '(no text)', finishReason, raw: j };
}

(async () => {
  console.log(`[probe] image: ${URL_ARG}`);
  console.log(`[probe] model: ${MODEL}`);
  const buf = await fetchImageBytes(URL_ARG);
  console.log(`[probe] fetched ${Math.round(buf.length / 1024)} KB`);

  const entries = Object.entries(VARIANTS);
  const results = await Promise.all(entries.map(async ([name, prompt]) => {
    const t0 = Date.now();
    try {
      const out = await runGemini(prompt, buf, MODEL);
      return { name, ms: Date.now() - t0, out };
    } catch (err) {
      return { name, ms: Date.now() - t0, err: err.message };
    }
  }));

  const fs = require('fs');
  for (const r of results) {
    console.log('\n' + '═'.repeat(70));
    console.log(`▶ VARIANT: ${r.name}  (${r.ms}ms, finish=${r.out?.finishReason || 'err'})`);
    console.log('═'.repeat(70));
    const text = r.err ? `ERROR: ${r.err}` : (r.out?.text || '').trim();
    console.log(text);
    fs.writeFileSync(`tmp/eval-${r.name}.txt`, text);
  }
  console.log('\n[probe] full outputs also written to tmp/eval-<variant>.txt');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

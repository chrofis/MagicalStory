// Identity vendor A/B: replay the SoM badge images from persisted detections
// and ask 5 vision models. Owner task 2026-08-22 (task #30 groundwork).
// Pages: 1 (crowd/fallback), 3@v0 (clean benchmark), 12, 16 (control), 18, 2 (control).
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const sharp = require('sharp');

const SID = 'job_1787349305313_hpv76p0rokg';
const OUT = 'C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/53ca16ce-9e51-4b2f-a36b-c324ee59638f/scratchpad/story2/vendors';
const BASE = 'https://magicalstory.ch';
const PAGES = [
  { p: 1, v: null },   // active; 11-badge crowd case
  { p: 3, v: 0 },      // clean original benchmark
  { p: 12, v: 0 },     // Levin-in-Julian's-clothes render
  { p: 16, v: null },  // control (correct page)
  { p: 18, v: null },  // scale case
  { p: 2, v: null },   // control
];

// Full character facts (hair from the Lab lines, wardrobe from clothingRequirements)
const CHARS = {
  Levin:  { age: 'preschooler little boy, 110 cm', hair: 'light blonde, wavy, short, tousled', full: 'A red short-sleeved cotton T-shirt, black denim shorts with two front pockets, white ankle socks, grey canvas sneakers', short: 'red T-shirt' },
  Julian: { age: 'toddler little boy, 102 cm', hair: 'light blonde, curly, ear-length', full: 'A yellow short-sleeved cotton T-shirt, dark brown denim dungaree shorts with a square bib panel and two shoulder straps, white ankle socks, light grey canvas sneakers', short: 'yellow T-shirt under brown dungarees' },
  Max:    { age: 'preschooler little boy, 98 cm', hair: 'light brown, curly, short', full: 'A green short-sleeved cotton T-shirt, dark purple cotton jogger shorts, white ankle socks, blue canvas sneakers', short: 'green T-shirt' },
  Kiaan:  { age: 'preschooler little boy, 102 cm', hair: 'dark brown, straight, short, bangs at eyebrows', full: 'An orange short-sleeved cotton T-shirt, dark grey cotton shorts, white ankle socks, white canvas sneakers', short: 'orange T-shirt' },
};

function buildPrompt(letters, variant) {
  const lines = Object.entries(CHARS).map(([n, c]) => variant === 'full'
    ? `- ${n}: ${c.age}. Hair: ${c.hair}. Wearing: ${c.full}.`
    : `- ${n}: young character. Hair: ${c.hair}. Wearing: ${c.short}.`);
  return `Figures in this illustration are marked with black letter badges (${letters.join(', ')}).
Match each letter to one of these characters by age, gender, hair, and clothing:
${lines.join('\n')}
Use "unknown" for a badge that is an extra/background figure. Each name at most once.
Answer JSON only, e.g. {"A": "name"}.`;
}

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'demo-b-hnecf@magicalstory.ch', password: 'DemoStory2026!' }) });
  return (await r.json()).token;
}

// ---- vendor callers: return { answers, inTok, outTok, ms, error } ----------
async function callGemini(b64, prompt) {
  const t0 = Date.now();
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ inlineData: { mimeType: 'image/jpeg', data: b64 } }, { text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } } }),
  });
  const j = await res.json();
  const block = j?.promptFeedback?.blockReason;
  const text = j?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  return { raw: text, blocked: block || null, inTok: j?.usageMetadata?.promptTokenCount, outTok: j?.usageMetadata?.candidatesTokenCount, ms: Date.now() - t0, http: res.status };
}
async function callOpenRouter(model, b64, prompt) {
  const t0 = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 1500,
      messages: [{ role: 'user', content: [ { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }, { type: 'text', text: prompt } ] }] }),
  });
  const j = await res.json();
  const text = j?.choices?.[0]?.message?.content || '';
  return { raw: text, blocked: j?.error ? String(j.error.message || j.error).slice(0, 120) : null, inTok: j?.usage?.prompt_tokens, outTok: j?.usage?.completion_tokens, ms: Date.now() - t0, http: res.status };
}
async function callGrok(b64, prompt) {
  const t0 = Date.now();
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.XAI_API_KEY}` },
    body: JSON.stringify({ model: 'grok-4', temperature: 0, max_tokens: 1500,
      messages: [{ role: 'user', content: [ { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }, { type: 'text', text: prompt } ] }] }),
  });
  const j = await res.json();
  const text = j?.choices?.[0]?.message?.content || '';
  return { raw: text, blocked: j?.error ? String(j.error.message || j.error).slice(0, 120) : null, inTok: j?.usage?.prompt_tokens, outTok: j?.usage?.completion_tokens, ms: Date.now() - t0, http: res.status };
}
async function callClaude(b64, prompt) {
  const t0 = Date.now();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1500, temperature: 0,
      messages: [{ role: 'user', content: [ { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }, { type: 'text', text: prompt } ] }] }),
  });
  const j = await res.json();
  const text = (j?.content || []).map(c => c.text).join('') || '';
  return { raw: text, blocked: j?.error ? String(j.error.message).slice(0, 120) : null, inTok: j?.usage?.input_tokens, outTok: j?.usage?.output_tokens, ms: Date.now() - t0, http: res.status };
}

const VENDORS = [
  { id: 'gemini-prod', label: 'Gemini 2.5 Flash (stripped lines — production today)', variant: 'short', call: callGemini, inP: 0.30, outP: 2.50 },
  { id: 'gemini-full', label: 'Gemini 2.5 Flash (FULL lines)', variant: 'full', call: callGemini, inP: 0.30, outP: 2.50 },
  { id: 'grok-4', label: 'Grok 4 vision (FULL lines)', variant: 'full', call: callGrok, inP: 3.00, outP: 15.00 },
  { id: 'qwen-vl', label: 'Qwen2.5-VL-72B via OpenRouter (FULL lines)', variant: 'full', call: (b, p) => callOpenRouter('qwen/qwen2.5-vl-72b-instruct', b, p), inP: 0.60, outP: 0.60 },
  { id: 'gpt4o-mini', label: 'GPT-4o-mini via OpenRouter (FULL lines)', variant: 'full', call: (b, p) => callOpenRouter('openai/gpt-4o-mini', b, p), inP: 0.15, outP: 0.60 },
  { id: 'haiku-4.5', label: 'Claude Haiku 4.5 (FULL lines)', variant: 'full', call: callClaude, inP: 1.00, outP: 5.00 },
];

function parseAnswers(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const token = await login();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const q = await pool.query(`select data->'sceneImages' as si from stories where id=$1`, [SID]);
  await pool.end();
  const scenes = q.rows[0].si;

  const results = [];
  for (const { p, v } of PAGES) {
    const scene = scenes.find(s => s.pageNumber === p);
    const det = v != null ? scene.imageVersions?.[v]?.bboxDetection : scene.bboxDetection;
    const badges = det?.gdinoDiag?.identity?.badges || [];
    if (!badges.length) { console.log(`p${p}: no badges — skipped`); continue; }
    // image bytes
    const url = v != null
      ? `${BASE}/api/admin/testlab/test-image/${SID}/scene/${p}/${v}`
      : `${BASE}/api/admin/testlab/baseline-image/${SID}/${p}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const jj = await res.json();
    let buf;
    if (/^https?:/.test(String(jj.imageData))) buf = Buffer.from(await (await fetch(jj.imageData)).arrayBuffer());
    else buf = Buffer.from(String(jj.imageData).replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const meta = await sharp(buf).metadata();
    const W = meta.width, H = meta.height;
    // draw badges exactly as production (black circle, white letter)
    const R = Math.max(22, Math.round(Math.min(W, H) * 0.028));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${badges.map(b => {
      const x = b.at ? b.at[0] : b.x, y = b.at ? b.at[1] : b.y;
      return `<circle cx="${x}" cy="${y}" r="${R}" fill="black" stroke="white" stroke-width="4"/>` +
        `<text x="${x}" y="${y + R * 0.38}" font-family="Arial" font-size="${Math.round(R * 1.15)}" font-weight="bold" fill="white" text-anchor="middle">${b.letter}</text>`;
    }).join('')}</svg>`;
    const marked = await sharp(buf).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 85 }).toBuffer();
    fs.writeFileSync(`${OUT}/badged-p${p}${v != null ? '-v' + v : ''}.jpg`, marked);
    const b64 = marked.toString('base64');
    const letters = badges.map(b => b.letter);

    for (const vend of VENDORS) {
      const prompt = buildPrompt(letters, vend.variant);
      let r2;
      try { r2 = await vend.call(b64, prompt); } catch (e) { r2 = { raw: '', blocked: 'threw: ' + e.message, ms: 0 }; }
      const answers = parseAnswers(r2.raw);
      const cost = (r2.inTok && r2.outTok) ? (r2.inTok * vend.inP + r2.outTok * vend.outP) / 1e6 : null;
      results.push({ page: p, version: v, vendor: vend.id, label: vend.label, letters, answers, blocked: r2.blocked, http: r2.http, inTok: r2.inTok, outTok: r2.outTok, costUsd: cost, ms: r2.ms, raw: String(r2.raw).slice(0, 300) });
      console.log(`p${p} ${vend.id}: ${r2.blocked ? 'BLOCKED/ERR: ' + r2.blocked : JSON.stringify(answers)} (${r2.ms}ms, in:${r2.inTok} out:${r2.outTok}${cost ? ', $' + cost.toFixed(5) : ''})`);
    }
  }
  fs.writeFileSync(`${OUT}/vendor-results.json`, JSON.stringify(results, null, 1));
  console.log('saved', OUT + '/vendor-results.json');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

// Trait panel — the cross-family probes behind the 3-model trait review.
//
// Extracted from routes/avatars.js 2026-08-26 so the Test Lab (and, once the
// owner has seen it work there, the avatar gate itself) can reuse the SAME
// bucket comparison rather than growing a second copy. The panel's job is
// narrow and deterministic: read a face, bucket the categorical perception
// fields, and let two independent families disagree with the first.
//
// Why buckets and not prose: "dark blonde" vs "light brown" is a nuance nobody
// should act on, while blond vs brown is a real difference. Bucketing collapses
// the first and keeps the second, so a comparison is a set equality test rather
// than an opinion.

const { log } = require('../utils/logger');

const TRAIT_REVIEW_FIELDS = ['hairColor', 'hairStyle', 'hairLength', 'eyeColor', 'skinTone', 'facialHair'];
const _TRAIT_HEX_ON_OVERRIDE = {
  hairColor: { blond: '#E6D3A3', brown: '#6B4A2B', black: '#2A2321', red: '#A34A2A', grey: '#9C9C9C' },
  eyeColor: { blue: '#4A78A0', brown: '#5B3B22', green: '#4A7A50', grey: '#7A8490', hazel: '#7A5B33' },
};
function _traitBucket(field, value) {
  const v = String(value || '').toLowerCase();
  if (!v || v === 'none' && field !== 'facialHair') return null;
  const pick = (map) => { for (const [bucket, re] of map) { if (re.test(v)) return bucket; } return null; };
  switch (field) {
    case 'hairColor': return pick([
      ['blond', /blond|golden|sandy|flaxen|fair/],
      ['red', /red|ginger|auburn|copper|strawberry/],
      ['black', /black|jet/],
      ['grey', /gr[ae]y|white|silver/],
      ['brown', /brown|brunette|chestnut/],
    ]);
    case 'eyeColor': return pick([
      ['blue', /blue/], ['green', /green/], ['hazel', /hazel|amber/],
      ['grey', /gr[ae]y/], ['brown', /brown|dark/],
    ]);
    case 'hairStyle': return pick([
      ['curly', /curl|coil|kink/], ['wavy', /wav/], ['straight', /straight/],
    ]);
    case 'hairLength': return pick([
      ['short', /short|crop|buzz/], ['long', /long|shoulder|waist/], ['medium', /medium|mid|ear|chin/],
    ]);
    case 'skinTone': return pick([
      ['light', /light|fair|pale/], ['dark', /dark|deep/], ['medium', /medium|tan|olive|brown/],
    ]);
    case 'facialHair': return /none|clean|no\b|^$/.test(v) ? 'none' : 'some';
    default: return null;
  }
}
async function _traitProbe(vendor, b64, mimeType) {
  const prompt = 'Analyze this person\'s photo. Return ONLY JSON: {"hairColor": "...", "hairStyle": "straight|wavy|curly", "hairLength": "...", "eyeColor": "...", "skinTone": "...", "facialHair": "..."}. Be precise about colours (e.g. "light blonde", "dark brown").';
  let text = '';
  if (vendor === 'qwen') {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) return null;
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'qwen/qwen2.5-vl-72b-instruct', temperature: 0, max_tokens: 400,
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } }, { type: 'text', text: prompt }] }] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    text = j?.choices?.[0]?.message?.content || '';
  } else if (vendor === 'haiku') {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return null;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, temperature: 0,
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mimeType, data: b64 } }, { type: 'text', text: prompt }] }] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    text = (j?.content || []).map(c => c.text || '').join('');
  }
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}


module.exports = {
  TRAIT_REVIEW_FIELDS,
  _TRAIT_HEX_ON_OVERRIDE,
  _traitBucket,
  _traitProbe,
};

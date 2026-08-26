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

/**
 * Compare the traits VISIBLE IN AN IMAGE against a character's stored traits.
 *
 * Used to ask whether a generated avatar still looks like the child its traits
 * describe. Returns one entry per field where the buckets disagree, plus the
 * raw readings, so a caller can show its work.
 */
async function compareTraitsToImage(imageData, storedTraits, { vendors = ['qwen', 'haiku'] } = {}) {
  const b64 = String(imageData).replace(/^data:image\/\w+;base64,/, '');
  const mimeType = (String(imageData).match(/^data:(image\/\w+);base64,/) || [])[1] || 'image/jpeg';
  const readings = {};
  for (const v of vendors) {
    try { readings[v] = await _traitProbe(v, b64, mimeType); }
    catch (e) { readings[v] = null; log.warn(`[TRAIT-COMPARE] ${v} probe failed: ${e.message}`); }
  }
  const available = Object.entries(readings).filter(([, r]) => r);
  const mismatches = [];
  for (const field of TRAIT_REVIEW_FIELDS) {
    const expected = _traitBucket(field, storedTraits?.[field]);
    if (!expected) continue;
    const seen = available
      .map(([vendor, r]) => ({ vendor, bucket: _traitBucket(field, r[field]), raw: r[field] }))
      .filter(x => x.bucket);
    if (seen.length === 0) continue;
    // Only a UNANIMOUS disagreement counts — one vendor differing is noise.
    const allDisagree = seen.every(x => x.bucket !== expected);
    if (allDisagree) {
      mismatches.push({
        field,
        expected,
        expectedRaw: storedTraits?.[field] ?? null,
        seen: seen.map(x => ({ vendor: x.vendor, bucket: x.bucket, raw: x.raw })),
      });
    }
  }
  return { mismatches, readings, vendorsAvailable: available.map(([v]) => v) };
}

/**
 * Resolve a character's stored traits into the panel's field names.
 *
 * They are NOT all in one place, and the naive `character.traits ||
 * character.physical` chain reads an empty `traits` object and stops there —
 * which is how the first Lab run compared against five nulls and reported a
 * trivial "matches" (experiment #859). Explicit mapping, no fallback chain:
 *   hairColor / eyeColor / skinTone   physical.*
 *   hairStyle                         physical.detailedHairAnalysis.type
 *   hairLength                        physical.detailedHairAnalysis.lengthTop
 * `traits` and `avatars.extractedTraits` win when they actually carry a value,
 * because the 3-model review writes its overrides there.
 */
function resolveStoredTraits(character) {
  const ph = character?.physical || {};
  const dha = ph.detailedHairAnalysis || {};
  const t = character?.traits || {};
  const ex = character?.avatars?.extractedTraits || {};
  const pick = (...vals) => vals.find(v => v != null && v !== '') ?? null;
  return {
    hairColor: pick(t.hairColor, ex.hairColor, ph.hairColor),
    hairStyle: pick(t.hairStyle, ex.hairStyle, dha.type),
    hairLength: pick(t.hairLength, ex.hairLength, dha.lengthTop, ph.hairLength),
    eyeColor: pick(t.eyeColor, ex.eyeColor, ph.eyeColor),
    skinTone: pick(t.skinTone, ex.skinTone, ph.skinTone),
    facialHair: pick(t.facialHair, ex.facialHair, ph.facialHair),
  };
}

module.exports = {
  TRAIT_REVIEW_FIELDS,
  _TRAIT_HEX_ON_OVERRIDE,
  _traitBucket,
  _traitProbe,
  compareTraitsToImage,
  resolveStoredTraits,
};

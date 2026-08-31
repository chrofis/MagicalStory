/**
 * writer_compare — one Test Lab stage that rates every writer model on every
 * writer stage, for a story, in a single experiment.
 *
 * WHY A STAGE AND NOT A SCRIPT. The Sonnet-vs-DeepSeek comparison was first run
 * as four separate CLI experiments (#504-#509) whose results could only be
 * joined by hand. Adding a model meant a new ad-hoc run and a new manual join.
 * As a stage it is one row per run: `params.models` grows, a `testlab_sets`
 * member adds a story, and the scorecard is stored with the experiment instead
 * of living in a chat message.
 *
 * ARMS. `shipped` is free — it reads the Sonnet output the story already has,
 * so re-running the comparison never re-pays for the baseline (owner rule:
 * "don't run sonnet anymore, reuse existing stories where sonnet ran"). Every
 * other arm is a TEXT_MODELS key and is actually called.
 *
 * STAGES. plan / bible / scenes / text — the four calls that write a story.
 * Each is scored on criteria appropriate to what it produces; a stage that is
 * structurally broken (unparseable metadata, wrong page count) scores 0 there
 * rather than being silently averaged away.
 *
 * params.models  : string[] TEXT_MODELS keys (default: the two DeepSeek tiers)
 * params.stages  : string[] subset of ['plan','bible','scenes','text']
 * params.baseline: include the free `shipped` arm (default true)
 */
const { log } = require('../utils/logger');

const ALL_STAGES = ['plan', 'bible', 'scenes', 'text'];
const NAME_RE = /\b(Emma|Noah|Hans|Sarah|Daniel|Lily|Ethan|Léa|Jules|Margaret|Miller|Berger|Dubois)\b/g;

const RE = {
  hair: /\bhair\b/i,
  eyes: /\beyes?\b/i,
  clothing: /wear|wears|dressed|coat|vest|bandana|tricorn|blouse|shirt|skirt|breeches|boots|dress/i,
  meta: /---\s*METADATA\s*---/i,
  charsArr: /"characters"\s*:/i,
  eszett: /ß/,
  guillemets: /[«»]/,
};

/** 0-5 from a hit rate so every criterion shares one scale. */
const rate = (hits, total) => (total === 0 ? 0 : Math.round((hits / total) * 50) / 10);
const avg = (xs) => (xs.length === 0 ? 0 : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10);

/**
 * Scene briefs: what every page-image prompt is built from. A field missing
 * here is a field missing in the render — identity anchoring especially, which
 * is the pipeline's only defence against drawing a stranger.
 */
function scoreScenes(briefs) {
  const n = briefs.length;
  if (n === 0) return { score: 0, note: 'no briefs' };
  let hair = 0, eyes = 0, cloth = 0, meta = 0, cast = 0, chars = 0;
  for (const raw of briefs) {
    const t = String(raw || '');
    chars += t.length;
    if (RE.hair.test(t)) hair++;
    if (RE.eyes.test(t)) eyes++;
    if (RE.clothing.test(t)) cloth++;
    if (RE.meta.test(t) && RE.charsArr.test(t)) meta++;
    const [prose = '', metaPart = ''] = t.split(/---\s*METADATA\s*---/i);
    const names = [...new Set(prose.match(NAME_RE) || [])];
    if (names.length > 0 && names.every(nm => metaPart.includes(nm))) cast++;
  }
  const criteria = {
    identity: rate(Math.min(hair, eyes), n),
    clothing: rate(cloth, n),
    metadata: rate(meta, n),
    cast: rate(cast, n),
  };
  return {
    ...criteria,
    score: avg(Object.values(criteria)),
    raw: `hair ${hair}/${n}, eyes ${eyes}/${n}, clothing ${cloth}/${n}, metadata ${meta}/${n}, cast ${cast}/${n}`,
    avgChars: Math.round(chars / n),
    pages: n,
  };
}

/**
 * Visual bible: the contract every later stage reads. Completeness matters more
 * than prose — a character missing from clothingRequirements has no outfit at
 * all, and a VB with too few entries leaves the Art Director with nothing to
 * reference.
 */
function scoreBible(clothing, visualBible, expectedChars) {
  const chars = Object.keys(clothing || {});
  const withDesc = chars.filter((n) => {
    const cats = clothing[n] || {};
    return Object.values(cats).some(v => v && v.used && String(v.description || '').trim());
  });
  const vbCount = Object.values(visualBible || {}).reduce((s, v) => s + (Array.isArray(v) ? v.length : 0), 0);
  const criteria = {
    coverage: rate(withDesc.length, Math.max(expectedChars, 1)),
    // 14+ entries is the prompt's own floor (one per page); scale to that.
    vbDepth: Math.min(5, Math.round((vbCount / 14) * 50) / 10),
    // A costume named per costumed character, not a bare category key.
    named: rate(chars.filter(n => Object.values(clothing[n] || {}).some(v => v?.used && (v.costume || v.description))).length, Math.max(chars.length, 1)),
  };
  return {
    ...criteria,
    score: avg(Object.values(criteria)),
    raw: `${withDesc.length}/${expectedChars} characters dressed, ${vbCount} VB entries`,
  };
}

/**
 * Page text: reader-facing prose. Swiss orthography is not a style preference
 * here — every German string in this product uses ss, never ß, and dialogue
 * uses guillemets.
 */
function scoreText(pages, expectedPages, language) {
  const n = pages.length;
  if (n === 0) return { score: 0, note: 'no pages' };
  const body = pages.map(p => p.text || '').join('\n');
  const isDe = String(language || '').startsWith('de');
  const criteria = {
    completeness: rate(Math.min(n, expectedPages), Math.max(expectedPages, 1)),
    nonEmpty: rate(pages.filter(p => String(p.text || '').trim().length > 20).length, n),
    // Swiss orthography: ß is always wrong. Full marks only when absent.
    orthography: isDe ? (RE.eszett.test(body) ? 0 : 5) : 5,
    // Dialogue convention, only judged when the text has dialogue at all.
    dialogue: !isDe || !/["“”]/.test(body) ? 5 : (RE.guillemets.test(body) ? 5 : 2),
  };
  return {
    ...criteria,
    score: avg(Object.values(criteria)),
    raw: `${n}/${expectedPages} pages, ß=${RE.eszett.test(body) ? 'FOUND' : 'none'}, guillemets=${RE.guillemets.test(body) ? 'yes' : 'no'}`,
    avgChars: Math.round(body.length / n),
  };
}

/** Beat plan: structure only — one beat and one page-plan line per page. */
function scorePlan(beats, expectedPages) {
  const n = beats.length;
  if (n === 0) return { score: 0, note: 'no beats' };
  const withBoth = beats.filter(b => String(b.beat || '').trim() && String(b.planLine || b.scene || '').trim()).length;
  const criteria = {
    completeness: rate(Math.min(n, expectedPages), Math.max(expectedPages, 1)),
    filled: rate(withBoth, n),
  };
  return { ...criteria, score: avg(Object.values(criteria)), raw: `${n}/${expectedPages} pages, ${withBoth} with beat+plan` };
}

module.exports = { ALL_STAGES, scoreScenes, scoreBible, scoreText, scorePlan, rate, avg };

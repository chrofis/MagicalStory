/**
 * ONE authored English label per Visual Bible element — minted once, stored
 * beside the id, read by every consumer through `labelOf`.
 *
 * WHY THIS EXISTS. A VB element carries five overlapping identity fields
 * (`name`, `properName`, `type`, `kind`, `description`) and nine competing
 * rules across the consumers that have to name it for an image model. On
 * de-ch job_1789301291267_ueh8h145m two different artifacts both declared
 * `type: "tool"`, so the REQUIRED OBJECTS block of the page prompt read
 * `**tool** (object)` twice — the model had no way to tell the two props
 * apart. The fix is not a tenth rule: it is one authored `label` per element
 * and one function that reads it. Ids never reach an image model (settled),
 * so the label is the ONLY handle the prompt has.
 *
 * Pure module: no I/O, no logging, never throws. `visualBible.js` requires
 * this file, so `clauseRef` / `REF_GENERIC_TYPE` are lazy-required INSIDE the
 * functions that need them to keep the cycle from biting at load time.
 */

/** Validator codes, in the order findings are emitted for one entry. */
const LABEL_CODES = [
  'label_missing',
  'label_not_english',
  'label_too_long',
  'label_bare_category',
  'label_proper_noun',
  'label_duplicate',
  'label_contains_id',
];

/**
 * Words that name the CATEGORY rather than the thing. A label that is exactly
 * one of these ("tool", "object") is the job_1789301291267 defect itself: it
 * distinguishes nothing from the other elements in its pool.
 */
const BARE_CATEGORIES = new Set([
  'tool', 'object', 'item', 'thing', 'document', 'box', 'container', 'prop',
  'device', 'vehicle', 'garment', 'outfit', 'place', 'building', 'room',
  'animal', 'creature', 'artifact', 'artefact', 'element',
]);

/** Id prefix → the Visual Bible array the element lives in. */
const POOL_OF = {
  CHR: 'secondaryCharacters',
  ANI: 'animals',
  ART: 'artifacts',
  LOC: 'locations',
  VEH: 'vehicles',
  CLO: 'clothing',
};

/** Last-resort noun per pool — never a bare id, never an empty label. */
const GENERIC_NOUN = {
  CHR: 'person',
  ANI: 'animal',
  ART: 'object',
  LOC: 'place',
  VEH: 'vehicle',
  CLO: 'outfit',
};

/**
 * Pool-category types, matched whole. `visualBible.js` holds the canonical
 * copy (`REF_GENERIC_TYPE`) but does not export it, so this is the fallback
 * used when the require gives nothing back — same grammar, one place to fix.
 */
const LOCAL_GENERIC_TYPE = /^(?:artifacts?|objects?|items?|props?|vehicles?|clothing|outfits?|garments?|locations?|places?|characters?|animals?)$/i;

/** Words too common to distinguish two elements that collided. */
const PREPEND_STOPWORDS = new Set(['a', 'an', 'the', 'of', 'with', 'and']);

const { VB_ID_PATTERN, baseVbId } = require('./vbIdGuard');

/** Non-global copy — `VB_ID_PATTERN` carries `g` and therefore `lastIndex`. */
const VB_ID_ANYWHERE = new RegExp(VB_ID_PATTERN.source);

function containsVbId(s) {
  return VB_ID_ANYWHERE.test(String(s ?? ''));
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * The pool prefix of an element or an id: 'ART001.2' → 'ART'.
 * @param {object|string} idOrEntry
 * @returns {'CHR'|'ANI'|'ART'|'LOC'|'VEH'|'CLO'|null}
 */
function poolOf(idOrEntry) {
  const raw = (idOrEntry && typeof idOrEntry === 'object') ? idOrEntry.id : idOrEntry;
  const base = baseVbId(raw);
  if (!base) return null;
  const prefix = base.slice(0, 3).toUpperCase();
  return Object.prototype.hasOwnProperty.call(POOL_OF, prefix) ? prefix : null;
}

/**
 * A label is image-facing text, so it must be ASCII English: letters, digits,
 * apostrophes, hyphens and spaces. A German `name` ("Roter Umhang") reaching
 * an English image prompt is the leak this rejects.
 * @param {string} s
 */
function isEnglishLabel(s) {
  return /^[A-Za-z0-9][A-Za-z0-9' \-]*$/.test(String(s ?? ''));
}

/** @param {string} s */
function wordCount(s) {
  return String(s ?? '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Drop a trailing ` (…)` parenthetical. Orientation is re-added downstream by
 * the REQUIRED OBJECTS builder from the entry's `name`, so a label that
 * already carries one would emit it twice.
 * @param {string} s
 */
function stripOrientation(s) {
  return String(s ?? '').replace(/\s*\([^()]*\)\s*$/, '').trim();
}

/**
 * The English label for one VB element. The authored `label` wins; everything
 * below it is BACKFILL for bibles stored before labels existed.
 *
 * @param {object} entry
 * @param {string} [poolHint] pool prefix when the entry has no usable id
 * @returns {string} never empty, never a raw VB id
 */
function labelOf(entry, poolHint) {
  const pool = poolHint || poolOf(entry) || null;
  const generic = (pool && GENERIC_NOUN[pool]) || 'object';
  if (!entry || typeof entry !== 'object') return generic;

  const authored = String(entry.label ?? '').trim();
  if (authored && !containsVbId(authored)) {
    const stripped = stripOrientation(authored);
    if (stripped) return stripped;
  }

  let out = '';
  try {
    // Lazy — visualBible.js requires this module.
    const { clauseRef, REF_GENERIC_TYPE } = require('./visualBible');
    const genericType = REF_GENERIC_TYPE || LOCAL_GENERIC_TYPE;
    const name = String(entry.name ?? '').trim();

    if (pool === 'CHR' || pool === 'ANI') {
      // A character or animal IS its name; that name is the identity anchor
      // every other consumer already uses.
      out = name;
    } else if (pool === 'LOC') {
      out = entry.isRealLandmark
        ? name
        : (clauseRef(entry.features || entry.description, { maxWords: 4, hardCap: 6 }) || name);
    } else {
      const type = String(entry.type ?? '').trim();
      const typeUsable = type
        && wordCount(type) >= 1 && wordCount(type) <= 4
        && isEnglishLabel(type)
        && !BARE_CATEGORIES.has(type.toLowerCase())
        && !genericType.test(type);
      if (typeUsable) {
        out = type;
      } else {
        const ref = clauseRef(entry.extractedDescription || entry.description, { maxWords: 4, hardCap: 6 });
        if (ref && isEnglishLabel(ref)) out = ref;
      }
    }
  } catch {
    out = '';
  }

  out = stripOrientation(out);
  if (!out || containsVbId(out)) return generic;
  return out;
}

/**
 * An element in one of its declared states ("wooden crate, lid open").
 * @param {object} entry
 * @param {{name?: string}} state
 */
function stateLabelOf(entry, state) {
  const base = labelOf(entry);
  const stateName = String(state?.name ?? '').trim();
  return stateName ? `${base}, ${stateName}` : base;
}

/**
 * CHR, ANI and real-landmark LOC entries are labelled by their NAME, which is
 * story-language by design — every rule but uniqueness would fire on them.
 */
function isExempt(pool, entry) {
  if (pool === 'CHR' || pool === 'ANI') return true;
  if (pool === 'LOC' && entry?.isRealLandmark) return true;
  return false;
}

/** Every element of a bible, in POOL_OF order then array order. */
function eachEntry(visualBible) {
  const out = [];
  if (!visualBible || typeof visualBible !== 'object') return out;
  for (const pool of Object.keys(POOL_OF)) {
    for (const entry of asArray(visualBible[POOL_OF[pool]])) {
      if (!entry || typeof entry !== 'object') continue;
      out.push({ entry, pool, id: String(entry.id ?? '') });
    }
  }
  return out;
}

/**
 * The first non-duplicate code a candidate label would trigger, or null.
 * Checked against the RAW candidate — backfill is not validation.
 */
function firstFault(label, entry) {
  const raw = String(label ?? '').trim();
  if (!raw) return 'label_missing';
  if (!isEnglishLabel(raw)) return 'label_not_english';
  const words = wordCount(raw);
  if (words > 4 || words === 0) return 'label_too_long';
  if (BARE_CATEGORIES.has(raw.toLowerCase())) return 'label_bare_category';
  const proper = String(entry?.properName ?? '').trim();
  if (proper && proper.toLowerCase() === raw.toLowerCase()) return 'label_proper_noun';
  if (containsVbId(raw)) return 'label_contains_id';
  return null;
}

/** id → the label the duplicate check compares (exempt pools use the name). */
function comparisonLabels(visualBible) {
  const map = new Map();
  for (const { entry, pool, id } of eachEntry(visualBible)) {
    const value = isExempt(pool, entry)
      ? String(entry.name ?? '').trim()
      : labelOf(entry, pool);
    map.set(id, { entry, pool, value });
  }
  return map;
}

/**
 * Every label fault in a bible, deterministically ordered.
 *
 * @param {object} visualBible
 * @returns {Array<{id: string, pool: string, label: string, code: string, detail: string}>}
 */
function validateLabels(visualBible) {
  const findings = [];
  const entries = eachEntry(visualBible);

  for (const { entry, pool, id } of entries) {
    if (isExempt(pool, entry)) continue;
    const raw = String(entry.label ?? '').trim();
    const code = firstFault(raw, entry);
    if (!code) continue;
    findings.push({
      id,
      pool,
      label: raw,
      code,
      detail: detailFor(code, raw, entry),
    });
  }

  // Uniqueness spans ALL SIX pools: an artifact called "Bruno" and a dog
  // called "Bruno" are the same word in the prompt.
  const byLabel = new Map();
  for (const [id, { value }] of comparisonLabels(visualBible)) {
    const key = String(value ?? '').trim().toLowerCase();
    if (!key) continue;
    if (!byLabel.has(key)) byLabel.set(key, []);
    byLabel.get(key).push(id);
  }
  const rivalsById = new Map();
  for (const [, ids] of byLabel) {
    if (ids.length < 2) continue;
    for (const id of ids) rivalsById.set(id, ids.filter(o => o !== id));
  }
  for (const { entry, pool, id } of entries) {
    const rivals = rivalsById.get(id);
    if (!rivals) continue;
    const shown = isExempt(pool, entry)
      ? String(entry.name ?? '').trim()
      : labelOf(entry, pool);
    findings.push({
      id,
      pool,
      label: shown,
      code: 'label_duplicate',
      detail: `shares the label "${shown}" with ${rivals.join(', ')}`,
    });
  }

  // Pool order, then entry order, then LABEL_CODES order.
  const entryRank = new Map(entries.map((e, i) => [e.id, i]));
  findings.sort((a, b) => {
    const ra = entryRank.get(a.id) ?? 0;
    const rb = entryRank.get(b.id) ?? 0;
    if (ra !== rb) return ra - rb;
    return LABEL_CODES.indexOf(a.code) - LABEL_CODES.indexOf(b.code);
  });
  return findings;
}

function detailFor(code, raw, entry) {
  switch (code) {
    case 'label_missing': return 'no label authored';
    case 'label_not_english': return `"${raw}" is not plain-ASCII English`;
    case 'label_too_long': return `"${raw}" is ${wordCount(raw)} words (max 4)`;
    case 'label_bare_category': return `"${raw}" names the category, not the thing`;
    case 'label_proper_noun': return `"${raw}" repeats properName`;
    case 'label_contains_id': return `"${raw}" carries a raw Visual Bible id`;
    default: return '';
  }
}

/** The first distinguishing word of `text` that `rivalText` does not use. */
function distinguishingWord(text, rivalText) {
  const rivalWords = new Set(
    String(rivalText ?? '').toLowerCase().match(/[a-z]+/g) || []
  );
  const words = String(text ?? '').match(/[A-Za-z]+/g) || [];
  for (const w of words) {
    const lower = w.toLowerCase();
    if (w.length < 4) continue;
    if (PREPEND_STOPWORDS.has(lower)) continue;
    if (rivalWords.has(lower)) continue;
    return lower;
  }
  return null;
}

/**
 * Repair the faults `validateLabels` found, in place.
 *
 * The ladder is deliberately dull so two runs of the same bible produce the
 * same labels: the entry's own `type`, then a four-word clause of its
 * description, then — for a collision — a distinguishing word from the
 * description prepended to the losing label. A numeric suffix is the admission
 * of defeat, and its id goes to `unresolved` so a human sees it.
 *
 * @param {object} visualBible mutated: `label` and `labelRepaired` are set
 * @param {Array} [findings] defaults to validateLabels(visualBible)
 * @returns {{repaired: Array<{id: string, from: string, to: string, code: string}>, unresolved: string[]}}
 */
function repairLabels(visualBible, findings) {
  const repaired = [];
  const unresolved = [];
  if (!visualBible || typeof visualBible !== 'object') return { repaired, unresolved };

  let work;
  try {
    work = Array.isArray(findings) ? findings : validateLabels(visualBible);
  } catch {
    return { repaired, unresolved };
  }

  const index = new Map(eachEntry(visualBible).map(e => [e.id, e]));
  const pushUnresolved = (id) => { if (id && !unresolved.includes(id)) unresolved.push(id); };

  const collides = (candidate, selfId) => {
    const key = String(candidate).trim().toLowerCase();
    if (!key) return true;
    for (const [id, { value }] of comparisonLabels(visualBible)) {
      if (id === selfId) continue;
      if (String(value).trim().toLowerCase() === key) return true;
    }
    return false;
  };

  for (const finding of work) {
    const slot = index.get(finding.id);
    if (!slot) continue;
    const { entry, pool } = slot;
    if (isExempt(pool, entry)) continue;

    const from = String(entry.label ?? '');
    const current = labelOf(entry, pool);

    // An earlier repair in this pass may already have cleared this finding —
    // a collision is gone once the rival was renamed. Repairing it anyway
    // would mangle a label that is now correct.
    const stillFaulty = finding.code === 'label_duplicate'
      ? collides(current, finding.id)
      : firstFault(from.trim(), entry) === finding.code;
    if (!stillFaulty) continue;

    const candidates = [];

    let clause = '';
    try {
      const { clauseRef } = require('./visualBible');
      clause = clauseRef(entry.extractedDescription || entry.description, { maxWords: 4, hardCap: 6 }) || '';
    } catch { clause = ''; }

    if (finding.code === 'label_duplicate') {
      const rivalText = rivalDescriptions(visualBible, finding.id, current);
      const word = distinguishingWord(entry.extractedDescription || entry.description, rivalText);
      if (word) candidates.push(`${word} ${current}`);
      if (clause) candidates.push(clause);
    } else {
      const type = String(entry.type ?? '').trim();
      if (type) candidates.push(type);
      if (clause) candidates.push(clause);
    }

    let applied = null;
    for (const candidate of candidates) {
      const value = stripOrientation(candidate);
      if (!value) continue;
      if (firstFault(value, entry)) continue;
      if (collides(value, finding.id)) continue;
      applied = value;
      break;
    }

    if (!applied) {
      // Defeat: a numeric suffix keeps the prompt unambiguous, and the id is
      // reported so the bible can be re-authored.
      const base = current || GENERIC_NOUN[pool] || 'object';
      for (let n = 2; n <= 9 && !applied; n++) {
        const value = `${base} ${n}`;
        if (!collides(value, finding.id)) applied = value;
      }
      if (!applied) applied = base;
      pushUnresolved(finding.id);
    }

    entry.label = applied;
    entry.labelRepaired = finding.code;
    repaired.push({ id: finding.id, from, to: applied, code: finding.code });
  }

  // A repair must never introduce a new fault. Whatever still fails is
  // reported rather than silently shipped.
  let post = [];
  try { post = validateLabels(visualBible); } catch { post = []; }
  for (const finding of post) pushUnresolved(finding.id);

  return { repaired, unresolved };
}

/** Concatenated descriptions of the entries currently sharing `label`. */
function rivalDescriptions(visualBible, selfId, label) {
  const key = String(label).trim().toLowerCase();
  const parts = [];
  for (const [id, { entry, value }] of comparisonLabels(visualBible)) {
    if (id === selfId) continue;
    if (String(value).trim().toLowerCase() !== key) continue;
    parts.push(String(entry.extractedDescription || entry.description || ''));
  }
  return parts.join(' ');
}

module.exports = {
  labelOf,
  stateLabelOf,
  validateLabels,
  repairLabels,
  isEnglishLabel,
  poolOf,
  BARE_CATEGORIES,
  LABEL_CODES,
  GENERIC_NOUN,
};

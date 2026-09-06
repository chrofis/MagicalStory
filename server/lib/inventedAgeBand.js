/**
 * INVENTED CHILDREN ARE BOUND TO THE COMMISSIONED CHILDREN'S AGE BAND.
 *
 * The bible invents secondary characters freely and states each one's age as
 * prose ("a boy of about ten"). Nothing tied that number to the children the
 * book was actually commissioned for, so a rival cast as a PEER of a
 * 6-year-old came out of the bible at ten and rendered at eleven or twelve
 * (job_1788641639919_mpjwlzkf1, CHR001 "The boy in the striped scarf", p5).
 *
 * The rule is mechanical, per the owner doctrine of 2026-09-05: the number is
 * computed in code from the commission and injected as a concrete band into the
 * generator prompt, and the SAME number is then used by a deterministic
 * post-check over what the generator returned. Nothing here is an AI call and
 * nothing here classifies: whether an invented character is a PEER of the
 * commissioned children is the bible's own declaration (`peerChild`), read as a
 * field — code only extracts a number and compares it against a band.
 *
 * Everything in this module is pure. It never throws, and a missing or
 * unparseable input degrades to "no band" / "no finding" rather than to a
 * wrong one — an age constraint must never be able to kill a paid run.
 */

/** Above this age a cast member is not a child and does not set the band. */
const CHILD_MAX_AGE = 12;

/**
 * Slack around the commissioned band, as [below, above].
 *
 * Asymmetric on purpose: a peer who reads slightly OLDER is the common and
 * mostly harmless case (an older child in the group), while one who reads
 * younger than the youngest commissioned child breaks the peer relation
 * outright. The band is a guideline, so the tolerance is what turns a stated
 * age into a finding — not the band itself.
 */
const BAND_TOLERANCE = [1, 2];

/** Number words a bible actually writes an age with. */
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

/**
 * The age stated in a piece of text, as a number.
 *
 * Handles the two shapes a commission and a bible actually use: a bare or
 * embedded numeral ("6", "aged 11", "a boy of about 10") and a spelled-out
 * number ("a boy of about ten"). A range ("nine or ten") takes the FIRST
 * number, which is the one the sentence leads with.
 *
 * @param {string|number} value
 * @returns {number|null} a plausible human age, or null
 */
function parseStatedAge(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 0 && value <= 120 ? Math.round(value) : null;
  }
  const text = String(value == null ? '' : value).toLowerCase();
  if (!text.trim()) return null;

  const digits = text.match(/\b(\d{1,3})\b/);
  const wordMatch = text.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/);

  // Whichever appears FIRST in the sentence wins, so "about ten" is not
  // overruled by a stray numeral further along.
  let n = null;
  if (digits && wordMatch) n = digits.index < wordMatch.index ? Number(digits[1]) : NUMBER_WORDS[wordMatch[1]];
  else if (digits) n = Number(digits[1]);
  else if (wordMatch) n = NUMBER_WORDS[wordMatch[1]];

  if (n == null || !Number.isFinite(n)) return null;
  return n >= 0 && n <= 120 ? n : null;
}

/**
 * The age band the commissioned CHILDREN occupy.
 *
 * @param {Array<{name?:string, age?:string|number}>} characters the commissioned cast
 * @param {Object} [opts]
 * @param {number} [opts.childMaxAge=CHILD_MAX_AGE]
 * @returns {{min:number, max:number, names:string[], tolerance:[number,number], low:number, high:number}|null}
 *   null when the book has no commissioned child at all — an all-adult
 *   commission constrains nothing, and inventing a band from adults would be
 *   worse than having none.
 */
function commissionedChildBand(characters = [], { childMaxAge = CHILD_MAX_AGE } = {}) {
  const kids = [];
  for (const c of (Array.isArray(characters) ? characters : [])) {
    const age = parseStatedAge(c?.age);
    if (age == null || age > childMaxAge) continue;
    kids.push({ name: String(c?.name || '').trim(), age });
  }
  if (kids.length === 0) return null;
  const ages = kids.map(k => k.age);
  const min = Math.min(...ages);
  const max = Math.max(...ages);
  return {
    min,
    max,
    names: kids.map(k => k.name).filter(Boolean),
    tolerance: [...BAND_TOLERANCE],
    low: Math.max(0, min - BAND_TOLERANCE[0]),
    high: max + BAND_TOLERANCE[1],
  };
}

/**
 * The band as the bible prompt states it. Terse, archetypal, no justification —
 * the number is the instruction.
 *
 * @param {Object|null} band from commissionedChildBand
 * @returns {string} '' when there is no band, so the caller can inject blindly
 */
function buildChildAgeBandNote(band) {
  if (!band) return '';
  const range = band.min === band.max ? `${band.min}` : `${band.min}-${band.max}`;
  return `**PEER AGES:** the commissioned children are ${range}. An invented child who plays, competes or shares a group with them is ${range} too, and its stated age says so. Mark such an entry \`peer: yes\`. An invented child the story places outside that group — a much younger sibling, an older helper — carries its own age and \`peer: no\`.`;
}

/**
 * Deterministic post-check over the bible's secondary characters.
 *
 * Reads the bible's OWN declaration of who is a peer (`peer` / `peerChild`);
 * it never infers one from the prose. An entry that declares nothing is
 * reported as unchecked rather than guessed at, so the gap stays visible
 * instead of turning into a silent pass.
 *
 * @param {Array<Object>} secondaryCharacters visualBible.secondaryCharacters
 * @param {Object|null} band from commissionedChildBand
 * @returns {{findings:Array, unchecked:Array, checked:number, band:Object|null}}
 *   findings: [{id, name, statedAge, low, high, detail}] — one per peer child
 *   whose stated age falls outside the tolerated band.
 */
function checkSecondaryAges(secondaryCharacters = [], band = null) {
  const entries = Array.isArray(secondaryCharacters) ? secondaryCharacters : [];
  const findings = [];
  const unchecked = [];
  let checked = 0;
  if (!band) return { findings, unchecked, checked, band };

  for (const e of entries) {
    if (!e) continue;
    const id = e.id || e.name || '(unnamed)';
    const name = e.name || id;
    const peer = e.peer != null ? e.peer : e.peerChild;
    const isPeer = peer === true || String(peer).trim().toLowerCase() === 'yes' || String(peer).trim().toLowerCase() === 'true';
    if (!isPeer) {
      if (peer == null) unchecked.push({ id, name });
      continue;
    }
    const statedAge = parseStatedAge(e.age) ?? parseStatedAge(e.description);
    if (statedAge == null) {
      unchecked.push({ id, name, reason: 'peer declared but no age could be read' });
      continue;
    }
    checked++;
    if (statedAge < band.low || statedAge > band.high) {
      findings.push({
        id,
        name,
        statedAge,
        low: band.low,
        high: band.high,
        detail: `${name} is declared a peer of the commissioned children (${band.min}-${band.max}) but is ${statedAge}; a peer's age belongs in ${band.low}-${band.high}`,
      });
    }
  }
  return { findings, unchecked, checked, band };
}

/**
 * The age a stored entry should carry when the finding cannot be fed back.
 *
 * The bible stage is fail-soft and has no retry loop, so a violation that
 * cannot be re-asked is clamped to the nearest edge of the tolerated band and
 * flagged, rather than shipped as-is or dropped.
 *
 * @param {number} statedAge
 * @param {Object} band
 * @returns {number}
 */
function clampAgeToBand(statedAge, band) {
  if (!band || !Number.isFinite(statedAge)) return statedAge;
  return Math.min(band.high, Math.max(band.low, statedAge));
}

/**
 * The proportions cue a secondary character needs in the IMAGE prompt.
 *
 * The AGE & PROPORTIONS block is built from `sceneCharacters`, which is the
 * COMMISSIONED cast only (`getCharactersInScene(sceneDescription,
 * inputData.characters)`), so an invented child has never had a head-count cue
 * on any page — its only size signal is the prose word "boy", which the model
 * is free to render at any age. This turns a bible entry into the same
 * `{name, age}` shape the block already consumes.
 *
 * @param {Array<Object>} secondaryCharacters
 * @param {number[]} [pageNumber] restrict to the entries appearing on this page
 * @returns {Array<{name:string, age:number}>} entries with a readable age
 */
function secondaryAgeCues(secondaryCharacters = [], pageNumber = null) {
  const out = [];
  for (const e of (Array.isArray(secondaryCharacters) ? secondaryCharacters : [])) {
    if (!e) continue;
    if (pageNumber != null) {
      const pages = e.appearsInPages || e.pages || [];
      if (Array.isArray(pages) && pages.length && !pages.includes(pageNumber)) continue;
    }
    const age = parseStatedAge(e.age) ?? parseStatedAge(e.description);
    if (age == null) continue;
    out.push({ name: e.name || e.id, age });
  }
  return out;
}

/**
 * Apply the band to what the bible returned: clamp, flag, and hand the caller
 * the list to log.
 *
 * The bible stage is fail-soft and has no retry loop, so a peer outside the
 * tolerated band is corrected in place rather than re-asked or shipped as-is.
 * Mutates the entries — the caller stores the same array — and rebuilds the
 * `description` through the INJECTED builder (the one the parser used), never
 * by string surgery on the old prose.
 *
 * Pure apart from that mutation: no logging, no I/O, no model call. The caller
 * owns every log line so this stays testable.
 *
 * @param {Array<Object>} secondaryCharacters visualBible.secondaryCharacters
 * @param {Object|null} band from commissionedChildBand
 * @param {(entry:Object)=>string} [buildDescription] rebuilds entry.description
 * @returns {Array<{id,name,statedAge,clampedTo,low,high,detail}>} applied clamps
 */
function applySecondaryAgeBand(secondaryCharacters, band, buildDescription = null) {
  const applied = [];
  const { findings } = checkSecondaryAges(secondaryCharacters, band);
  for (const f of findings) {
    const entry = (secondaryCharacters || []).find(e => e && (e.id || e.name) === f.id);
    if (!entry) continue;
    const clampedTo = clampAgeToBand(f.statedAge, band);
    entry.age = clampedTo;
    entry.secondaryAgeClamped = { statedAge: f.statedAge, clampedTo, band: [band.low, band.high] };
    if (typeof buildDescription === 'function') {
      try {
        const rebuilt = buildDescription(entry);
        if (rebuilt) entry.description = rebuilt;
      } catch { /* a description rebuild must never cost the story its bible */ }
    }
    applied.push({ ...f, clampedTo });
  }
  return applied;
}

module.exports = {
  CHILD_MAX_AGE,
  BAND_TOLERANCE,
  parseStatedAge,
  commissionedChildBand,
  buildChildAgeBandNote,
  checkSecondaryAges,
  clampAgeToBand,
  applySecondaryAgeBand,
  secondaryAgeCues,
};

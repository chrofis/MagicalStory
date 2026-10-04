// Request guards shared by routes that put client text into paid prompts or store it for later
// paid calls (docs/decisions.md "Input caps and per-user spend limits", code review 2026-10 T1/R4).
//
// Pure functions: each returns an error string (for a 400) or null.

const FIELD_MAX_CHARS = 2000; // every free-text field (topic, theme, custom text, special details, ...)
const IDEA_TEXT_MAX_CHARS = 4000; // the chosen story idea text (a two-paragraph back cover, any language)
const TRAITS_MAX_ITEMS = 20;
const TRAIT_MAX_CHARS = 100;
const CHARACTERS_MAX = 20;
const RELATIONSHIPS_MAX = 400; // a full 20x20 matrix

function textError(label, value, max = FIELD_MAX_CHARS) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return `${label} must be text`;
  if (value.length > max) return `${label} is too long (max ${max} characters)`;
  return null;
}

/** First error among several `[label, value]` pairs (optional `max` as third element). */
function textFieldsError(pairs) {
  for (const [label, value, max] of pairs) {
    const err = textError(label, value, max);
    if (err) return err;
  }
  return null;
}

/** A list of short strings: max 20 items of max 100 characters. */
function traitListError(label, list) {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list)) return `${label} must be a list`;
  if (list.length > TRAITS_MAX_ITEMS) return `${label} has too many items (max ${TRAITS_MAX_ITEMS})`;
  for (const item of list) {
    if (typeof item !== 'string') return `${label} must contain only text`;
    if (item.length > TRAIT_MAX_CHARS) return `${label} item is too long (max ${TRAIT_MAX_CHARS} characters)`;
  }
  return null;
}

/**
 * The traits of one character in either shape the app sends: a flat list (trial wizard) or the
 * structured { strengths, flaws, challenges, specialDetails } object (full wizard).
 */
function characterTraitsError(traits) {
  if (traits === undefined || traits === null) return null;
  if (Array.isArray(traits)) return traitListError('traits', traits);
  if (typeof traits !== 'object') return 'traits must be a list or an object';
  return traitListError('traits.strengths', traits.strengths)
    || traitListError('traits.flaws', traits.flaws)
    || traitListError('traits.challenges', traits.challenges)
    || textError('traits.specialDetails', traits.specialDetails);
}

/** The characters array the idea routes read (name, age, gender, traits, special details). */
function characterListError(characters) {
  if (characters === undefined || characters === null) return null;
  if (!Array.isArray(characters)) return 'characters must be a list';
  if (characters.length > CHARACTERS_MAX) return `too many characters (max ${CHARACTERS_MAX})`;
  for (const c of characters) {
    if (!c || typeof c !== 'object') return 'each character must be an object';
    const err = textFieldsError([
      ['character name', c.name], ['character gender', c.gender],
      ['character specialDetails', c.specialDetails], ['character special_details', c.special_details],
    ]) || characterTraitsError(c.traits);
    if (err) return err;
    if (c.age !== undefined && c.age !== null && typeof c.age !== 'number' && typeof c.age !== 'string') return 'character age is invalid';
    if (typeof c.age === 'string' && c.age.length > 20) return 'character age is invalid';
  }
  return null;
}

function relationshipListError(relationships) {
  if (relationships === undefined || relationships === null) return null;
  if (!Array.isArray(relationships)) return 'relationships must be a list';
  if (relationships.length > RELATIONSHIPS_MAX) return `too many relationships (max ${RELATIONSHIPS_MAX})`;
  for (const r of relationships) {
    if (!r || typeof r !== 'object') return 'each relationship must be an object';
    const err = textFieldsError([['relationship', r.relationship], ['relationship character', r.character1], ['relationship character', r.character2]]);
    if (err) return err;
  }
  return null;
}

/** A client-supplied location: an object whose text parts are short. */
function locationError(location) {
  if (location === undefined || location === null) return null;
  if (typeof location !== 'object' || Array.isArray(location)) return 'userLocation must be an object';
  return textFieldsError([['city', location.city, 200], ['country', location.country, 200], ['region', location.region, 200]]);
}

/**
 * A user-supplied photo reference that the server will turn into bytes (r2.bytesFromAnyImage fetches
 * ANY http(s) URL): only data URIs, raw base64 and URLs on OUR R2 bucket are accepted, so the route
 * cannot be pointed at an arbitrary host (code review 2026-10 V5). The shared fetcher stays open
 * because the landmark pipeline fetches Wikimedia URLs through it - the restriction is at the input.
 */
function userImageSourceError(label, value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return `${label} must be an image string`;
  if (/^https?:\/\//i.test(value)) {
    return require('./r2').keyFromPublicUrl(value) ? null : `${label} must be an uploaded image, not an external URL`;
  }
  return null;
}

/**
 * AbortSignal that fires when the client goes away before the response finished. A streaming
 * handler passes it to its paid model calls so a closed tab stops the spend. Uses res 'close'
 * (req 'close' fires when the request BODY has been read, not on disconnect).
 */
function abortOnClientClose(res) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) {
      const err = new Error('client disconnected');
      err.clientAborted = true;
      controller.abort(err);
    }
  });
  return controller.signal;
}

module.exports = {
  FIELD_MAX_CHARS, IDEA_TEXT_MAX_CHARS, TRAITS_MAX_ITEMS, TRAIT_MAX_CHARS, CHARACTERS_MAX, RELATIONSHIPS_MAX,
  textError, textFieldsError, traitListError, characterTraitsError, characterListError,
  relationshipListError, locationError, userImageSourceError, abortOnClientClose,
};

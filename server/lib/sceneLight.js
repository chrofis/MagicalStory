/**
 * SCENE LIGHT — a page's time of day and weather, declared once as two closed
 * enums and read by every stage that writes, paints or judges the light.
 *
 * Owner sign-off 2026-09-24 (reversal of docs/decisions.md 2026-08-11 "prose
 * covers lighting/weather" and 2026-08-15 "rejected for now: a declared
 * time-of-day"). The light lived only in free prose, and three things lost it:
 *   - pages sharing a vantage plate inherited the representative page's light
 *     and weather (prod job_1790107559778_fcmlfa8kn: p2/p4/p5/p6 plates
 *     byte-identical, with rain), and the page prompt told the model to copy the
 *     plate's light;
 *   - `sceneIntent` named no light on 135 of 294 staging pages;
 *   - the visual-flow judge read the hour off the prose with a keyword scan.
 * Pixel sample: 7 of 15 shared-plate pages whose light differed from the
 * representative's rendered the wrong light.
 *
 * Producers: the Art Director (both templates), the iterate rewrite (both
 * templates) and the trial writer emit `timeOfDay` and `weather` in the brief
 * metadata; the scene review keeps them (carryForwardLightInBrief) and checks
 * them. Consumers: the plate grouping and relight derive (storyJobPipeline),
 * the plate prompt and the page prompt (`buildLightLine`, a fixed line in the
 * protected tail), every repair that repaints pixels (`buildRepairLightLine`:
 * the page inpaint, the character repair, the scale repair and the manual
 * repair route), the semantic judge and the visual-flow judge.
 *
 * A brief written before the fields existed declares no light: it gets no
 * LIGHT line, shares its vantage plate as before, and no judge can call its
 * light wrong. Nothing reads the hour out of the prose.
 */

/** In the order a day runs. Adjacent values are neighbours on the clock. */
const TIMES_OF_DAY = ['dawn', 'morning', 'midday', 'afternoon', 'evening', 'dusk', 'night'];

/** `none`: an interior, where the weather is not visible. */
const WEATHERS = ['clear', 'overcast', 'rain', 'snow', 'fog', 'storm', 'none'];

const TIME_OF_DAY_ENUM = TIMES_OF_DAY.join(' | ');
const WEATHER_ENUM = WEATHERS.join(' | ');

/** What the illustrator is told each value means. Generic, positive, terse. */
const TIME_OF_DAY_PHRASES = {
  dawn: 'dawn: the sun just up, low pale light, long soft shadows',
  morning: 'morning: fresh daylight from a low sun',
  midday: 'midday: bright daylight from a high sun, short shadows',
  afternoon: 'afternoon: warm daylight from a sun past its height',
  evening: 'evening: a low golden sun, long shadows',
  dusk: 'dusk: the sun down, a deep blue fading sky, the first lamps lit',
  night: 'night: a dark sky, the scene lit by the moon and by the light sources in it',
};
const WEATHER_PHRASES = {
  clear: 'a clear sky',
  overcast: 'overcast, a grey sky and soft even light',
  rain: 'rain falling, surfaces wet and shining',
  snow: 'snow falling',
  fog: 'fog softening the distance',
  storm: 'a storm: dark clouds, wind, heavy rain',
  none: 'indoors: the light comes from the room\'s own sources and any window',
};

function normaliseEnum(raw, allowed) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return allowed.includes(v) ? v : null;
}

/** 'night' | … | null. An unknown word is not a declaration. */
function normaliseTimeOfDay(raw) { return normaliseEnum(raw, TIMES_OF_DAY); }
/** 'rain' | … | 'none' | null. */
function normaliseWeather(raw) { return normaliseEnum(raw, WEATHERS); }

/**
 * The page's declared light from parsed brief metadata (either the flat keys
 * extractSceneMetadata publishes or its `fullData`).
 * @returns {{timeOfDay: string|null, weather: string|null}}
 */
function declaredLight(metadata) {
  const m = metadata || {};
  const f = m.fullData || {};
  return {
    timeOfDay: normaliseTimeOfDay(m.timeOfDay ?? f.timeOfDay),
    weather: normaliseWeather(m.weather ?? f.weather),
  };
}

/**
 * The light a page's brief DECLARED, from its metadata fields. Nothing is
 * read out of the prose; a brief without the fields declares nothing.
 * @param {string} brief - prose + ---METADATA--- + JSON
 * @returns {{timeOfDay: string|null, weather: string|null}}
 */
function declaredLightOfBrief(brief) {
  const text = String(brief || '');
  if (!text.trim()) return { timeOfDay: null, weather: null };
  const { extractSceneMetadata } = require('./sceneMetadata');
  return declaredLight(extractSceneMetadata(text));
}

/** Grouping key: pages with equal keys can share one plate. `''` = undeclared. */
function lightKey(light) {
  const l = light || {};
  if (!l.timeOfDay && !l.weather) return '';
  return `${l.timeOfDay || '-'}|${l.weather || '-'}`;
}

/** "night, rain" / "evening" — for logs and judge lines. '' when undeclared. */
function describeLight(light) {
  const l = light || {};
  return [l.timeOfDay, l.weather && l.weather !== 'none' ? l.weather : (l.weather === 'none' ? 'indoors' : null)]
    .filter(Boolean).join(', ');
}

/** The light as phrases, '' when undeclared. Shared by every line below. */
function lightPhrase(light) {
  const l = light || {};
  const parts = [];
  if (l.timeOfDay) parts.push(TIME_OF_DAY_PHRASES[l.timeOfDay]);
  if (l.weather) parts.push(WEATHER_PHRASES[l.weather]);
  return parts.join('; ');
}

/**
 * The fixed LIGHT line of a page prompt and a plate prompt. It sits in the
 * protected tail of the page prompt (images.js PROMPT_NEVER_CUT marker
 * `**LIGHT:**`), so no shrink removes it. '' when the page declares no light.
 */
function buildLightLine(light, { plate = false } = {}) {
  const phrase = lightPhrase(light);
  if (!phrase) return '';
  return plate
    ? `**LIGHT:** ${phrase}. Paint the place in this time of day and weather; it wins over any other time or weather named above and over the light of a reference photo.`
    : `**LIGHT:** ${phrase}. This is the page's time of day and weather, and it wins over the light and weather of any reference image.`;
}

/**
 * The LIGHT line of every repair that repaints pixels of a finished page (the
 * inpaint, the character repair, the scale repair, the manual repair route).
 * An edit told only "remove the lamp" repainted a declared night as golden
 * daylight (staging job_1790277448294_5herh01j7 p15, inpaint round 1), because
 * nothing in its prompt said what the light was. '' when the page declares no
 * light — the edit is then told nothing about it, as before.
 */
function buildRepairLightLine(light) {
  const phrase = lightPhrase(light);
  if (!phrase) return '';
  return `**LIGHT:** ${phrase}. This is the page's time of day and weather: the edited image keeps exactly this light, sky and weather, and the edit changes none of them.`;
}

/**
 * The edit instruction that re-lights a base plate for a page whose declared
 * light differs from the one the base plate was painted in. Same place, same
 * camera; only the light, the sky and the weather change.
 */
function buildPlateRelightInstruction(light) {
  const phrase = lightPhrase(light);
  if (!phrase) return null;
  return `This backdrop shows a place. Re-light it for ${phrase}. `
    + 'The camera, the framing, the buildings, walls, roofs, trees, paths and surfaces keep their shape, material, colour and arrangement exactly, and the season stays the same. Only the light, the shadows, the sky and the weather change, and no one is added to it.';
}

/**
 * The sentence the angle derive ends with when the derived plate also takes a
 * different light (shotVocabulary.buildPlateDeriveInstruction).
 */
function relightClause(light) {
  const phrase = lightPhrase(light);
  return phrase ? `The light changes to ${phrase}; nothing else about the place changes with it.` : '';
}

/**
 * ONE rule for the two fields, filled into every template that authors a page
 * brief (both Art Director templates, both iterate templates) and into the
 * scene review's check, so the author and the critic read the same words.
 */
const SCENE_LIGHT_FIELD_RULE = `\`timeOfDay\` is one of ${TIME_OF_DAY_ENUM}, and \`weather\` one of ${WEATHER_ENUM} — \`none\` for an interior, where the weather is not visible. Both are required on every page, agree with the light the prose describes, and follow the book's time: they hold from page to page until the story moves the clock or the sky. They decide the page's light and the light of the plate it is painted on.`;

/**
 * A rewritten brief keeps the declared light of the brief it replaces when it
 * states none itself (the scene review and the iterate rewrite both rewrite
 * whole briefs). A rewrite that states a value wins — it may correct the light.
 *
 * @param {string} newBrief - the rewrite (prose + ---METADATA--- + JSON)
 * @param {string|Object} previous - the brief it replaces, as text, or its
 *   parsed metadata (extractSceneMetadata shape)
 * @returns {{brief: string, carried: string[]}|null} null when nothing carried
 */
function carryForwardLightInBrief(newBrief, previous) {
  const { parseProseMetadataFormat } = require('./sceneMetadata');
  const after = parseProseMetadataFormat(String(newBrief || ''));
  if (!after) return null;
  let prevLight;
  if (typeof previous === 'string') {
    const before = parseProseMetadataFormat(previous);
    if (!before) return null;
    prevLight = declaredLight(before.metadata);
  } else {
    prevLight = declaredLight(previous);
  }
  const metadata = { ...after.metadata };
  const carried = [];
  for (const [field, norm] of [['timeOfDay', normaliseTimeOfDay], ['weather', normaliseWeather]]) {
    if (norm(metadata[field])) continue;
    if (!prevLight[field]) continue;
    metadata[field] = prevLight[field];
    carried.push(field);
  }
  if (carried.length === 0) return null;
  return { brief: `${after.prose}\n\n---METADATA---\n${JSON.stringify(metadata, null, 2)}`, carried };
}

/**
 * Is a rendered hour a contradiction of the declared one? Neighbours on the
 * clock (dawn/morning, evening/dusk, dusk/night) are not — a judge cannot
 * tell them apart reliably and neither can a reader.
 */
function timeContradicts(declared, rendered) {
  const d = TIMES_OF_DAY.indexOf(declared);
  const r = TIMES_OF_DAY.indexOf(rendered);
  if (d < 0 || r < 0) return false;
  return Math.abs(d - r) > 1;
}

module.exports = {
  TIMES_OF_DAY,
  WEATHERS,
  TIME_OF_DAY_ENUM,
  WEATHER_ENUM,
  SCENE_LIGHT_FIELD_RULE,
  normaliseTimeOfDay,
  normaliseWeather,
  declaredLight,
  declaredLightOfBrief,
  lightKey,
  describeLight,
  buildLightLine,
  buildRepairLightLine,
  buildPlateRelightInstruction,
  relightClause,
  carryForwardLightInBrief,
  timeContradicts,
};

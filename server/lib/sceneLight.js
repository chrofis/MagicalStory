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

/**
 * THE LIGHT TABLE: the one place a `timeOfDay` value is defined (owner, 2026-10-06: one table instead of
 * hand-kept copies). Every list that names the values is derived from it: the enum, the phrases, what
 * Jev is told each value means (`jev`), what the visual-flow judge is told (`judge`). A value added
 * here reaches all of them; the parity test (tests/unit/scene-light-table.test.ts) pins that.
 *
 * Seven HOURS, in the order a day runs (adjacent values are neighbours on the clock), each with the
 * phrasing the illustrator is given under an open sky (`open`), under a covered one (`veiled`, weather
 * owns the sky: no sun or moon named) and INDOORS (`indoor`, weather `none`: window light only, no sky,
 * sun or moon; owner, 2026-10-06 bug: an indoor page was told "a deep blue fading sky" and "lit by the
 * moon", essbvehs8 p8 the ship's hold, 6mjcny1c7 p6 a tram).
 *
 * Then the SKYLESS LIGHTS (owner, 2026-10-06, reversing the 2026-09-24 "the light is one of seven hours"
 * line for the pages that have no sky). A page set beneath the water, or in a place no daylight reaches
 * (ink, a cave, a ship's hold), is not at any hour: the hour's sun and sky wording drew staging
 * job_1791267520938_essbvehs8 p5, p7 and p9-p12 at the surface or on dry land with a sky (and ypl33 p9 a
 * bright reef against pitch-black ink). Water has its own variants (sunlit, deep, night, dark: the ink
 * pages p6, p9 of essbvehs8 and p7-p9 of ypl33 are submerged AND pitch dark). They sit outside the clock:
 * the book's hour goes on around them, they name no sun, moon or sky, and their weather is `none`.
 */
const LIGHTS = [
  { id: 'dawn', hour: true, jev: 'dawn', judge: 'dawn',
    open: 'dawn: the sun just up, low pale light, long soft shadows',
    veiled: 'dawn: faint cool early light, the day just beginning',
    indoor: 'dawn: faint cool early light at the windows, the day just beginning' },
  { id: 'morning', hour: true, jev: 'morning', judge: 'morning',
    open: 'morning: fresh daylight from a low sun',
    veiled: 'morning: fresh cool daylight',
    indoor: 'morning: fresh daylight at the windows' },
  { id: 'midday', hour: true, jev: 'midday', judge: 'midday',
    open: 'midday: bright daylight from a high sun, short shadows',
    veiled: 'midday: full daylight, the brightest hour of the day',
    indoor: 'midday: bright daylight at the windows' },
  { id: 'afternoon', hour: true, jev: 'afternoon', judge: 'afternoon',
    open: 'afternoon: warm daylight from a sun past its height',
    veiled: 'afternoon: full daylight, a touch warm',
    indoor: 'afternoon: warm daylight at the windows' },
  { id: 'evening', hour: true, jev: 'evening', judge: 'evening',
    open: 'evening: a low golden sun, long shadows',
    veiled: 'evening: the daylight fading, lit windows beginning to glow',
    indoor: 'evening: the daylight at the windows fading to gold, the lamps beginning to glow' },
  { id: 'dusk', hour: true, jev: 'dusk', judge: 'dusk',
    open: 'dusk: the sun down, a deep blue fading sky, the first lamps lit',
    veiled: 'dusk: dim blue-grey light, the first lamps lit',
    indoor: 'dusk: dim blue-grey light at the windows, the lamps lit' },
  { id: 'night', hour: true, dim: true, jev: 'night', judge: 'night',
    open: 'night: a dark sky, the scene lit by the moon and by the light sources in it',
    veiled: 'night: dark, the scene lit only by the light sources in it',
    indoor: 'night: dark at the windows, the room lit only by its own lamps and fires' },
  // No sun, moon, sky or horizon is named, and the same words hold whatever the weather says.
  { id: 'underwater', hour: false,
    jev: 'underwater: the picture is beneath the surface of the sea or a lake in daylight, sunlit blue-green water',
    judge: 'underwater: beneath the sea in sunlit blue-green water',
    phrase: 'underwater: the whole picture is beneath the sea, blue-green water all around, soft light falling through it from above, drifting particles' },
  { id: 'underwater_deep', hour: false, dim: true,
    jev: 'deep underwater: far below the surface of the sea, dim deep-blue water, only a faint glow reaching down from above',
    judge: 'underwater_deep: deep beneath the sea in dim deep-blue water',
    phrase: 'deep underwater: the whole picture is far beneath the sea, dim deep-blue water all around, only a faint blue glow reaching down from above, the far distance fading into dark blue, drifting particles' },
  { id: 'underwater_night', hour: false, dim: true,
    jev: 'underwater at night: beneath the surface of the sea while it is night above, dark blue water with a faint pale silvery glow from above',
    judge: 'underwater_night: beneath the sea at night in dark blue water with a faint pale glow',
    phrase: 'underwater at night: the whole picture is beneath the sea, dark blue water all around, a faint pale silvery glow falling through it from above, drifting particles' },
  { id: 'underwater_dark', hour: false, dim: true,
    jev: 'dark underwater: beneath the surface in pitch-black water — a cloud of ink, the abyss, the inside of a sunken wreck — no daylight reaches it',
    judge: 'underwater_dark: beneath the sea in pitch-black water, lit only by light sources in it',
    phrase: 'dark underwater: the whole picture is beneath the sea in pitch-black water, nothing reaches it from above, the scene lit only by the light sources in it, drifting particles' },
  { id: 'dark', hour: false, dim: true,
    jev: 'dark: pitch dark, no daylight reaches the place — a cave, a ship\'s hold, a sealed room',
    judge: 'dark: a pitch-dark place with no daylight, lit only by light sources in it',
    phrase: 'dark: a pitch-dark place, the scene lit only by the light sources in it' },
];

/** In the order a day runs. Adjacent values are neighbours on the clock. */
const CLOCK_HOURS = LIGHTS.filter(l => l.hour).map(l => l.id);

/** The lights that are not an hour: no sky, no sun, no moon. */
const SKYLESS_LIGHTS = LIGHTS.filter(l => !l.hour).map(l => l.id);

/** The lights too dim to see by without a light source in the picture: Jev is asked what is lit (jevDecisions.decideLightSources). */
const DIM_LIGHTS = LIGHTS.filter(l => l.dim).map(l => l.id);
function isDimLight(timeOfDay) { return DIM_LIGHTS.includes(timeOfDay); }

/** The `timeOfDay` enum: the seven hours, then the skyless lights. */
const TIMES_OF_DAY = LIGHTS.map(l => l.id);

/** Is this declared value a light with no sky (underwater, dark) rather than an hour? */
function isSkylessLight(timeOfDay) { return SKYLESS_LIGHTS.includes(timeOfDay); }

/** What Jev is told each `timeOfDay` value means: id -> label (jevDecisions.lightQuestions). */
const JEV_TIME_CRITERIA = Object.fromEntries(LIGHTS.map(l => [l.id, l.jev]));

/** What the visual-flow judge is told each skyless bucket means (the hours need no gloss). */
const JUDGE_SKYLESS_NOTES = LIGHTS.filter(l => !l.hour).map(l => l.judge).join('; ');

/**
 * THE WEATHER TABLE: the one place a `weather` value is defined (owner, 2026-10-06, same rule as LIGHTS).
 * Jev's criteria, the phrases, the sky-owning set, the neighbour rule of the visual-flow judge and the
 * plate-QC checks are all derived from it. `sky: 'covers'` weathers OWN the sky (no sun, moon or blue sky;
 * `day`/`dark` phrases, closed by COVERED_SKY_CLAUSE); `sky: 'open'` weathers leave the sky to the hour
 * (`open` phrase). `near`: the weathers a judge cannot tell from this one (a drizzle beside a rain), so a
 * rendered neighbour is never a contradiction (weatherContradicts). `qc`: the plate-QC template key of the
 * extra check this weather gets. `none` is an interior, where the weather is not visible.
 * Jev's answer is advisory (the Art Director's own `weather` stays the field).
 */
const WEATHER_TABLE = [
  { id: 'clear', jev: 'clear sky', sky: 'open', open: 'a clear sky', near: ['windy', 'heat', 'rainbow'] },
  { id: 'overcast', jev: 'overcast, grey clouds', sky: 'covers',
    day: 'overcast: a flat grey cloud-covered sky, soft even light, soft faint shadows',
    dark: 'overcast: a flat dark cloud-covered sky', near: ['fog', 'drizzle'] },
  { id: 'rain', jev: 'rain', sky: 'covers',
    day: 'rain falling from a grey cloud-covered sky, surfaces wet and shining',
    dark: 'rain falling from a dark cloud-covered sky, surfaces wet and shining with the reflected lamplight', near: ['drizzle', 'storm', 'thunder'] },
  { id: 'drizzle', jev: 'drizzle: a fine light rain from a grey sky, surfaces damp', sky: 'covers',
    day: 'a fine drizzle falling from a grey cloud-covered sky, surfaces damp and dull',
    dark: 'a fine drizzle falling from a dark cloud-covered sky, surfaces damp with a few lamp reflections', near: ['rain', 'overcast', 'fog'] },
  { id: 'snow', jev: 'snow', sky: 'covers',
    day: 'snow falling from a pale grey sky',
    dark: 'snow falling from a dark grey sky', near: ['snow-lying'] },
  { id: 'snow-lying', jev: 'snow lying: a dry day with snow on the ground, roofs and branches, none falling', sky: 'open',
    open: 'snow lying thick on the ground, roofs and branches, none falling', qc: 'LIGHT_SNOW_LYING', near: ['snow', 'clear', 'overcast'] },
  { id: 'fog', jev: 'fog or mist', sky: 'covers',
    day: 'fog: the sky a flat pale grey-white, distant forms fading out into the fog, only the nearest things clear, no hard shadows',
    dark: 'fog: the sky a flat dark grey haze, distant forms fading out into it, the lamps glowing with soft halos', qc: 'LIGHT_FOG', near: ['overcast', 'drizzle'] },
  { id: 'storm', jev: 'storm, strong wind', sky: 'covers',
    day: 'a storm: dark clouds filling the sky, wind, heavy rain',
    dark: 'a storm: black clouds filling the sky, wind, heavy rain', near: ['rain', 'thunder', 'windy', 'hail'] },
  { id: 'thunder', jev: 'thunderstorm: black clouds, heavy rain, lightning', sky: 'covers',
    day: 'a thunderstorm: black clouds filling the sky, heavy rain, forked lightning in the distance',
    dark: 'a thunderstorm: black clouds filling the sky, heavy rain, forked lightning lighting the clouds', near: ['storm', 'rain'] },
  { id: 'hail', jev: 'hail: white ice pellets falling from a dark sky', sky: 'covers',
    day: 'hail falling from a dark grey cloud-covered sky, white ice pellets bouncing on the ground',
    dark: 'hail falling from a black cloud-covered sky, white ice pellets bouncing on the ground', near: ['storm', 'rain'] },
  { id: 'windy', jev: 'windy: a dry day with strong wind, things blowing, no rain or snow', sky: 'open',
    open: 'wind: a dry day, clouds streaming across the sky, grass, leaves, hair and cloth blowing the same way', near: ['clear', 'storm', 'overcast'] },
  { id: 'rainbow', jev: 'rainbow: sun with passing showers, a rainbow in the sky', sky: 'open',
    open: 'a rainbow arching across the sky after a shower, the ground still wet, the sun low behind the viewer', near: ['clear', 'rain', 'drizzle'] },
  { id: 'heat', jev: 'heat: a hot dry day, shimmering haze, a pale bleached sky', sky: 'open',
    open: 'heat: a hot dry day, a pale bleached sky, a shimmering haze rising off the ground', near: ['clear', 'windy'] },
  { id: 'none', jev: 'none: the scene is indoors', sky: 'open', open: "indoors: the light comes from the room's own sources and any window", near: [] },
];

const JEV_WEATHER_CRITERIA = Object.fromEntries(WEATHER_TABLE.map(w => [w.id, w.jev]));
const WEATHERS = WEATHER_TABLE.map(w => w.id);

const TIME_OF_DAY_ENUM = TIMES_OF_DAY.join(' | ');
const WEATHER_ENUM = WEATHERS.join(' | ');

/**
 * What the illustrator is told each value means. Generic, positive, terse.
 *
 * WEATHER OWNS THE SKY (owner, 2026-09-26). Time of day sets the brightness,
 * the colour of the light, the shadows and whether the lamps are lit; the
 * weather decides what the sky shows. Each hour therefore has three phrasings:
 * `open`, under a clear (or undeclared) sky, which names the sun or the moon,
 * `veiled`, under a covered one, which names no light source in the sky, and
 * `indoor`, with weather `none`, window light only. The line used to append the
 * weather to the open phrase, so a fog page was told "warm daylight from a sun
 * past its height; fog softening the distance" and Grok painted the sun: fog
 * rendered on 1 of 12 staging fog pages and 0 of 6 night-fog pages
 * (job_1790277448294_5herh01j7). Derived from LIGHTS.
 */
const TIME_OF_DAY_PHRASES = Object.fromEntries(LIGHTS.map(l => [l.id, l.hour
  ? { open: l.open, veiled: l.veiled, indoor: l.indoor }
  : { open: l.phrase, veiled: l.phrase, indoor: l.phrase }]));

/** The hours whose covered sky is dark, not pale. */
const DARK_TIMES = new Set(['dusk', 'night']);

/** Closes every covered-sky phrase: the weather hides every light source above. */
const COVERED_SKY_CLAUSE = 'no sun disc, no moon and no blue sky anywhere in the picture';

/** The weathers that OWN the sky: a phrasing for the light hours and one for the dark hours (DARK_TIMES). Each is closed by COVERED_SKY_CLAUSE. */
const COVERED_WEATHER_PHRASES = Object.fromEntries(WEATHER_TABLE.filter(w => w.sky === 'covers').map(w => [w.id, { day: w.day, dark: w.dark }]));

/** The weathers that leave the sky to the time of day. */
const OPEN_WEATHER_PHRASES = Object.fromEntries(WEATHER_TABLE.filter(w => w.sky === 'open').map(w => [w.id, w.open]));

/** Does this declared weather own the sky? */
function weatherOwnsSky(weather) {
  return Object.prototype.hasOwnProperty.call(COVERED_WEATHER_PHRASES, weather);
}

/**
 * The composition of time × weather: the time part (brightness, colour,
 * shadows, lamps) and the sky part. Either is '' when undeclared.
 * @returns {{time: string, sky: string}}
 */
function lightParts(light) {
  const l = light || {};
  // A skyless light has no sky to describe, whatever weather the brief carries.
  if (isSkylessLight(l.timeOfDay)) return { time: TIME_OF_DAY_PHRASES[l.timeOfDay].open, sky: '' };
  const covered = weatherOwnsSky(l.weather);
  // Indoors (weather `none`) is window light only: no sun, moon or sky is named.
  const variant = l.weather === 'none' ? 'indoor' : (covered ? 'veiled' : 'open');
  const time = l.timeOfDay ? TIME_OF_DAY_PHRASES[l.timeOfDay][variant] : '';
  let sky = '';
  if (covered) {
    sky = `${COVERED_WEATHER_PHRASES[l.weather][DARK_TIMES.has(l.timeOfDay) ? 'dark' : 'day']}; ${COVERED_SKY_CLAUSE}`;
  } else if (l.weather) {
    sky = OPEN_WEATHER_PHRASES[l.weather];
  }
  return { time, sky };
}

function normaliseEnum(raw, allowed) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return allowed.includes(v) ? v : null;
}

/** 'night' | … | null. An unknown word is not a declaration. */
function normaliseTimeOfDay(raw) { return normaliseEnum(raw, TIMES_OF_DAY); }
/** 'rain' | … | 'none' | null. */
function normaliseWeather(raw) { return normaliseEnum(raw, WEATHERS); }

/**
 * THE LIGHT SOURCES of a dark page (owner, 2026-10-06): the names of the cited elements that are lit or
 * glowing in the picture (a lantern, a glow-fish), decided by Jev from the element's cited look
 * (jevDecisions.decideLightSources) and pinned into the brief's `lightSources`. An element's own glow
 * stays a Visual Bible STATE (SETTLED: it is drawn from its state's reference cell); this line only says
 * that this lit element is what the page is lit by. Names, never ids: the line is read by an image model.
 */
function normaliseLightSources(raw) {
  return (Array.isArray(raw) ? raw : []).map(x => String(x == null ? '' : x).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 4);
}

/** The sources as a clause, '' when none. */
function sourcesClause(light) {
  const names = normaliseLightSources((light || {}).sources);
  if (!names.length) return '';
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `the light comes from ${list}, lit and glowing in the picture`;
}

/**
 * The page's declared light from parsed brief metadata (either the flat keys
 * extractSceneMetadata publishes or its `fullData`).
 * @returns {{timeOfDay: string|null, weather: string|null}}
 */
function declaredLight(metadata) {
  const m = metadata || {};
  const f = m.fullData || {};
  const sources = normaliseLightSources(m.lightSources ?? f.lightSources);
  return {
    timeOfDay: normaliseTimeOfDay(m.timeOfDay ?? f.timeOfDay),
    weather: normaliseWeather(m.weather ?? f.weather),
    ...(sources.length ? { sources } : {}),
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
  if (isSkylessLight(l.timeOfDay)) return l.timeOfDay;
  return [l.timeOfDay, l.weather && l.weather !== 'none' ? l.weather : (l.weather === 'none' ? 'indoors' : null)]
    .filter(Boolean).join(', ');
}

/**
 * The light as phrases, '' when undeclared. Shared by every line below. `sources`: the page's own light
 * sources join the PAGE and REPAIR lines only; a plate is the empty place and a derive never carries them.
 */
function lightPhrase(light, { sources = false } = {}) {
  const { time, sky } = lightParts(light);
  return [time, sky, time && sources ? sourcesClause(light) : ''].filter(Boolean).join('; ');
}

/**
 * The light as the judges read it: the labels ("afternoon, fog"), and, when
 * the weather owns the sky, the same sky phrase the illustrator was given — so
 * a sun painted into a fog page is judged against the words that forbade it.
 * A clear or indoor page is judged on its labels alone, as before.
 * '' when undeclared.
 */
function describeLightForJudge(light) {
  const words = describeLight(light);
  if (!words) return '';
  const l = light || {};
  if (isSkylessLight(l.timeOfDay)) return TIME_OF_DAY_PHRASES[l.timeOfDay].open;
  return weatherOwnsSky(l.weather) ? `${words} — ${lightParts(l).sky}` : words;
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
    : `**LIGHT:** ${lightPhrase(light, { sources: true })}. It wins over the light and weather of any reference image.`;
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
  const phrase = lightPhrase(light, { sources: true });
  if (!phrase) return '';
  // A skyless page (underwater, dark) and an interior (weather none) are told nothing about a sky they do not show.
  if (isSkylessLight(light.timeOfDay) || light.weather === 'none') return `**LIGHT:** ${phrase}. This is the page's light: the edited image keeps exactly this light, and the edit changes none of it.`;
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
  if (isSkylessLight(light.timeOfDay)) {
    return `This backdrop shows a place. Re-paint it for ${phrase}. `
      + 'The camera, the framing and the surfaces keep their shape, material, colour and arrangement exactly, and the season stays the same. Only the light and what surrounds the surfaces change, and no one is added to it.';
  }
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
 * The sentence an angle derive ends with when the derived plate keeps the base
 * plate's light: it names that light, weather included. "The light keeps the
 * same direction and time of day" said nothing about the sky, and a derive of
 * a sunny-rendered fog plate stayed sunny.
 */
function keepLightClause(light) {
  const phrase = lightPhrase(light);
  if (phrase && isSkylessLight((light || {}).timeOfDay)) return `The picture is painted in this light: ${phrase}.`;
  return phrase ? `The picture is painted in this light, sky and weather: ${phrase}.` : '';
}

/**
 * ONE rule for the two fields, filled into every template that authors a page
 * brief (both Art Director templates, both iterate templates) and into the
 * scene review's check, so the author and the critic read the same words.
 */
const SKYLESS_LIGHT_RULE = `The skyless lights are \`underwater\` (sunlit water), \`underwater_deep\`, \`underwater_night\`, \`underwater_dark\` (pitch-black water: ink, the abyss) and \`dark\` (a place no daylight reaches: a cave, a ship's hold); each takes weather \`none\`, names no sun, moon, sky or horizon in the prose, and the book's hour goes on around it.`;

const SCENE_LIGHT_FIELD_RULE = `\`timeOfDay\` is one of ${TIME_OF_DAY_ENUM}, and \`weather\` one of ${WEATHER_ENUM} — \`none\` for an interior, where the weather is not visible. Both are required on every page, agree with the light the prose describes, and follow the book's time: they hold from page to page until the story moves the clock or the sky. ${SKYLESS_LIGHT_RULE} They decide the page's light and the light of the plate it is painted on.`;

/**
 * The light fields as the page-brief call states them when the decision layer
 * fixed the page (owner, 2026-10-05): code writes a story page's `timeOfDay` (and
 * pins `weather` `none` indoors) from the FIXED block, but `weather` stays the
 * Art Director's on EVERY page, `none` indoors. Lab #1636 showed that "write it
 * outdoors only, leave it out indoors" made the model leave it out everywhere
 * (21 of 21 briefs `light_undeclared`). One source with SCENE_LIGHT_FIELD_RULE:
 * the same enums and the same "holds until the story moves the sky" clause.
 */
const SCENE_WEATHER_FIELD_RULE = `\`weather\` is one of ${WEATHER_ENUM} — \`none\` for an interior, where the weather is not visible. It is required on every page, agrees with the light the prose describes, and holds from page to page until the story moves the sky. A page's \`timeOfDay\` is code's, from its FIXED block, and a cover's \`weather\` is code's too. ${SKYLESS_LIGHT_RULE}`;

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
  // A skyless light is contradicted by a daylight read (a bright reef or a lit shore for a dark or
  // underwater page; a bright day for a dark one) and by nothing else: a judge cannot tell dark water
  // from night, and ink from a hold.
  if (isSkylessLight(declared) || isSkylessLight(rendered)) {
    const other = isSkylessLight(declared) ? rendered : declared;
    return ['morning', 'midday', 'afternoon'].includes(other);
  }
  const d = TIMES_OF_DAY.indexOf(declared);
  const r = TIMES_OF_DAY.indexOf(rendered);
  if (d < 0 || r < 0) return false;
  return Math.abs(d - r) > 1;
}

/**
 * Is a rendered weather a contradiction of the declared one? A neighbour in the table (a drizzle beside
 * a rain, snow falling beside snow lying) is not: a judge cannot tell them apart reliably and neither can
 * a reader. An interior declares no sky; `indoor` and `none` contradict nothing.
 */
function weatherContradicts(declared, rendered) {
  if (!declared || !rendered || declared === 'none' || declared === rendered || rendered === 'indoor') return false;
  const row = WEATHER_TABLE.find(w => w.id === declared);
  if (!row) return false;
  const back = WEATHER_TABLE.find(w => w.id === rendered);
  return !(row.near.includes(rendered) || (back && back.near.includes(declared)));
}

/** The plate-QC template key of the extra check a declared weather gets, or null. */
function weatherQcCheck(weather) {
  const row = WEATHER_TABLE.find(w => w.id === weather);
  return (row && row.qc) || null;
}

module.exports = {
  WEATHER_TABLE,
  weatherContradicts,
  weatherQcCheck,
  LIGHTS,
  JEV_TIME_CRITERIA,
  JEV_WEATHER_CRITERIA,
  JUDGE_SKYLESS_NOTES,
  CLOCK_HOURS,
  SKYLESS_LIGHTS,
  SKYLESS_LIGHT_RULE,
  isSkylessLight,
  isDimLight,
  TIMES_OF_DAY,
  WEATHERS,
  TIME_OF_DAY_ENUM,
  WEATHER_ENUM,
  SCENE_LIGHT_FIELD_RULE,
  SCENE_WEATHER_FIELD_RULE,
  normaliseTimeOfDay,
  normaliseWeather,
  normaliseLightSources,
  declaredLight,
  declaredLightOfBrief,
  lightKey,
  describeLight,
  describeLightForJudge,
  lightPhrase,
  weatherOwnsSky,
  COVERED_SKY_CLAUSE,
  buildLightLine,
  buildRepairLightLine,
  buildPlateRelightInstruction,
  relightClause,
  keepLightClause,
  carryForwardLightInBrief,
  timeContradicts,
};

// server/config/storyThemes.js
//
// The adventure themes (client/src/constants/storyTypes.ts) are chosen by ID.
// An ID is a lookup key, never English prose: `farm`, `space`, `mothers-day`
// and `ocean` all read as nonsense the moment a prompt drops the raw value into
// a sentence ("The child plays at being a farm", "…being a mothers-day",
// "…being a ocean" — a broken article on top).
//
// Two things are needed to write that sentence correctly, and they are both
// here so no prompt site has to reinvent either:
//
//  1. WHAT KIND of thing the theme is. The sentence assumed every theme is a
//     role a child can pretend to be. A third of them are not: `farm`, `space`,
//     `ocean`, `forest`, `jungle`, `roman`, `caveman` are PLACES or eras, and
//     `christmas`, `mothers-day`, `fathers-day` are OCCASIONS. A display name
//     does not fix that — "plays at being a Farm Life" is still wrong.
//  2. A ready-to-embed English NOUN PHRASE with its article already correct.
//     The idea prompt is written in English (the output language is carried by
//     the language instruction, not by this sentence), so one phrase per theme
//     is enough and there is no per-language table to keep in step.
//
// The sentence itself is built by `buildThemePlaySentence` so every consumer
// emits a byte-identical string: hand-kept copies of one sentence across the
// trial route and its Test Lab mirror are exactly what let the raw ID ship.
// Adding a theme to storyTypes.ts means adding it here; an unknown ID falls
// back to a QUOTED form, which is grammatical whatever the value turns out to
// be (this also covers `custom`, whose value is the visitor's own free text).

/** @typedef {'role'|'place'|'occasion'} ThemeKind */

/**
 * themeId -> [kind, English noun phrase with its article].
 * The phrase is written to slot into the sentence for its own kind — a role
 * reads after "plays at being", a place after "takes them to", an occasion
 * after "happens around".
 */
const THEME_PLAY = {
  // Roles — someone a child can pretend to BE
  pirate: ['role', 'a pirate'],
  knight: ['role', 'a knight'],
  princess: ['role', 'a princess'],
  cowboy: ['role', 'a cowboy'],
  ninja: ['role', 'a ninja'],
  viking: ['role', 'a viking'],
  samurai: ['role', 'a samurai'],
  wizard: ['role', 'a wizard'],
  mermaid: ['role', 'a mermaid'],
  superhero: ['role', 'a superhero'],
  detective: ['role', 'a detective'],
  fireman: ['role', 'a firefighter'],
  doctor: ['role', 'a doctor'],
  police: ['role', 'a police officer'],

  // Places and eras — somewhere the make-believe GOES
  roman: ['place', 'ancient Rome'],
  egyptian: ['place', 'ancient Egypt'],
  greek: ['place', 'ancient Greece'],
  caveman: ['place', 'the Stone Age'],
  dragon: ['place', 'a land of dragons'],
  unicorn: ['place', 'a world of magical unicorns'],
  dinosaur: ['place', 'a world of dinosaurs'],
  space: ['place', 'outer space'],
  ocean: ['place', 'the deep ocean'],
  jungle: ['place', 'the jungle'],
  farm: ['place', 'a farm'],
  forest: ['place', 'the forest'],

  // Occasions — a day the story sits ON, not a game
  christmas: ['occasion', 'Christmas'],
  newyear: ['occasion', 'New Year'],
  easter: ['occasion', 'Easter'],
  halloween: ['occasion', 'Halloween'],
  'mothers-day': ['occasion', "Mother's Day"],
  'fathers-day': ['occasion', "Father's Day"],
};

/**
 * One sentence per KIND. No theme is named in the template — the phrase is the
 * only thing that varies, so a new theme never needs new prompt text.
 */
const THEME_PLAY_SENTENCE = {
  role: (phrase) => `The child plays at being ${phrase}; that play is where the struggle happens.`,
  place: (phrase) => `The child's make-believe takes them to ${phrase}; that play is where the struggle happens.`,
  occasion: (phrase) => `The story happens around ${phrase}; that occasion is where the struggle happens.`,
};

/**
 * Which of the three kinds a theme ID is, or null when it is not a make-believe
 * wrapper at all (missing, empty, or the explicit `realistic` setting).
 * @param {string} themeId
 * @returns {ThemeKind|null}
 */
function themeKind(themeId) {
  const id = String(themeId || '').trim();
  if (!id || id === 'realistic') return null;
  return THEME_PLAY[id]?.[0] || null;
}

/**
 * The life-skill idea prompt's one line about the make-believe wrapper.
 * Returns '' for no wrapper (empty / `realistic`) so callers can concatenate it
 * unconditionally.
 * @param {string} themeId a storyTypes.ts adventure theme ID
 * @returns {string} a grammatical English sentence, or ''
 */
function buildThemePlaySentence(themeId) {
  const id = String(themeId || '').trim();
  if (!id || id === 'realistic') return '';
  const entry = THEME_PLAY[id];
  // Unknown ID (a new theme, or `custom`'s free text): quoting sidesteps both
  // the article and the kind, and never emits "a mothers-day".
  if (!entry) return `The story's make-believe is "${id}"; that play is where the struggle happens.`;
  return THEME_PLAY_SENTENCE[entry[0]](entry[1]);
}

module.exports = { THEME_PLAY, THEME_PLAY_SENTENCE, themeKind, buildThemePlaySentence };

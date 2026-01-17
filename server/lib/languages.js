/**
 * Centralized Language Configuration
 *
 * All language-specific instructions are defined here.
 * To add a new language, simply add it to LANGUAGES object.
 */

const LANGUAGES = {
  // ============================================================================
  // GERMAN VARIANTS
  // ============================================================================

  'de-de': {
    code: 'de-de',
    name: 'Deutsch (Standard)',
    nameEnglish: 'German (Standard)',
    instruction: 'You MUST write your response in German. Use standard German spelling (Hochdeutsch). CRITICAL RULES: (1) Use ä, ö, ü - NEVER ae, oe, ue. (2) Use "ß" after long vowels and diphthongs, "ss" after short vowels. (3) Use Präteritum for narrative prose, Perfekt in dialogue. (4) Standard vocabulary throughout. CORRECT: "größer", "süß", "er lief", "der Junge", "die Mütze", "der Eimer", "im Januar", "die Tomate", "gucken", "die Treppe" | WRONG: "groesser", "grösser", "der Bub", "die Kappe", "der Kübel".',
    note: '(Standard German: ß after long vowels, ss after short. Präteritum in narrative. CORRECT: "größer", "süß", "er lief" | WRONG: "grösser", "der Bub")'
  },

  'de-de-north': {
    code: 'de-de-north',
    name: 'Deutsch (Nord)',
    nameEnglish: 'German (North)',
    instruction: 'You MUST write your response in German. Use standard German spelling. CRITICAL RULES: (1) Use ä, ö, ü - NEVER ae, oe, ue. (2) Use "ß" after long vowels and diphthongs, "ss" after short vowels. (3) Strongly prefer Präteritum even in dialogue. (4) Use northern vocabulary: "Junge" (not "Bub"), "Mütze" (not "Kappe"), "Eimer" (not "Kübel"), "gucken/kucken" (not "schauen"), "Treppe" (not "Stiege"), "Januar", "dieses Jahr", "Tomate". (5) Crisper, more understated tone. CORRECT: "er lief", "er rief", "der Junge", "die Mütze", "gucken" | WRONG: "er ist gelaufen", "der Bub", "die Kappe", "schauen", "heuer", "grösser".',
    note: '(Northern German: Präteritum preferred. "Junge", "Mütze", "gucken". CORRECT: "er lief", "der Junge" | WRONG: "der Bub", "schauen")'
  },

  'de-de-south': {
    code: 'de-de-south',
    name: 'Deutsch (Süd)',
    nameEnglish: 'German (South)',
    instruction: 'You MUST write your response in German. Use standard German spelling. CRITICAL RULES: (1) Use ä, ö, ü - NEVER ae, oe, ue. (2) Use "ß" after long vowels and diphthongs, "ss" after short vowels. (3) Prefer Perfekt in dialogue, Präteritum acceptable in narrative. (4) Use southern vocabulary: "Bub" (not "Junge"), "Kappe" (not "Mütze"), "schauen" (not "gucken"), may use "Stiege" alongside "Treppe", "heuer" for "dieses Jahr". (5) Warmer, softer tone. CORRECT: "er hat gelacht", "der Bub", "die Kappe", "schauen", "heuer" | WRONG: "grösser", "der Junge", "gucken", "Jänner", "Paradeiser".',
    note: '(Southern German: Perfekt in dialogue. "Bub", "Kappe", "schauen", "heuer". CORRECT: "der Bub", "schauen" | WRONG: "grösser", "Jänner")'
  },

  'de-at': {
    code: 'de-at',
    name: 'Deutsch (Österreich)',
    nameEnglish: 'Austrian German',
    instruction: 'You MUST write your response in German. Use Austrian German spelling and vocabulary. CRITICAL RULES: (1) Use ä, ö, ü - NEVER ae, oe, ue. (2) Use "ß" after long vowels and diphthongs, "ss" after short vowels. (3) Strongly prefer Perfekt for all past tense, including narrative. (4) Use Austrian vocabulary: "Bub" (not "Junge"), "Kappe" (not "Mütze"), "Kübel" (not "Eimer"), "Stiege" (not "Treppe"), "schauen" (not "gucken"), "Jänner" (not "Januar"), "Feber" (not "Februar"), "heuer" (not "dieses Jahr"), "Paradeiser" (not "Tomate"), "Erdapfel" (not "Kartoffel"), "Sackerl" (not "Tüte"), "Sessel" (not "Stuhl"). CORRECT: "er ist gelaufen", "im Jänner", "der Bub", "die Stiege", "heuer", "das Sackerl" | WRONG: "er lief", "im Januar", "der Junge", "die Treppe", "die Tüte", "grösser".',
    note: '(Austrian German: Perfekt preferred. "Bub", "Jänner", "Paradeiser", "Sackerl". CORRECT: "er ist gelaufen", "im Jänner" | WRONG: "er lief", "grösser")'
  },

  'de-ch': {
    code: 'de-ch',
    name: 'Deutsch (Schweiz)',
    nameEnglish: 'Swiss German',
    instruction: 'You MUST write your response in German. Use Swiss Standard German spelling and vocabulary. CRITICAL RULES: (1) Use ä, ö, ü - NEVER ae, oe, ue. (2) NEVER use "ß", always use "ss" instead. (3) Prefer Perfekt for all past tense, including narrative. (4) Use Swiss vocabulary: "Bub" (not "Junge"), "Kappe" (not "Mütze"), "Rüebli" (not "Karotte"), "Velo" (not "Fahrrad"), "parkieren" (not "parken"), "grillieren" (not "grillen"), "Trottoir" (not "Bürgersteig"), "Lavabo" (not "Waschbecken"), "Natel" (not "Handy"), "Poulet" (not "Hähnchen"), "Glace" (not "Eis"), "Znüni/Zvieri" for snacks. (5) More formal register, no contractions. CORRECT: "grösser", "süss", "er ist gelaufen", "das Velo", "das Rüebli", "parkieren", "das Poulet" | WRONG: "größer", "süß", "er lief", "das Fahrrad", "die Karotte", "parken", "das Hähnchen".',
    note: '(Swiss German: NEVER ß, always ss. Perfekt preferred. "Velo", "Rüebli", "Poulet". CORRECT: "grösser", "süss" | WRONG: "größer", "süß")'
  },

  'de-it': {
    code: 'de-it',
    name: 'Deutsch (Südtirol)',
    nameEnglish: 'South Tyrolean German',
    instruction: 'You MUST write your response in German. Use South Tyrolean German spelling and vocabulary. CRITICAL RULES: (1) Use ä, ö, ü - NEVER ae, oe, ue. (2) Use "ß" after long vowels and diphthongs like Austrian standard. (3) Strongly prefer Perfekt for all past tense. (4) Use Austrian vocabulary as base: "Bub", "Kappe", "Kübel", "Stiege", "schauen", "Jänner", "heuer", "Paradeiser". (5) May include Italian-influenced words: "Ciao" for greetings, "Bar" (not "Café"), "Matura" (not "Abitur"). (6) Warmer, melodic tone similar to Austrian. CORRECT: "er ist gegangen", "der Bub", "die Kappe", "im Jänner", "heuer", "Ciao" | WRONG: "er ging", "der Junge", "die Mütze", "im Januar", "grösser", "dieses Jahr".',
    note: '(South Tyrolean: Austrian base + Italian influence. Perfekt preferred. "Bub", "Jänner", "Ciao". CORRECT: "er ist gegangen" | WRONG: "er ging", "grösser")'
  },

  // Legacy 'de' maps to Standard German for backwards compatibility
  'de': {
    code: 'de-de',
    name: 'Deutsch (Standard)',
    nameEnglish: 'German (Standard)',
    instruction: 'You MUST write your response in German. Use standard German spelling (Hochdeutsch). CRITICAL RULES: (1) Use ä, ö, ü - NEVER ae, oe, ue. (2) Use "ß" after long vowels and diphthongs, "ss" after short vowels. (3) Use Präteritum for narrative prose, Perfekt in dialogue. (4) Standard vocabulary throughout. CORRECT: "größer", "süß", "er lief", "der Junge", "die Mütze", "der Eimer", "im Januar", "die Tomate", "gucken", "die Treppe" | WRONG: "groesser", "grösser", "der Bub", "die Kappe", "der Kübel".',
    note: '(Standard German: ß after long vowels, ss after short. Präteritum in narrative. CORRECT: "größer", "süß", "er lief" | WRONG: "grösser", "der Bub")'
  },

  // ============================================================================
  // FRENCH VARIANTS
  // ============================================================================

  'fr-fr': {
    code: 'fr-fr',
    name: 'Français (France)',
    nameEnglish: 'French (France)',
    instruction: 'You MUST write your response in French. Use standard metropolitan French. CRITICAL RULES: (1) Use "soixante-dix" (70), "quatre-vingts" (80), "quatre-vingt-dix" (90). (2) Meal names: "petit-déjeuner" (breakfast), "déjeuner" (lunch), "dîner" (dinner). (3) Use standard vocabulary: "voiture" (car), "portable" (mobile phone), "week-end", "e-mail", "parking", "shopping". (4) Informal "tu" common among peers. CORRECT: "soixante-dix", "le petit-déjeuner", "le portable", "le week-end", "faire du shopping" | WRONG: "septante", "le déjeuner" for breakfast, "le natel", "la fin de semaine", "magasiner".',
    note: '(French France: soixante-dix/quatre-vingt-dix. "petit-déjeuner/déjeuner/dîner". CORRECT: "le portable", "le week-end" | WRONG: "septante", "le natel")'
  },

  'fr-ch': {
    code: 'fr-ch',
    name: 'Français (Suisse)',
    nameEnglish: 'French (Switzerland)',
    instruction: 'You MUST write your response in French. Use Swiss French vocabulary and expressions. CRITICAL RULES: (1) Use "septante" (70), "huitante" (80, in Vaud) or "quatre-vingts" (elsewhere), "nonante" (90). (2) Meal names: "déjeuner" (breakfast), "dîner" (lunch), "souper" (dinner). (3) Use Swiss vocabulary: "Natel" (not "portable"), "action" (special offer), "cornet" (plastic bag), "poutser" (to clean), "fourrer" (to put/stuff), "bancomat" (ATM), "course d\'école" (school trip), "régie" (property management). (4) More formal register, prefer "vous". CORRECT: "septante", "nonante", "le souper", "le Natel", "un cornet", "une action" | WRONG: "soixante-dix", "quatre-vingt-dix", "le dîner" for dinner, "le portable", "un sac plastique", "une promo".',
    note: '(Swiss French: septante/nonante. "déjeuner/dîner/souper". "Natel", "cornet". CORRECT: "septante", "le Natel" | WRONG: "soixante-dix", "le portable")'
  },

  'fr-be': {
    code: 'fr-be',
    name: 'Français (Belgique)',
    nameEnglish: 'French (Belgium)',
    instruction: 'You MUST write your response in French. Use Belgian French vocabulary and expressions. CRITICAL RULES: (1) Use "septante" (70), "quatre-vingts" (80), "nonante" (90). (2) Meal names: "déjeuner" (breakfast), "dîner" (lunch), "souper" (dinner). (3) Use Belgian vocabulary: "GSM" (not "portable"), "aubette" (bus shelter), "drache" (heavy rain), "kot" (student room), "sacoche" (bag), "pistolet" (bread roll), "praline" (chocolate), "torchon" (floor cloth), "savoir" used as "pouvoir" in some contexts ("tu sais me dire...?"). (4) Flemish influences in vocabulary. CORRECT: "septante", "nonante", "le souper", "le GSM", "une drache", "une aubette", "il drache" | WRONG: "soixante-dix", "quatre-vingt-dix", "le dîner" for dinner, "le portable", "une averse", "un abribus".',
    note: '(Belgian French: septante/nonante. "déjeuner/dîner/souper". "GSM", "drache". CORRECT: "septante", "il drache" | WRONG: "soixante-dix", "le portable")'
  },

  'fr-ca': {
    code: 'fr-ca',
    name: 'Français (Québec)',
    nameEnglish: 'French (Quebec)',
    instruction: 'You MUST write your response in French. Use Quebec French vocabulary and expressions. CRITICAL RULES: (1) Use "soixante-dix" (70), "quatre-vingts" (80), "quatre-vingt-dix" (90) like France. (2) Meal names: "déjeuner" (breakfast), "dîner" (lunch), "souper" (dinner). (3) Avoid anglicisms, use Quebec terms: "fin de semaine" (not "week-end"), "courriel" (not "e-mail"), "stationnement" (not "parking"), "magasiner" (not "faire du shopping"), "char" (car, informal), "blonde/chum" (girlfriend/boyfriend), "bienvenue" (you\'re welcome), "dépanneur" (corner store), "tuque" (winter hat), "pogner" (to grab/catch). (4) More informal "tu" usage. CORRECT: "la fin de semaine", "le courriel", "magasiner", "bienvenue", "le dépanneur", "une tuque" | WRONG: "le week-end", "l\'e-mail", "faire du shopping", "de rien", "l\'épicerie du coin", "un bonnet".',
    note: '(Quebec French: soixante-dix but "fin de semaine", "courriel", "magasiner". CORRECT: "la fin de semaine", "bienvenue" | WRONG: "le week-end", "de rien")'
  },

  'fr-af': {
    code: 'fr-af',
    name: 'Français (Afrique)',
    nameEnglish: 'French (African)',
    instruction: 'You MUST write your response in French. Use African French based on French (France) with local adaptations. CRITICAL RULES: (1) Use "soixante-dix", "quatre-vingts", "quatre-vingt-dix". (2) More formal register overall. (3) Common vocabulary additions: "essencerie" (petrol station), "présentement" (currently), "être fatigué de" (to be sick of), "gérer" used broadly, "ça va aller" (it will be fine). (4) Often preserves older French expressions. (5) Direct, clear sentence structure preferred. (6) Avoid overly casual French slang from France. CORRECT: "soixante-dix", "présentement", "l\'essencerie", "ça va aller" | WRONG: "septante", "actuellement" (when meaning "now"), "la station-service" (acceptable but less common), French verlan slang.',
    note: '(African French: Based on France French. "présentement", "essencerie". CORRECT: "soixante-dix", "présentement" | WRONG: "septante", verlan slang)'
  },

  // Legacy 'fr' maps to Swiss French for backwards compatibility (Swiss is our primary market)
  'fr': {
    code: 'fr-ch',
    name: 'Français (Suisse)',
    nameEnglish: 'French (Switzerland)',
    instruction: 'You MUST write your response in French. Use Swiss French vocabulary and expressions. CRITICAL RULES: (1) Use "septante" (70), "huitante" (80, in Vaud) or "quatre-vingts" (elsewhere), "nonante" (90). (2) Meal names: "déjeuner" (breakfast), "dîner" (lunch), "souper" (dinner). (3) Use Swiss vocabulary: "Natel" (not "portable"), "action" (special offer), "cornet" (plastic bag), "poutser" (to clean), "fourrer" (to put/stuff), "bancomat" (ATM), "course d\'école" (school trip), "régie" (property management). (4) More formal register, prefer "vous". CORRECT: "septante", "nonante", "le souper", "le Natel", "un cornet", "une action" | WRONG: "soixante-dix", "quatre-vingt-dix", "le dîner" for dinner, "le portable", "un sac plastique", "une promo".',
    note: '(Swiss French: septante/nonante. "déjeuner/dîner/souper". "Natel", "cornet". CORRECT: "septante", "le Natel" | WRONG: "soixante-dix", "le portable")'
  },

  // ============================================================================
  // OTHER LANGUAGES
  // ============================================================================

  'en': {
    code: 'en',
    name: 'English',
    nameEnglish: 'English',
    instruction: 'You MUST write your response in English. Use standard English spelling and grammar.',
    note: ''
  }
};

/**
 * Get full language instruction for a language code
 * @param {string} langCode - German: 'de-ch', 'de-de', 'de-at', 'de-it', 'de-de-north', 'de-de-south', 'de' | French: 'fr-fr', 'fr-ch', 'fr-be', 'fr-ca', 'fr-af', 'fr' | 'en'
 * @returns {string} Full instruction for AI
 */
function getLanguageInstruction(langCode) {
  const lang = LANGUAGES[langCode] || LANGUAGES.en;
  return lang.instruction;
}

/**
 * Get short language note (for prompts that already specify language)
 * @param {string} langCode
 * @returns {string} Short note with spelling rules
 */
function getLanguageNote(langCode) {
  const lang = LANGUAGES[langCode] || LANGUAGES.en;
  return lang.note;
}

/**
 * Get language name in that language
 * @param {string} langCode
 * @returns {string} e.g., 'Deutsch (Schweiz)', 'Français', 'English'
 */
function getLanguageName(langCode) {
  const lang = LANGUAGES[langCode] || LANGUAGES.en;
  return lang.name;
}

/**
 * Get language name in English
 * @param {string} langCode
 * @returns {string} e.g., 'German (Switzerland)', 'French', 'English'
 */
function getLanguageNameEnglish(langCode) {
  const lang = LANGUAGES[langCode] || LANGUAGES.en;
  return lang.nameEnglish;
}

/**
 * Get list of available languages for UI
 * @returns {Array} List of {code, name, nameEnglish}
 */
function getAvailableLanguages() {
  return [
    // German variants
    { code: 'de-de', name: 'Deutsch (Standard)', nameEnglish: 'German (Standard)' },
    { code: 'de-de-north', name: 'Norddeutsch', nameEnglish: 'German (North)' },
    { code: 'de-de-south', name: 'Süddeutsch', nameEnglish: 'German (South)' },
    { code: 'de-at', name: 'Deutsch (Österreich)', nameEnglish: 'Austrian German' },
    { code: 'de-ch', name: 'Deutsch (Schweiz)', nameEnglish: 'Swiss German' },
    { code: 'de-it', name: 'Deutsch (Südtirol)', nameEnglish: 'South Tyrolean German' },
    // French variants
    { code: 'fr-fr', name: 'Français (France)', nameEnglish: 'French (France)' },
    { code: 'fr-ch', name: 'Français (Suisse)', nameEnglish: 'French (Switzerland)' },
    { code: 'fr-be', name: 'Français (Belgique)', nameEnglish: 'French (Belgium)' },
    { code: 'fr-ca', name: 'Français (Québec)', nameEnglish: 'French (Quebec)' },
    { code: 'fr-af', name: 'Français (Afrique)', nameEnglish: 'French (African)' },
    // English
    { code: 'en', name: 'English', nameEnglish: 'English' }
  ];
}

module.exports = {
  LANGUAGES,
  getLanguageInstruction,
  getLanguageNote,
  getLanguageName,
  getLanguageNameEnglish,
  getAvailableLanguages
};

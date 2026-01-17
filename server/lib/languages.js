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
  // OTHER LANGUAGES
  // ============================================================================

  'fr': {
    code: 'fr',
    name: 'Français',
    nameEnglish: 'French',
    instruction: 'You MUST write your response in French. Use standard French spelling and grammar. Use passé simple for literary/narrative prose, passé composé in dialogue.',
    note: ''
  },

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
 * @param {string} langCode - 'de-ch', 'de-de', 'de-at', 'de-it', 'de-de-north', 'de-de-south', 'de', 'fr', 'en'
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
    { code: 'de-de', name: 'Deutsch (Standard)', nameEnglish: 'German (Standard)' },
    { code: 'de-de-north', name: 'Deutsch (Nord)', nameEnglish: 'German (North)' },
    { code: 'de-de-south', name: 'Deutsch (Süd)', nameEnglish: 'German (South)' },
    { code: 'de-at', name: 'Deutsch (Österreich)', nameEnglish: 'Austrian German' },
    { code: 'de-ch', name: 'Deutsch (Schweiz)', nameEnglish: 'Swiss German' },
    { code: 'de-it', name: 'Deutsch (Südtirol)', nameEnglish: 'South Tyrolean German' },
    { code: 'fr', name: 'Français', nameEnglish: 'French' },
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

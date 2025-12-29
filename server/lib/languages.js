/**
 * Centralized Language Configuration
 * 
 * All language-specific instructions are defined here.
 * To add a new language, simply add it to LANGUAGES object.
 */

const LANGUAGES = {
  'de-ch': {
    code: 'de-ch',
    name: 'Deutsch (Schweiz)',
    nameEnglish: 'German (Switzerland)',
    // Swiss Standard German spelling rules
    instruction: 'You MUST write your response in German. Use Swiss Standard German spelling (Schweizer Hochdeutsch). CRITICAL SPELLING RULES: (1) Use ä, ö, ü - NEVER ae, oe, ue. (2) Use "ss" instead of "ß". Examples: CORRECT: "grösser", "süss" | WRONG: "größer", "groesser", "süß", "suess". Use standard German vocabulary, not Swiss dialect.',
    note: '(Swiss Standard German: Use ä, ö, ü - NEVER ae, oe, ue. Use "ss" instead of "ß". CORRECT: "grösser", "süss" | WRONG: "größer", "groesser", "süß", "suess")'
  },
  'de-de': {
    code: 'de-de',
    name: 'Deutsch (Deutschland)',
    nameEnglish: 'German (Germany)',
    // Standard German spelling rules
    instruction: 'You MUST write your response in German. Use standard German spelling (Hochdeutsch). CRITICAL SPELLING RULES: (1) Use ä, ö, ü - NEVER ae, oe, ue. (2) Use "ß" correctly (after long vowels: "größer", "Straße"; use "ss" after short vowels: "müssen", "dass"). Examples: CORRECT: "größer", "süß", "Straße" | WRONG: "groesser", "suess", "Strasse".',
    note: '(Standard German: Use ä, ö, ü - NEVER ae, oe, ue. Use "ß" after long vowels, "ss" after short vowels. CORRECT: "größer", "süß" | WRONG: "groesser", "suess")'
  },
  // Legacy 'de' maps to Swiss German for backwards compatibility
  'de': {
    code: 'de-ch',
    name: 'Deutsch (Schweiz)',
    nameEnglish: 'German (Switzerland)',
    instruction: 'You MUST write your response in German. Use Swiss Standard German spelling (Schweizer Hochdeutsch). CRITICAL SPELLING RULES: (1) Use ä, ö, ü - NEVER ae, oe, ue. (2) Use "ss" instead of "ß". Examples: CORRECT: "grösser", "süss" | WRONG: "größer", "groesser", "süß", "suess". Use standard German vocabulary, not Swiss dialect.',
    note: '(Swiss Standard German: Use ä, ö, ü - NEVER ae, oe, ue. Use "ss" instead of "ß". CORRECT: "grösser", "süss" | WRONG: "größer", "groesser", "süß", "suess")'
  },
  'fr': {
    code: 'fr',
    name: 'Français',
    nameEnglish: 'French',
    instruction: 'You MUST write your response in French.',
    note: ''
  },
  'en': {
    code: 'en',
    name: 'English',
    nameEnglish: 'English',
    instruction: 'You MUST write your response in English.',
    note: ''
  }
};

/**
 * Get full language instruction for a language code
 * @param {string} langCode - 'de-ch', 'de-de', 'de', 'fr', 'en'
 * @returns {string} Full instruction for AI
 */
function getLanguageInstruction(langCode) {
  const lang = LANGUAGES[langCode] || LANGUAGES.en;
  return lang.instruction;
}

/**
 * Get short language note (for prompts that already specify language)
 * @param {string} langCode - 'de-ch', 'de-de', 'de', 'fr', 'en'
 * @returns {string} Short note with spelling rules
 */
function getLanguageNote(langCode) {
  const lang = LANGUAGES[langCode] || LANGUAGES.en;
  return lang.note;
}

/**
 * Get language name in that language
 * @param {string} langCode - 'de-ch', 'de-de', 'de', 'fr', 'en'
 * @returns {string} e.g., 'Deutsch (Schweiz)', 'Français', 'English'
 */
function getLanguageName(langCode) {
  const lang = LANGUAGES[langCode] || LANGUAGES.en;
  return lang.name;
}

/**
 * Get language name in English
 * @param {string} langCode - 'de-ch', 'de-de', 'de', 'fr', 'en'
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
    { code: 'de-ch', name: 'Deutsch (Schweiz)', nameEnglish: 'German (Switzerland)' },
    { code: 'de-de', name: 'Deutsch (Deutschland)', nameEnglish: 'German (Germany)' },
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

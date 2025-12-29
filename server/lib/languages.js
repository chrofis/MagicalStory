/**
 * Centralized Language Configuration
 * 
 * All language-specific instructions are defined here.
 * To add a new language, simply add it to LANGUAGES object.
 */

const LANGUAGES = {
  de: {
    code: 'de',
    name: 'Deutsch',
    nameEnglish: 'German',
    // Swiss Standard German spelling rules
    instruction: 'You MUST write your response in German. Use Swiss Standard German spelling (Schweizer Hochdeutsch). CRITICAL SPELLING RULES: (1) Use ä, ö, ü - NEVER ae, oe, ue. (2) Use "ss" instead of "ß". Examples: CORRECT: "grösser", "süss" | WRONG: "größer", "groesser", "süß", "suess". Use standard German vocabulary, not Swiss dialect.',
    // Short note for prompts that already mention language
    note: '(Swiss Standard German: Use ä, ö, ü - NEVER ae, oe, ue. Use "ss" instead of "ß". CORRECT: "grösser", "süss" | WRONG: "größer", "groesser", "süß", "suess")'
  },
  fr: {
    code: 'fr',
    name: 'Français',
    nameEnglish: 'French',
    instruction: 'You MUST write your response in French.',
    note: ''
  },
  en: {
    code: 'en',
    name: 'English',
    nameEnglish: 'English',
    instruction: 'You MUST write your response in English.',
    note: ''
  }
};

/**
 * Get full language instruction for a language code
 * @param {string} langCode - 'de', 'fr', 'en'
 * @returns {string} Full instruction for AI
 */
function getLanguageInstruction(langCode) {
  const lang = LANGUAGES[langCode] || LANGUAGES.en;
  return lang.instruction;
}

/**
 * Get short language note (for prompts that already specify language)
 * @param {string} langCode - 'de', 'fr', 'en'
 * @returns {string} Short note with spelling rules
 */
function getLanguageNote(langCode) {
  const lang = LANGUAGES[langCode] || LANGUAGES.en;
  return lang.note;
}

/**
 * Get language name in that language
 * @param {string} langCode - 'de', 'fr', 'en'
 * @returns {string} e.g., 'Deutsch', 'Français', 'English'
 */
function getLanguageName(langCode) {
  const lang = LANGUAGES[langCode] || LANGUAGES.en;
  return lang.name;
}

/**
 * Get language name in English
 * @param {string} langCode - 'de', 'fr', 'en'
 * @returns {string} e.g., 'German', 'French', 'English'
 */
function getLanguageNameEnglish(langCode) {
  const lang = LANGUAGES[langCode] || LANGUAGES.en;
  return lang.nameEnglish;
}

module.exports = {
  LANGUAGES,
  getLanguageInstruction,
  getLanguageNote,
  getLanguageName,
  getLanguageNameEnglish
};

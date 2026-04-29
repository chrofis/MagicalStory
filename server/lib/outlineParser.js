/**
 * Outline parser barrel — re-exports the split modules so existing imports
 * (`require('./server/lib/outlineParser')`) keep working.
 *
 * Implementation lives in:
 *   - ./outlineParser/shared.js       — keywords, regex helpers, section parsers
 *   - ./outlineParser/legacy.js       — OutlineParser (legacy outline.txt mode)
 *   - ./outlineParser/unified.js      — UnifiedStoryParser (unified prompt mode)
 *   - ./outlineParser/progressive.js  — ProgressiveUnifiedParser (streaming)
 */

const { OutlineParser } = require('./outlineParser/legacy');
const { UnifiedStoryParser } = require('./outlineParser/unified');
const { ProgressiveUnifiedParser } = require('./outlineParser/progressive');
const {
  KEYWORDS,
  CLOTHING_CATEGORIES,
  keywordPattern,
  createPageHeaderPattern,
  createSectionPattern,
  extractCharacterNamesFromScene,
} = require('./outlineParser/shared');

module.exports = {
  OutlineParser,
  UnifiedStoryParser,
  ProgressiveUnifiedParser,
  KEYWORDS,
  CLOTHING_CATEGORIES,
  keywordPattern,
  createPageHeaderPattern,
  createSectionPattern,
  extractCharacterNamesFromScene,
};

/**
 * Swiss Stories — Loads multilingual story ideas from JSON and
 * research content from docs/story-ideas/*.md files at startup.
 */

const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logger');

// In-memory cache: Map<cityId, { ideas: [{id, title, description, context}], research: string }>
let swissStoriesCache = null;
let swissCitiesData = null;
// Multilingual ideas from JSON: Map<cityId, [{id, title:{en,de,fr}, context:{en,de,fr}, description:{en,de,fr}}]>
let swissIdeasJson = null;
// Swiss fairy tales / legends (Sagen)
let swissSagenData = null;

/**
 * Extract story ideas from the "## Story Ideas" section of an MD file.
 * Format: "1. **Title** — Description text"
 */
function extractStoryIdeas(content, cityId) {
  const ideas = [];
  // Find the Story Ideas section
  const match = content.match(/## Story Ideas[^\n]*\n([\s\S]*?)$/);
  if (!match) return ideas;

  const section = match[1].trim();
  // Match numbered items: "1. **Title** — Description"
  const itemRegex = /^\d+\.\s+\*\*(.+?)\*\*\s*[—–-]\s*(.+)$/gm;
  let itemMatch;
  let index = 1;
  while ((itemMatch = itemRegex.exec(section)) !== null) {
    ideas.push({
      id: `${cityId}-${index}`,
      title: itemMatch[1].trim(),
      description: itemMatch[2].trim()
    });
    index++;
  }
  return ideas;
}

/**
 * Extract research sections (everything between Sources and Story Ideas).
 * This is the historical/cultural context used for prompt injection.
 */
function extractResearchSections(content) {
  // Get content between the first --- and the Story Ideas section
  const parts = content.split(/---/);
  if (parts.length < 3) {
    // Fallback: get everything between Sources and Story Ideas
    const match = content.match(/## Sources[\s\S]*?\n(## \d+\.[\s\S]*?)(?=## Story Ideas)/);
    return match ? match[1].trim() : '';
  }
  // The research is in the middle section (between the two ---)
  return parts.slice(1, -1).join('---').trim();
}

/**
 * Parse all swiss story-ideas MD files into memory.
 * Called once at startup.
 */
function parseAllSwissStories() {
  const dir = path.join(__dirname, '../../docs/story-ideas');
  if (!fs.existsSync(dir)) {
    log.warn('[SWISS] docs/story-ideas directory not found');
    return new Map();
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  const cache = new Map();

  for (const file of files) {
    const cityId = file.replace('.md', '');
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const ideas = extractStoryIdeas(content, cityId);
      const research = extractResearchSections(content);
      cache.set(cityId, { ideas, research });
    } catch (err) {
      log.warn(`[SWISS] Failed to parse ${file}: ${err.message}`);
    }
  }

  log.info(`[SWISS] Parsed ${cache.size} city files with story ideas`);
  return cache;
}

/**
 * Load swiss-cities.json metadata.
 */
function loadCitiesData() {
  const filePath = path.join(__dirname, '../data/swiss-cities.json');
  if (!fs.existsSync(filePath)) {
    log.warn('[SWISS] swiss-cities.json not found');
    return { cantons: {}, cities: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    log.error(`[SWISS] Failed to parse swiss-cities.json: ${err.message}`);
    return { cantons: {}, cities: [] };
  }
}

/**
 * Load multilingual story ideas from swiss-story-ideas.json.
 * Returns Map<cityId, ideas[]> or null if file missing.
 */
function loadSwissStoryIdeas() {
  const filePath = path.join(__dirname, '../data/swiss-story-ideas.json');
  if (!fs.existsSync(filePath)) {
    log.warn('[SWISS] swiss-story-ideas.json not found, falling back to MD parsing');
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const map = new Map();
    for (const [cityId, ideas] of Object.entries(data)) {
      map.set(cityId, ideas);
    }
    log.info(`[SWISS] Loaded multilingual ideas for ${map.size} cities from JSON`);
    return map;
  } catch (err) {
    log.error(`[SWISS] Failed to parse swiss-story-ideas.json: ${err.message}`);
    return null;
  }
}

/**
 * Load Swiss fairy tales / legends (Sagen) from swiss-sagen.json.
 */
function loadSwissSagen() {
  const filePath = path.join(__dirname, '../data/swiss-sagen.json');
  if (!fs.existsSync(filePath)) {
    log.warn('[SWISS] swiss-sagen.json not found');
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    log.info(`[SWISS] Loaded ${data.length} Sagen (fairy tales)`);
    return data;
  } catch (err) {
    log.error(`[SWISS] Failed to parse swiss-sagen.json: ${err.message}`);
    return [];
  }
}

/**
 * Initialize the swiss stories cache. Call once at startup.
 */
function initSwissStories() {
  swissStoriesCache = parseAllSwissStories();
  swissCitiesData = loadCitiesData();
  swissIdeasJson = loadSwissStoryIdeas();
  swissSagenData = loadSwissSagen();
}

/**
 * Get the combined API response: cities with their story ideas.
 * Uses multilingual JSON ideas if available, falls back to MD-parsed ideas.
 */
function getSwissStoriesResponse() {
  if (!swissStoriesCache || !swissCitiesData) {
    initSwissStories();
  }

  const cities = swissCitiesData.cities.map(city => {
    // Prefer multilingual JSON ideas, fall back to MD-parsed
    const jsonIdeas = swissIdeasJson?.get(city.id);
    const mdData = swissStoriesCache.get(city.id);
    return {
      ...city,
      ideas: jsonIdeas || mdData?.ideas || []
    };
  });

  return {
    cantons: swissCitiesData.cantons,
    cities,
    sagen: swissSagenData || []
  };
}

/**
 * Get research content for a specific city (for prompt injection).
 */
function getSwissStoryResearch(cityId) {
  if (!swissStoriesCache) initSwissStories();
  return swissStoriesCache.get(cityId) || null;
}

/**
 * Get city metadata by ID.
 */
function getSwissCityById(cityId) {
  if (!swissCitiesData) initSwissStories();
  return swissCitiesData.cities.find(c => c.id === cityId) || null;
}

/**
 * Get a single Sage (fairy tale) by its ID.
 */
function getSageById(sageId) {
  if (!swissSagenData) initSwissStories();
  return swissSagenData?.find(s => s.id === sageId) || null;
}

module.exports = {
  initSwissStories,
  getSwissStoriesResponse,
  getSwissStoryResearch,
  getSwissCityById,
  getSageById
};

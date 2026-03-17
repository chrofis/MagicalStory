/**
 * Swiss Stories — Parses docs/story-ideas/*.md files at startup
 * and serves city/story data via API.
 */

const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logger');

// In-memory cache: Map<cityId, { ideas: [{id, title, description}], research: string }>
let swissStoriesCache = null;
let swissCitiesData = null;

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
 * Initialize the swiss stories cache. Call once at startup.
 */
function initSwissStories() {
  swissStoriesCache = parseAllSwissStories();
  swissCitiesData = loadCitiesData();
}

/**
 * Get the combined API response: cities with their story ideas.
 */
function getSwissStoriesResponse() {
  if (!swissStoriesCache || !swissCitiesData) {
    initSwissStories();
  }

  const cities = swissCitiesData.cities.map(city => {
    const storyData = swissStoriesCache.get(city.id);
    return {
      ...city,
      ideas: storyData?.ideas || []
    };
  });

  return {
    cantons: swissCitiesData.cantons,
    cities
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

module.exports = {
  initSwissStories,
  getSwissStoriesResponse,
  getSwissStoryResearch,
  getSwissCityById
};

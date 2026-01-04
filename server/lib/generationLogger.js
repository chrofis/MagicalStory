/**
 * Generation Logger Module
 * Captures key events during story generation for debugging in dev mode
 */

const { log } = require('../utils/logger');

/**
 * @typedef {'outline' | 'avatars' | 'scenes' | 'images' | 'covers' | 'finalize'} GenerationLogStage
 * @typedef {'info' | 'warn' | 'error' | 'debug'} GenerationLogLevel
 *
 * @typedef {Object} GenerationLogEntry
 * @property {string} timestamp - ISO timestamp
 * @property {GenerationLogStage} stage - Generation stage
 * @property {GenerationLogLevel} level - Log level
 * @property {string} event - Short event name
 * @property {string} message - Human-readable description
 * @property {string} [character] - Character name if relevant
 * @property {Record<string, unknown>} [details] - Additional structured data
 */

class GenerationLogger {
  constructor() {
    /** @type {GenerationLogEntry[]} */
    this.entries = [];
    /** @type {GenerationLogStage} */
    this.currentStage = 'outline';
    /** @type {Record<string, number>} */
    this.stageTiming = {};
    this._stageStartTime = null;
  }

  /**
   * Set the current generation stage
   * @param {GenerationLogStage} stage
   */
  setStage(stage) {
    // Record timing for previous stage
    if (this._stageStartTime && this.currentStage) {
      this.stageTiming[this.currentStage] = Date.now() - this._stageStartTime;
    }
    this.currentStage = stage;
    this._stageStartTime = Date.now();
    this.info('stage_start', `Starting ${stage} stage`);
  }

  /**
   * Add a log entry
   * @param {GenerationLogLevel} level
   * @param {string} event
   * @param {string} message
   * @param {string} [character]
   * @param {Record<string, unknown>} [details]
   */
  _log(level, event, message, character, details) {
    const entry = {
      timestamp: new Date().toISOString(),
      stage: this.currentStage,
      level,
      event,
      message,
      ...(character && { character }),
      ...(details && { details })
    };
    this.entries.push(entry);

    // Also log to server console for immediate visibility
    const prefix = character ? `[${character}]` : '';
    const logMsg = `[GEN:${this.currentStage}] ${prefix} ${message}`;
    if (level === 'error') {
      log.error(logMsg);
    } else if (level === 'warn') {
      log.warn(logMsg);
    } else {
      log.debug(logMsg);
    }
  }

  /**
   * Log info level event
   * @param {string} event
   * @param {string} message
   * @param {string} [character]
   * @param {Record<string, unknown>} [details]
   */
  info(event, message, character, details) {
    this._log('info', event, message, character, details);
  }

  /**
   * Log warning level event
   * @param {string} event
   * @param {string} message
   * @param {string} [character]
   * @param {Record<string, unknown>} [details]
   */
  warn(event, message, character, details) {
    this._log('warn', event, message, character, details);
  }

  /**
   * Log error level event
   * @param {string} event
   * @param {string} message
   * @param {string} [character]
   * @param {Record<string, unknown>} [details]
   */
  error(event, message, character, details) {
    this._log('error', event, message, character, details);
  }

  /**
   * Log debug level event
   * @param {string} event
   * @param {string} message
   * @param {string} [character]
   * @param {Record<string, unknown>} [details]
   */
  debug(event, message, character, details) {
    this._log('debug', event, message, character, details);
  }

  // Convenience methods for common events

  /**
   * Log avatar lookup event
   * @param {string} character
   * @param {string} result - What avatar was selected
   * @param {Record<string, unknown>} [details]
   */
  avatarLookup(character, result, details) {
    this.info('avatar_lookup', result, character, details);
  }

  /**
   * Log avatar fallback event
   * @param {string} character
   * @param {string} reason
   * @param {Record<string, unknown>} [details]
   */
  avatarFallback(character, reason, details) {
    this.warn('avatar_fallback', reason, character, details);
  }

  /**
   * Log costume generation event
   * @param {string} character
   * @param {string} costumeType
   * @param {boolean} success
   * @param {Record<string, unknown>} [details]
   */
  costumeGenerated(character, costumeType, success, details) {
    if (success) {
      this.info('costume_generated', `Generated ${costumeType} costume`, character, details);
    } else {
      this.error('costume_failed', `Failed to generate ${costumeType} costume`, character, details);
    }
  }

  /**
   * Log styled avatar generation event
   * @param {string} character
   * @param {string} artStyle
   * @param {boolean} success
   * @param {Record<string, unknown>} [details]
   */
  styledAvatarGenerated(character, artStyle, success, details) {
    if (success) {
      this.info('styled_avatar_generated', `Converted to ${artStyle} style`, character, details);
    } else {
      this.error('styled_avatar_failed', `Failed to convert to ${artStyle} style`, character, details);
    }
  }

  /**
   * Log clothing requirement parsed
   * @param {string} character
   * @param {string} clothing
   * @param {Record<string, unknown>} [details]
   */
  clothingParsed(character, clothing, details) {
    this.debug('clothing_parsed', `Clothing requirement: ${clothing}`, character, details);
  }

  /**
   * Log image generation event
   * @param {number} pageNumber
   * @param {boolean} success
   * @param {Record<string, unknown>} [details]
   */
  imageGenerated(pageNumber, success, details) {
    if (success) {
      this.info('image_generated', `Generated image for page ${pageNumber}`, null, details);
    } else {
      this.error('image_failed', `Failed to generate image for page ${pageNumber}`, null, details);
    }
  }

  /**
   * Finalize and get timing summary
   */
  finalize() {
    // Record final stage timing
    if (this._stageStartTime && this.currentStage) {
      this.stageTiming[this.currentStage] = Date.now() - this._stageStartTime;
    }

    // Add timing summary entry
    this.info('timing_summary', 'Generation complete', null, {
      stageTiming: this.stageTiming,
      totalEntries: this.entries.length
    });
  }

  /**
   * Get all log entries
   * @returns {GenerationLogEntry[]}
   */
  getEntries() {
    return this.entries;
  }

  /**
   * Get summary statistics
   */
  getSummary() {
    const byLevel = { info: 0, warn: 0, error: 0, debug: 0 };
    const byStage = {};

    for (const entry of this.entries) {
      byLevel[entry.level]++;
      byStage[entry.stage] = (byStage[entry.stage] || 0) + 1;
    }

    return {
      totalEntries: this.entries.length,
      byLevel,
      byStage,
      stageTiming: this.stageTiming,
      hasErrors: byLevel.error > 0,
      hasWarnings: byLevel.warn > 0
    };
  }
}

module.exports = { GenerationLogger };

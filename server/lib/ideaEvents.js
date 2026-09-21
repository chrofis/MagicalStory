/**
 * THE IDEA FUNNEL — what the wizard offered, and what the customer clicked.
 *
 * WHY THIS EXISTS (owner, 2026-09-21): the story-idea quality series optimised a
 * RATER's proxy for "would a parent buy this", and a blind re-rate showed the
 * proxy is unreliable. The signal that is not a proxy already happens in
 * production every day: two ideas are shown, and the customer either clicks one
 * or presses regenerate. A click is a buy vote. A regeneration rejects BOTH
 * arms. Nothing recorded either until this module — see migrations/039.
 *
 * Design constraints, copied deliberately from server/lib/failureLog.js:
 *   - NEVER throws, NEVER blocks, NEVER awaited by the request it describes.
 *     Telemetry must not be able to fail an idea generation a customer is
 *     watching stream in.
 *   - NEVER writes image bytes or free text a parent typed. Everything written
 *     is a slug, a number, or a bounded JSON object.
 */

const { log } = require('../utils/logger');

const MAX_ROWS_PER_HOUR = 500;   // backstop against a client stuck in a retry loop
let _hourStart = 0;
let _hourCount = 0;

const EVENTS = new Set(['idea_generated', 'idea_picked']);

/** Trim to a column's width, or NULL for empty. */
function _trim(value, max) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function _int(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * The cast facts the funnel slices by. Kept here rather than at the call sites
 * so the authenticated endpoints and the pick path cannot disagree about what
 * "cast size" and "youngest" mean.
 *
 * @param {Array} characters - the cast as the wizard sent it ({ age })
 * @returns {{castSize: number|null, youngestAge: number|null}}
 */
function castFacts(characters) {
  if (!Array.isArray(characters) || characters.length === 0) {
    return { castSize: null, youngestAge: null };
  }
  const ages = characters.map(c => parseInt(c?.age, 10)).filter(Number.isFinite);
  return {
    castSize: characters.length,
    youngestAge: ages.length ? Math.min(...ages) : null,
  };
}

/**
 * A premise shape as the funnel stores it: the id and the name only. The
 * definition is a paragraph of prompt text and belongs in premise-shapes.txt,
 * not in every row of an analytics table.
 */
function shapeRef(shape) {
  if (!shape || typeof shape !== 'object') return null;
  const id = _int(shape.id);
  const name = _trim(shape.name, 60);
  if (id === null && !name) return null;
  return { id, name };
}

/**
 * Pure: turn a caller's event into the exact column values the insert uses.
 * Exported so the shape is unit-testable without a database.
 *
 * Returns null when the event is unusable (unknown slug), which the writer
 * treats as "drop it silently" — a mis-shaped event must never become an error
 * on the customer's path.
 */
function normaliseIdeaEvent(e = {}) {
  if (!EVENTS.has(e.event)) return null;
  const { castSize, youngestAge } = castFacts(e.characters);
  const attempt = _int(e.attempt);
  const shapes = Array.isArray(e.shapes)
    ? e.shapes.map(shapeRef).filter(Boolean)
    : shapeRef(e.shapes);
  const cost = Number(e.costUsd);
  return {
    environment: process.env.RAILWAY_ENVIRONMENT_NAME || 'local',
    event: e.event,
    userId: _trim(e.userId, 100),
    storyId: _trim(e.storyId, 100),
    category: _trim(e.category, 60),
    topic: _trim(e.topic, 120),
    theme: _trim(e.theme, 120),
    language: _trim(e.language, 10),
    pages: _int(e.pages),
    castSize,
    youngestAge,
    // 'auto' is the wizard's default and is what an absent value means.
    worldMode: _trim(e.worldMode, 20) || 'auto',
    attempt,
    // Derived, never taken on trust: attempt 1 is the first pair this wizard
    // session asked for; anything above it is a regeneration. The client sends
    // both so a client that forgets the counter still records the flag.
    regenerated: attempt === null ? (e.regenerate === true) : attempt > 1,
    armIndex: _int(e.armIndex),
    worlds: e.worlds ?? null,
    shapes: (Array.isArray(shapes) ? (shapes.length ? shapes : null) : shapes) || null,
    model: _trim(e.model, 80),
    costUsd: Number.isFinite(cost) && cost > 0 ? cost : null,
    detail: e.detail && typeof e.detail === 'object' ? e.detail : null,
  };
}

function _allowed() {
  const now = Date.now();
  if (now - _hourStart > 3600_000) { _hourStart = now; _hourCount = 0; }
  if (_hourCount >= MAX_ROWS_PER_HOUR) return false;
  _hourCount++;
  return true;
}

/**
 * Record one idea-funnel event. Fire-and-forget: returns immediately, never
 * rejects.
 *
 * @param {object} e
 * @param {'idea_generated'|'idea_picked'} e.event
 * @param {string} [e.userId] @param {string} [e.storyId]
 * @param {string} [e.category] @param {string} [e.topic] @param {string} [e.theme]
 * @param {string} [e.language] @param {number} [e.pages]
 * @param {Array}  [e.characters]  the cast (cast size + youngest are derived)
 * @param {string} [e.worldMode]   'auto' | 'location' | 'fantasy'
 * @param {number} [e.attempt]     1 = first pair, >1 = regeneration
 * @param {boolean}[e.regenerate]  the client's own flag (fallback for attempt)
 * @param {number} [e.armIndex]    idea_picked: 0 | 1, null = user-written
 * @param {*}      [e.worlds]      both arms' worlds, or the picked one
 * @param {*}      [e.shapes]      both arms' premise shapes, or the picked one
 * @param {string} [e.model] @param {number} [e.costUsd]
 * @param {object} [e.detail]      small bounded context
 */
function recordIdeaEvent(e = {}) {
  try {
    const row = normaliseIdeaEvent(e);
    if (!row) return;
    if (!_allowed()) return;
    const { getPool } = require('../services/database');
    const pool = getPool && getPool();
    if (!pool) return;
    // Deliberately not awaited — see the header. A rejected insert is logged
    // and forgotten; it must never surface on the customer's request.
    pool.query(
      `INSERT INTO idea_events
         (environment, event, user_id, story_id, category, topic, theme, language,
          pages, cast_size, youngest_age, world_mode, attempt, regenerated,
          arm_index, worlds, shapes, model, cost_usd, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        row.environment, row.event, row.userId, row.storyId, row.category, row.topic,
        row.theme, row.language, row.pages, row.castSize, row.youngestAge, row.worldMode,
        row.attempt, row.regenerated, row.armIndex,
        row.worlds === null ? null : JSON.stringify(row.worlds),
        row.shapes === null ? null : JSON.stringify(row.shapes),
        row.model, row.costUsd,
        row.detail === null ? null : JSON.stringify(row.detail),
      ]
    ).catch(err => log.debug(`[IDEA EVENTS] insert failed: ${err.message}`));
  } catch (err) {
    log.debug(`[IDEA EVENTS] record failed: ${err.message}`);
  }
}

module.exports = { recordIdeaEvent, normaliseIdeaEvent, castFacts, shapeRef };

// Logger Utility
// LOG_LEVEL controls verbosity: error < warn < info < debug < trace

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const CURRENT_LOG_LEVEL = LOG_LEVELS[LOG_LEVEL] !== undefined ? LOG_LEVELS[LOG_LEVEL] : LOG_LEVELS.info;

const log = {
  // ERROR: Something failed, needs immediate attention
  error: (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args),

  // WARN: Something unexpected but not broken
  warn: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.warn && console.warn(`[WARN] ${msg}`, ...args),

  // INFO: Key business events (startup, user actions, completions)
  info: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.info && console.log(msg, ...args),

  // DEBUG: Developer troubleshooting (API calls, DB queries, flow tracing)
  debug: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.debug && console.log(`[DEBUG] ${msg}`, ...args),

  // TRACE: Super detailed (request/response bodies, token counts, internal state)
  trace: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.trace && console.log(`[TRACE] ${msg}`, ...args),

  // Backwards compatibility alias
  verbose: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.debug && console.log(`[DEBUG] ${msg}`, ...args)
};

module.exports = {
  log,
  LOG_LEVELS,
  LOG_LEVEL,
  CURRENT_LOG_LEVEL
};

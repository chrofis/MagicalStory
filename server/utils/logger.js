// Logger Utility
// LOG_LEVEL controls verbosity: error < warn < info < debug < trace

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const CURRENT_LOG_LEVEL = LOG_LEVELS[LOG_LEVEL] !== undefined ? LOG_LEVELS[LOG_LEVEL] : LOG_LEVELS.info;

// Log listeners — lets a caller (the Test Lab) capture the log lines emitted
// during a scoped operation and persist them with the run, instead of the
// faults living only in Railway. error/warn/info are forwarded regardless of
// LOG_LEVEL (a fault must reach the capture even when console output is
// filtered); debug/trace are never forwarded (noise).
const _listeners = new Set();
function addLogListener(fn) { _listeners.add(fn); }
function removeLogListener(fn) { _listeners.delete(fn); }
function _emit(level, msg, args) {
  if (_listeners.size === 0) return;
  let line = String(msg);
  if (args.length) {
    try {
      line += ' ' + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    } catch { /* unserializable arg — keep the message alone */ }
  }
  for (const fn of _listeners) { try { fn(level, line); } catch { /* listener must never break logging */ } }
}

const log = {
  // ERROR: Something failed, needs immediate attention
  error: (msg, ...args) => { _emit('error', msg, args); return console.error(`[ERROR] ${msg}`, ...args); },

  // WARN: Something unexpected but not broken
  warn: (msg, ...args) => { _emit('warn', msg, args); return CURRENT_LOG_LEVEL >= LOG_LEVELS.warn && console.warn(`[WARN] ${msg}`, ...args); },

  // INFO: Key business events (startup, user actions, completions)
  info: (msg, ...args) => { _emit('info', msg, args); return CURRENT_LOG_LEVEL >= LOG_LEVELS.info && console.log(msg, ...args); },

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
  CURRENT_LOG_LEVEL,
  addLogListener,
  removeLogListener
};

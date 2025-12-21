const fs = require('fs');

// Read the server.js file
const content = fs.readFileSync('server.js', 'utf8');

// Define the old logging code
const oldCode = `// Logging helper functions
const log = {
  info: (msg, ...args) => console.log(msg, ...args),
  error: (msg, ...args) => console.error(msg, ...args),
  warn: (msg, ...args) => console.warn(msg, ...args),
  // Verbose logs only show when VERBOSE_LOGGING is enabled
  verbose: (msg, ...args) => VERBOSE_LOGGING && console.log(\`[VERBOSE] \${msg}\`, ...args),
  // Debug logs for development
  debug: (msg, ...args) => VERBOSE_LOGGING && console.log(\`[DEBUG] \${msg}\`, ...args)
};`;

// Define the new logging code
const newCode = `// LOG_LEVEL controls verbosity: error < warn < info < debug < trace
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const CURRENT_LOG_LEVEL = LOG_LEVELS[LOG_LEVEL] !== undefined ? LOG_LEVELS[LOG_LEVEL] : LOG_LEVELS.info;

const log = {
  // ERROR: Something failed, needs immediate attention
  error: (msg, ...args) => console.error(\`[ERROR] \${msg}\`, ...args),
  // WARN: Something unexpected but not broken
  warn: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.warn && console.warn(\`[WARN] \${msg}\`, ...args),
  // INFO: Key business events (startup, user actions, completions)
  info: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.info && console.log(msg, ...args),
  // DEBUG: Developer troubleshooting (API calls, DB queries, flow tracing)
  debug: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.debug && console.log(\`[DEBUG] \${msg}\`, ...args),
  // TRACE: Super detailed (request/response bodies, token counts, internal state)
  trace: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.trace && console.log(\`[TRACE] \${msg}\`, ...args),
  // Backwards compatibility alias
  verbose: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.debug && console.log(\`[DEBUG] \${msg}\`, ...args)
};`;

if (content.includes(oldCode)) {
  const newContent = content.replace(oldCode, newCode);
  fs.writeFileSync('server.js', newContent);
  console.log('SUCCESS: Log object replaced');
} else {
  console.log('ERROR: Could not find old code block');
  // Show what we're looking for vs what exists
  const idx = content.indexOf('// Logging helper functions');
  if (idx !== -1) {
    console.log('Found "// Logging helper functions" at index', idx);
    console.log('Content around it:');
    console.log(content.substring(idx, idx + 500));
  } else {
    console.log('Could not find "// Logging helper functions"');
  }
}

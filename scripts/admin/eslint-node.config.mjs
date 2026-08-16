// Flat config for the pre-push crash gate (scripts/admin/check-no-undef.js).
//
// Deliberately ONE rule. This is not a style linter — it is a crash gate. Every
// error it reports is a variable that does not exist at runtime, i.e. a
// guaranteed ReferenceError the moment that line executes.
//
// Globals are inlined rather than imported from the `globals` package: this
// config is loaded from scripts/admin/, so a bare import resolves against that
// directory and not against client/node_modules where eslint actually lives.
// Self-contained is also safer for a gate — a resolution failure here would
// either block every push or silently skip the check.
//
// Bias the list GENEROUS. A global that is missing here becomes a false
// positive that blocks a legitimate push; an extra name costs nothing, because
// the rule only ever asks "does this identifier exist somewhere".
const NODE_GLOBALS = [
  // CommonJS module scope
  'require', 'module', 'exports', '__dirname', '__filename',
  // Node runtime
  'process', 'Buffer', 'global', 'globalThis', 'console',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'setImmediate', 'clearImmediate', 'queueMicrotask', 'structuredClone',
  'performance', 'crypto', 'fetch', 'Headers', 'Request', 'Response',
  'FormData', 'Blob', 'File', 'URL', 'URLSearchParams',
  'AbortController', 'AbortSignal', 'Event', 'EventTarget', 'MessageChannel',
  'TextEncoder', 'TextDecoder', 'ReadableStream', 'WritableStream',
  'TransformStream', 'BroadcastChannel', 'WebSocket', 'navigator',
];

export default [
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: Object.fromEntries(NODE_GLOBALS.map(g => [g, 'readonly'])),
    },
    linterOptions: { reportUnusedDisableDirectives: false },
    rules: { 'no-undef': 'error' },
  },
];

#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook (see .claude/settings.json): after Edit/Write
 * lands in prompts/*.txt, inject a reminder to re-check the just-written text
 * against the prompt-writing rules. Non-blocking — advisory context only.
 */
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let filePath = '';
  try {
    filePath = (JSON.parse(raw).tool_input || {}).file_path || '';
  } catch { /* no payload — stay silent */ }
  const p = filePath.replace(/\\/g, '/');

  if (!/\/prompts\/[^/]+\.txt$/.test(p)) return; // exit 0, no output — no-op

  // NOTE: no process.exit() after write — on Windows, stdout pipes flush
  // asynchronously and an immediate exit silently drops the output.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        'PROMPT-RULES CHECK: re-read the text you just wrote into this template and fix it NOW if it violates any of these. ' +
        '1) GENERIC: no names, settings, or plotlines from any specific story — if the prompt reveals which story motivated it, rewrite with archetypes ("the main character", "a guard"). ' +
        '2) TERSE: rules are 1-2 sentences; fold new conditions into existing rules instead of appending sentences. ' +
        '3) NO BANNERS: no CRITICAL/MUST/LOCKED emphasis. ' +
        '4) NO JUSTIFICATION: state the rule, not the reasoning behind it.',
    },
  }) + '\n');
});

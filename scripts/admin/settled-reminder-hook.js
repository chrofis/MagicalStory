#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook (see .claude/settings.json): when Edit/Write
 * targets a flip-flop-prone file (prompt templates, model routing, eval
 * scoring), inject a reminder to check docs/SETTLED.md before the edit.
 * Non-blocking — advisory context only.
 */
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let filePath = '';
  try {
    filePath = (JSON.parse(raw).tool_input || {}).file_path || '';
  } catch { /* no payload — stay silent */ }
  const p = filePath.replace(/\\/g, '/');

  const sensitive =
    /\/prompts\/[^/]+\.txt$/.test(p) ||
    /\/server\/config\/models\.js$/.test(p) ||
    /\/server\/lib\/(scoring|evalBuckets)\.js$/.test(p);

  if (!sensitive) return; // exit 0 with no output — hook is a no-op

  // NOTE: no process.exit() after write — on Windows, stdout pipes flush
  // asynchronously and an immediate exit silently drops the output.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        'SETTLED-VERDICT CHECK: this file is on the flip-flop-prone list. Before editing, read docs/SETTLED.md. ' +
        'If this edit reverses a settled verdict, STOP: it needs user sign-off (AskUserQuestion), evidence ' +
        '(Test Lab experiment ID or >=3 pages/stories), and a superseding docs/decisions.md entry. ' +
        'Also follow the validating-prompt-changes skill for prompt edits.',
    },
  }) + '\n');
});

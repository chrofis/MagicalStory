#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook (see .claude/settings.json): after an Edit/Write
 * lands in a file declared in scripts/admin/sibling-registry.json, inject a
 * reminder naming that file's siblings.
 *
 * WHY — the pre-push gate (check-sibling-paths.js) blocks the partial fix, but
 * it does so at push time, long after the session has decided the fix is done.
 * This moves the reminder to the moment the edit is written. Advisory only; it
 * never blocks and never fails a tool call.
 */
const path = require('path');
const fs = require('fs');

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let filePath = '';
  try {
    filePath = (JSON.parse(raw).tool_input || {}).file_path || '';
  } catch { return; } // no payload — stay silent

  const ROOT = path.join(__dirname, '..', '..');
  const p = path.resolve(filePath).replace(/\\/g, '/');
  const rel = path.relative(ROOT, p).replace(/\\/g, '/');

  let reg;
  try {
    reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'sibling-registry.json'), 'utf8'));
  } catch { return; } // a broken registry is the pre-push gate's problem, not this one's

  const lines = [];
  for (const set of reg.sets || []) {
    // A generator-vs-critic set is directional: editing a judge names the
    // generator that must be told, and editing a generator names its judges.
    if (Array.isArray(set.generators) && Array.isArray(set.critics)) {
      if (set.critics.includes(rel)) {
        lines.push(`- you just edited a CRITIC. A rule added to a judge is a rule the generator must be told, or the page is penalised for something it was never asked to do. Generator: ${set.generators.join(', ')} — ${set.reason}`);
      } else if (set.generators.includes(rel)) {
        lines.push(`- you just edited a GENERATOR. Its judges will score the new behaviour without knowing about it. Critics: ${set.critics.join(', ')} — ${set.reason}`);
      }
      continue;
    }
    if (!set.members.includes(rel)) continue;
    const others = set.members.filter(m => m !== rel);
    lines.push(`- ${set.axis}: also check ${others.join(', ')} — ${set.reason}`);
  }
  for (const w of reg.withinFile || []) {
    if (w.file !== rel) continue;
    lines.push(`- ${w.axis}: every block matching /${w.blockPattern}/ in this file must contain "${w.mustContain}" — ${w.reason}`);
  }
  if (lines.length === 0) return;

  // NOTE: no process.exit() after write — on Windows, stdout pipes flush
  // asynchronously and an immediate exit silently drops the output.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        `SIBLING PATHS: ${rel} is a declared sibling. Before calling this fix done, apply it to (or rule out) each counterpart:\n` +
        lines.join('\n') +
        '\nWhere a rule must hold on both sides, prefer ONE JS constant injected into both templates over two hand-kept copies. ' +
        'The pre-push gate blocks a commit that moves one side only; the escape is `Siblings-Checked: <reason>` in the commit message. See docs/sibling-paths.md.',
    },
  }) + '\n');
});

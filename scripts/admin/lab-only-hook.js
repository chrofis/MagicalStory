#!/usr/bin/env node
/**
 * PreToolUse(Bash) — pipeline experiments belong in the Test Lab, not local.
 *
 * WHY THIS EXISTS (2026-08-14). The rule "experiments run in the Test Lab,
 * never local-only" lived in a memory file, which is advisory: an agent can
 * read it and still choose local iteration because it is faster, especially
 * when staging is busy. That choice is not just a process violation, it
 * produces WRONG RESULTS — this machine has no MobileSAM (`No module named
 * 'ultralytics'`), so any local run of the repair/composite path silently
 * takes a degraded branch:
 *   - the crosshatch treatment falls back to a RECTANGULAR hatch and skips the
 *     face blur (faceRepair.js says so in its own comment),
 *   - whiteout throws outright,
 *   - the blend gate cannot evaluate and rejects everything.
 * A whole afternoon went into hand-building mask geometry to compensate for an
 * environment gap that does not exist on staging.
 *
 * So this asks for confirmation rather than blocking outright — an override is
 * one keypress, and there are legitimate local runs (a dry pass, a harness
 * against stored images with no model call).
 *
 * Scope is deliberately narrow: a `node` command running a script under the
 * scratchpad that pulls in server/lib. DB queries, image inspection and HTML
 * builders are untouched.
 */
const fs = require('fs');
const path = require('path');

const ALLOW = { continue: true };
const emit = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let cmd = '';
  try { cmd = JSON.parse(raw || '{}')?.tool_input?.command || ''; } catch { emit(ALLOW); }
  if (!cmd || !/\bnode\b/.test(cmd)) emit(ALLOW);

  // Script paths named in the command. The scratchpad usually arrives via a
  // leading `cd`, not on the script token itself ("cd <scratchpad> && node
  // charfix.js"), so resolve each token against any cd target too and judge the
  // RESOLVED path.
  const cdMatch = cmd.match(/cd\s+"?([^"&;|]+)"?/);
  const cdDir = cdMatch ? cdMatch[1].trim() : null;
  const tokens = (cmd.match(/[^\s"']+\.js\b/g) || []).map((s) => s.replace(/^["']|["']$/g, ''));
  if (!tokens.length) emit(ALLOW);

  const hits = [];
  for (const t of tokens) {
    const candidates = [t, cdDir ? path.join(cdDir, t) : null].filter(Boolean);
    for (const c of candidates) {
      if (!/scratchpad/i.test(c)) continue;
      let body = '';
      try { body = fs.readFileSync(c, 'utf8'); } catch { continue; }
      // Must actually LOAD the pipeline, not merely mention it. Naming a path in
      // a string is not running it: a patch script that rewrites
      // server/lib/foo.js, or a report that prints the path, used to trip this
      // and cost an approval prompt every single time — which trains the wrong
      // reflex and buries the real warning in noise. Only a require of
      // server/lib can take the degraded local branch this hook exists to catch.
      if (/require\s*\(\s*['"][^'"]*server[/\\]lib/.test(body)) { hits.push(path.basename(c)); break; }
    }
  }
  if (!hits.length) emit(ALLOW);

  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason:
        `${hits.join(', ')} runs the pipeline (server/lib) locally. This machine has no MobileSAM `
        + `(ultralytics is not installed), so repair and composite runs silently take a degraded path: `
        + `rectangular hatch instead of a figure-clipped one, no face blur, whiteout throws, and the blend `
        + `gate rejects everything. Results from here do not reproduce staging. Prefer the Test Lab `
        + `(scene_composite / char repair stages) so the run is visible and the masks are real. `
        + `Approve to run locally anyway — fine for a dry pass or stored-image inspection.`,
    },
  });
});

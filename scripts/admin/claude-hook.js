#!/usr/bin/env node
/**
 * The ONE Claude Code hook (PreToolUse on Edit|Write|Bash, .claude/settings.json).
 *
 * WHY ONE (owner, 2026-11-02: "One hook not 100x, this is annoying"). This used
 * to be five scripts — three on every edit, two on every shell call — each its
 * own node process and its own status line. Every check below is the same rule
 * it was before; only the packaging changed. See docs/decisions.md 2026-11-02.
 *
 * Edit/Write:
 *   - settled: a flip-flop-prone file → read docs/SETTLED.md first.
 *   - prompt rules: prompts/*.txt → generic, terse, no banners, no justification.
 *   - siblings: a file in sibling-registry.json → name its counterparts.
 * Bash:
 *   - paid run: a story/trial run ASKS the owner (iron rule, 2026-10-09), unless
 *     an owner pre-approval in .claude/paid-run-preapproval.json covers it.
 *   - lab only: a scratchpad script that requires server/lib runs the pipeline
 *     locally without MobileSAM → reminder, never a gate (owner, 2026-08-15).
 * Everything except the paid-run ask is advisory context.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const GRANT_FILE = path.join(ROOT, '.claude', 'paid-run-preapproval.json');

// ── Edit/Write checks ──────────────────────────────────────────────────────

function settledNote(rel) {
  const sensitive = /^prompts\/[^/]+\.txt$/.test(rel)
    || rel === 'server/config/models.js'
    || /^server\/lib\/(scoring|evalBuckets)\.js$/.test(rel);
  if (!sensitive) return null;
  return 'SETTLED-VERDICT CHECK: this file is on the flip-flop-prone list. Before editing, read docs/SETTLED.md. '
    + 'If this edit reverses a settled verdict, STOP: it needs user sign-off (AskUserQuestion), evidence '
    + '(Test Lab experiment ID or >=3 pages/stories), and a superseding docs/decisions.md entry. '
    + 'Also follow the validating-prompt-changes skill for prompt edits.';
}

function promptRulesNote(rel) {
  if (!/^prompts\/[^/]+\.txt$/.test(rel)) return null;
  return 'PROMPT-RULES CHECK: the text you write into this template must be '
    + '1) GENERIC: no names, settings, or plotlines from any specific story — use archetypes ("the main character", "a guard"); '
    + '2) TERSE: rules are 1-2 sentences; fold new conditions into existing rules instead of appending sentences; '
    + '3) NO BANNERS: no CRITICAL/MUST/LOCKED emphasis; '
    + '4) NO JUSTIFICATION: state the rule, not the reasoning behind it.';
}

function siblingNote(rel, reg) {
  if (!reg) return null;
  const lines = [];
  for (const set of reg.sets || []) {
    // A generator-vs-critic set is directional: editing a judge names the
    // generator that must be told, and editing a generator names its judges.
    if (Array.isArray(set.generators) && Array.isArray(set.critics)) {
      if (set.critics.includes(rel)) {
        lines.push(`- you are editing a CRITIC. A rule added to a judge is a rule the generator must be told, or the page is penalised for something it was never asked to do. Generator: ${set.generators.join(', ')} — ${set.reason}`);
      } else if (set.generators.includes(rel)) {
        lines.push(`- you are editing a GENERATOR. Its judges will score the new behaviour without knowing about it. Critics: ${set.critics.join(', ')} — ${set.reason}`);
      }
      continue;
    }
    if (!(set.members || []).includes(rel)) continue;
    lines.push(`- ${set.axis}: also check ${set.members.filter(m => m !== rel).join(', ')} — ${set.reason}`);
  }
  for (const w of reg.withinFile || []) {
    if (w.file !== rel) continue;
    lines.push(`- ${w.axis}: every block matching /${w.blockPattern}/ in this file must contain "${w.mustContain}" — ${w.reason}`);
  }
  if (!lines.length) return null;
  return `SIBLING PATHS: ${rel} is a declared sibling. Before calling this fix done, apply it to (or rule out) each counterpart:\n`
    + lines.join('\n')
    + '\nWhere a rule must hold on both sides, prefer ONE JS constant injected into both templates over two hand-kept copies. '
    + 'The pre-push gate blocks a commit that moves one side only; the escape is `Siblings-Checked: <reason>` in the commit message. See docs/sibling-paths.md.';
}

function loadRegistry() {
  // A broken registry is the pre-push gate's problem, not this hook's.
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'sibling-registry.json'), 'utf8')); } catch { return null; }
}

// ── Bash checks ────────────────────────────────────────────────────────────

/** Returns a short label when the command starts a paid story/trial run, else null. */
function paidRunKind(cmd) {
  const c = String(cmd || '');
  if (/trial-showcase\.js/.test(c) && !/--dry-run\b/.test(c)) return 'trial run (trial-showcase.js)';
  if (/rerun-story-on-staging\.js/.test(c) && /--yes\b/.test(c)) return 'story rerun (rerun-story-on-staging.js --yes)';
  if (/test-scene-composite-smoke\.js/.test(c) && !/--dryRun\b/.test(c)) return 'smoke story (test-scene-composite-smoke.js)';
  if (/scripts[/\\]admin[/\\]showcase\.js|npm\s+run\s+showcase/.test(c)) return 'showcase';
  if (/curl\b[\s\S]*\/api\/(jobs|trial)\/create-story/.test(c)) return 'create-story API call';
  return null;
}

function paidRunReason(kind) {
  return `PAID ${kind}. IRON RULE (CLAUDE.md, owner 2026-10-09): test fixes on STORED stories `
    + '(replay / console / Test Lab, >=20 cases, report a rate); a new story or trial is an '
    + 'integration check only, after 20 successful stage tests since the last run, and never to '
    + 'prove one fix. Approve only if that holds and the price fits the task\'s stated cap.';
}

/**
 * A pre-approval the OWNER granted in chat for a run while they are away (owner, 2026-10-11).
 * Local file, never committed: { grantedBy, grantedAt, expiresAt (ISO), kinds: [...], remaining: N, reason }.
 * A run of a listed kind before expiresAt consumes one `remaining`; anything else still asks.
 */
function consumeGrant(kind, now = Date.now(), file = GRANT_FILE) {
  let g;
  try { g = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  if (!g || !Array.isArray(g.kinds) || !g.kinds.some((k) => kind.startsWith(k))) return false;
  if (!(Date.parse(g.expiresAt) > now) || !(g.remaining > 0)) return false;
  g.remaining -= 1;
  g.used = [...(g.used || []), { kind, at: new Date(now).toISOString() }];
  fs.writeFileSync(file, JSON.stringify(g, null, 2));
  return true;
}

/**
 * Scratchpad scripts in the command that LOAD server/lib (a require, not a mere
 * mention: a patch script naming a path is not running it). The scratchpad
 * usually arrives via a leading `cd`, so each token is also resolved against it.
 */
function localPipelineScripts(cmd, readFile = (f) => fs.readFileSync(f, 'utf8')) {
  if (!/\bnode\b/.test(cmd)) return [];
  const cdMatch = cmd.match(/cd\s+"?([^"&;|]+)"?/);
  const cdDir = cdMatch ? cdMatch[1].trim() : null;
  const tokens = (cmd.match(/[^\s"']+\.js\b/g) || []).map((s) => s.replace(/^["']|["']$/g, ''));
  const hits = [];
  for (const t of tokens) {
    for (const c of [t, cdDir ? path.join(cdDir, t) : null].filter(Boolean)) {
      if (!/scratchpad/i.test(c)) continue;
      let body = '';
      try { body = readFile(c); } catch { continue; }
      if (/require\s*\(\s*['"][^'"]*server[/\\]lib/.test(body)) { hits.push(path.basename(c)); break; }
    }
  }
  return hits;
}

function labOnlyNote(hits) {
  if (!hits.length) return null;
  return `${hits.join(', ')} runs the pipeline (server/lib) locally. This machine has no MobileSAM `
    + '(ultralytics is not installed), so repair and composite runs silently take a degraded path: '
    + 'rectangular hatch instead of a figure-clipped one, no face blur, whiteout throws, and the blend '
    + 'gate rejects everything. Results from here do not reproduce staging. Prefer the Test Lab '
    + '(scene_composite / char repair stages) so the run is visible and the masks are real. '
    + 'Running locally is fine for a dry pass or stored-image inspection — judge it.';
}

// ── Dispatch ───────────────────────────────────────────────────────────────

/** The hook's whole answer for one tool call. Pure apart from the grant file and the reads it is handed. */
function respond(payload, { registry = loadRegistry, grant = consumeGrant, readFile } = {}) {
  const tool = payload?.tool_name || '';
  const input = payload?.tool_input || {};
  const notes = [];
  let ask = null;

  if (tool === 'Edit' || tool === 'Write') {
    const rel = path.relative(ROOT, path.resolve(String(input.file_path || ''))).replace(/\\/g, '/');
    notes.push(settledNote(rel), promptRulesNote(rel), siblingNote(rel, registry()));
  } else if (tool === 'Bash') {
    const cmd = String(input.command || '');
    const kind = paidRunKind(cmd);
    if (kind && !grant(kind)) ask = paidRunReason(kind);
    notes.push(labOnlyNote(localPipelineScripts(cmd, readFile)));
  }

  const context = notes.filter(Boolean);
  if (!ask && !context.length) return { continue: true };
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      ...(ask ? { permissionDecision: 'ask', permissionDecisionReason: ask } : {}),
      ...(context.length ? { additionalContext: context.join('\n\n') } : {}),
    },
  };
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(raw || '{}'); } catch { /* no payload — answer allow */ }
    // No process.exit() after write: on Windows an immediate exit can drop piped stdout.
    process.stdout.write(JSON.stringify(respond(payload)) + '\n');
  });
}

module.exports = { respond, paidRunKind, paidRunReason, consumeGrant, localPipelineScripts, settledNote, promptRulesNote, siblingNote };

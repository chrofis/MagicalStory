#!/usr/bin/env node
/**
 * Pre-push gate: a fix must reach every sibling of the path it fixes.
 *
 * WHY THIS EXISTS — 2026-09-15. A verification sweep of 173 behaviour commits
 * from a 60-hour window found 27 PARTIAL fixes, and all 27 had one shape: the
 * change landed on one code or prompt path and not its sibling. Among them the
 * story's root cause — a `crowdExpected` metadata field added to the per-page
 * Art Director template (prompts/scene-expansion.txt) and not to the all-pages
 * one (prompts/scene-expansion-all.txt) that the live beats pipeline actually
 * runs. The field was therefore false on all 16 pages, nine of which then took
 * an `extra_character` CRITICAL for correctly-drawn crowds.
 *
 * A skill describing this failure class (.claude/skills/fixing-sibling-paths)
 * had existed for five weeks and prevented none of the 27: a skill is advisory,
 * read only by a session that chooses to invoke it. So the sibling relationship
 * is now DATA (scripts/admin/sibling-registry.json) with two mechanical readers
 * — this gate, and tests/unit/sibling-parity.test.ts.
 *
 * WHAT IT CHECKS — for each commit in the push range: if the commit touches some
 * members of a declared sibling set but not all of them, that is a partial fix.
 * Two things make it pass anyway, both deliberate:
 *   1. The push's FULL range covers the missing members. A fix split across two
 *      commits of one push is a complete fix; only the push ships.
 *   2. The commit message carries `Siblings-Checked: <reason>`. The escape is a
 *      statement, not a silencer — write why the sibling needs no change.
 * EVERY set blocks. A `severity: "warn"` tier existed for one day and the owner
 * retired it on 2026-09-15 — the marker is the one escape, and it leaves a written
 * reason behind where a warn tier left nothing.
 *
 * FAIL CLOSED. If the registry is missing or malformed, or git cannot be read,
 * this exits non-zero. A gate that waves a push through on its own error is a
 * gate nobody can rely on.
 *
 * Usage:
 *   node scripts/admin/check-sibling-paths.js               # gate: the push range
 *   node scripts/admin/check-sibling-paths.js --range A..B  # judge any range
 *   node scripts/admin/check-sibling-paths.js --list        # print the registry
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const REGISTRY = path.join(__dirname, 'sibling-registry.json');
// Same-commit marker: "Siblings-Checked: <reason>" on the commit itself.
const MARKER = /^\s*Siblings-Checked:\s*\S/mi;
// Vouching marker: "Siblings-Checked: <sha-prefix> — <reason>". A LATER commit in
// the same push range vouches for an EARLIER one. This exists because the honest
// catch-up case cannot use the same-commit marker without a rebase: the sibling
// was fixed in a commit that has already been pushed, so the range cannot cover
// it, and rewording the blocked commit rewrites every hash after it — hashes that
// handoff notes cite. A vouch is an added commit, so history is preserved.
// Separator is an em dash or a plain hyphen; the reason is mandatory.
const NL = String.fromCharCode(10);
const VOUCH = /^[ 	]*Siblings-Checked:[ 	]*([0-9a-fA-F]{7,40})[ 	]*(?:—|--?)[ 	]*(\S.*)$/gmi;

function die(msg) {
  console.error('');
  console.error(`check-sibling-paths: ${msg}`);
  process.exit(1);
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function loadRegistry() {
  let raw;
  try {
    raw = fs.readFileSync(REGISTRY, 'utf8');
  } catch {
    die(`registry not readable at ${path.relative(ROOT, REGISTRY)} — this gate fails closed rather than waving a push through.`);
  }
  let reg;
  try {
    reg = JSON.parse(raw);
  } catch (e) {
    die(`registry is not valid JSON (${e.message}) — fix it; the gate cannot judge a push without it.`);
  }
  if (!reg || !Array.isArray(reg.sets)) die('registry has no `sets` array.');
  for (const s of reg.sets) {
    if (!s.id || !Array.isArray(s.members) || s.members.length < 2) {
      die(`registry set ${s && s.id ? `"${s.id}"` : '(unnamed)'} needs an id and at least two members.`);
    }
    if (s.severity && s.severity !== 'block') {
      die(`registry set "${s.id}" declares severity "${s.severity}". The warn tier was retired by the owner on 2026-09-15 — every set blocks, and the Siblings-Checked marker (same-commit or vouching) is the one escape. Remove the field or set it to "block".`);
    }
    for (const m of s.members) {
      if (!fs.existsSync(path.join(ROOT, m))) {
        die(`registry set "${s.id}" names a member that does not exist: ${m}. A stale member makes the set unenforceable — fix or remove it.`);
      }
    }
  }
  return reg;
}

/** Commits this push would send, oldest first. Falls back to the upstream branch. */
function pushRange() {
  const explicit = process.argv.indexOf('--range');
  if (explicit !== -1) {
    const r = process.argv[explicit + 1];
    if (!r) die('--range needs an argument, e.g. --range origin/staging..HEAD');
    return r;
  }
  const candidates = [];
  try {
    candidates.push(`${git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])}..HEAD`);
  } catch { /* no upstream configured */ }
  candidates.push('origin/staging..HEAD', 'origin/master..HEAD');
  for (const range of candidates) {
    try {
      git(['rev-list', '--max-count=1', range]);
      return range;
    } catch { /* unresolvable — try the next */ }
  }
  die('no push range could be resolved (no upstream, no origin/staging, no origin/master).');
}

function commitsIn(range) {
  let out;
  try {
    out = git(['rev-list', '--reverse', '--no-merges', range]);
  } catch (e) {
    die(`could not list commits for ${range}: ${e.message}`);
  }
  return out ? out.split('\n').map(s => s.trim()).filter(Boolean) : [];
}

function filesOf(sha) {
  const out = git(['show', '--pretty=format:', '--name-only', '--diff-filter=ACMR', sha]);
  return new Set(out.split('\n').map(s => s.trim().replace(/\\/g, '/')).filter(Boolean));
}

function messageOf(sha) {
  return git(['log', '-1', '--format=%B', sha]);
}


/**
 * Pure decision core — no git, no filesystem. Exported so the vouching rules can
 * be tested against synthetic history instead of a scratch repository.
 *
 * @param commits [{ sha, message, files: string[] }] oldest first, the push range
 * @param sets    registry sets
 * @returns { blocks, warns, vouchErrors } — vouchErrors is fatal (fail closed)
 */
function analyze(commits, sets) {
  const inRange = commits.map(c => c.sha);
  const rangeFiles = new Set();
  for (const c of commits) for (const f of c.files) rangeFiles.add(f);

  // Collect vouches from every commit in the range, resolving each sha prefix
  // against the range itself. A prefix that is ambiguous or names a commit
  // outside the push is an ERROR, never a silent pass: a vouch nobody can
  // attribute is exactly the loophole this marker must not become.
  const vouchedBy = new Map(); // full sha -> { by, reason }
  const vouchErrors = [];
  for (const c of commits) {
    VOUCH.lastIndex = 0;
    let m;
    while ((m = VOUCH.exec(c.message)) !== null) {
      const prefix = m[1].toLowerCase();
      const reason = m[2].trim();
      const hits = inRange.filter(sha => sha.toLowerCase().startsWith(prefix));
      if (hits.length === 0) {
        vouchErrors.push(`${c.sha.slice(0, 9)} vouches for "${prefix}", which is not a commit in this push range. A vouch may only excuse a commit being pushed.`);
        continue;
      }
      if (hits.length > 1) {
        vouchErrors.push(`${c.sha.slice(0, 9)} vouches for "${prefix}", which is ambiguous in this range (${hits.map(h => h.slice(0, 9)).join(', ')}). Use a longer prefix.`);
        continue;
      }
      if (hits[0] === c.sha) {
        vouchErrors.push(`${c.sha.slice(0, 9)} vouches for itself. Use the plain "Siblings-Checked: <reason>" form for the commit's own siblings.`);
        continue;
      }
      vouchedBy.set(hits[0], { by: c.sha.slice(0, 9), reason });
    }
  }

  const blocks = [];
  const warns = [];
  for (const c of commits) {
    const touched = new Set(c.files);
    const selfExcused = MARKER.test(c.message) && !hasOnlyVouches(c.message);
    const vouch = vouchedBy.get(c.sha) || null;
    const subject = c.message.split(NL)[0];

    for (const set of sets) {
      const hit = set.members.filter(m => touched.has(m));
      if (hit.length === 0 || hit.length === set.members.length) continue;
      const missing = set.members.filter(m => !touched.has(m));
      // Covered elsewhere in the same push? Then the push is complete.
      if (missing.every(m => rangeFiles.has(m))) continue;
      const entry = {
        sha: c.sha.slice(0, 9), subject, set,
        changed: hit, missing: missing.filter(m => !rangeFiles.has(m)),
      };
      // Every set blocks (owner, 2026-09-15). `warns` now holds only EXCUSED
      // pairs, kept visible so an escape is never silent.
      if (selfExcused) warns.push({ ...entry, excused: true });
      else if (vouch) warns.push({ ...entry, excused: true, vouch });
      else blocks.push(entry);
    }
  }
  return { blocks, warns, vouchErrors };
}

/** True when every Siblings-Checked line in the message is a vouch for ANOTHER
 *  commit — such a line must not also excuse the vouching commit's own siblings. */
function hasOnlyVouches(message) {
  const all = message.split(NL).filter(l => /^[ 	]*Siblings-Checked:/i.test(l));
  if (all.length === 0) return false;
  return all.every(l => {
    VOUCH.lastIndex = 0;
    return VOUCH.test(l);
  });
}

function main() {
  const reg = loadRegistry();

  if (process.argv.includes('--list')) {
    console.log(`sibling registry — ${reg.sets.length} file sets, ${(reg.withinFile || []).length} within-file sets\n`);
    for (const s of reg.sets) {
      console.log(`  ${s.id}  [block]  axis: ${s.axis}`);
      for (const m of s.members) console.log(`      ${m}`);
      console.log(`      ${s.reason}\n`);
    }
    for (const w of reg.withinFile || []) {
      console.log(`  ${w.id}  [block]  within ${w.file} — every /${w.blockPattern}/ block must contain "${w.mustContain}"\n`);
    }
    return;
  }

  const range = pushRange();
  const commits = commitsIn(range);
  if (commits.length === 0) {
    console.log(`check-sibling-paths: no commits in ${range} — nothing to check.`);
    return;
  }

  const { blocks, warns, vouchErrors } = analyze(
    commits.map(sha => ({ sha, message: messageOf(sha), files: [...filesOf(sha)] })),
    reg.sets
  );

  if (vouchErrors.length) {
    console.error('');
    console.error('check-sibling-paths: BLOCKED — a Siblings-Checked vouch could not be attributed.');
    console.error('');
    for (const e of vouchErrors) console.error(`  ✗ ${e}`);
    console.error('');
    console.error('Syntax: Siblings-Checked: <sha-prefix ≥7> — <why the sibling needs no change>');
    process.exit(1);
  }

  const render = (e, prefix) => {
    console.error(`${prefix} ${e.sha}  ${e.subject}`);
    console.error(`    set:     ${e.set.id}   (axis: ${e.set.axis})`);
    console.error(`    changed: ${e.changed.join(', ')}`);
    console.error(`    MISSING: ${e.missing.join(', ')}`);
    if (e.vouch) console.error(`    vouched by ${e.vouch.by}: ${e.vouch.reason}`);
    console.error(`    why they move together: ${e.set.reason}`);
    console.error('');
  };

  for (const w of warns) {
    render(w, `check-sibling-paths: EXCUSED${w.vouch ? ` (vouched by ${w.vouch.by})` : ' (Siblings-Checked)'}`);
  }

  if (blocks.length === 0) {
    console.log(`check-sibling-paths: ${commits.length} commit(s) in ${range} — no unexplained partial fixes.`);
    return;
  }

  console.error('');
  console.error(`check-sibling-paths: BLOCKED — ${blocks.length} commit/set pair(s) changed one sibling path and not the others.`);
  console.error('');
  for (const b of blocks) render(b, '  ✗');
  console.error('Fix the missing sibling(s) in this push, or — if they genuinely need no');
  console.error('change — say so in the commit message and amend:');
  console.error('');
  console.error('    Siblings-Checked: <why the sibling needs no change>');
  console.error('');
  console.error('Or, without rewriting history, add ONE later commit to the same push');
  console.error('that vouches for it — attribution stays visible in the gate output:');
  console.error('');
  console.error('    Siblings-Checked: <sha-prefix ≥7> — <why the sibling needs no change>');
  console.error('');
  console.error('Registry: scripts/admin/sibling-registry.json   Explainer: docs/sibling-paths.md');
  process.exit(1);
}

module.exports = { analyze, MARKER, VOUCH };

if (require.main !== module) return;

try {
  main();
} catch (e) {
  // Fail closed: an unexpected error is not permission to push.
  die(`unexpected error, refusing the push rather than failing open: ${e && e.stack ? e.stack : e}`);
}

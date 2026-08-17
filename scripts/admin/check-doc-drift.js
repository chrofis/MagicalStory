#!/usr/bin/env node
/**
 * Pre-push gate: documentation that asserts a code value must still be true.
 *
 * WHY THIS EXISTS — 2026-08-17. `MODEL_DEFAULTS.figureDetectionBackend` flipped
 * from 'gemini' to 'grounding-dino', and five documents kept saying the old
 * thing: docs/image-routing.md ("prod runs the Gemini backend"),
 * image-generation-methods.html ("staging; prod stays gemini"),
 * research-log.html ("shipped behind flag (staging)"), a decisions.md entry, and
 * CLAUDE.md's key-file list. Every one of them would have sent a future session
 * down the wrong path — one of them explicitly implies the scene-composite
 * feature always aborts in production, which had stopped being true.
 *
 * The existing rule ("log every architectural decision") did not fail here: the
 * decisions entries WERE written. What has no owner is the opposite direction —
 * a document making a claim that a later code change quietly falsifies. Prose
 * cannot be diffed against code, so the claims that matter carry an assertion
 * the machine can evaluate.
 *
 * SYNTAX — anywhere in any file under docs/, plus CLAUDE.md and README.md:
 *
 *   <!-- ASSERT models.figureDetectionBackend === 'grounding-dino' -->
 *   <!-- ASSERT models.figureDetectionEligibleStyles includes 'watercolor' -->
 *   <!-- ASSERT credits.STORY_COST !== 0 -->
 *
 * Left side is a dot-path into a NAMESPACE (below). Operators: === !== includes.
 * Right side is JSON ('single quotes' accepted). Anything unparseable is a hard
 * failure, not a skip: a typo that silently stops checking is the exact failure
 * mode this gate exists to prevent.
 *
 * Usage:
 *   node scripts/admin/check-doc-drift.js         # gate (all assertions)
 *   node scripts/admin/check-doc-drift.js --list  # show every assertion + value
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// What a document is allowed to assert about. Add a namespace here rather than
// widening the expression language — this stays a lookup, never an eval, so a
// document can never execute anything.
const NAMESPACES = {
  get models() { return require(path.join(ROOT, 'server/config/models.js')).MODEL_DEFAULTS; },
  get textModels() { return require(path.join(ROOT, 'server/config/models.js')).TEXT_MODELS; },
  get credits() { return require(path.join(ROOT, 'server/config/credits.js')); },
};

const SCAN_ROOTS = ['docs', 'CLAUDE.md', 'README.md'];
const SCAN_EXT = /\.(md|html|txt)$/i;
const ASSERT_RE = /<!--\s*ASSERT\s+([\s\S]*?)\s*-->/g;

function walk(p, out = []) {
  const abs = path.join(ROOT, p);
  if (!fs.existsSync(abs)) return out;
  const st = fs.statSync(abs);
  if (st.isFile()) { if (SCAN_EXT.test(abs)) out.push(p); return out; }
  for (const e of fs.readdirSync(abs)) {
    if (e === 'archive' || e === 'node_modules') continue;   // archive is history on purpose
    walk(path.join(p, e), out);
  }
  return out;
}

function resolvePath(expr) {
  const [ns, ...rest] = expr.split('.');
  if (!(ns in NAMESPACES)) throw new Error(`unknown namespace "${ns}" (known: ${Object.keys(NAMESPACES).join(', ')})`);
  let v = NAMESPACES[ns];
  for (const key of rest) {
    if (v == null) throw new Error(`"${expr}" is not reachable — "${key}" has no parent`);
    v = v[key];
  }
  return v;
}

function parseLiteral(raw) {
  const s = raw.trim();
  try { return JSON.parse(s); } catch { /* try single quotes */ }
  try { return JSON.parse(s.replace(/^'([\s\S]*)'$/, '"$1"')); } catch { /* fall through */ }
  throw new Error(`right side is not a JSON literal: ${s}`);
}

function evaluate(body) {
  const m = body.match(/^(\S+)\s+(===|!==|includes)\s+([\s\S]+)$/);
  if (!m) throw new Error(`cannot parse assertion (expected "<path> <===|!==|includes> <literal>"): ${body}`);
  const [, lhsPath, op, rhsRaw] = m;
  const actual = resolvePath(lhsPath);
  const expected = parseLiteral(rhsRaw);
  let ok;
  if (op === '===') ok = actual === expected;
  else if (op === '!==') ok = actual !== expected;
  else ok = Array.isArray(actual) ? actual.includes(expected) : String(actual ?? '').includes(String(expected));
  return { ok, lhsPath, op, expected, actual };
}

const files = SCAN_ROOTS.flatMap(r => walk(r));
const failures = [];
const all = [];

for (const rel of files) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const lines = text.split('\n');
  ASSERT_RE.lastIndex = 0;
  let m;
  while ((m = ASSERT_RE.exec(text)) !== null) {
    const line = text.slice(0, m.index).split('\n').length;
    const body = m[1].replace(/\s+/g, ' ').trim();
    let res;
    try {
      res = evaluate(body);
    } catch (err) {
      failures.push({ rel, line, body, why: err.message });
      continue;
    }
    all.push({ rel, line, body, ...res });
    if (!res.ok) {
      failures.push({
        rel, line, body,
        why: `claims ${res.lhsPath} ${res.op} ${JSON.stringify(res.expected)} — actual: ${JSON.stringify(res.actual)}`,
        // The line AFTER the marker: the prose the assertion guards, which is
        // what has to change when it fires.
        context: (lines[line] || lines[line - 2] || '').trim().slice(0, 100),
      });
    }
  }
}

if (process.argv.includes('--list')) {
  if (!all.length) console.log('(no assertions found)');
  for (const a of all) console.log(`${a.ok ? 'ok  ' : 'FAIL'} ${a.rel}:${a.line}  ${a.body}   [actual: ${JSON.stringify(a.actual)}]`);
  process.exit(0);
}

if (failures.length) {
  console.error(`\ncheck-doc-drift: ${failures.length} documentation claim(s) no longer true\n`);
  for (const f of failures) {
    console.error(`  ${f.rel}:${f.line}`);
    if (f.context) console.error(`    near: "${f.context}"`);
    console.error(`    ${f.why}\n`);
  }
  console.error('  Fix the document (or the code). If the claim is now wrong, the prose around');
  console.error('  it is wrong too — that is the point of the marker.\n');
  process.exit(1);
}

console.log(`check-doc-drift: OK (${all.length} assertion${all.length === 1 ? '' : 's'})`);

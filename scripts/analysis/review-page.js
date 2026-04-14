#!/usr/bin/env node
/**
 * Per-page review focused on the hint → expansion → image causal chain.
 *
 * Primary sections (top of output, what matters most):
 *   1. PAGE TEXT — what the reader sees in the book
 *   2. SCENE HINT — structured output from the unified pass (outlineExtract)
 *   3. SCENE EXPANSION — prose + structured metadata produced from the hint
 *   4. DIFFERENCES — what the expansion added, dropped, or changed vs the hint
 *
 * Secondary sections follow (scores, issues, retries) — skim these after
 * you've identified the starting point of the problem above.
 *
 * Usage:
 *   node scripts/analysis/review-page.js <storyId|latest> <pageNumber>
 *   node scripts/analysis/review-page.js latest 3            # most-recent story
 *   node scripts/analysis/review-page.js <id> 3 --full       # also print full prompt + fix targets
 */

require('dotenv').config();
const { Pool } = require('pg');

const VERBOSE = process.argv.includes('--full');

async function main() {
  const storyArg = process.argv[2];
  const pageNum = parseInt(process.argv[3], 10);

  if (!storyArg || !pageNum) {
    console.error('Usage: node scripts/analysis/review-page.js <storyId|latest> <pageNumber> [--full]');
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Set DATABASE_URL or DATABASE_PUBLIC_URL');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  try {
    let row;
    if (storyArg === 'latest') {
      const r = await pool.query("SELECT id, data FROM stories ORDER BY created_at DESC LIMIT 1");
      row = r.rows[0];
    } else {
      const r = await pool.query("SELECT id, data FROM stories WHERE id = $1", [storyArg]);
      row = r.rows[0];
    }
    if (!row) { console.error('Story not found:', storyArg); process.exit(1); }

    const d = row.data || {};
    const scenes = d.sceneImages || [];
    const scene = scenes.find((s) => s.pageNumber === pageNum) || scenes[pageNum - 1];
    if (!scene) {
      console.error(`Page ${pageNum} not found (have ${scenes.length})`);
      process.exit(1);
    }

    const hint = parseHint(scene.outlineExtract);
    const { prose, metadata } = splitExpansion(scene.description);

    // =========================================================================
    // HEADER
    // =========================================================================
    const title = d.title || d.storyTitle || '(untitled)';
    hr('=', `${title}  —  Page ${pageNum} of ${scenes.length}`);
    console.log(`Story ID:   ${row.id}`);

    // =========================================================================
    // 1. PAGE TEXT
    // =========================================================================
    hr('-', '1. PAGE TEXT  (printed in the book)');
    console.log(scene.text || '(no text)');

    // =========================================================================
    // 2. SCENE HINT (from outline)
    // =========================================================================
    hr('-', '2. SCENE HINT  (from unified outline pass)');
    printHint(hint);

    // =========================================================================
    // 3. SCENE EXPANSION (prose + metadata)
    // =========================================================================
    hr('-', '3. SCENE EXPANSION  (prose written from the hint)');
    console.log(prose || '(no expansion prose)');
    if (metadata) {
      console.log();
      console.log('--- expansion metadata ---');
      printMetadata(metadata);
    }

    // =========================================================================
    // 4. DIFFERENCES (hint → expansion)
    // =========================================================================
    hr('-', '4. DIFFERENCES  (hint → expansion)');
    printDifferences(hint, metadata, prose || '');

    // =========================================================================
    // 5. SCORES & REPAIR OUTCOME (short)
    // =========================================================================
    hr('-', '5. SCORES  &  REPAIR');
    console.log(`quality=${scene.qualityScore ?? '?'}  semantic=${scene.semanticScore ?? '?'}  verdict=${scene.verdict?.verdict || scene.verdict || '?'}  regen=${scene.wasRegenerated ?? false}`);
    const rh = scene.retryHistory || [];
    if (rh.length > 0) {
      console.log(`repair rounds: ${rh.length}`);
      for (const [i, r] of rh.entries()) {
        const score = r.score ?? r.finalScore ?? '?';
        const src = r.source || r.type || '?';
        console.log(`  [${i}] ${src} — score ${score}`);
      }
    }
    const vs = scene.imageVersions || [];
    if (vs.length > 1) {
      console.log(`versions kept: ${vs.length} — ${vs.map(v => `${v.source || v.type}=${v.score ?? '?'}`).join(', ')}`);
    }

    // =========================================================================
    // 6. ISSUES (short)
    // =========================================================================
    hr('-', '6. ISSUES');
    if (scene.issuesSummary) {
      console.log('summary: ' + scene.issuesSummary);
      console.log();
    }
    const fix = scene.fixableIssues || [];
    if (fix.length === 0) {
      console.log('quality: (no fixable issues)');
    } else {
      console.log(`quality: ${fix.length} issue(s)`);
      for (const iss of fix) {
        const sev = iss.severity || '?';
        const type = iss.type || '';
        const desc = iss.description || iss.problem || iss.issue || '';
        console.log(`  [${sev}] (${type}) ${desc}`);
      }
    }
    const sem = scene.semanticResult || {};
    const semIssues = sem.issues || sem.semanticIssues || [];
    if (semIssues.length === 0) {
      console.log('semantic: (no issues)');
    } else {
      console.log(`semantic: ${semIssues.length} issue(s)`);
      for (const iss of semIssues) {
        console.log(`  [${iss.severity || '?'}] ${iss.type || ''} ${iss.item ? `(${iss.item})` : ''}: ${iss.problem || iss.description || ''}`);
      }
    }

    // =========================================================================
    // 7. BBOX DETECTION (brief)
    // =========================================================================
    hr('-', '7. BBOX DETECTION');
    const bb = scene.bboxDetection || {};
    const figs = bb.figures || [];
    const objs = bb.objects || [];
    console.log(`figures: ${figs.length}   objects: ${objs.length}`);
    for (const f of figs) {
      const conf = f.confidence || '?';
      const name = f.name || 'UNKNOWN';
      console.log(`  figure: ${name.padEnd(18)} conf=${conf}`);
    }
    for (const o of objs) {
      const found = o.found === false ? 'MISSING' : 'found';
      console.log(`  object: ${(o.name || o.label || '?').padEnd(18)} ${found}`);
    }

    // =========================================================================
    // 8. (--full) FULL IMAGE PROMPT + FIX TARGETS
    // =========================================================================
    if (VERBOSE) {
      hr('-', '8. FULL IMAGE API PROMPT');
      console.log(scene.prompt || '(none)');

      hr('-', '9. FIX TARGETS (bbox-enriched for inpaint)');
      if ((scene.fixTargets || []).length === 0) {
        console.log('(none)');
      } else {
        for (const [i, t] of scene.fixTargets.entries()) {
          console.log(`[${i}] ${JSON.stringify(t, null, 2)}`);
        }
      }
    } else {
      console.log();
      console.log('(re-run with --full for image prompt + fix targets)');
    }

    hr('=', 'END');
  } finally {
    await pool.end();
  }
}

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function hr(ch, label) {
  console.log();
  console.log(ch.repeat(78));
  console.log(label);
  console.log(ch.repeat(78));
}

/** Parse outlineExtract which may be a JSON string, fenced JSON, or already an object. */
function parseHint(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  const s = String(raw).trim();
  // Strip ```json ... ``` fences if present
  const cleaned = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch { /* ignore */ }
  // Fall back: extract the first {...} block
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* ignore */ }
  }
  return { _raw: s };
}

/** Split scene.description into prose paragraph and parsed metadata. */
function splitExpansion(raw) {
  if (!raw || typeof raw !== 'string') return { prose: raw || '', metadata: null };
  const metaIdx = raw.indexOf('---METADATA---');
  if (metaIdx < 0) return { prose: raw.trim(), metadata: null };
  const prose = raw.substring(0, metaIdx).trim();
  const metaRaw = raw.substring(metaIdx + '---METADATA---'.length).trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  let metadata = null;
  try { metadata = JSON.parse(metaRaw); }
  catch {
    const m = metaRaw.match(/\{[\s\S]*\}/);
    if (m) { try { metadata = JSON.parse(m[0]); } catch { /* ignore */ } }
  }
  return { prose, metadata };
}

function printHint(h) {
  if (!h) { console.log('(no hint)'); return; }
  if (h._raw) { console.log(h._raw); return; }
  if (h.description) console.log(`description: ${h.description}`);
  if (Array.isArray(h.characters) && h.characters.length > 0) {
    console.log(`characters (${h.characters.length}):`);
    for (const c of h.characters) {
      const parts = [c.name];
      if (c.position) parts.push(`position=${c.position}`);
      if (c.clothing) parts.push(`clothing=${c.clothing}`);
      if (c.perspective) parts.push(`perspective=${c.perspective}`);
      if (c.depth) parts.push(`depth=${c.depth}`);
      console.log('  - ' + parts.join(', '));
    }
  }
  if (Array.isArray(h.objects) && h.objects.length > 0) {
    console.log(`objects: ${h.objects.join(', ')}`);
  }
  const kv = [
    ['setting', h.setting],
    ['time', h.time],
    ['weather', h.weather],
    ['shot', h.shot],
    ['background', h.background],
  ].filter(([, v]) => v);
  for (const [k, v] of kv) console.log(`${k}: ${v}`);
  if (h.emptyScenePrompt) {
    console.log(`emptyScenePrompt: ${truncate(h.emptyScenePrompt, 200)}`);
  }
}

function printMetadata(m) {
  if (!m) { console.log('(no metadata)'); return; }
  if (Array.isArray(m.characters) && m.characters.length > 0) {
    console.log(`characters (${m.characters.length}):`);
    for (const c of m.characters) {
      const parts = [c.name];
      if (c.position) parts.push(`position=${c.position}`);
      if (c.clothing) parts.push(`clothing=${c.clothing}`);
      if (c.perspective) parts.push(`perspective=${c.perspective}`);
      if (c.depth) parts.push(`depth=${c.depth}`);
      console.log('  - ' + parts.join(', '));
    }
  }
  if (Array.isArray(m.objects) && m.objects.length > 0) {
    console.log(`objects: ${m.objects.join(', ')}`);
  }
  if (Array.isArray(m.interactions) && m.interactions.length > 0) {
    console.log(`interactions (${m.interactions.length}):`);
    for (const i of m.interactions) {
      console.log(`  - ${i.character} → ${i.object}: ${i.where || '(no where)'}`);
    }
  }
  if (m.textPosition) console.log(`textPosition: ${m.textPosition}`);
  if (m.emptyScenePrompt) console.log(`emptyScenePrompt: ${truncate(m.emptyScenePrompt, 200)}`);
}

/**
 * Compare hint vs expansion metadata. Reports:
 *   - characters ADDED in expansion that weren't in hint
 *   - characters DROPPED from hint in expansion
 *   - character attributes CHANGED (position, clothing, depth, etc.)
 *   - objects ADDED / DROPPED
 *   - setting/shot CHANGED
 *   - characters MENTIONED IN PROSE but not in the expansion metadata array
 */
function printDifferences(hint, meta, prose) {
  if (!hint && !meta) { console.log('(nothing to compare — missing hint and expansion)'); return; }
  if (!hint) { console.log('(no scene hint available — cannot compare)'); return; }
  if (!meta) { console.log('(no expansion metadata parsed — cannot compare structurally)'); return; }

  const findings = [];

  // ---- characters ----
  const hintChars = (hint.characters || []).map(c => ({ ...c, _key: norm(c.name) }));
  const expChars = (meta.characters || []).map(c => ({ ...c, _key: norm(c.name) }));
  const hintKeys = new Set(hintChars.map(c => c._key));
  const expKeys = new Set(expChars.map(c => c._key));

  const added = expChars.filter(c => !hintKeys.has(c._key));
  const dropped = hintChars.filter(c => !expKeys.has(c._key));
  for (const c of added) findings.push(`+ character ADDED in expansion: ${c.name} (${[c.position, c.clothing].filter(Boolean).join(', ')})`);
  for (const c of dropped) findings.push(`- character DROPPED from hint: ${c.name} (${[c.position, c.clothing].filter(Boolean).join(', ')})`);

  // Character attribute changes for shared characters.
  // Quiet rules:
  //   - skip position when expansion dropped it for ALL characters (old schema,
  //     before scene-expansion.txt required the position field)
  //   - skip position refinements ("center" → "center foreground")
  //   - skip clothing refinements where expansion value starts with/contains hint value
  const expansionDroppedAllPositions = expChars.length > 0 && expChars.every(c => !c.position);
  for (const h of hintChars) {
    const e = expChars.find(c => c._key === h._key);
    if (!e) continue;
    const diffs = [];
    for (const attr of ['position', 'clothing', 'perspective', 'depth']) {
      const hv = h[attr] ? String(h[attr]).toLowerCase() : null;
      const ev = e[attr] ? String(e[attr]).toLowerCase() : null;
      if (hv === ev) continue;
      if (!hv && !ev) continue;
      if (attr === 'position' && expansionDroppedAllPositions) continue;
      if (attr === 'position' && hv && ev && (ev.includes(hv) || hv.includes(ev))) continue;
      if (attr === 'clothing' && hv && ev && (ev.startsWith(hv) || hv.startsWith(ev))) continue;
      diffs.push(`${attr}: "${h[attr] || '—'}" → "${e[attr] || '—'}"`);
    }
    if (diffs.length > 0) {
      findings.push(`~ character CHANGED ${h.name}: ${diffs.join('; ')}`);
    }
  }

  // characters mentioned in prose but not in expansion metadata
  const knownNames = new Set([...hintChars, ...expChars].map(c => c.name).filter(Boolean));
  const mentionedInProse = new Set();
  for (const name of knownNames) {
    const re = new RegExp(`\\b${escapeRegex(name)}\\b`, 'i');
    if (re.test(prose)) mentionedInProse.add(norm(name));
  }
  const mentionedButNotListed = hintChars
    .filter(c => mentionedInProse.has(c._key) && !expKeys.has(c._key))
    .map(c => c.name);
  // Also check the page text / hint description / prose for characters
  // that are clearly involved but missing from BOTH hint and expansion metadata.
  // (Not easy without the full character list — skip.)
  if (mentionedButNotListed.length > 0) {
    findings.push(`! character mentioned in prose but NOT in expansion metadata: ${mentionedButNotListed.join(', ')}`);
  }

  // ---- objects ----
  const hintObjs = normList(hint.objects);
  const expObjs = normList(meta.objects);
  const objAdded = expObjs.filter(o => !hintObjs.includes(o));
  const objDropped = hintObjs.filter(o => !expObjs.includes(o));
  for (const o of objAdded) findings.push(`+ object ADDED in expansion: ${o}`);
  for (const o of objDropped) findings.push(`- object DROPPED from hint: ${o}`);

  // ---- setting / shot / time / weather / background ----
  // These fields live ONLY in the hint schema; the expansion folds them into
  // the prose (no structured counterpart). Only flag when the expansion prose
  // contradicts the hint — e.g. hint shot="close-up" but prose describes a wide shot.
  const proseLower = (prose || '').toLowerCase();
  const shotMismatches = {
    'close-up': /\b(wide|aerial|long|establishing)\s+shot\b/,
    'wide': /\bclose[-\s]?up\b/,
    'aerial': /\bground[-\s]?level|\beye[-\s]?level\b/,
  };
  if (hint.shot && shotMismatches[hint.shot.toLowerCase()]?.test(proseLower)) {
    findings.push(`~ shot MISMATCH: hint="${hint.shot}" but expansion prose describes a different shot`);
  }
  if (hint.time) {
    const timeWord = hint.time.toLowerCase();
    const opposites = { night: /\b(day|daylight|noon|morning|afternoon)\b/, day: /\b(night|midnight|evening|twilight)\b/,
                         afternoon: /\b(night|midnight|evening)\b/, morning: /\b(night|midnight|evening|afternoon)\b/ };
    if (opposites[timeWord]?.test(proseLower)) {
      findings.push(`~ time MISMATCH: hint="${hint.time}" but expansion prose implies a different time`);
    }
  }
  if (hint.weather && hint.weather !== 'n/a') {
    if (!proseLower.includes(hint.weather.toLowerCase())) {
      // soft signal — just note that the weather word isn't anywhere in the prose
      findings.push(`? weather "${hint.weather}" from hint not explicitly mentioned in expansion prose`);
    }
  }

  // ---- emptyScenePrompt ----
  // Minor rewording is normal; only flag when length changed by more than 40%.
  if (hint.emptyScenePrompt && meta.emptyScenePrompt) {
    const hLen = hint.emptyScenePrompt.length;
    const eLen = meta.emptyScenePrompt.length;
    const drift = Math.abs(eLen - hLen) / Math.max(hLen, 1);
    if (drift > 0.4) {
      findings.push(`~ emptyScenePrompt substantially rewritten (length ${hLen} → ${eLen})`);
    }
  }

  // ---- output ----
  if (findings.length === 0) {
    console.log('(no structural differences — expansion followed the hint exactly)');
  } else {
    for (const f of findings) console.log(f);
  }
}

function norm(s) { return (s || '').trim().toLowerCase(); }
function normList(list) { return (list || []).filter(Boolean).map(x => String(x).trim()); }
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function truncate(s, n) { s = String(s); return s.length > n ? s.substring(0, n) + '…' : s; }

main().catch((e) => {
  console.error('Error:', e.message);
  console.error(e.stack);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Per-page review focused on the unified-outline → image causal chain.
 *
 * In unified mode, Sonnet produces the scene hint AND the prose in ONE call
 * (no separate Haiku scene-expansion). The "prose" and "hint" shown below
 * are both from that single pass — they are not independent stages.
 *
 * Sections:
 *   1. PAGE TEXT       — what the reader sees in the book
 *   2. SCENE HINT      — structured metadata from the unified pass (outlineExtract)
 *   3. UNIFIED PROSE   — prose portion of the same unified pass
 *   4. REQUESTED SCENE — checklist of what the image should contain
 *   4b. CHANGES        — prose vs hint drift (sanity check on the unified pass)
 *   5. EMPTY SCENE     — background-only prompt (used as [Background] reference, NOT evaluated)
 *   6. VERSION TIMELINE — for each imageVersions[]: input prompt, what eval found,
 *                         what fix was requested for the next version
 *   7. BBOX DETECTION
 *   8. (--full)        — full image prompt + fix targets for the active version
 *
 * Usage:
 *   node scripts/analysis/review-page.js <storyId|latest> <pageNumber>
 *   node scripts/analysis/review-page.js latest 3            # most-recent story
 *   node scripts/analysis/review-page.js <id> 3 --full       # also print full prompt + fix targets
 *
 * Step-by-step mode (one section at a time, easier to read):
 *   ... <id> <page> --step header   → header + page text + scene hint + prose
 *   ... <id> <page> --step empty    → empty-scene prompt + retry QC
 *   ... <id> <page> --step v0       → version 0 only (input + eval)
 *   ... <id> <page> --step v1       → version 1 only
 *   ... <id> <page> --step active   → just active-version summary
 *   ... <id> <page> --step bbox     → bbox detection
 *   ... <id> <page> --step versions → all versions, no other sections
 */

require('dotenv').config();
const { Pool } = require('pg');

const VERBOSE = process.argv.includes('--full');
const STEP_ARG = (() => {
  const i = process.argv.indexOf('--step');
  return i > -1 ? (process.argv[i + 1] || '').toLowerCase() : null;
})();
// When no --step given, every section prints (legacy behavior).
function shouldPrint(step) {
  if (!STEP_ARG) return true;
  if (STEP_ARG === step) return true;
  // 'header' shorthand prints sections 1-4b
  if (STEP_ARG === 'header' && ['header', 'pagetext', 'hint', 'prose', 'requested', 'changes'].includes(step)) return true;
  // 'versions' prints all v* + active
  if (STEP_ARG === 'versions' && (step.startsWith('v') || step === 'active')) return true;
  return false;
}

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
    // Header always prints so user knows what they're looking at.
    hr('=', `${title}  —  Page ${pageNum} of ${scenes.length}`);
    console.log(`Story ID:   ${row.id}`);

    // =========================================================================
    // 1. PAGE TEXT
    // =========================================================================
    if (shouldPrint('pagetext')) {
      hr('-', '1. PAGE TEXT  (printed in the book)');
      console.log(scene.text || '(no text)');
    }

    // =========================================================================
    // 2. SCENE HINT (from outline)
    // =========================================================================
    if (shouldPrint('hint')) {
      hr('-', '2. SCENE HINT  (from unified outline pass)');
      printHint(hint);
    }

    // =========================================================================
    // 3. UNIFIED PROSE (prose portion of the same unified pass, + metadata block)
    // =========================================================================
    if (shouldPrint('prose')) {
      hr('-', '3. UNIFIED PROSE  (prose portion of the unified pass — NOT a separate expansion)');
      console.log(prose || '(no prose)');
      if (metadata) {
        console.log();
        console.log('--- METADATA block ---');
        printMetadata(metadata);
      }
    }

    // =========================================================================
    // 4. REQUESTED SCENE (checklist to hold against the image)
    // =========================================================================
    if (shouldPrint('requested')) {
      hr('-', '4. REQUESTED SCENE  (what the image should show)');
      printRequestedScene(hint, metadata, prose || '', d.visualBible);
    }

    // =========================================================================
    // 4b. CHANGES (hint → expansion) — kept as a smaller subsection
    // =========================================================================
    if (shouldPrint('changes')) {
      hr('-', '4b. CHANGES  (what the expansion altered from the hint)');
      printDifferences(hint, metadata, prose || '');
    }

    // =========================================================================
    // 5. EMPTY SCENE (background reference — NOT evaluated)
    // =========================================================================
    if (shouldPrint('empty')) {
      hr('-', '5. EMPTY SCENE  (used as [Background] reference — no evaluation stored)');
      if (scene.emptyScenePrompt) {
        console.log(`hasEmptySceneImage: ${scene.hasEmptySceneImage ?? false}`);
        console.log();
        console.log('prompt:');
        console.log(scene.emptyScenePrompt);
      } else {
        console.log('(no emptyScenePrompt)');
      }
      console.log();
      console.log('NOTE: the empty-scene image is not scored. No quality/semantic eval runs on it.');
    }

    // =========================================================================
    // 6. VERSION TIMELINE — per-version input prompt, eval, requested next fix
    // =========================================================================
    const vs = scene.imageVersions || [];
    // Active-version summary line is always useful — print at top of versions
    // step OR when caller asked for 'active' specifically.
    if (shouldPrint('active') || shouldPrint('v0') || shouldPrint('v1') || shouldPrint('v2') || shouldPrint('v3') || shouldPrint('v4') || shouldPrint('v5')) {
      hr('-', `ACTIVE VERSION SUMMARY`);
      console.log(`active: quality=${scene.qualityScore ?? '?'}  semantic=${scene.semanticScore ?? '?'}  verdict=${scene.verdict?.verdict || scene.verdict || '?'}  regen=${scene.wasRegenerated ?? false}`);
      console.log(`versions kept: ${vs.length}`);
    }
    if (vs.length === 0 && shouldPrint('active')) {
      console.log('(no imageVersions recorded)');
    }
    for (const [i, v] of vs.entries()) {
      // Per-version step: only print this version if --step v<i>
      if (!shouldPrint(`v${i}`)) continue;
      hr('-', `VERSION v${i}`);
      const src = v.source || v.type || '?';
      const q = v.qualityScore ?? '?';
      const s = v.semanticScore ?? '?';
      const ep = v.entityPenalty != null ? `  entityPenalty=${v.entityPenalty}` : '';
      const rq = v.rawQualityScore != null ? `  raw=${v.rawQualityScore}` : '';
      console.log(`[v${i}] ${src}   type=${v.type || '?'}   model=${v.modelId || '?'}`);
      console.log(`     score: quality=${q}  semantic=${s}${ep}${rq}`);

      console.log();
      if (i === 0) {
        console.log('  >>> WHAT GROK RECEIVED  (full unified-prose image prompt)');
        const p = v.prompt || '';
        console.log(`      prompt length: ${p.length} chars. First 300:`);
        console.log(indent(truncate(p, 300), 8));
      } else {
        // Step 1: the EVAL output of the previous version (the cause).
        const prev = vs[i - 1];
        const prevTargets = prev?.fixTargets || [];
        if (prevTargets.length > 0) {
          console.log(`  >>> WHY THIS REPAIR RAN  (eval flagged on v${i - 1}, with proposed fix)`);
          for (const t of prevTargets) {
            console.log(`      [${t.severity || '?'}] (${t.type || '?'}) ${t.issue || ''}`);
            if (t.fix_instruction || t.fixPrompt) {
              console.log(`        proposed fix → ${t.fix_instruction || t.fixPrompt}`);
            }
          }
          console.log();
        }
        // Step 2: what the inpaint generator actually wrote (frequently shorter
        // than the proposed fix above — and what Grok actually saw).
        console.log(`  >>> WHAT GROK RECEIVED  (inpaint prompt — sent verbatim to Grok)`);
        if (v.inpaintInstruction) {
          console.log(indent(v.inpaintInstruction, 8));
        } else {
          console.log('      (no inpaintInstruction — likely an iterate pass re-ran the full unified prompt)');
        }
        const refCount = (v.inpaintReferenceImages || []).length;
        console.log(`      reference images attached: ${refCount}`);
      }

      console.log();
      console.log(`  >>> WHAT EVAL FOUND IN v${i}  (after Grok produced this version)`);
      if (v.issuesSummary) {
        console.log('    summary: ' + v.issuesSummary);
      }
      const fix = v.fixableIssues || [];
      if (fix.length === 0) {
        console.log('    quality: (no fixable issues)');
      } else {
        console.log(`    quality: ${fix.length} issue(s)`);
        for (const iss of fix) {
          console.log(`      [${iss.severity || '?'}] (${iss.type || ''}) ${iss.description || iss.problem || iss.issue || ''}`);
        }
      }
      const semIssues = (v.semanticResult?.issues) || (v.semanticResult?.semanticIssues) || [];
      if (semIssues.length === 0) {
        console.log('    semantic: (no issues)');
      } else {
        console.log(`    semantic: ${semIssues.length} issue(s)`);
        for (const iss of semIssues) {
          console.log(`      [${iss.severity || '?'}] ${iss.type || ''} ${iss.item ? `(${iss.item})` : ''}: ${iss.problem || iss.description || ''}`);
        }
      }
      console.log();
    }

    // =========================================================================
    // 6b. DUMP IMAGES TO DISK (empty scene + every version, so reviewer can
    //     inspect what the pipeline actually produced rather than guessing)
    // =========================================================================
    if (shouldPrint('dump') || !STEP_ARG) {
      try {
        const fs = require('fs');
        const path = require('path');
        const outDir = path.join(process.cwd(), 'tmp', `review-${row.id}-p${pageNum}`);
        fs.mkdirSync(outDir, { recursive: true });
        const imgRows = await pool.query(
          `SELECT image_type, version_index, image_data
             FROM story_images
            WHERE story_id = $1 AND page_number = $2
            ORDER BY image_type, version_index`,
          [row.id, pageNum]
        );
        hr('-', '6b. DUMPED IMAGES');
        if (imgRows.rows.length === 0) {
          console.log('(no story_images rows for this page)');
        } else {
          console.log(`Output dir: ${outDir}`);
          for (const r2 of imgRows.rows) {
            const data = (r2.image_data || '').replace(/^data:image\/\w+;base64,/, '');
            if (!data) continue;
            const fname = `${r2.image_type}-v${r2.version_index}.png`;
            fs.writeFileSync(path.join(outDir, fname), Buffer.from(data, 'base64'));
            console.log(`  ${fname} (${Math.round(data.length / 1024)} KB)`);
          }
        }
      } catch (e) {
        console.log(`(image dump failed: ${e.message})`);
      }
    }

    // =========================================================================
    // 7. BBOX DETECTION (brief — active version)
    // =========================================================================
    if (shouldPrint('bbox')) {
      hr('-', '7. BBOX DETECTION  (active version)');
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

/**
 * Build a pre-flight checklist of what the image should contain.
 * Pulls from hint + expansion metadata + prose so you can eyeball the rendered
 * image against explicit expectations.
 */
function printRequestedScene(hint, meta, prose, visualBible) {
  if (!hint && !meta) { console.log('(no hint or expansion — nothing to describe)'); return; }

  // One-line description from hint (the human-readable summary)
  const desc = hint?.description || '';
  if (desc) {
    console.log('Description:');
    console.log('  ' + desc);
    console.log();
  }

  // Setting / shot / time / weather / background (prefer hint values)
  const settingParts = [];
  if (hint?.setting) settingParts.push(hint.setting);
  if (hint?.time) settingParts.push(hint.time);
  if (hint?.weather && hint.weather !== 'n/a') settingParts.push(hint.weather);
  if (hint?.shot) settingParts.push(`${hint.shot} shot`);
  if (settingParts.length > 0) {
    console.log(`Setting:  ${settingParts.join(', ')}`);
  }
  if (hint?.background) console.log(`Background: ${hint.background}`);
  console.log();

  // Characters — merge hint entries with expansion metadata entries and interactions.
  // Hint gives position/clothing, expansion interactions give explicit actions ("stirring",
  // "leaning", "reaching toward the tower"), expansion metadata may refine position/perspective.
  const hintChars = hint?.characters || [];
  const expChars = meta?.characters || [];
  const interactions = meta?.interactions || [];
  const allNames = [];
  const seen = new Set();
  for (const c of [...hintChars, ...expChars]) {
    if (!c?.name) continue;
    const k = c.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    allNames.push(c.name);
  }

  if (allNames.length > 0) {
    console.log(`Characters (${allNames.length}):`);
    for (const name of allNames) {
      const h = hintChars.find(c => c.name?.toLowerCase() === name.toLowerCase()) || {};
      const e = expChars.find(c => c.name?.toLowerCase() === name.toLowerCase()) || {};
      // Attribute merge: prefer expansion if it has more detail, else hint
      const position = e.position || h.position;
      const clothing = e.clothing || h.clothing;
      const perspective = e.perspective || h.perspective;
      const depth = e.depth || h.depth;
      const parts = [];
      if (position) parts.push(`position=${position}`);
      if (clothing) parts.push(`clothing=${clothing}`);
      if (perspective) parts.push(`perspective=${perspective}`);
      if (depth) parts.push(`depth=${depth}`);
      console.log(`  ${name}  (${parts.join(', ') || 'no attributes'})`);

      // What this character is doing (from interactions)
      const myInteractions = interactions.filter(i => i.character?.toLowerCase() === name.toLowerCase());
      for (const i of myInteractions) {
        const where = i.where ? `: ${i.where}` : '';
        console.log(`    → ${i.object}${where}`);
      }

      // Gaze / pose signals from hint description
      const gaze = extractGazeFromText(name, desc);
      if (gaze) console.log(`    [gaze] ${gaze}`);
    }
    console.log();
  }

  // Objects — resolve IDs against Visual Bible for readable names
  const hintObjs = hint?.objects || [];
  const metaObjs = meta?.objects || [];
  const allObjs = [...new Set([...hintObjs, ...metaObjs])];
  if (allObjs.length > 0) {
    console.log(`Objects (${allObjs.length}):`);
    for (const id of allObjs) {
      const resolved = resolveVbId(id, visualBible);
      console.log(`  ${id}${resolved ? `  —  ${resolved}` : ''}`);
    }
    console.log();
  }

  // Text-overlay placement
  if (meta?.textPosition || hint?.textPosition) {
    console.log(`Text overlay position: ${meta?.textPosition || hint?.textPosition}`);
  }
}

/**
 * Extract a gaze/facing hint for a specific character from a short description
 * sentence. Looks for patterns like "Werner ... schaut den Drachen direkt an",
 * "Lukas ... Blick auf ... gerichtet".
 */
function extractGazeFromText(name, text) {
  if (!name || !text) return null;
  const lower = text.toLowerCase();
  const nameLower = name.toLowerCase();
  const idx = lower.indexOf(nameLower);
  if (idx < 0) return null;
  // Pull the clause starting at the character's name, up to the next comma or period
  const rest = text.substring(idx);
  const clause = rest.split(/[.!?]|,\s+(?=[A-Z])/)[0];
  // Find verbs that imply gaze/facing direction
  const gazePatterns = [
    /schaut[^.,]*/i, /blick[^.,]*gerichtet/i, /sieht[^.,]*an/i, /looks?[^.,]*at/i,
    /faces?[^.,]*/i, /gazes?[^.,]*at/i, /facing[^.,]*/i,
  ];
  for (const pat of gazePatterns) {
    const m = clause.match(pat);
    if (m) return m[0].trim();
  }
  return null;
}

/** Resolve a VB id (LOC001, ART003, ANI001, CHR001) to a readable name. */
function resolveVbId(id, vb) {
  if (!id || !vb) return null;
  const prefix = String(id).substring(0, 3).toUpperCase();
  const lists = {
    LOC: vb.locations,
    ART: vb.artifacts,
    ANI: vb.animals,
    VEH: vb.vehicles,
    CHR: vb.secondaryCharacters,
  };
  const list = lists[prefix];
  if (!Array.isArray(list)) return null;
  const cleanId = String(id).split('.')[0]; // strip variant suffix (.2 etc.)
  const entry = list.find(e => e?.id === cleanId);
  if (!entry) return null;
  const parts = [];
  if (entry.name) parts.push(entry.name);
  if (prefix === 'ANI' && entry.species) parts.push(`(${entry.species})`);
  return parts.join(' ');
}

function norm(s) { return (s || '').trim().toLowerCase(); }
function normList(list) { return (list || []).filter(Boolean).map(x => String(x).trim()); }
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function truncate(s, n) { s = String(s); return s.length > n ? s.substring(0, n) + '…' : s; }
function indent(s, n) { const pad = ' '.repeat(n); return String(s).split('\n').map(l => pad + l).join('\n'); }

main().catch((e) => {
  console.error('Error:', e.message);
  console.error(e.stack);
  process.exit(1);
});

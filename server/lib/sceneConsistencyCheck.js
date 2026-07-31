/**
 * Scene metadata ↔ scene design consistency — deterministic validator.
 *
 * MECHANICAL PARITY ONLY (owner decision 2026-07-31): this module does exactly
 * what sets and strings can do — name-set comparisons, membership checks, and
 * word matching. It performs NO semantic inference of any kind: no facing
 * logic, no shared-action detection, no pose plausibility. All semantic scene
 * consistency (e.g. "companions walking together must share a facing
 * treatment") belongs to the external outline reviewer — see
 * prompts/outline-review.txt § SEMANTIC SCENE CONSISTENCY and docs/decisions.md.
 *
 * Checks per page (pure string/JSON logic, no model calls):
 *   (a) locked SCENE SEQUENCE cast (Scene N `Cast:` lines in the raw writer
 *       output, when present) vs METADATA characters[] names
 *   (b) METADATA characters[] names vs SCENE prose mentions (both directions;
 *       the prose→metadata direction is limited to KNOWN character names)
 *   (c) interactions[] character/object refs exist in characters[]/objects[]
 *       (objects may also be anchored in background/emptyScenePrompt/prose)
 *   (d) depth word inside the `position` phrase vs the `depth` field
 *   (e) sceneIntent names ⊆ characters[] (limited to KNOWN character names)
 *
 * Output: [{ page, issues: [{ type, detail }] }] — only pages with issues.
 */

const DEPTH_WORDS = ['foreground', 'midground', 'background'];

/** Escape a string for use inside a RegExp. */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive whole-word presence of `name` in `text`. */
function nameMentioned(name, text) {
  if (!name || !text) return false;
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(name)}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

/** Strip a trailing parenthesised annotation from a character name. */
function baseName(name) {
  return String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/** True for Visual-Bible entity ids (CHR001, ANI002, …) which are not prose names. */
function isEntityId(name) {
  return /^(?:CHR|ANI|ART|LOC|VEH|OBJ|CLO)\d{1,4}$/i.test(String(name || '').trim());
}

/**
 * Tolerant METADATA parse: the parser hands us the balanced JSON string, but a
 * stray fence or truncation must not crash the check.
 * @returns {object|null}
 */
function parseMetadata(sceneHint) {
  if (!sceneHint || typeof sceneHint !== 'string') return null;
  const cleaned = sceneHint.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/**
 * Parse the locked SCENE SEQUENCE cast lines from the raw writer output.
 * Returns Map<sceneNumber, castLineString> or an empty Map when the section is
 * absent (text-first variant, trial mode, or rerun without raw output).
 */
function extractSceneSequenceCasts(rawOutput) {
  const casts = new Map();
  if (!rawOutput || typeof rawOutput !== 'string') return casts;
  const secMatch = rawOutput.match(/---\s*SCENE\s+SEQUENCE\s*---\s*([\s\S]*?)(?=---\s*[A-Z][A-Z ]+---|$)/);
  if (!secMatch) return casts;
  const section = secMatch[1];
  const blockRe = /\*\*Scene\s+(\d+)\*\*\s*([\s\S]*?)(?=\*\*Scene\s+\d+\*\*|$)/g;
  let m;
  while ((m = blockRe.exec(section)) !== null) {
    const castMatch = m[2].match(/^\s*Cast:\s*(.+)$/im);
    if (castMatch) casts.set(parseInt(m[1], 10), castMatch[1].trim());
  }
  return casts;
}

/**
 * Run the deterministic consistency check over parsed pages.
 *
 * @param {Array<{pageNumber:number, text?:string, sceneProse?:string, sceneHint?:string}>} pages
 *   Parsed story pages (UnifiedStoryParser.extractPages() shape).
 * @param {string|null} rawOutput - Full raw writer output (for SCENE SEQUENCE
 *   cast lines). Pass null when unavailable — check (a) is skipped.
 * @param {object} [options]
 * @param {string[]} [options.knownCharacterNames] - Cast names from inputData
 *   (main + primary characters). Used for the prose→metadata and sceneIntent
 *   directions where free-text matching needs a closed name list.
 * @returns {Array<{page:number, issues:Array<{type:string, detail:string}>}>}
 */
function checkSceneConsistency(pages, rawOutput = null, options = {}) {
  const knownNames = (options.knownCharacterNames || [])
    .map(n => baseName(n))
    .filter(n => n && n.length >= 2);
  const sequenceCasts = extractSceneSequenceCasts(rawOutput);
  const results = [];

  for (const page of pages || []) {
    const issues = [];
    const pageNumber = page.pageNumber;
    const prose = page.sceneProse || '';
    const meta = parseMetadata(page.sceneHint);

    if (!meta) {
      if (page.sceneHint && String(page.sceneHint).trim()) {
        issues.push({ type: 'metadata_parse_failed', detail: 'METADATA JSON did not parse — downstream consumers will fall back to defaults' });
      }
      if (issues.length > 0) results.push({ page: pageNumber, issues });
      continue;
    }

    const metaChars = Array.isArray(meta.characters) ? meta.characters : [];
    const metaCharNames = metaChars.map(c => baseName(c && c.name)).filter(Boolean);
    const metaCharSet = new Set(metaCharNames.map(n => n.toLowerCase()));
    const objects = Array.isArray(meta.objects) ? meta.objects : [];
    const objectStrings = objects.map(o => (typeof o === 'string' ? o : (o && (o.name || o.id)) || '')).filter(Boolean);
    const background = typeof meta.background === 'string' ? meta.background : '';
    const emptyScenePrompt = typeof meta.emptyScenePrompt === 'string' ? meta.emptyScenePrompt : '';

    // (a) Locked SCENE SEQUENCE cast vs METADATA characters[] — known names only
    // (Cast lines are free prose; a closed name list keeps the match exact).
    const castLine = sequenceCasts.get(pageNumber);
    if (castLine && knownNames.length > 0) {
      for (const name of knownNames) {
        const inCast = nameMentioned(name, castLine);
        const inMeta = metaCharSet.has(name.toLowerCase());
        if (inCast && !inMeta) {
          issues.push({ type: 'cast_char_missing_from_metadata', detail: `locked Scene ${pageNumber} cast names '${name}' but METADATA characters[] does not` });
        } else if (!inCast && inMeta) {
          issues.push({ type: 'metadata_char_not_in_cast', detail: `METADATA characters[] has '${name}' but the locked Scene ${pageNumber} cast line does not name them` });
        }
      }
    }

    // (b) METADATA characters[] vs SCENE prose mentions
    if (prose) {
      for (const name of metaCharNames) {
        if (isEntityId(name)) continue; // ids are legal in metadata, never in prose
        if (!nameMentioned(name, prose)) {
          issues.push({ type: 'metadata_char_absent_from_prose', detail: `metadata char '${name}' absent from prose` });
        }
      }
      for (const name of knownNames) {
        if (nameMentioned(name, prose) && !metaCharSet.has(name.toLowerCase())) {
          issues.push({ type: 'prose_char_absent_from_metadata', detail: `SCENE prose mentions '${name}' but METADATA characters[] does not list them` });
        }
      }
    }

    // (c) interactions[] character/object refs
    const interactions = Array.isArray(meta.interactions) ? meta.interactions : [];
    for (const inter of interactions) {
      if (!inter || typeof inter !== 'object') continue;
      const ch = baseName(inter.character);
      if (ch && !metaCharSet.has(ch.toLowerCase())) {
        issues.push({ type: 'interaction_char_unknown', detail: `interactions[] references character '${ch}' who is not in characters[]` });
      }
      const obj = String(inter.object || '').trim();
      if (obj) {
        const objIsKnownChar = knownNames.some(n => n.toLowerCase() === baseName(obj).toLowerCase());
        if (objIsKnownChar) {
          if (!metaCharSet.has(baseName(obj).toLowerCase())) {
            issues.push({ type: 'interaction_target_char_unknown', detail: `interactions[] targets character '${obj}' who is not in characters[]` });
          }
        } else if (!isEntityId(obj)) {
          // Free-form object: must be anchored SOMEWHERE the renderer sees —
          // objects[], background, emptyScenePrompt, or the SCENE prose.
          const haystacks = [objectStrings.join(' | '), background, emptyScenePrompt, prose];
          const anchored = haystacks.some(h => h && h.toLowerCase().includes(obj.toLowerCase()))
            || obj.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 3)
              .some(word => haystacks.some(h => nameMentioned(word, h)));
          if (!anchored) {
            issues.push({ type: 'interaction_object_unanchored', detail: `interactions[] object '${obj}' appears in neither objects[], background, emptyScenePrompt, nor the SCENE prose` });
          }
        }
      }
    }

    // (d) depth word inside position phrase vs the depth field
    for (const c of metaChars) {
      if (!c || typeof c !== 'object') continue;
      const position = String(c.position || '').toLowerCase();
      const depth = String(c.depth || '').toLowerCase().trim();
      if (!position || !depth) continue;
      const posDepthWord = DEPTH_WORDS.find(w => position.includes(w));
      if (posDepthWord && DEPTH_WORDS.includes(depth) && posDepthWord !== depth) {
        issues.push({ type: 'position_depth_mismatch', detail: `${baseName(c.name) || 'character'} position='${c.position}' contains '${posDepthWord}' but depth='${depth}'` });
      }
    }

    // (e) sceneIntent names ⊆ characters[] — known names only
    const sceneIntent = typeof meta.sceneIntent === 'string' ? meta.sceneIntent : '';
    if (sceneIntent && knownNames.length > 0) {
      for (const name of knownNames) {
        if (nameMentioned(name, sceneIntent) && !metaCharSet.has(name.toLowerCase())) {
          issues.push({ type: 'scene_intent_char_absent', detail: `sceneIntent names '${name}' but METADATA characters[] does not list them` });
        }
      }
    }

    if (issues.length > 0) results.push({ page: pageNumber, issues });
  }

  return results;
}

/**
 * Compact per-page summary lines for logging:
 *   [SCENE-CONSISTENCY] P3: metadata char 'X' absent from prose
 * @returns {string[]}
 */
function formatSceneConsistencySummary(results) {
  const lines = [];
  for (const entry of results || []) {
    for (const issue of entry.issues || []) {
      lines.push(`[SCENE-CONSISTENCY] P${entry.page}: ${issue.detail}`);
    }
  }
  return lines;
}

module.exports = {
  checkSceneConsistency,
  formatSceneConsistencySummary,
  extractSceneSequenceCasts, // exported for tests
};

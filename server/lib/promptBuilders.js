// promptBuilders.js — story/scene/image prompt builders + their support data
// (character description builders, teaching guides, historical locations/objects,
// art styles, language levels, age-category helpers, review/beats parsers).
// Extracted verbatim from storyHelpers.js (docs/plans/storyhelpers-split.md, Wave 3).
// storyHelpers.js re-exports everything here — importers keep requiring storyHelpers.
// Depends top-level on sceneMetadata + clothingResolve only (acyclic split DAG).

const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logger');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const { IMAGE_MODELS, MODEL_DEFAULTS } = require('../config/models');
const { buildVisualBiblePrompt, englishEntityRef, englishLocationRef, significantEntityTokens } = require('./visualBible');
const { getPhysical } = require('./characterPhysical');
const { getTraits } = require('./characterTraits');
const { frameColorForName } = require('./characterFrames');
const { getLanguageNote, getLanguageInstruction, getLanguageNameEnglish } = require('./languages');
const { getEventById } = require('./historicalEvents');
const { getSwissStoryResearch, getSwissCityById } = require('./swissStories');
const { parseProseMetadataFormat, stripSceneMetadata, extractSceneMetadata, collectSceneCharacterNames, enforceSpreadTextPosition, parseSceneHintMetadata } = require('./sceneMetadata');
const { resolveClothingForPage, buildUsedClothingText, buildAvailableAvatarsForPrompt } = require('./clothingResolve');

/**
 * Wrap user-provided text in XML boundary markers to mitigate prompt injection.
 * The <user_input> tags signal to the AI model that the enclosed content is
 * user-provided data and should be treated as data only, not as instructions.
 * @param {string} value - The user-provided string
 * @returns {string} The value wrapped in <user_input> tags, or the original if empty/None
 */
function wrapUserInput(value) {
  if (!value || value === 'None') return value;
  return `<user_input>${value}</user_input>`;
}

/**
 * Build physical traits object from character
 * Uses the characterPhysical helper to read from canonical or legacy fields
 * @param {Object} char - Character object
 * @returns {Object} Physical traits object with camelCase keys
 * @deprecated Use getPhysical() from characterPhysical.js directly
 */
function getPhysicalFromChar(char) {
  return getPhysical(char);
}

/**
 * Strip age-correlated words from freeform face/distinguishing-marks text.
 *
 * Belt-and-braces defense for legacy character data that was analyzed before
 * the character-analysis prompt was tightened. The intended source of age info
 * is the apparentAge field — face and distinguishing-marks lines should never
 * carry an age signal that can contradict it.
 *
 * Strips qualifier phrases (e.g. "typical of a child", "youthful", "baby-faced",
 * "mature", "weathered") and trims any leftover whitespace/dangling commas.
 *
 * @param {string} text - The text to clean
 * @returns {string} Cleaned text, or the original if nothing matched
 */
function stripAgeWords(text) {
  if (!text || typeof text !== 'string') return text;
  let cleaned = text;

  // Phrase-level: "typical of a/an X" where X is an age noun
  cleaned = cleaned.replace(
    /\s*[,;]?\s*(?:shape\s+)?typical\s+of\s+(?:a|an)\s+(?:young\s+)?(?:child|kid|baby|infant|toddler|teen|teenager|adult|senior|elderly)(?:'s|s)?\b/gi,
    ''
  );
  // Phrase-level: "for a X-year-old" / "for a child" / etc.
  cleaned = cleaned.replace(
    /\s*[,;]?\s*for\s+(?:a|an)\s+(?:young\s+)?(?:child|kid|baby|teen|teenager|adult|senior|elderly)\b/gi,
    ''
  );
  // Standalone age-correlated adjectives
  const ageAdjectives = [
    'youthful', 'young-looking', 'baby-faced', 'babyfaced', 'childlike', 'childish',
    'mature(?:-looking)?', 'aged', 'elderly', 'weathered', 'wrinkled', 'fresh-faced',
    'developing', 'adolescent', 'juvenile', 'infantile'
  ];
  cleaned = cleaned.replace(
    new RegExp(`\\s*[,;]?\\s*\\b(?:${ageAdjectives.join('|')})\\b`, 'gi'),
    ''
  );
  // "soft bone structure" alone is fine, but "soft features" + age word is the bad pattern
  // (already covered by phrase-level above)
  // Cleanup: collapse double spaces / commas, trim trailing punctuation
  cleaned = cleaned.replace(/\s+/g, ' ').replace(/\s*,\s*,/g, ',').replace(/[,\s;]+$/, '').trim();
  return cleaned;
}

/**
 * Build physical age-marker cues from an apparentAge category.
 *
 * The analyzer emits apparentAge as a single category ("teenager", "school-age"),
 * and the formatter used to render that as just `Looks: teenager` — a weak signal
 * image models would ignore, rendering every character as generically young when
 * the art style skewed that way. This returns a concrete physical description so
 * mixed-age casts actually read at the right ages.
 *
 * @param {string} apparentAge - Age category from the analyzer
 * @returns {string} Physical age markers (empty string if no category)
 */
function getAgeMarkers(apparentAge) {
  if (!apparentAge) return '';
  // Head-height figures are the strongest age cue in stylized art — models
  // ignore adjectives but respect proportion numbers (same table the avatar
  // prompt uses: infant≈4, child≈6, teen≈7, adult≈8 head-heights).
  switch (apparentAge) {
    // Every bucket is bounded on BOTH sides against its neighbours, and the
    // head-heights rise monotonically with no ties. Merged buckets were the
    // original defect: apparentAge is allowed to drift one bucket
    // (clampApparentAge), so a bucket phrased at its neighbour's age turns a
    // legal drift into a two-bucket error. That is how an 8-year-old was
    // described as a "very young child" — and how a preschooler reading one
    // young was described with "baby proportions, rounded baby features".
    case 'infant':
      return 'infant proportions about 3.5-4 heads tall, very large head relative to body, rounded baby features, not yet walking — clearly smaller than a toddler';
    case 'toddler':
      return 'toddler proportions about 4 heads tall, large head relative to body, soft rounded features and a rounded belly, walking but unsteady — no longer a baby, clearly smaller than a preschooler';
    case 'preschooler':
      return 'preschool-age proportions about 4.5 heads tall, large head relative to body, soft rounded features, clearly taller than a toddler and smaller than a kindergarten child';
    case 'kindergartner':
      return 'kindergarten-age proportions about 5 heads tall, head still large relative to body but less than a toddler, softly rounded features, clearly older and taller than a preschooler and shorter than a grade-schooler';
    case 'young-school-age':
      return 'early grade-school proportions about 5.5 heads tall, rounded child features, clearly taller than a kindergarten child and shorter than an older grade-schooler — NOT toddler proportions';
    case 'school-age':
      return 'grade-school proportions about 6 heads tall, child features starting to lengthen, clearly taller than an early grade-schooler and clearly not yet a preteen — NOT toddler proportions';
    case 'preteen':
      return 'late-child proportions about 6.25 heads tall, slightly longer limbs than a grade-schooler, visibly older than grade-schoolers and clearly not yet a teenager';
    case 'young-teen':
      return 'early adolescent proportions about 6.5 heads tall, longer limbs than a child, face more elongated than a child, taller than a preteen but not yet at full teenage height';
    case 'teenager':
      return 'teenage proportions about 7 heads tall, long limbs, clearly taller than a young teen and not yet at adult build — visibly NOT a child, render as a 15-16 year old';
    case 'young-adult':
      return 'young adult proportions about 7.5-8 heads tall, full adult height, clearly taller and more developed than a teenager, mature face with defined bone structure and no adolescent softness, no signs of middle age';
    case 'adult':
      return 'adult proportions about 7.5-8 heads tall, full adult height, mature bone structure, clearly older than a young adult and not yet showing the age signs of middle age';
    case 'middle-aged':
      return 'adult proportions about 7.5-8 heads tall, full adult height, mature bone structure with subtle signs of age (faint lines, slightly softer jawline), clearly older than a young adult and not yet elderly';
    case 'senior':
      return 'older adult proportions about 7.5 heads tall, full adult height with a slightly softer posture, visible age markers (lines around eyes and mouth, softer musculature), commonly silver or greying hair — clearly older than middle-aged, still upright and not yet stooped';
    // Head-height stays 7.5: the head-to-body RATIO does not shrink with age, so
    // dipping the number would tell the model to draw a smaller-headed figure.
    // Reduced stature belongs to POSTURE, stated separately.
    case 'elderly':
      return 'elderly proportions about 7.5 heads tall but visibly shorter in silhouette from a stooped, rounded posture, pronounced age markers (deeper lines, thinner frame, looser skin), white or silver hair — clearly older and less upright than a senior';
    default:
      return '';
  }
}

/**
 * Resolve an age-appropriate gender noun (e.g. "boy", "young man", "elderly woman")
 * @param {string} gender - 'male' | 'female' | 'other'
 * @param {string} apparentAge - Age category from the analyzer
 * @returns {string} Gender term, or empty string if unspecified
 */
function getGenderTerm(gender, apparentAge) {
  if (!gender || gender === 'other') return '';
  const isMale = gender === 'male';
  switch (apparentAge) {
    case 'infant':
      return isMale ? 'baby boy' : 'baby girl';
    case 'toddler':
    case 'preschooler':
    case 'kindergartner':
      return isMale ? 'little boy' : 'little girl';
    case 'young-school-age':
    case 'school-age':
      return isMale ? 'boy' : 'girl';
    case 'preteen':
      // 11-12: still a child, NOT a teenager.
      return isMale ? 'boy' : 'girl';
    case 'young-teen':
      return isMale ? 'young teen boy' : 'young teen girl';
    case 'teenager':
      return isMale ? 'teenage boy' : 'teenage girl';
    case 'young-adult':
      return isMale ? 'young man' : 'young woman';
    case 'adult':
    case 'middle-aged':
      return isMale ? 'man' : 'woman';
    case 'senior':
    case 'elderly':
      return isMale ? 'elderly man' : 'elderly woman';
    default:
      return isMale ? 'boy/man' : 'girl/woman';
  }
}

/**
 * Build detailed hair description using both simple fields and detailedHairAnalysis
 * Uses detailed analysis when available for better consistency across scenes
 * User-edited values (from physicalTraitsSource) take priority over auto-extracted values
 * @param {Object} physical - Physical traits object containing hair fields
 * @param {Object} physicalTraitsSource - Optional object tracking source of each trait ('photo', 'extracted', 'user')
 * @returns {string} Formatted hair description (without "Hair:" prefix)
 */
function buildHairDescription(physical, physicalTraitsSource = null) {
  if (!physical) return '';

  const detailed = physical.detailedHairAnalysis;
  const override = physical.userHairOverride && typeof physical.userHairOverride === 'object'
    ? physical.userHairOverride
    : {};

  if (!detailed && Object.keys(override).length === 0) {
    // Truly legacy record (no detailed analysis, no user overrides). Use
    // whatever prose is stored in the free-form `hair` field as a last resort.
    return physical.hair || '';
  }

  // Field-level read priority: user override wins, falls back to extraction.
  // Each subfield is resolved independently so partial overrides work
  // (e.g. user only changed styling; length/density still come from extraction).
  const pick = (k) => {
    const o = override[k];
    if (o != null && String(o).trim() !== '') return String(o).trim();
    const d = detailed?.[k];
    return d != null && String(d).trim() !== '' ? String(d).trim() : null;
  };

  const parts = [];

  // Color — the one non-hair-shape field that stays at top level. Describes
  // the hair colour even when the person is bald (greying temples etc.).
  if (physical.hairColor) parts.push(physical.hairColor);

  // Bald / near-bald takes priority — don't add texture/length/styling that
  // make no sense on bald hair. ("white, bald" beats "white, straight".)
  const lengthTop = pick('lengthTop')?.toLowerCase();
  const density = pick('density')?.toLowerCase();
  const isBald = lengthTop === 'bald' || density === 'bald';
  const isBalding = density === 'balding';
  if (isBald) {
    parts.push('bald');
    return parts.join(', ');
  }
  if (isBalding) {
    parts.push('balding');
    // Fall through so we still describe whatever hair remains (e.g. "balding, short on sides").
  }

  // Type/texture. From extraction (no user dropdown for this).
  const type = pick('type');
  if (type) parts.push(type);

  // Length — scale for picking the more informative description.
  const lengthOrder = ['bald', 'buzz cut', 'shaved', 'fade', 'tapered', 'short', 'ear-length', 'chin-length', 'neck-length', 'shoulder-length', 'mid-back', 'waist-length'];

  if (lengthTop) {
    // lengthSides only meaningful when the user didn't override the top
    // length — a user "shoulder-length" intent shouldn't be split into
    // "tapered on sides, shoulder-length on top".
    const sidesLength = override.lengthTop ? null : pick('lengthSides')?.toLowerCase();
    if (sidesLength && sidesLength !== 'same as top') {
      const topIdx = lengthOrder.indexOf(lengthTop);
      const sidesIdx = lengthOrder.indexOf(sidesLength);
      if (topIdx >= 0 && sidesIdx >= 0 && topIdx - sidesIdx >= 2) {
        parts.push(`${sidesLength} on sides, ${lengthTop} on top`);
      } else {
        parts.push(lengthTop);
      }
    } else {
      parts.push(lengthTop);
    }
  }

  // Styling — user override bypasses the "uninformative words" gate
  // because user-typed values are explicit intent.
  const styling = pick('styling')?.toLowerCase();
  if (styling) {
    if (override.styling) {
      parts.push(styling);
    } else if (!['natural', 'textured'].includes(styling)) {
      parts.push(styling);
    }
  }

  // Bangs.
  const bangs = pick('bangsEndAt');
  if (bangs && bangs !== 'no bangs') {
    parts.push(`bangs ${bangs}`);
  }

  // Parting — supports legacy `direction` alias.
  const parting = pick('parting') || detailed?.direction;
  if (parting && !['none', 'natural', 'back', 'forward'].includes(parting)) {
    parts.push(parting);
  }

  return parts.join(', ');
}

// ============================================================================
// JSON METADATA EXTRACTION - Parse structured data from scene descriptions
// ============================================================================


/**
 * Build the `characterDescriptions` map that bbox detection consumes.
 *
 * Combines:
 *   - Primary characters from `storyData.characters` (avatars + clothing).
 *   - Visual Bible secondaryCharacters / animals when their name or VB-id
 *     (e.g. "CHR003") appears in the page's `expectedPositions` keys.
 *
 * Without the VB enrichment, secondary characters like Gessler (CHR003) or
 * tracked animals (Floh = ANI001) are sent to the detector with no
 * description and come back as UNKNOWN — even though the renderer drew
 * them into the image. Used by every bbox call site so primary + VB
 * characters are always presented to the detector together.
 *
 * @param {object} storyData - story.data (must have .characters and optionally .visualBible)
 * @param {object} expectedPositions - sceneMetadata.characterPositions ({name|VBid: prosePosition})
 * @returns {{[name: string]: { richDescription: string, clothingDescriptions?: object }}}
 */
function buildCharacterDescriptionsForBbox(storyData, expectedPositions) {
  const out = {};
  // Per-story clothingRequirements is the source of truth — raw
  // avatars.clothing is character-level metadata that can be stale across
  // stories. Resolving here keeps the detector/eval canonical in sync with
  // the redressed avatars (a stored-clothing canonical made the consistency
  // eval flag correct story outfits and repaint them back to stored).
  const clothingRequirements = storyData?.clothingRequirements || null;
  const artStyle = storyData?.artStyle || null;
  const { buildClothingDescription } = require('./entityConsistency');
  const { resolveCharacterReqs } = require('./clothingCategories');
  // Primary characters first — they have richer data (clothing variants etc.)
  for (const char of (storyData?.characters || [])) {
    if (!char?.name) continue;
    let clothingDescriptions = char.avatars?.clothing || {};
    if (clothingRequirements) {
      const categories = new Set([
        ...Object.keys(char.avatars?.clothing || {}),
        ...Object.keys(resolveCharacterReqs(clothingRequirements, char.name) || {}),
      ]);
      const resolved = {};
      for (const cat of categories) {
        resolved[cat] = buildClothingDescription(char, cat, artStyle, clothingRequirements);
      }
      clothingDescriptions = resolved;
    }
    out[char.name] = {
      richDescription: buildCharacterPhysicalDescription(char),
      // Concise grounding prompt for the GroundingDINO detection path (clothing
      // appended per-page in buildExpectedCharactersForBbox).
      gdinoIdentity: buildGroundingPrompt(char),
      clothingDescriptions,
    };
  }
  // Enrich with Visual Bible secondaries / animals whose name or VB-id is in
  // the page's expected positions but not yet covered by a primary entry.
  if (!storyData?.visualBible || !expectedPositions) return out;
  Object.assign(out, buildSecondaryCharacterDescriptions(
    storyData.visualBible, Object.keys(expectedPositions), Object.keys(out)));
  return out;
}

/**
 * Resolve the STORY-INVENTED characters a scene references (Visual Bible
 * secondaryCharacters / animals) into detector-ready description entries.
 *
 * Story-invented characters never appear in `stories.data.characters[]` — that
 * array is the user's photo-backed cast (uploaded photos + generated avatars),
 * and an invented character has neither. Any detection path that builds its
 * expected-character list from the cast alone therefore drops them, and the
 * identity call is asked to place N names onto N+1 figures.
 *
 * Measured (staging story job_1786737619634_d66c7bg9g, page 4 — Emma and Noah
 * plus Lira, an invented mermaid): bboxDetection.expectedCharacters was
 * [Emma, Noah] while the scene's clothing map and outlineCharacters both named
 * Lira. With 3 badges and 2 names, _somIdentifyFigures takes its LENIENT
 * branch ("assign rather than unknown") and answered {A:"Emma", B:"unknown",
 * C:"Noah"} — badge A was the mermaid, so a green-eyed teal-haired adult got
 * the preschooler's name and the real Emma came back unknown. Reproduced
 * independently on job_1786571353564_0sgrd0f4g page 4.
 *
 * Only names the SCENE references are resolved (never the whole Visual Bible),
 * and a referenced name with no resolvable entry is logged rather than
 * silently dropped — it stays an honest `missingCharacters` signal downstream.
 *
 * @param {object} visualBible - story.data.visualBible (may be null/malformed)
 * @param {string[]} sceneNames - names/VB-ids this scene references
 * @param {string[]} knownNames - names already covered (photo-backed cast)
 * @param {string} pageLabel - e.g. "PAGE 4 " for logs
 * @returns {{[name: string]: { richDescription: string }}}
 */
function buildSecondaryCharacterDescriptions(visualBible, sceneNames, knownNames = [], pageLabel = '') {
  const out = {};
  const vb = visualBible || {};
  // ANIMALS ARE NOT EXPECTED CHARACTERS (owner, 2026-08-19). DINO detects
  // `person`; a dog or a dragon can never satisfy it, so every animal in the
  // expected list is a guaranteed "missing person": it fires the undercount,
  // routes the page to the Gemini second opinion, and hands the identity call
  // a name no person badge can carry. Animals stay fully detectable through
  // the OBJECT pass (buildObjectGroundingHints pools vb.animals). Human-shaped
  // story-invented characters (vb.secondaryCharacters — the Lira-the-mermaid
  // case this function exists for) keep flowing.
  const lists = [
    { list: vb.secondaryCharacters, kind: 'secondary character' },
  ];
  // A malformed Visual Bible (object instead of array, missing entirely) must
  // not throw — the page still renders, it just has no secondary to add.
  if (!lists.some(l => Array.isArray(l.list) && l.list.length > 0)) return out;
  const known = new Set((knownNames || []).map(n => String(n).toLowerCase()));
  const seen = new Set();
  for (const raw of (sceneNames || [])) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const name = raw.trim();
    const key = name.toLowerCase();
    if (known.has(key) || seen.has(key)) continue;
    seen.add(key);
    let matched = null;
    for (const { list, kind } of lists) {
      if (!Array.isArray(list)) continue;
      const entry = list.find(e => (e?.name && e.name.toLowerCase() === key)
        || (e?.id && e.id.toLowerCase() === key));
      if (entry) { matched = { entry, kind }; break; }
    }
    // A TITLE IS NOT A DIFFERENT PERSON (owner, 2026-08-25). The Visual Bible
    // names secondaries in full ("Kapitänin Rossa", "König Ludwig"); the scene
    // metadata refers to them the way the prose does ("Rossa"). Exact match
    // alone therefore resolved neither, and the detector was never told that
    // figure exists — so it borrowed a user character's name for her instead.
    // Measured on p15 of job_1787514666616_yw9qsv1vf: "Sarah" landed on Rossa
    // and a face repair whited out the wrong person's head.
    //
    // Word-boundary containment either way, and ONLY when exactly one entry
    // matches: two candidates mean the reference is genuinely ambiguous, and
    // guessing between them is how the wrong description gets attached.
    if (!matched) {
      const asWord = (haystack, needle) =>
        new RegExp(`(^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s)`, 'i').test(haystack);
      for (const { list, kind } of lists) {
        if (!Array.isArray(list)) continue;
        const candidates = list.filter(e => e?.name
          && (asWord(e.name, name) || asWord(name, e.name)));
        if (candidates.length === 1) { matched = { entry: candidates[0], kind }; break; }
        if (candidates.length > 1) {
          log.warn(`⚠️ [BBOX-BUILD] ${pageLabel}Scene reference "${name}" matches ${candidates.length} Visual Bible entries (${candidates.map(c => c.name).join(', ')}) — too ambiguous to resolve`);
        }
      }
      if (matched) {
        log.debug(`[BBOX-BUILD] ${pageLabel}Resolved scene reference "${name}" to Visual Bible entry "${matched.entry.name}"`);
      }
    }
    if (!matched) {
      log.warn(`⚠️ [BBOX-BUILD] ${pageLabel}Scene references "${name}" but no Visual Bible entry resolves it — the detector will report it as missing`);
      continue;
    }
    const e = matched.entry;
    const parts = [];
    // Age band and build lead: they are what the identity call separates
    // figures by first (a young adult vs a preschooler), and a VB entry
    // without a prose `description` used to omit both.
    if (e.age) parts.push(`Age: ${e.age}`);
    if (e.build) parts.push(`Build: ${e.build}`);
    if (e.species) parts.push(`Species: ${e.species}`);
    if (e.size) parts.push(`Size: ${e.size}`);
    if (e.coloring) parts.push(`Coloring: ${e.coloring}`);
    if (e.features) parts.push(`Features: ${e.features}`);
    if (e.hair) parts.push(`Hair: ${e.hair}`);
    if (e.face) parts.push(`Face: ${e.face}`);
    if (e.signatureLook) parts.push(`Distinctive: ${e.signatureLook}`);
    if (e.clothing) parts.push(`Wearing: ${e.clothing}`);
    const baseDesc = e.description || parts.join('. ');
    const label = e.name || name;
    const rich = baseDesc ? `${label} (${matched.kind}). ${baseDesc}` : `${label} (${matched.kind})`;
    // Key by the metadata name (may be a VB id placeholder like "CHR001")
    // so buildExpectedCharactersForBbox finds it via the same key.
    out[name] = { richDescription: rich };
  }
  return out;
}

/**
 * The detector-ready `expectedCharacters` ENTRIES for the story-invented
 * characters a scene references — the array companion to
 * buildSecondaryCharacterDescriptions, for the call sites that build the
 * expected list straight from `sceneCharacters` (the photo-backed cast) and
 * pass it to detectAllBoundingBoxes: the shared pre-detection in
 * storyJobPipeline.js, the repair round re-detect, and the iterate path.
 * Append-only — the cast entries stay first and untouched.
 *
 * @param {object} visualBible - story.data.visualBible
 * @param {object} sceneMetadata - extractSceneMetadata() result for the page
 * @param {string[]} knownNames - names already in the expected list
 * @param {{pageLabel?: string, extraNames?: string[]}} [opts]
 * @returns {Array<{name: string, description: string}>}
 */

/**
 * The identity line for a photo-backed cast member.
 *
 * WHY THIS EXISTS (owner, 2026-08-15). Every call site built its expected list as
 * `{ name, description: c.description || '' }` from `sceneCharacters` — whose
 * entries are [id, age, name, gender, photos, traits, avatars, physical,
 * ageCategory, structuredClothing]. There is NO `description` key, so the field
 * was ALWAYS ''. The Set-of-Mark prompt then asked "match each letter by age,
 * gender, hair, and clothing" and listed "- Emma: Emma." — a bare name.
 *
 * Measured on job_1786743927715_kcx0p939w p3: three figures (a brown-haired girl
 * in yellow, a teal-haired mermaid in green, a blond boy in blue), two bare
 * names, and the answer put Emma on the MERMAID. The recolour then repainted the
 * mermaid's green top toward Emma's yellow. With a description the question is
 * trivial — "brown wavy ponytail, freckles" separates her from teal hair on
 * sight, whether or not the mermaid is named at all.
 *
 * Same shape buildExpectedCharactersForBbox produces, so both paths describe a
 * character identically.
 */
/**
 * The clothing text for a DETECTOR identity line — one chain, used by every
 * call site that builds one (owner, 2026-08-18).
 *
 * Three sites built this independently and all three had the same shape:
 *   const category = someMap[name];
 *   if (category) { ...resolve... }        // no category -> no clothing, silently
 *
 * That "if" is the whole bug. On job_1787001865052_lehb1p64c every figure on all
 * three covers came back with seedTrace "no garment colour in the identity line"
 * and seeds=0, so MobileSAM had a face point and nothing else and the cut-outs
 * were a face and limbs with no shirt or trousers. The map was simply empty:
 * covers have no sceneCharacterClothing, and the round re-detect
 * (repairPipeline) writes the LAST detection, overwriting the dressed one that
 * coverIterate had produced.
 *
 * The clothing was never missing — clothingRequirements held a full description
 * per character the whole time. So the lookup no longer gives up at the first
 * empty map: hinted category -> the category the story marked `used` ->
 * 'standard' -> the character's own wardrobe. Returns '' only when the character
 * genuinely has no clothing anywhere, which the caller should treat as an error.
 */
function buildIdentityClothingText(character, category, artStyle, clothingRequirements, { label = '' } = {}) {
  if (!character || typeof character !== 'object') return '';
  const { log } = require('../utils/logger');
  const usedCategory = () => {
    const reqs = clothingRequirements?.[character.name]
      || clothingRequirements?.[String(character.name || '').toLowerCase()];
    if (!reqs || typeof reqs !== 'object') return null;
    const hit = Object.entries(reqs).find(([, v]) => v && v.used === true);
    return hit ? hit[0] : null;
  };
  for (const [cat, why] of [[category, 'given'], [usedCategory(), 'used'], ['standard', 'default']]) {
    if (!cat) continue;
    try {
      const txt = require('./entityConsistency').buildClothingDescription(
        character, cat, artStyle, clothingRequirements || null) || '';
      if (txt) {
        if (why !== 'given') log.debug(`👕 [IDENTITY] ${label}${character.name}: clothing via ${why}:${cat}`);
        return txt;
      }
    } catch (e) {
      log.warn(`⚠️ [IDENTITY] ${label}${character.name}: clothing "${cat}" did not resolve (${e.message})`);
    }
  }
  const worn = character.avatars?.clothing?.standard || character.structuredClothing?.upperBody || '';
  if (worn) { log.debug(`👕 [IDENTITY] ${label}${character.name}: clothing via avatar wardrobe`); return worn; }
  log.error(`❌ [IDENTITY] ${label}${character.name}: NO clothing resolved — the detector gets no garment colour, SAM places no garment seed, and the cut-out loses its clothes`);
  return '';
}

/**
 * Identity line + clothing, never dropping the clothing. `c.description ||
 * build(...)` discarded a resolved outfit the moment a character carried its own
 * description, which is the second half of the same bug.
 */
function buildIdentityLine(character, clothingText) {
  const base = character?.description
    || buildCastIdentityDescription(character, clothingText);
  if (!clothingText || /\bwearing\b/i.test(String(base))) return base;
  return `${base}. Wearing: ${clothingText}`;
}

function buildCastIdentityDescription(char, clothingText = '') {
  if (!char || typeof char !== 'object') return '';
  const parts = [];
  const look = char.ageCategory || char.age || '';
  const gender = char.gender === 'female' ? 'girl/woman' : char.gender === 'male' ? 'boy/man' : '';
  if (look || gender) parts.push([look, gender].filter(Boolean).join(' '));
  const phys = char.physical || {};
  if (phys.hair) parts.push(`hair: ${phys.hair}`);
  if (phys.build) parts.push(`build: ${phys.build}`);
  if (phys.face) parts.push(phys.face);
  if (Array.isArray(char.traits) && char.traits.length) parts.push(char.traits.filter(t => typeof t === 'string').join(', '));
  const base = parts.filter(Boolean).join(', ');
  if (!base) return '';
  // NEVER emit a CATEGORY LABEL as clothing. sceneCharacterClothing holds
  // 'costumed:mermaid' / 'summer' — metadata tags, not garments — and sending
  // "Wearing: costumed:mermaid" to the detector is the same class of leak
  // buildExpectedCharactersForBbox guards with isCategoryLabel(). The caller is
  // expected to resolve the category to prose (buildClothingDescription); this
  // is the backstop for when it cannot.
  const tag = String(clothingText || '').trim().toLowerCase();
  const isCategory = ['standard', 'winter', 'summer', 'costumed'].includes(tag) || tag.startsWith('costumed:');
  const wearable = isCategory ? '' : clothingText;
  return wearable ? `${base}. Wearing: ${wearable}` : base;
}

/**
 * Secondary characters that declare THIS page.
 *
 * A visual-bible secondary carries `pages` / `appearsInPages` — Lira on
 * job_1786743927715_kcx0p939w is `pages: [3,5,9]`. That is a stronger signal
 * than scanning the scene's metadata lists, which omitted her entirely on p3
 * (sceneCharacters, outlineCharacters and characterClothing all said just
 * [Emma, Noah] while the PROSE and the image prompt both named her). Her own
 * declaration is authoritative and needs no inference.
 */
function buildSecondaryExpectedForPage(visualBible, pageNumber, knownNames = []) {
  const vb = visualBible || {};
  const list = Array.isArray(vb.secondaryCharacters)
    ? vb.secondaryCharacters
    : Object.values(vb.secondaryCharacters || {});
  const known = new Set((knownNames || []).map(n => String(n).toLowerCase()));
  const out = [];
  for (const e of list) {
    if (!e || !e.name || known.has(String(e.name).toLowerCase())) continue;
    const pages = e.pages || e.appearsInPages;
    if (!Array.isArray(pages) || !pages.map(Number).includes(Number(pageNumber))) continue;
    const desc = e.description
      || [e.age, e.build, e.hair && `hair: ${e.hair}`, e.face, e.signatureLook, e.clothing && `Wearing: ${e.clothing}`]
        .filter(Boolean).join('. ');
    if (!desc) continue;
    out.push({ name: e.name, description: desc });
  }
  return out;
}

function buildSecondaryExpectedCharacters(visualBible, sceneMetadata, knownNames = [], opts = {}) {
  const { pageLabel = '', extraNames = [] } = opts;
  const resolved = buildSecondaryCharacterDescriptions(
    visualBible,
    collectSceneCharacterNames(sceneMetadata, extraNames),
    knownNames,
    pageLabel
  );
  return Object.entries(resolved).map(([name, d]) => ({ name, description: d.richDescription }));
}

/**
 * Build the open-area paragraph that gets injected into image prompts.
 * Story text is rendered in WHITE, so the zone must be a saturated, high-contrast
 * surface — not pale, not pure black, not a box. Uses Sonnet's textZoneDescription
 * when available; falls back to a generic surface list otherwise.
 *
 * ASKS FOR CONTENT, NEVER FOR A TREATMENT (2026-08-21). This paragraph used to
 * end "Keep this area calm — gentle gradient, minimal texture, low contrast".
 * Grok reads that flatness vocabulary as an instruction to paint a slab: on
 * job_1787262655143 p4 it rendered the requested upper-right ~10% as a flat
 * blue-grey panel over the whole right THIRD, full height, with a hard vertical
 * seam — while the same prompt's "no split screens, panel keylines" ban lost, as
 * negative instructions do against positive ones. Note "painted continuously
 * through the same scene material" was ALREADY present and did not prevent it,
 * so the fix is removing the flatness words, not adding more continuity words.
 * Low clutter is still requested — by naming what occupies the area and by
 * keeping faces and high-contrast detail out of it, which is what actually
 * matters for legibility.
 *
 * @param {string} textPosition - e.g. 'top-right', 'bottom-full'
 * @param {string|null} textZoneDescription - Sonnet's 5–15 word description
 * @param {string} areaPct - e.g. '30%'
 * @returns {string} Instruction paragraph for the image model
 */
function buildTextZoneInstruction(textPosition, textZoneDescription, areaPct, opts = {}) {
  const { isEmptyScene = false } = opts;
  const cornerDesc = {
    'top-left': 'upper-left corner',
    'top-right': 'upper-right corner',
    'bottom-left': 'lower-left corner',
    'bottom-right': 'lower-right corner',
    'top-full': 'upper third',
    'bottom-full': 'lower third',
  };
  const displacementDesc = {
    'top-left': 'down and to the right of it',
    'top-right': 'down and to the left of it',
    'bottom-left': 'up and to the right of it',
    'bottom-right': 'up and to the left of it',
    'top-full': 'below this strip',
    'bottom-full': 'above this strip',
  };
  const corner = cornerDesc[textPosition] || textPosition.replace('-', ' ');
  const displacement = displacementDesc[textPosition] || 'away from this area';
  const surface = textZoneDescription && String(textZoneDescription).trim()
    ? String(textZoneDescription).trim()
    : 'an uninterrupted expanse of the surrounding scene material (sky, wall, water, foliage, or ground)';
  let body = `**COMPOSITION — OPEN AREA:** In the ${corner} of the image (roughly ${areaPct}) the scene continues as ${surface}, the same paint carrying through it with no edge, band or panel where it meets the rest of the picture. Keep character heads, faces, and high-contrast detail (hats, embroidery, patterns, weapon edges) out of this area — figures belong ${displacement}.`;
  if (isEmptyScene) {
    body += ' If a layout reference image is attached, the slightly darker grey region marks this area.';
  }
  return body;
}

/**
 * Build the era-guard paragraph injected into empty-scene + page prompts.
 * Era is free-text inferred by Sonnet (e.g. "medieval Switzerland, ~1300",
 * "1920s New York", "present day"). The guard tells the image model to
 * render every architectural and street element consistent with that era,
 * which catches anachronisms (traffic signs in 1300s scenes, etc.) much
 * more reliably than the previous negative-only enumeration.
 *
 * Returns an empty string when era is missing or "present day"-ish — no
 * guard needed for contemporary scenes.
 */
function buildEraGuard(era) {
  if (!era || typeof era !== 'string') return '';
  const trimmed = era.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (lower.includes('present day') || lower.includes('contemporary') || lower.includes('modern day')) return '';
  return `**STORY ERA:** ${trimmed}. Every architectural and street element in the frame must match this era. No vehicles, traffic signs, road markings, street lamps, utility poles, power lines, billboards, modern signage, plastic objects, satellite dishes, air conditioners, or modern pedestrians — anywhere in the frame.`;
}

/**
 * Strong landmark-fidelity block for empty-scene / plate prompts — fills the
 * empty-scene template's {LANDMARK_FIDELITY} placeholder. Anchors the
 * attached reference photo by NAME so the image model knows which building
 * it's looking at and preserves its silhouette; without the name the photo
 * reads as one style hint among many and the distinctive shape gets
 * stylized away. Extracted from the trial empty-scene path (server.js) —
 * previously ONLY that path built it; every other empty-scene caller
 * shipped the generic unnamed block.
 *
 * Only meaningful when the caller ALSO attaches the landmark photo to the
 * generation call (the FRAMING section references "the reference photo").
 *
 * @param {{name?: string}|string|null} landmark - landmark object (any shape
 *        carrying `name`) or a bare name string. Null-safe.
 * @returns {string} the fidelity block, or '' when no named landmark.
 */
function buildLandmarkFidelityBlock(landmark) {
  const name = typeof landmark === 'string'
    ? landmark.trim()
    : String(landmark?.name || '').trim();
  if (!name) return '';
  return `**LANDMARK IN THIS SCENE: ${name}.** The attached reference photo shows this exact real-world landmark. The scene depicts this specific building (or part of it), not a generic version.

**IDENTITY (from the photo):** Preserve the silhouette, architectural details, distinctive features and overall proportions exactly as in the photo. Someone who has seen the real building must immediately recognise it.

**MEDIUM (never from the photo):** The photo supplies geometry and nothing else. Every surface of the landmark is painted in the ART STYLE, with the same brushwork, edges, texture and palette as the rest of the page — no photographic detail, no lens depth of field, no camera grain. A page whose landmark reads sharper or more photographic than its sky, ground and figures is wrong.

**CONDITIONS (from the scene):** Camera angle, distance and framing, season, time of day, weather and light all come from the scene description — repaint the structure into them. The landmark still reads at page size: never a tiny speck against a wide cityscape.

**EXCLUDE:** modern-era elements visible in the photo per the STORY ERA rule. Separate props sit in open space relative to the landmark — never mounted on or overlapping its structure. Keep the landmark itself unchanged; only remove the modern surroundings.`;
}

/**
 * Get age category from numeric age
 * Categories: infant (0-1), toddler (1-2), preschooler (3-4), kindergartner (5-6),
 * young-school-age (7-8), school-age (9-10), preteen (11-12), young-teen (13-14),
 * teenager (15-17), young-adult (18-25), adult (26-39), middle-aged (40-59),
 * senior (60-75), elderly (75+)
 */
function getAgeCategory(age) {
  const numAge = parseInt(age, 10);
  if (isNaN(numAge) || numAge < 0) return null;

  if (numAge <= 1) return 'infant';
  if (numAge <= 2) return 'toddler';
  if (numAge <= 4) return 'preschooler';
  if (numAge <= 6) return 'kindergartner';
  if (numAge <= 8) return 'young-school-age';
  if (numAge <= 10) return 'school-age';
  if (numAge <= 12) return 'preteen';
  if (numAge <= 14) return 'young-teen';
  if (numAge <= 17) return 'teenager';
  if (numAge <= 25) return 'young-adult';
  if (numAge <= 39) return 'adult';
  if (numAge <= 59) return 'middle-aged';
  if (numAge <= 75) return 'senior';
  return 'elderly';
}

/**
 * Get human-readable age category label for prompts
 */
function getAgeCategoryLabel(ageCategory) {
  const labels = {
    'infant': 'infant/baby (0-1 years)',
    'toddler': 'toddler (1-2 years)',
    'preschooler': 'preschooler (3-4 years)',
    'kindergartner': 'kindergartner (5-6 years)',
    'young-school-age': 'young school-age child (7-8 years)',
    'school-age': 'school-age child (9-10 years)',
    'preteen': 'preteen (11-12 years)',
    'young-teen': 'young teen (13-14 years)',
    'teenager': 'teenager (15-17 years)',
    'young-adult': 'young adult (18-25 years)',
    'adult': 'adult (26-39 years)',
    'middle-aged': 'middle-aged (40-59 years)',
    'senior': 'senior (60-75 years)',
    'elderly': 'elderly (75+ years)'
  };
  return labels[ageCategory] || ageCategory;
}

// Canonical age category order — used by clampApparentAge() to compute distance
// between categories. Must match getAgeCategory() / character-analysis.txt schema.
const AGE_CATEGORY_ORDER = [
  'infant',
  'toddler',
  'preschooler',
  'kindergartner',
  'young-school-age',
  'school-age',
  'preteen',
  'young-teen',
  'teenager',
  'young-adult',
  'adult',
  'middle-aged',
  'senior',
  'elderly',
];

/**
 * Get the index of an age category in the canonical order.
 * @param {string} category - Age category name
 * @returns {number} Index 0-13, or -1 if unknown
 */
function getAgeCategoryIndex(category) {
  if (!category) return -1;
  return AGE_CATEGORY_ORDER.indexOf(category);
}

/**
 * Clamp an analyzed (visual) apparent-age category to within ±1 group of the
 * stated numeric age. This is the safety net for the "trust visual age"
 * strategy: a 12-year-old who looks 13 is fine (preteen → young-teen, off by
 * 1, accept), but a 12-year-old who got mis-analyzed as "adult" gets clamped
 * to young-teen (one group above preteen).
 *
 * Strategy:
 *  - No stated age      → return analyzed (nothing to clamp against)
 *  - No analyzed value  → return null (caller falls back to category from age)
 *  - Low confidence     → return expected (the analysis isn't trustworthy)
 *  - |analyzed - expected| ≤ 1 → return analyzed (visual age wins, normal variance)
 *  - else               → clamp to expected ± 1 in the direction of analyzed
 *
 * @param {string} analyzedCategory - apparentAge from image analysis
 * @param {string|number} statedAge - the user-entered numeric age
 * @param {string} confidence - "high" | "medium" | "low" from analysis (optional)
 * @returns {{category: string|null, clamped: boolean, reason: string}}
 */
function clampApparentAge(analyzedCategory, statedAge, confidence = null) {
  const expected = getAgeCategory(statedAge);
  if (!expected) {
    return { category: analyzedCategory || null, clamped: false, reason: 'no stated age' };
  }
  if (!analyzedCategory) {
    return { category: expected, clamped: false, reason: 'no analyzed category, using stated' };
  }

  const expectedIdx = getAgeCategoryIndex(expected);
  const analyzedIdx = getAgeCategoryIndex(analyzedCategory);

  // Unknown analyzed value → trust the stated category
  if (analyzedIdx === -1) {
    return { category: expected, clamped: true, reason: `unknown analyzed value "${analyzedCategory}"` };
  }

  // Low-confidence analysis → don't trust visual age, use stated
  if (typeof confidence === 'string' && confidence.toLowerCase() === 'low') {
    if (analyzedIdx !== expectedIdx) {
      return { category: expected, clamped: true, reason: `low-confidence analysis (${analyzedCategory} → ${expected})` };
    }
    return { category: analyzedCategory, clamped: false, reason: 'low confidence but matches stated' };
  }

  const diff = analyzedIdx - expectedIdx;
  if (Math.abs(diff) <= 1) {
    return { category: analyzedCategory, clamped: false, reason: 'within ±1 group of stated age' };
  }

  // More than 1 group apart → clamp to expected ± 1 in the direction of analyzed
  const clampedIdx = expectedIdx + (diff > 0 ? 1 : -1);
  const clampedCategory = AGE_CATEGORY_ORDER[clampedIdx];
  return {
    category: clampedCategory,
    clamped: true,
    reason: `analyzed ${analyzedCategory} differs by ${Math.abs(diff)} groups from stated ${expected}, clamped to ${clampedCategory}`,
  };
}

// ============================================================================
// TEACHING GUIDES - Loaded from text files for easy editing
// ============================================================================

/**
 * Parse a teaching guide file into a map of id -> guide content
 * Format: [topic-id] followed by content until next [topic-id] or end
 */
function parseTeachingGuideFile(filePath) {
  const guides = new Map();
  try {
    if (!fs.existsSync(filePath)) {
      log.warn(`Teaching guide file not found: ${filePath}`);
      return guides;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    let currentId = null;
    let currentContent = [];

    for (const line of lines) {
      // Check for new section: [topic-id]
      const match = line.match(/^\[([a-z0-9-]+)\]$/);
      if (match) {
        // Save previous section if exists
        if (currentId) {
          guides.set(currentId, currentContent.join('\n').trim());
        }
        currentId = match[1];
        currentContent = [];
      } else if (currentId) {
        // Skip comment lines at start of file
        if (!line.startsWith('#') || currentContent.length > 0) {
          currentContent.push(line);
        }
      }
    }

    // Save last section
    if (currentId) {
      guides.set(currentId, currentContent.join('\n').trim());
    }

  } catch (err) {
    log.error(`Error loading teaching guide file ${filePath}:`, err.message);
  }
  return guides;
}

// Load teaching guides at startup
const PROMPTS_DIR = path.join(__dirname, '../../prompts');
const EDUCATIONAL_GUIDES = parseTeachingGuideFile(path.join(PROMPTS_DIR, 'educational-guides.txt'));
const LIFE_CHALLENGE_GUIDES = parseTeachingGuideFile(path.join(PROMPTS_DIR, 'life-challenge-guides.txt'));
const ADVENTURE_GUIDES = parseTeachingGuideFile(path.join(PROMPTS_DIR, 'adventure-guides.txt'));
const HISTORICAL_GUIDES = parseTeachingGuideFile(path.join(PROMPTS_DIR, 'historical-guides.txt'));
const SWISS_SAGEN_GUIDES = parseTeachingGuideFile(path.join(PROMPTS_DIR, 'swiss-sagen-guides.txt'));

/**
 * Get teaching guide for a specific topic
 * @param {string} category - 'educational', 'life-challenge', 'adventure', 'historical', or 'swiss-sagen'
 * @param {string} topicId - The topic ID (e.g., 'months-year', 'potty-training', 'pirate', 'moon-landing', 'sage-wilhelm-tell')
 * @returns {string|null} The teaching guide content or null if not found
 */
function getTeachingGuide(category, topicId) {
  if (!topicId) return null;

  // Normalize the topic ID (handle display names that might be passed)
  const normalizedId = topicId.toLowerCase().replace(/\s+/g, '-');

  if (category === 'educational') {
    return EDUCATIONAL_GUIDES.get(normalizedId) || null;
  } else if (category === 'life-challenge') {
    return LIFE_CHALLENGE_GUIDES.get(normalizedId) || null;
  } else if (category === 'adventure') {
    return ADVENTURE_GUIDES.get(normalizedId) || null;
  } else if (category === 'historical') {
    return HISTORICAL_GUIDES.get(normalizedId) || null;
  } else if (category === 'swiss-sagen') {
    return SWISS_SAGEN_GUIDES.get(normalizedId) || null;
  }
  return null;
}

// Historical Locations Databank
const HISTORICAL_LOCATIONS_FILE = path.join(__dirname, '../data/historical-locations.json');
let historicalLocationsCache = null;

/**
 * Preload historical locations from the database into the in-memory cache.
 * Call once at server startup (after DB init). If the DB has no rows or the
 * query fails, the cache stays null so the sync fallback can try the JSON file.
 */
async function preloadHistoricalLocations() {
  try {
    const { dbQuery, isDatabaseMode } = require('../services/database');
    if (!isDatabaseMode()) {
      log.info('[LOCATIONS] Not in database mode — skipping DB preload');
      return;
    }

    const rows = await dbQuery(
      'SELECT * FROM historical_locations ORDER BY event_id, location_name'
    );

    if (!rows || rows.length === 0) {
      log.warn('[LOCATIONS] DB table historical_locations is empty — will fall back to JSON file');
      return;
    }

    // Group rows into the same structure as the JSON file:
    // { eventId: { locations: [{ name, query, type, aliases, photos: [...] }] } }
    const databank = {};
    for (const row of rows) {
      if (!databank[row.event_id]) {
        databank[row.event_id] = { locations: [] };
      }

      const event = databank[row.event_id];
      // Find or create the location entry
      let loc = event.locations.find(l => l.name === row.location_name);
      if (!loc) {
        loc = {
          name: row.location_name,
          query: row.location_query,
          type: row.location_type,
          aliases: row.aliases || [],
          photos: [],
        };
        event.locations.push(loc);
      }

      // Add photo if there is one
      if (row.photo_data || row.photo_url) {
        loc.photos.push({
          photoUrl: row.photo_url || '',
          photoUrlSquare: row.photo_url_square || '',
          photoData: row.photo_data || '',
          attribution: row.photo_attribution || '',
          description: row.photo_description || '',
          score: row.photo_score,
          reason: row.photo_reason || '',
        });
      }
    }

    historicalLocationsCache = databank;
    const eventIds = Object.keys(databank);
    log.info(`[LOCATIONS] Loaded historical locations databank from DB with ${eventIds.length} events (${rows.length} rows)`);
  } catch (err) {
    log.warn(`[LOCATIONS] DB preload failed (${err.message}) — will fall back to JSON file`);
  }
}

/**
 * Load historical locations databank (lazy loading with cache).
 * If preloadHistoricalLocations() already populated the cache from DB, returns that.
 * Otherwise falls back to reading the local JSON file.
 * @returns {Object} The databank object (empty {} if not available)
 */
function loadHistoricalLocationsDatabank() {
  if (historicalLocationsCache !== null) {
    log.debug(`[LOCATIONS] Using cached databank with ${Object.keys(historicalLocationsCache).length} events`);
    return historicalLocationsCache;
  }

  // Fallback: try loading from JSON file (local dev without DB data)
  log.info(`[LOCATIONS] Loading historical locations from JSON fallback: ${HISTORICAL_LOCATIONS_FILE}`);
  try {
    if (fs.existsSync(HISTORICAL_LOCATIONS_FILE)) {
      historicalLocationsCache = JSON.parse(fs.readFileSync(HISTORICAL_LOCATIONS_FILE, 'utf-8'));
      const eventIds = Object.keys(historicalLocationsCache);
      log.info(`[LOCATIONS] Loaded historical locations databank with ${eventIds.length} events: ${eventIds.slice(0, 5).join(', ')}${eventIds.length > 5 ? '...' : ''}`);
    } else {
      log.warn(`[LOCATIONS] Historical locations databank NOT FOUND at: ${HISTORICAL_LOCATIONS_FILE}`);
      historicalLocationsCache = {};
    }
  } catch (err) {
    log.warn(`[LOCATIONS] Error loading historical locations databank: ${err.message}`);
    historicalLocationsCache = {};
  }

  return historicalLocationsCache;
}

/**
 * Get pre-fetched location photos for a historical event
 * Randomly selects one photo per location for variety
 * @param {string} eventId - The historical event ID (e.g., 'moon-landing', 'pyramids')
 * @returns {Array} Array of location objects with randomly selected photo
 */
function getHistoricalLocations(eventId, opts = {}) {
  if (!eventId) {
    log.debug(`[LOCATIONS] getHistoricalLocations called with no eventId`);
    return [];
  }

  // Square-format stories (imageAspect '1:1') use the square landmark variant
  // (photo_url_square) so the stylized empty scene fills the page edge-to-edge.
  // A4/portrait stories keep the original A4 photo. Parse W:H — square when
  // width === height. Falls back to the A4 photo when no square exists.
  const aspect = String(opts.aspect || '').trim();
  const [aw, ah] = aspect.split(':').map(Number);
  const wantSquare = aw > 0 && ah > 0 && aw === ah;

  log.info(`[LOCATIONS] Getting locations for event: ${eventId} (aspect: ${aspect || 'default'}, variant: ${wantSquare ? 'square' : 'A4'})`);
  const databank = loadHistoricalLocationsDatabank();
  const eventData = databank[eventId];

  if (!eventData?.locations?.length) {
    log.warn(`[LOCATIONS] No locations found for event: ${eventId} (event exists: ${!!eventData})`);
    return [];
  }

  log.info(`[LOCATIONS] Found ${eventData.locations.length} locations for ${eventId}`);

  // For each location, randomly pick one of the stored photos
  return eventData.locations.map(loc => {
    if (!loc.photos || loc.photos.length === 0) {
      return {
        name: loc.name,
        type: loc.type,
        hasPhoto: false
      };
    }

    // Random selection from available photos
    const randomPhoto = loc.photos[Math.floor(Math.random() * loc.photos.length)];

    return {
      name: loc.name,
      type: loc.type,
      query: loc.query,
      // Stable lookup slug for DB linking. The outline writer copies this
      // verbatim into each VB location's `dbKey` field, and the linker
      // matches on it before falling back to fuzzy name matching. This
      // eliminates substring-collision risk (e.g. "Altdorf Panorama" vs
      // "Marktplatz Altdorf" both containing "Altdorf").
      dbKey: locationNameToDbKey(loc.name),
      description: randomPhoto.description,
      photoUrl: (wantSquare && randomPhoto.photoUrlSquare) ? randomPhoto.photoUrlSquare : randomPhoto.photoUrl,
      photoData: randomPhoto.photoData,
      attribution: randomPhoto.attribution,
      hasPhoto: true
    };
  }).filter(loc => loc.hasPhoto);
}

/**
 * Deterministic slug from a canonical location name. Used as the cross-pipeline
 * lookup key between historical_locations rows and Visual Bible entries.
 *
 * Examples:
 *   "Marktplatz Altdorf"             → "marktplatz-altdorf"
 *   "Hohle Gasse Küssnacht"          → "hohle-gasse-kuessnacht"
 *   "Tellsplatte (boat jump)"        → "tellsplatte-boat-jump"
 *   "Apple Shot Scene (Altdorf)"     → "apple-shot-scene-altdorf"
 */
function locationNameToDbKey(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^\w\s-]/g, ' ')   // strip punctuation/parens
    .replace(/\s+/g, '-')         // spaces → dashes
    .replace(/-+/g, '-')          // collapse repeats
    .replace(/^-|-$/g, '');       // trim leading/trailing dashes
}

// ============================================================================
// Historical Objects Databank (parallel to historical_locations)
// Stores period objects (weapons, symbols, artifacts) referenced in a story
// so the outline prompt knows about them and the image pipeline can use them.
// ============================================================================

let historicalObjectsCache = null;

async function preloadHistoricalObjects() {
  try {
    const { dbQuery, isDatabaseMode } = require('../services/database');
    if (!isDatabaseMode()) {
      log.info('[OBJECTS] Not in database mode — skipping DB preload');
      return;
    }

    const rows = await dbQuery(
      'SELECT * FROM historical_objects ORDER BY event_id, object_name'
    );

    if (!rows || rows.length === 0) {
      log.warn('[OBJECTS] DB table historical_objects is empty');
      historicalObjectsCache = {};
      return;
    }

    const databank = {};
    for (const row of rows) {
      if (!databank[row.event_id]) databank[row.event_id] = { objects: [] };
      databank[row.event_id].objects.push({
        name: row.object_name,
        type: row.object_type,
        aliases: row.aliases || [],
        photoUrl: row.photo_url,
        photoData: row.photo_data,
        attribution: row.photo_attribution,
        description: row.photo_description,
      });
    }

    historicalObjectsCache = databank;
    const eventIds = Object.keys(databank);
    log.info(`[OBJECTS] Loaded historical objects databank from DB with ${eventIds.length} events (${rows.length} rows)`);
  } catch (err) {
    log.warn(`[OBJECTS] DB preload failed (${err.message}) — historical_objects unavailable`);
    historicalObjectsCache = {};
  }
}

function getHistoricalObjects(eventId) {
  if (!eventId) return [];
  if (historicalObjectsCache === null) {
    log.debug(`[OBJECTS] Cache not initialised — returning empty list for ${eventId}`);
    return [];
  }
  const eventData = historicalObjectsCache[eventId];
  if (!eventData?.objects?.length) return [];
  return eventData.objects.map(obj => ({
    name: obj.name,
    type: obj.type,
    description: obj.description,
    photoUrl: obj.photoUrl,
    photoData: obj.photoData,
    attribution: obj.attribution,
    hasPhoto: !!(obj.photoData || obj.photoUrl),
  }));
}

/**
 * Get adventure theme guide directly (for always including in story ideas)
 * @param {string} themeId - The adventure theme ID (e.g., 'pirate', 'knight', 'wizard')
 * @returns {string|null} The adventure guide content or null if not found
 */
function getAdventureGuide(themeId) {
  if (!themeId) return null;
  const normalizedId = themeId.toLowerCase().replace(/\s+/g, '-');
  return ADVENTURE_GUIDES.get(normalizedId) || null;
}

/**
 * Get scene complexity guide based on number of scenes
 * Provides guidance on story complexity for different scene counts
 * @param {number} sceneCount - Number of scenes/illustrations in the story
 * @returns {string} Complexity guide text
 */
function getSceneComplexityGuide(sceneCount) {
  if (sceneCount <= 5) {
    return `STORY COMPLEXITY (${sceneCount} scenes):
- SUPER SIMPLE - one clear problem, one solution
- Single storyline only, no subplots
- 2-3 main events maximum
- Very straightforward cause-and-effect`;
  } else if (sceneCount <= 10) {
    return `STORY COMPLEXITY (${sceneCount} scenes):
- Simple but engaging story
- One main storyline with 1-2 obstacles
- 4-5 key events
- Can include a small twist or surprise`;
  } else if (sceneCount <= 20) {
    return `STORY COMPLEXITY (${sceneCount} scenes):
- Moderate complexity
- Main storyline PLUS one secondary element or subplot
- At least 2 interwoven themes or character developments
- 6-8 key events with meaningful progression`;
  } else {
    return `STORY COMPLEXITY (${sceneCount} scenes):
- Rich, multi-layered story told concisely
- Main storyline with key turning points and resolution
- 2-3 interwoven themes or character developments
- Focus on main plot arc - describe in 8 sentences or less`;
  }
}

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Art styles definitions (matches index.html)
 */
// Two lines every style shares, so a rule that applies to all of them is
// written (and fixed) once.
//   AGE_LINE — models flatten a cast to one age bracket without it.
//   NOT_A_PHOTOGRAPH — for the painterly styles whose subject matter (real
//   people, real places, true-to-life anatomy) sits closest to photography.
//   Denying "photorealistic" alone does not work: the model reproduces the
//   CAMERA's fingerprints, so those are named — and each denial carries the
//   painterly marker to render instead.
// Descriptors ride in EVERY page prompt, so they are kept terse and of
// comparable length (~370-750 chars); the whole set was compressed on
// 2026-08-17 from 429-1249 (mean 723) after it started pushing pages through
// the prompt-shrink pipeline.
const AGE_LINE = 'Each character keeps their real age — babies, children, teenagers, adults and grandparents each look it.';
// The trailing clause closes a loophole the camera-fingerprint list cannot: an
// evenly-lit photograph has no bokeh, no flare, no visible grain and no
// camera-real fabric, so it satisfies every item above while still being a
// photograph. Staging job_1787252581387_6sn8z0nh2 shipped exactly that — a
// photographic family portrait under a watercolour-washed sky.
const NOT_A_PHOTOGRAPH = 'Painted by hand, never captured by a camera: no bokeh, no lens flare, no photographic grain, no skin pores, no camera-real fabric; depth from atmospheric haze, not optical blur; visible brushwork on every surface, faces included. No sharp photoreal rendering; a photograph with a painterly filter is still a photograph.';

const ART_STYLES = {
  // Sentence-based style descriptions — work well with both Gemini and Grok Imagine.
  // Each names its medium first, then its faces rule, then the shared lines.
  pixar: 'A 3D animated children\'s illustration in the style of Pixar and Disney Animation Studios: stylized characters with smooth skin and simplified features, vibrant colours, soft volumetric lighting, a warm family-friendly look. Never photographic. Faces: smooth stylized skin with no pores, expressive eyes with iris reflections, bone structure suited to each character\'s age. Consistent 3D-rendered look across all characters. ' + AGE_LINE,
  cartoon: 'A 2D cartoon illustration in the style of classic Saturday-morning animation: bold black outlines, vibrant flat colours, minimal shading, smooth vector quality. Never photographic, never 3D-looking. Faces: bold outlines around the features, flat-coloured skin, exaggerated expressions, simple dot or oval eyes. ' + AGE_LINE,
  anime: 'A modern digital anime illustration in the style of Makoto Shinkai: detailed cel-shading, vibrant palette, cinematic atmosphere, stylized figures with simplified features. Never photographic. Faces: flat-coloured smooth skin, very large eyes (30-40% of face height) with coloured irises and highlight dots, tiny triangular nose, pointed chin, minimal shading — anime proportions on every character, never realistic. ' + AGE_LINE,
  chibi: 'A chibi illustration with super-deformed proportions — massive head, tiny body, kawaii aesthetic, minimalist detail. Never photographic. Faces: ultra-simplified kawaii features, large stylized eyes, dot nose, tiny mouth. Age still reads through the simplification: elderly characters have white hair and lined faces, adults defined jawlines, and only young children get blush-mark cheeks. ' + AGE_LINE,
  steampunk: 'A steampunk graphic-novel illustration in the style of Sean Murphy: bold ink linework and graphic ink-and-wash shading, warm sepia-and-amber palette of leather and aged brass. Clearly hand-drawn, never photographic. Steampunk-ify the WORLD — brass gears, riveted copper pipes, clockwork, gauges and steam fittings woven into architecture, furniture and background, even where the setting would otherwise be plain; never on people, and characters wear exactly the clothing described. Faces: clean ink lines, stylised graphic features. ' + AGE_LINE,
  comic: 'A Franco-Belgian ligne-claire comic illustration in the style of Hergé and Peyo: clean black outlines of uniform weight, flat solid colours, bright friendly palette, dynamic composition. No halftone dots, no CMYK separation, no crosshatching, no painterly shading, never photographic. Faces: clean simple features, flat natural skin tones, readable expressions — skin and hair in their natural colours, never overlaid with coloured patches. ' + AGE_LINE,
  manga: 'A traditional Japanese manga illustration: intricate ink linework, backgrounds and scenery in monochrome ink with atmospheric screentones and dramatic lighting, while character clothing, hair and key story objects keep their natural colours (colour-spread cover style, not black-and-white interior panels). Never photographic. Faces: clean ink lines, screentone shading, large but less extreme eyes than anime, defined noses, expressive mouths. ' + AGE_LINE,
  // The intensity words are load-bearing, not decoration (2026-08-20): the
  // 2026-08-17 compression dropped "expressive", "prominent", "strong",
  // "throughout" and "paint-dominant", and watercolour went from 7/7 books
  // scoring styleMatch=matches to 2/2 scoring wrong_medium. They set how much
  // paint the model puts on; without them the render settles toward a photo.
  watercolor: 'A bold, expressive traditional watercolor painting: prominent visible brushstrokes, strong wet-on-wet washes bleeding together, pigment pooling and granulating, rough cold-press paper texture throughout, edges dissolving into the paper. Paint-dominant: no hard outlines, no ink or pencil lines. Characters stay fully opaque, never see-through. Warm, not overly vibrant. ' + NOT_A_PHOTOGRAPH + ' Faces: loose washes with visible brushstroke texture. ' + AGE_LINE,
  oil: 'A classic oil painting on canvas in the style of John Singer Sargent: worked alla prima, strokes left visible rather than blended, impasto ridges catching the light, canvas weave in thin passages, a limited mixed palette, backgrounds in broad loose strokes while the face carries the finish. ' + NOT_A_PHOTOGRAPH + ' Proportions true to life, execution unmistakably paint. Faces: visible strokes of warm mixed pigment, defined bone structure. ' + AGE_LINE,
  lowpoly: 'A low-poly 3D illustration in the style of Monument Valley: geometric faceted forms, isometric perspective, minimalist shapes, vibrant solid colours, clean edges, retro game aesthetic. Never photographic. Faces: faceted surfaces, flat-shaded polygonal features, minimal detail — everything angular, no smooth skin. ' + AGE_LINE,
  concept: 'A digital concept-art painting in the style of Craig Mullins and Karla Ortiz — film production art in broad digital brushes: big shapes read first, brush marks visible in sky, water, ground and clothing, light STAGED for the moment (a shaft, a rim light, a silhouette). ' + NOT_A_PHOTOGRAPH + ' Proportions true to life, execution unmistakably painted. Faces: painted planes and strokes, defined bone structure — illustrated, never photographed. ' + AGE_LINE,
  pixel: 'A 16-bit pixel-art illustration in the style of Final Fantasy VI: low resolution, limited colour palette, detailed sprite work, retro video-game aesthetic. Never photographic. Faces: pixel rendering with a visible pixel grid, few colours per face, no anti-aliasing on the features. ' + AGE_LINE,
  cyber: 'A cyberpunk anime illustration: every figure cel-shaded with clean ink outlines, flat shaded skin and stylized features, never photographic. Keep the story\'s own time of day, weather and location — never switch day to night, never add rain. Add cyberpunk elements that read in daylight: neon signs on the scene\'s own posts, billboards and shopfronts (glowing shapes and colour only, no readable text), holographic glows, sleek neon-lit tech. Faces: cel-shaded with a neon rim light. ' + AGE_LINE,
  // Photography-first by design (2026-08-14): this style IS the camera.
  realistic: 'A photograph. Real people captured by a camera: natural proportions, real skin texture with pores, natural hair, shallow depth of field, warm natural light, real-world textures, cinematic composition. Never illustrated, stylized, animated or 3D-rendered. Faces: real human proportions with skin texture and small imperfections, real-sized eyes with iris detail, natural brows, defined nose and lips, warm skin with subsurface scattering. ' + AGE_LINE,
};

/**
 * Art styles that name a WORLD rather than a medium, and the name that world
 * goes by in the wardrobe prompt.
 *
 * Only these influence what characters wear. Every other ART_STYLES key names a
 * medium — oil is Sargent's brushwork, not Sargent's era — and a medium changes
 * how an outfit is painted, never what it is. Letting one dress the cast would
 * put a present-day family in period costume because someone picked a paint
 * style. Owner call 2026-08-09: world styles only, accents only.
 *
 * Adding a world here is the whole change: the wardrobe stages read this map.
 * Historical settings do NOT belong here — those come from the story's own
 * setting via prompts/historical-guides.txt, and a second source for "what era
 * is this" is exactly the kind of split this codebase keeps paying for.
 */
const WORLD_ART_STYLES = {
  steampunk: 'steampunk',
  cyber: 'cyberpunk',
};

/**
 * Wardrobe instruction for a world art style, or '' for every other style.
 *
 * Deliberately names no garments. The costume exemplar lists were removed for
 * the same reason (owner, 2026-08-09): the model already knows what the world
 * looks like, and listing items narrows it to the listed ones without binding
 * anything outside them.
 */
function buildStyleWardrobeBlock(artStyle) {
  const world = WORLD_ART_STYLES[String(artStyle || '').trim().toLowerCase()];
  if (!world) return '';
  return `- **The illustration style is ${world}.** Every character wears one or two items that world is known for, over clothing the story's own setting calls for. The story's setting decides the rest of the outfit.
- Recurring story objects and props are described in that world's idiom too (materials, fittings, ornament) in their Visual Bible entry — the object is defined once, so every page renders the same object.`;
}

/**
 * Resolve an art-style description. ONE description per style (2026-08-09):
 * the per-backend { default, grok, gemini } variants were removed — tuning the
 * prompt per model does not fix model behaviour, and maintaining three copies
 * only let them drift (e.g. steampunk's grok/gemini variants demanded
 * "realistic faces / grounded realism / smooth gradients", producing photoreal
 * people the "graphic novel" label was supposed to prevent). `backend` is kept
 * in the signature for caller compatibility but no longer selects a variant.
 * @param {string} artStyleId - Style key (e.g., 'steampunk')
 * @param {string} [_backend] - unused; retained for call-site compatibility
 * @returns {string|null} Style description or null if not found
 */
function resolveArtStyle(artStyleId, _backend) {
  const style = ART_STYLES[artStyleId];
  if (!style) return null;
  // All entries are strings now; tolerate a stray legacy object defensively.
  return typeof style === 'string' ? style : (style.default || null);
}

/**
 * Resolve art style description for EMPTY SCENE generation (no characters present).
 * Strips sentences that describe character anatomy (faces, eyes, skin, proportions),
 * because image generators can't reliably negate "no people" — explicit eye/face
 * details in the style prompt cause stray faces and eyes to appear in empty backgrounds.
 *
 * Keeps: rendering technique, color palette, lighting, texture, medium, composition.
 * Removes: any sentence mentioning face/eyes/skin/character/proportions/nose/mouth/cheek.
 *
 * @param {string} artStyleId - Style key (e.g., 'anime')
 * @param {string} [backend] - Image backend ('grok', 'gemini', 'runware')
 * @returns {string|null} Cleaned style description or null if not found
 */
function resolveArtStyleForEmptyScene(artStyleId, backend) {
  const full = resolveArtStyle(artStyleId, backend);
  if (!full) return null;

  // Pattern matches anatomy-related keywords (whole-word, case-insensitive).
  // "features" only matches when it's clearly facial (paired with face/eye context),
  // so we keep it broad and rely on the sentence containing other anatomy cues too.
  const ANATOMY_RE = /\b(face|faces|facial|eye|eyes|skin|character|characters|proportion|proportions|proportioned|nose|mouth|jawline|cheek|cheeks|expression|expressions|expressive|brow|brows|eyebrow|eyebrows|lips|chin|iris|irises|pore|pores)\b/i;

  // Split on sentence boundaries while preserving the punctuation.
  // Handles ". ", "! ", "? " — em-dashes mid-sentence are not split.
  const sentences = full.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [full];

  const kept = sentences
    .map(s => s.trim())
    .filter(s => s.length > 0 && !ANATOMY_RE.test(s));

  return kept.join(' ').trim() || null;
}

/**
 * Resolve art style description for the 2×4 CHARACTER REFERENCE SHEET (Pass-2
 * style transfer). The page-style descriptors bake in scene/environment prose
 * ("rainy streets, chrome surfaces, volumetric fog") because they were authored
 * for full illustrations. On a reference sheet those words make the model paint
 * a whole environment behind the figure, defeating the plain-white background a
 * cutout needs. This is the mirror of resolveArtStyleForEmptyScene: it strips
 * ENVIRONMENT clauses while keeping the rendering technique, palette, linework,
 * and face description.
 *
 * Strips at CLAUSE level (comma-delimited), not sentence level, because the
 * scene words are often embedded in the same sentence that names the medium
 * (e.g. cyber's "A cyberpunk graphic novel illustration with neon reflections,
 * rainy streets, chrome surfaces, ..."). Dropping the whole sentence would lose
 * the style identity; dropping only the scene clauses keeps it.
 *
 * @param {string} artStyleId - Style key (e.g., 'cyber')
 * @param {string} [backend] - Image backend ('grok', 'gemini', 'runware')
 * @returns {string|null} Sheet-safe style description or null if not found
 */
function resolveArtStyleForSheet(artStyleId, backend) {
  const full = resolveArtStyle(artStyleId, backend);
  if (!full) return null;

  // Environment / scenery / composition words. "neon reflections" and "neon
  // highlights" describe how light hits the character, so bare "neon" is NOT
  // matched — only scene nouns like "neon sign" are.
  const SCENE_RE = /\b(street|streets|road|roads|pavement|sidewalk|alley|alleys|rainy|rain|raining|puddle|puddles|fog|foggy|mist|misty|smoke|steamy|atmosphere|atmospheric|scenery|landscape|landscapes|cityscape|skyline|skyscraper|skyscrapers|chrome|backdrop|background|backgrounds|environment|environments|setting|settings|indoor|indoors|outdoor|outdoors|room|rooms|wall|walls|floor|sky|cloud|clouds|forest|building|buildings|architecture|storefront|window|windows|composition|staged|staging|photographed|neon signs?)\b/i;
  // Sentences carrying an explicit RULE (negation, "only on …", parentheticals,
  // em-dash asides) are kept verbatim — clause-splitting them risks inverting a
  // rule ("gears never on faces" → "gears on faces"). Purity is worth less than
  // not corrupting a constraint; a stray scene noun inside a negated rule won't
  // make the model paint a background on an otherwise empty sheet.
  const RULE_RE = /\b(never|not|no|only|exactly|must|preserve|keep|do not|appear only)\b|[()]|—/i;

  const sentences = full.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [full];
  const outSentences = [];
  for (const raw of sentences) {
    const m = raw.match(/([.!?]+)\s*$/);
    const end = m ? m[1] : '';
    const body = (m ? raw.slice(0, m.index) : raw).trim();
    if (!body) continue;
    if (RULE_RE.test(body)) { outSentences.push(body + end); continue; }
    if (!SCENE_RE.test(body)) { outSentences.push(body + end); continue; }
    // Scene-bearing, no rule markers: drop the environment clauses (split on
    // commas AND semicolons), keep the rest. Strip a dangling leading "and ".
    const keptClauses = body.split(/[,;]/).map(c => c.trim()).filter(Boolean)
      .filter(c => !SCENE_RE.test(c))
      .map(c => c.replace(/^and\s+/i, '').trim())
      .filter(Boolean);
    if (!keptClauses.length) continue;
    outSentences.push(keptClauses.join(', ') + end);
  }

  return outSentences.join(' ').replace(/\s{2,}/g, ' ').trim() || null;
}

/**
 * Language level definitions - controls text length per page
 */
const LANGUAGE_LEVELS = {
  '1st-grade': {
    description: 'Simple words and very short sentences for early readers',
    wordsPerPageMin: 25,
    wordsPerPageMax: 50,
    sentencesPerPage: '2-4',
    pacing: 'Small amount of variation is fine — some pages can sit at the low end (a quiet beat), others near the top. Don\'t aim for a uniform word count.',
  },
  'standard': {
    description: 'Age-appropriate vocabulary for elementary school children',
    wordsPerPageMin: 40,
    wordsPerPageMax: 150,
    sentencesPerPage: '3-12',
    pacing: '150 words is the UPPER LIMIT, not the target. Alternate rhythm: short pages (40-80 words, a quiet beat) interleaved with longer pages (120-150 words, a fuller scene). Avoid two long pages back-to-back — always give the reader breath between dense pages. Aim for variation like: long, short, medium, long, short. Mix sentence lengths within a page — some longer sentences that join two thoughts, some short ones: a short sentence lands because longer ones surround it. Never string several short sentences in a row, and never repeat the same subject-verb opening in consecutive sentences.',
  },
  'advanced': {
    description: 'More complex vocabulary and varied sentence structure for advanced readers',
    wordsPerPageMin: 250,
    wordsPerPageMax: 300,
    sentencesPerPage: '15-20',
    pacing: 'Every page should land at similar length (250-300 words). Do NOT alternate short and long pages at this level — consistent density creates reading momentum for advanced readers. Aim for the middle of the range on every page. Use the full range of sentence lengths on every page: genuinely long sentences whose subordinate clauses connect cause, consequence and feeling, medium ones that carry the action, and an occasional short one for a moment that must land. Never string several short sentences in a row, and never repeat the same subject-verb opening in consecutive sentences.',
  }
};

// ============================================================================
// LEVEL HELPERS
// ============================================================================

/**
 * Get reading level text for prompts
 */
function getReadingLevel(languageLevel) {
  const levelInfo = LANGUAGE_LEVELS[languageLevel] || LANGUAGE_LEVELS['standard'];
  const pageLength = `${levelInfo.sentencesPerPage} sentences per page (approximately ${levelInfo.wordsPerPageMin}-${levelInfo.wordsPerPageMax} words)`;
  const pacing = levelInfo.pacing ? ` PACING: ${levelInfo.pacing}` : '';
  return `${levelInfo.description}. ${pageLength}.${pacing}`;
}

/**
 * Estimate tokens per page for batch size calculation
 */
function getTokensPerPage(languageLevel) {
  const levelInfo = LANGUAGE_LEVELS[languageLevel] || LANGUAGE_LEVELS['standard'];
  // Use max words, multiply by ~1.3 tokens/word (English average), add 2x safety margin
  const tokensPerPage = Math.ceil(levelInfo.wordsPerPageMax * 1.3 * 2);
  return tokensPerPage;
}

// ============================================================================
// PAGE CALCULATIONS
// ============================================================================


const NONE_WORDS = new Set(['none', 'no', 'nein', 'aucun', 'niente', '-', 'keine']);
const isNone = (v) => !v || NONE_WORDS.has(String(v).toLowerCase().trim());

/**
 * Extract a canonical visual profile from a character object. This is the
 * ONE place that knows which fields to read. Adding a new visual trait means
 * a single line here — all downstream formatters pick it up automatically.
 *
 * @param {Object} char - Character object
 * @param {Object} [options]
 * @param {string} [options.clothingOverride] - Pre-resolved clothing string (e.g. from avatar photo eval)
 * @returns {Object} Normalized visual profile
 */
function extractCharacterVisualProfile(char, options = {}) {
  if (!char || typeof char !== 'object') char = {};
  const physical = getPhysicalFromChar(char) || {};
  const numericAge = parseInt(char.age);
  const resolvedAge = Number.isFinite(numericAge) ? numericAge : null;
  // apparentAge (the photo read) is FIRST on purpose: real 8-year-olds range
  // from looking 6 to looking 10, and the picture is the better guide to how the
  // child should be drawn than the number typed in. It is safe to trust here
  // because clampApparentAge() already bounded it to ONE bucket from the stated
  // age when the photo was analysed (routes/avatars.js) — the same tolerance
  // image-evaluation.txt applies ("a 7-year-old reading as 6 → NO deduction").
  const ageCategory = physical.apparentAge || char.ageCategory ||
    (resolvedAge != null ? getAgeCategory(resolvedAge) : null);

  return {
    name: char.name,
    gender: char.gender,
    numericAge: resolvedAge,
    ageCategory,
    ageMarkers: ageCategory ? getAgeMarkers(ageCategory) : '',
    genderTerm: getGenderTerm(char.gender, ageCategory),
    height: char.height || char.physical?.height || null,
    build: physical.build || char.physical?.build || null,
    eyeColor: physical.eyeColor || null,
    // Hair description is derived from detailedHairAnalysis only (see
    // buildHairDescription). The legacy simple fields hairStyle/hairLength/
    // hairDensity are no longer read — they drifted from detailedHairAnalysis
    // and produced wrong prose (e.g. calling a bald character "white, straight").
    hair: buildHairDescription(physical, char.physicalTraitsSource) || null,
    facialHair: physical.facialHair || char.physical?.facialHair || null,
    face: physical.face || char.physical?.face || char.otherFeatures || null,
    glasses: physical.glasses || null,
    other: physical.other || char.physical?.other || null,
    clothing: options.clothingOverride ||
      char.clothing?.current ||
      (typeof char.clothing === 'string' ? char.clothing : null),
    clothingStyle: char.clothingStyle || char.clothing_style || char.clothing?.style ||
      char.clothingColors || char.clothing_colors || char.clothing?.colors || null,
  };
}

/**
 * Build the shared labeled-parts array used by numbered-list and
 * [Name]: markdown formatters. Returns an array of "Label: value" strings
 * with "none"-synonyms filtered out and age-word cleanup applied.
 *
 * @param {Object} profile - result of extractCharacterVisualProfile
 * @param {Object} [options]
 * @param {boolean} [options.includeEyeColor=true]
 * @param {boolean} [options.includeAgeMarkers=true]
 * @param {string}  [options.clothingLabel='Wearing']
 * @returns {string[]}
 */
function buildLabeledPhysicalParts(profile, options = {}) {
  const { includeEyeColor = true, includeAgeMarkers = true, clothingLabel = 'Wearing' } = options;
  const parts = [];

  if (profile.build) parts.push(`Build: ${profile.build}`);
  if (includeAgeMarkers && profile.ageMarkers) parts.push(`Age cues: ${profile.ageMarkers}`);
  if (includeEyeColor && profile.eyeColor) parts.push(`Eyes: ${profile.eyeColor}`);
  if (profile.hair) parts.push(`Hair: ${profile.hair}`);

  if (profile.gender === 'male' && !isNone(profile.facialHair)) {
    parts.push(profile.facialHair.toLowerCase() === 'clean-shaven'
      ? 'Facial hair: NO beard, NO mustache, NO stubble — clean-shaven face'
      : `Facial hair: ${profile.facialHair}`);
  }

  if (!isNone(profile.face)) parts.push(`Face: ${stripAgeWords(profile.face)}`);
  if (!isNone(profile.glasses)) parts.push(`Glasses: ${profile.glasses}`);
  if (!isNone(profile.other)) parts.push(`Distinctive marks: ${stripAgeWords(profile.other)}`);

  if (profile.clothing) parts.push(`${clothingLabel}: ${profile.clothing}`);
  else if (profile.clothingStyle) parts.push(`Clothing style: ${profile.clothingStyle}`);

  return parts;
}

/**
 * Build a prose physical description of a character (used for simple
 * validation / feedback text, NOT for image prompts).
 * Format: "Name is a {age}-year-old {noun}, {height}cm tall, {build} build. Hair: ... ."
 *
 * @param {Object} char - Character object
 * @returns {string} Prose description
 */
function buildCharacterPhysicalDescription(char, clothingOverride = null) {
  const p = extractCharacterVisualProfile(char, { clothingOverride });
  // Prefer the apparent-age categorical label (genderTerm derived from apparentAge)
  // over the numeric age. The avatar photo and the eval are both anchored to the
  // apparent-age bucket — leading the prose with a number lets Claude paraphrase
  // into the wrong bucket (e.g. "12-year-old" → "grade-school" when the photo
  // looks school-age and the eval will judge against that). Falls back to a
  // numeric description only when no category is available.
  const ageLabel = p.ageCategory || null;
  const genderLabel = p.genderTerm
    || (p.gender === 'male' ? 'boy' : p.gender === 'female' ? 'girl' : 'child');
  const age = p.numericAge ?? 10;

  let s = ageLabel
    ? `${p.name} is a ${ageLabel} ${genderLabel} (Looks: ${ageLabel})`
    : `${p.name} is a ${age}-year-old ${genderLabel}`;
  if (p.height) s += `, ${p.height} cm tall`;
  if (p.build) s += `, ${p.build} build`;
  if (p.hair) s += `. Hair: ${p.hair}`;
  if (p.gender === 'male' && !isNone(p.facialHair)) {
    s += p.facialHair.toLowerCase() === 'clean-shaven'
      ? '. Facial hair: NO beard, NO mustache, NO stubble — clean-shaven face'
      : `. Facial hair: ${p.facialHair}`;
  }
  if (!isNone(p.face)) s += `, ${stripAgeWords(p.face)}`;
  if (!isNone(p.glasses)) s += `. Glasses: ${p.glasses}`;
  if (!isNone(p.other)) s += `, ${stripAgeWords(p.other)}`;
  if (p.clothing) s += `. Wearing: ${p.clothing}`;
  return s;
}

/**
 * Concise GroundingDINO grounding prompt for figure DETECTION — NOT the
 * image-gen description. GDINO localises on visually-groundable tokens (age,
 * gender, hair COLOUR, facial hair, glasses, clothing colour) and has a
 * 256-token text cap. Feeding it buildCharacterPhysicalDescription's ~250
 * chars of face geometry (jawline/chin/nose-tip/cheekbones/lips) — which GDINO
 * cannot see in a render — fills the budget and buries/truncates the groundable
 * tokens, tanking localisation and causing figure misattribution. Measured on
 * an anime page (2026-07-15): verbose prompt 0.45 + wrong boxes vs this concise
 * form 0.86 + tight boxes. Clothing is appended per-page by the caller
 * (buildExpectedCharactersForBbox) because the worn outfit is page-specific.
 */
function buildGroundingPrompt(char) {
  const p = extractCharacterVisualProfile(char, {});
  const genderLabel = p.genderTerm
    || (p.gender === 'male' ? 'boy' : p.gender === 'female' ? 'girl' : 'child');
  const noun = p.ageCategory ? `${p.ageCategory} ${genderLabel}` : genderLabel;
  const art = /^[aeiou]/i.test(noun) ? 'an' : 'a';
  const parts = [];
  // Hair COLOUR only (first comma-segment of the full hair prose), not style.
  const hairColour = p.hair ? String(p.hair).split(',')[0].trim() : '';
  if (hairColour) parts.push(`${hairColour} hair`);
  if (p.gender === 'male' && !isNone(p.facialHair) && p.facialHair.toLowerCase() !== 'clean-shaven') {
    parts.push('a beard');
  }
  if (!isNone(p.glasses)) parts.push('glasses');
  return parts.length ? `${art} ${noun} with ${parts.join(' and ')}` : `${art} ${noun}`;
}

/**
 * Estimate a character's height in cm from age + gender when no explicit
 * height is set. Used purely for relative ordering — exact values don't
 * matter, only the rank preservation.
 *
 * @param {Object} char - Character with optional age, apparentAge, gender
 * @returns {number|null} Estimated height in cm, or null if no signal
 */
function estimateHeightFromAgeGender(char) {
  const gender = char?.gender;
  const isMale = gender === 'male';
  const isFemale = gender === 'female';

  // Prefer numeric age when present
  let age = parseInt(char?.age);
  if (isNaN(age)) {
    // Fall back to apparent age category → approximate years
    const physical = getPhysicalFromChar(char) || {};
    const apparent = physical.apparentAge || char?.apparentAge || char?.ageCategory;
    const APPARENT_AGE_YEARS = {
      infant: 0.5,
      toddler: 2,
      preschooler: 4,
      kindergartner: 5,
      'young-school-age': 7,
      'school-age': 9,
      preteen: 11,
      'young-teen': 13,
      teenager: 16,
      'young-adult': 25,
      adult: 35,
      'middle-aged': 50,
      senior: 70,
      elderly: 80,
    };
    age = APPARENT_AGE_YEARS[apparent];
  }
  if (age == null || isNaN(age)) return null;

  // Growth curve in cm, averaged WHO/CDC references. Gender diverges from ~12.
  // Values are order-preserving approximations — not medically precise.
  if (age < 1) return 55;
  if (age < 2) return 75;
  if (age < 3) return 86;
  if (age < 4) return 95;
  if (age < 5) return 103;
  if (age < 6) return 110;
  if (age < 7) return 117;
  if (age < 8) return 122;
  if (age < 9) return 128;
  if (age < 10) return 133;
  if (age < 11) return 138;
  if (age < 12) return 144;
  if (age < 13) return isFemale ? 155 : 150;
  if (age < 14) return isFemale ? 158 : 157;
  if (age < 15) return isFemale ? 160 : 164;
  if (age < 16) return isFemale ? 161 : 170;
  if (age < 17) return isFemale ? 162 : 174;
  if (age < 18) return isFemale ? 163 : 176;
  // Adult ranges
  const adultBase = isMale ? 178 : isFemale ? 165 : 172;
  if (age < 60) return adultBase;
  if (age < 75) return adultBase - 3; // mild shrink with age
  return adultBase - 5;
}

/**
 * Build a single character's full physical + clothing description for scene expansion.
 *
 * Returns a numbered-list line in the same format buildImagePrompt currently uses for
 * CHARACTER REFERENCE PHOTOS. Scene expansion (Claude) will read these and weave them
 * naturally into the prose so the final image prompt is conversational language instead
 * of a structured block.
 *
 * @param {Object} char - Character object (with physical traits + avatars)
 * @param {string|null} clothingDescription - Pre-resolved avatar clothing description (from referencePhotos)
 * @param {number} index - 1-based index for the numbered list
 * @returns {string} Formatted line: "1. Lukas, Looks: school-age, boy, Build: slim. Age cues: ..."
 */
function buildCharacterDescriptionForExpansion(char, clothingDescription, index) {
  return buildCharacterPromptBlock(char, {
    format: 'numbered',
    numbered: index,
    includeClothing: true,
    clothingOverride: clothingDescription,
  });
}

/**
 * Public entry point for rendering a character's identity block into prompts.
 * Wraps the canonical extractCharacterVisualProfile + buildLabeledPhysicalParts
 * path so every consumer (unified story prompt, VB section, scene expansion,
 * image-prompt reference list) sees the same fields — including glasses,
 * hairStyle, facialHair — and field-subset drift across builders is impossible.
 *
 * @param {Object} char - Character object (source of truth, not a VB copy)
 * @param {Object} [opts]
 * @param {'bullets'|'numbered'|'prose'} [opts.format='bullets']
 *   - 'bullets': "**Name:**\n- Age cues: ...\n- Hair: ..." (for image-prompt MAIN CHARACTERS block)
 *   - 'numbered': "N. Name, Looks: ..., Build: ..." (for scene-expansion input)
 *   - 'prose': full sentence (for validation / feedback text)
 * @param {number|null} [opts.numbered=null] - 1-based index for 'numbered' format
 * @param {boolean} [opts.includeClothing=false] - append clothing/Wearing line
 * @param {string|null} [opts.clothingOverride=null] - pre-resolved clothing string
 * @returns {string}
 */
function buildCharacterPromptBlock(char, opts = {}) {
  const {
    format = 'bullets',
    numbered = null,
    includeClothing = false,
    clothingOverride = null,
  } = opts;

  const profile = extractCharacterVisualProfile(char, { clothingOverride });
  const parts = buildLabeledPhysicalParts(profile);
  const partsFiltered = includeClothing
    ? parts
    : parts.filter(p => !p.startsWith('Wearing:') && !p.startsWith('Clothing style:'));

  if (format === 'prose') {
    return buildCharacterPhysicalDescription(char, clothingOverride);
  }

  if (format === 'numbered') {
    const visualAge = profile.ageCategory ? `Looks: ${profile.ageCategory.replace(/-/g, ' ')}` : '';
    const brief = [profile.name, visualAge, profile.genderTerm, partsFiltered.join('. ')].filter(Boolean).join(', ');
    const prefix = numbered != null ? `${numbered}. ` : '';
    return `${prefix}${brief}`;
  }

  // bullets (default). For image-pipeline consumers we surface the VISUAL age
  // category ('school-age', 'teenager', 'adult') — not the numeric age. The
  // numeric age is used elsewhere (story-text generation, reading-level
  // decisions) but image models respond to visual cues, not numbers. A 45-year-old
  // and a 50-year-old look the same to the model; what matters is 'adult'.
  // buildLabeledPhysicalParts already emits 'Age cues: ...' from profile.ageMarkers;
  // 'Looks' + genderTerm above give the reader a quick identity anchor.
  const lines = [`**${profile.name}:**`];
  if (profile.ageCategory) lines.push(`- Looks: ${profile.ageCategory.replace(/-/g, ' ')}`);
  if (profile.genderTerm) lines.push(`- Gender: ${profile.genderTerm}`);
  for (const p of partsFiltered) lines.push(`- ${p}`);
  return lines.join('\n');
}

/**
 * Build relative height description for characters
 * Instead of absolute cm values, describes relative heights which AI understands better.
 * Characters without explicit height fall back to age+gender estimation so they
 * can still be placed in the ordering — the output is just a rank order, not
 * absolute cm values, so approximate estimates are sufficient.
 * @param {Array} characters - Array of character objects with name and height properties
 * @returns {string} Description like "Height order: Emma (shortest) -> Max (taller) -> Dad (slightly taller)"
 */
function buildRelativeHeightDescription(characters) {
  if (!characters || characters.length < 2) return '';

  // Resolve a height for every character: prefer explicit, fall back to estimate.
  // Support both new structure (char.physical.height) and legacy (char.height).
  const withHeight = characters
    .map(c => {
      const explicit = c.height || c.physical?.height;
      const explicitNum = explicit ? parseInt(explicit) : NaN;
      if (!isNaN(explicitNum)) {
        return { name: c.name, height: explicitNum };
      }
      const estimate = estimateHeightFromAgeGender(c);
      if (estimate != null) {
        return { name: c.name, height: estimate };
      }
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => a.height - b.height);

  if (withHeight.length < 2) return '';

  // Build relative description
  const descriptions = [];

  for (let i = 0; i < withHeight.length; i++) {
    const char = withHeight[i];

    if (i === 0) {
      // First (shortest) character
      descriptions.push(`${char.name} (shortest)`);
    } else {
      // Compare to previous character
      const prev = withHeight[i - 1];
      const diff = char.height - prev.height;

      let descriptor;
      if (diff <= 3) {
        descriptor = 'similar height';
      } else if (diff <= 10) {
        descriptor = 'slightly taller';
      } else if (diff <= 25) {
        descriptor = 'taller';
      } else {
        descriptor = 'noticeably taller';
      }

      descriptions.push(`${char.name} (${descriptor})`);
    }
  }

  return `**HEIGHT ORDER (shortest to tallest):** ${descriptions.join(' -> ')}`;
}

/**
 * Explicit character-restriction block appended to an image / cover prompt when
 * the user regenerates with a subset of characters. Filtering the reference
 * photos is NOT enough — the scene prose still names excluded characters and the
 * image model draws anyone it is told about (observed: a supporting character
 * reappearing on a cover the user regenerated without them). Single source of
 * truth for scene-page regen (routes/regeneration.js) and cover regen
 * (lib/coverIterate.js). Returns '' when nothing is excluded.
 */
function buildCharacterRestriction(selectedNames, excludedNames) {
  if (!Array.isArray(excludedNames) || excludedNames.length === 0) return '';
  return `\n\n**CRITICAL CHARACTER RESTRICTION:**\nONLY show these characters: ${(selectedNames || []).join(', ')}\nDo NOT include: ${excludedNames.join(', ')}\nIf the scene description mentions excluded characters, IGNORE those mentions and show ONLY the specified characters.`;
}

/**
 * Build character reference list for image prompts (covers and story pages)
 * Creates a numbered list with consistent formatting across all image types
 * @param {Array} photos - Reference photos with name, clothingDescription
 * @param {Array} characters - Original character data with physical descriptions
 * @returns {string} Formatted character reference list
 */
/**
 * REFERENCE CARD COLOURS legend — which colour-framed reference card is whom.
 *
 * Shared by pages AND covers (owner, 2026-08-26: "make them IDENTICAL to normal
 * pages. IDENTICAL CODE"). grok.js frames every character card in a colour, and
 * without this legend the model gets framed cards with no key. Pages have
 * carried it for months; covers packed the SAME framed cards and shipped no
 * legend at all — one half of why cover wardrobes drift while page wardrobes
 * hold.
 *
 * grok.js frames cards ONLY for characters that actually have a reference photo
 * on this image (after any OTS/background filtering), so the colour canon MUST
 * be that same filtered set — building it from ALL characters diverges in
 * membership and the colours bind to the wrong person.
 */
/**
 * Build a COVER prompt — through the exact same builder a page uses.
 *
 * Owner, 2026-08-26: "make them IDENTICAL to normal pages. IDENTICAL CODE...
 * Covers get one more pass for text, that is it. Otherwise they are identical."
 *
 * Before this, three separate call sites (coverIterate, the streaming cover in
 * storyJobPipeline, and the trial cover) each filled their own copy of four
 * cover templates. Three duplicated parallel paths, none of which received the
 * improvements pages got — which is how a character kept his dungarees on every
 * page and lost them on every cover.
 *
 * A cover is now a page plus two things: the cover-only composition bullets
 * (title-safe top third, group arrangement, bottom margin) and, afterwards, the
 * typography pass that composites the title. The art itself is generated
 * textless, so no template needs a TITLE or DEDICATION block at all.
 *
 * @param {'front'|'initialPage'|'back'} coverType
 * @param {Object} args - everything buildImagePrompt needs, plus groupComposition
 */
function buildCoverPrompt(coverType, {
  sceneDescription,
  inputData,
  characters = null,
  visualBible = null,
  referencePhotos = null,
  groupComposition = '',
  options = {},
} = {}) {
  const key = coverType === 'front' ? 'front' : coverType === 'back' ? 'back' : 'initialPage';
  const raw = PROMPT_TEMPLATES.coverComposition || '';
  // Sections are delimited by '### <key>' lines in cover-composition.txt.
  const section = (() => {
    const m = raw.split(/^###\s+/m).find(b => b.trim().toLowerCase().startsWith(key.toLowerCase()));
    if (!m) {
      log.error(`❌ [COVER PROMPT] cover-composition.txt has no '### ${key}' section — the cover ships without its composition rules.`);
      return '';
    }
    return m.slice(m.indexOf('\n') + 1).trim();
  })();
  const composition = section
    ? `**COMPOSITION GUIDELINES:**\n${section.replace('{GROUP_COMPOSITION}', groupComposition || '').trim()}`
    : '';

  return buildImagePrompt(
    sceneDescription,
    inputData,
    characters,
    visualBible,
    require('./coverKeys').COVER_PAGE_NUMBERS[
      coverType === 'front' ? 'frontCover' : coverType === 'back' ? 'backCover' : 'initialPage'
    ] ?? null,
    referencePhotos,
    { ...options, coverComposition: composition }
  );
}

function buildReferenceCardColours(chars, referencePhotos) {
  chars = Array.isArray(chars) ? chars.filter(Boolean) : [];
  if (chars.length === 0) return '';
  const cardNames = (referencePhotos || []).map(p => p && p.name).filter(Boolean);
  const cardSet = new Set(cardNames.map(n => n.toLowerCase()));
  const canonNames = cardNames.length ? cardNames : chars.map(c => c.name);
  const frameLines = [];
  for (const c of chars) {
    // Only characters with a reference card get a colour line (matches grok.js).
    if (cardNames.length && !cardSet.has(String(c.name).toLowerCase())) continue;
    const col = frameColorForName(c.name, canonNames);
    if (col) frameLines.push(`- ${col.label} frame = ${c.name}`);
  }
  if (frameLines.length === 0) return '';
  return `\nREFERENCE CARD COLOURS (each character's reference card has a coloured frame — match each person to their card):\n${frameLines.join('\n')}\nThe frame colours are identifiers ONLY. Never paint a coloured frame, border, or these colours onto any character, clothing, prop, or surface in the scene.\n`;
}

function buildCharacterReferenceList(photos, characters = null, { includeClothing = false } = {}) {
  if (!photos || photos.length === 0) return '';

  // Each character is already named with their physical description in the
  // SCENE prose (per story-unified.txt: "Name each character explicitly on
  // first mention, THEN weave the physical description in"), and each
  // attached image carries a `[Name]:` label in the parts array. Repeating
  // the description here was triple-binding the same info — drop it.
  // Just list the names so the model knows which images to expect.
  // Exception: covers set includeClothing — their scene prose carries no
  // clothing, so without a text anchor the outfit rides on the reference
  // pixels alone and repairs can drift it.
  const names = photos.map(p => `[${p.name}]`).join(', ');
  let result = `\n**CHARACTER REFERENCE PHOTOS (one per character, labeled images attached below):** ${names}\n`;

  if (includeClothing) {
    // BIND THE GARMENT TO THE PERSON, exactly as a page does (owner,
    // 2026-08-26: covers must be identical to pages). A page brief dresses each
    // character inside their own sentence — "Name — a toddler-proportioned
    // little boy, <hair>, <eyes>, <every garment> — stands ...". Covers used to
    // emit a DETACHED list of near-identical outfits instead, and in a lineup
    // the odd garment out got flattened into the majority pattern: the same
    // child kept his dungarees on every page and lost them on all three covers
    // of two consecutive books, while the prompt text and the reference image
    // both carried them.
    //
    // Same shape, same builder as the page path (buildCharacterPromptBlock
    // 'prose' → buildCharacterPhysicalDescription), so there is one description
    // format and no second, worse copy of the job.
    const byName = new Map((characters || []).map(c => [String(c.name).toLowerCase(), c]));
    const lines = [];
    for (const p of photos) {
      if (!p?.name || !p?.clothingDescription) continue;
      const char = byName.get(String(p.name).toLowerCase());
      lines.push(char
        ? `- ${buildCharacterPromptBlock(char, { format: 'prose', includeClothing: true, clothingOverride: p.clothingDescription })}`
        : `- ${p.name} wears: ${p.clothingDescription}`);
    }
    if (lines.length > 0) {
      result += `\n**CHARACTERS IN THIS IMAGE (each person, then what that person wears):**\n${lines.join('\n')}\n`;
    }
  }

  if (characters && characters.length >= 2) {
    const sceneCharacters = characters.filter(c => photos.some(ph => ph.name === c.name));
    const heightDescription = buildRelativeHeightDescription(sceneCharacters);
    if (heightDescription) {
      result += `\n${heightDescription}\n`;
      log.debug(`📏 Added relative heights: ${heightDescription}`);
    }
  }

  return result;
}

// ============================================================================
// PARSERS
// ============================================================================

/**
 * Build base prompt for story text generation
 */
function buildBasePrompt(inputData, textPageCount = null) {
  const mainCharacterIds = inputData.mainCharacters || [];
  // Picture-book layout for all reading levels: 1 page = 1 scene = 1 text page.
  const actualTextPages = textPageCount || (inputData.pages || 15);

  // For story text generation, we use BASIC character info (no strengths/weaknesses)
  // Strengths/weaknesses are only used in outline generation to avoid repetitive trait mentions
  const characterSummary = (inputData.characters || []).map(char => {
    const isMain = mainCharacterIds.includes(char.id);
    const traits = getTraits(char);
    return {
      name: char.name,
      isMainCharacter: isMain,
      gender: char.gender,
      age: char.age,
      specialDetails: traits.specialDetails || ''  // Includes hobbies, hopes, fears, favorite animals
    };
  });

  // Build relationship descriptions
  let relationshipDescriptions = '';
  if (inputData.relationships) {
    const relationships = inputData.relationships;
    const relationshipTexts = inputData.relationshipTexts || {};
    const characters = inputData.characters || [];

    const relationshipLines = Object.entries(relationships)
      .filter(([key, type]) => type && type !== 'Not Known to')
      .map(([key, type]) => {
        const [char1Id, char2Id] = key.split('-').map(Number);
        const char1 = characters.find(c => c.id === char1Id);
        const char2 = characters.find(c => c.id === char2Id);
        if (!char1 || !char2) return null;
        const customText = relationshipTexts[key] || '';
        const baseRelationship = `${char1.name} is ${type} ${char2.name}`;
        return customText ? `${baseRelationship}. ${customText}` : baseRelationship;
      })
      .filter(Boolean);

    if (relationshipLines.length > 0) {
      relationshipDescriptions = `\n- **Relationships**:\n${relationshipLines.map(r => `  - ${r}`).join('\n')}`;
    }
  }

  const readingLevel = getReadingLevel(inputData.languageLevel);

  // Add language-specific note from centralized config
  const language = inputData.language || 'en';
  const languageNote = getLanguageNote(language);

  return `# Story Parameters

- **Title**: ${inputData.title || 'Untitled'}
- **Length**: ${actualTextPages} text pages (write exactly this many pages, each within word limit)
- **Language**: ${language}${languageNote}
- **Reading Level**: ${readingLevel}
- **Story Type**: ${inputData.storyType || 'adventure'}
- **Story Details**: <user_input>${inputData.storyDetails || 'None'}</user_input>
- **Characters**: ${JSON.stringify(characterSummary, null, 2)}${relationshipDescriptions}`;
}

/**
 * Render the Visual Bible as the {RECURRING_ELEMENTS} block.
 *
 * Shared by the per-page expansion (which filters to the ids the scene hint
 * names, saving ~500 tokens) and the all-pages expansion (which passes the
 * whole bible, because every page draws on a different slice of it). Extracted
 * so the two callers can never format the same bible differently.
 *
 * @param {Object|null} visualBible
 * @param {Set<string>} [filterIds] - upper-cased VB ids to keep; empty = keep all
 * @returns {string}
 */
function buildRecurringElementsText(visualBible, filterIds = new Set()) {
  let recurringElements = '';
  const isRelevant = (entry) => {
    if (!filterIds || filterIds.size === 0) return true; // No filter — pass everything
    return entry.id && filterIds.has(entry.id.toUpperCase());
  };
  if (visualBible) {
    if (visualBible.secondaryCharacters && visualBible.secondaryCharacters.length > 0) {
      for (const sc of visualBible.secondaryCharacters) {
        if (!isRelevant(sc)) continue;
        const description = sc.extractedDescription || sc.description;
        recurringElements += `* **${sc.name}** [${sc.id}] (secondary character): ${description}\n`;
      }
    }
    if (visualBible.locations && visualBible.locations.length > 0) {
      for (const loc of visualBible.locations) {
        if (!isRelevant(loc)) continue;
        recurringElements += buildVbLocationLines(loc);
      }
    }
    if (visualBible.vehicles && visualBible.vehicles.length > 0) {
      for (const veh of visualBible.vehicles) {
        if (!isRelevant(veh)) continue;
        const description = veh.extractedDescription || veh.description;
        recurringElements += `* **${veh.name}** [${veh.id}] (vehicle): ${description}\n`;
      }
    }
    if (visualBible.animals && visualBible.animals.length > 0) {
      for (const animal of visualBible.animals) {
        if (!isRelevant(animal)) continue;
        const description = animal.extractedDescription || animal.description;
        recurringElements += `* **${animal.name}** [${animal.id}] (animal): ${description}\n`;
      }
    }
    if (visualBible.artifacts && visualBible.artifacts.length > 0) {
      for (const artifact of visualBible.artifacts) {
        if (!isRelevant(artifact)) continue;
        const description = artifact.extractedDescription || artifact.description;
        recurringElements += `* **${artifact.name}** [${artifact.id}] (object): ${description}\n`;
      }
    }
    if (visualBible.clothing && visualBible.clothing.length > 0) {
      for (const item of visualBible.clothing) {
        if (!isRelevant(item)) continue;
        const description = item.extractedDescription || item.description;
        const wornBy = item.wornBy ? ` (worn by ${item.wornBy})` : '';
        recurringElements += `* **${item.name}** [${item.id}]${wornBy} (clothing): ${description}\n`;
      }
    }
  }
  return recurringElements || '(None available)';
}

/**
 * ALL-pages scene expansion (beats pipeline, step 4).
 *
 * The per-page fan-out expanded each page blind to its neighbours, and the
 * scene review then had to repair the drift it caused (a page landing in a
 * "warmly lit indoor domestic interior" with no narrative transition into a
 * house, between two riverbank pages). Location, time of day, clothing and
 * composition continuity are properties of the SET, so the set is written in
 * one call. Repetition and visual arc were already reviewed set-wide; now they
 * are authored set-wide too.
 *
 * Output shape is `## Page N` + prose + METADATA per page — exactly what the
 * scene review returns — so parseRefinedText(raw, expected, 'SCENES') reads it
 * with no new parser.
 *
 * @param {Object} inputData
 * @param {Array<{pageNumber:number, beat:string, scene:string}>} beats
 * @param {Object} [options]
 * @param {Object} [options.visualBible]
 * @param {string} [options.availableAvatars]
 * @param {number} [options.maxCharactersPerScene]
 * @returns {string|null} null when the template is unavailable
 */
function buildSceneExpansionAllPrompt(inputData, beats = [], options = {}) {
  const template = PROMPT_TEMPLATES.sceneExpansionAll;
  if (!template) {
    log.error('[PROMPT] sceneExpansionAll template not loaded — all-pages scene expansion unavailable');
    return null;
  }
  const characters = inputData.characters || [];
  // Clothing TEXT per character, not the category key. Passing null here left
  // the all-pages Art Director with no outfit at all, so it wrote the key into
  // the prose ("wearing his standard clothes") — the metadata label as an
  // English phrase, which the quality evaluator then judges the render against.
  // Story-level requirements are the source; the per-page category picks which
  // entry, defaulting to the story's primary when the beat doesn't say.
  const clothingReqs = options.clothingRequirements || inputData.clothingRequirements || null;
  // The category is resolved from the CONTRACT, never from pageClothing: that
  // blob is derived from the metadata THIS stage emits, so it is always absent
  // here. The old `(clothingReqs && primaryCategory)` gate could therefore never
  // be satisfied in the beats pipeline and every run fell through to no outfit
  // at all — for four days, silently, because the warning below only checked
  // clothingReqs. The Art Director then invented one outfit and painted the
  // whole cast in it (job_1786484554633_crojok432: five characters, five
  // contract colours, one purple robe on all of them).
  const primaryCategory = options.primaryClothing || inputData.pageClothing?.primaryClothing || null;
  let resolvedOutfits = 0;
  const characterDescriptions = characters
    .map((char, idx) => {
      const outfit = (primaryCategory ? resolveClothingForPage(char, primaryCategory, clothingReqs) : null)
        || buildUsedClothingText(char, clothingReqs);
      if (outfit) resolvedOutfits++;
      return buildCharacterDescriptionForExpansion(char, outfit || null, idx + 1);
    })
    .join('\n');
  if (!clothingReqs) {
    log.warn('[PROMPT] all-pages scene expansion has no clothingRequirements — the Art Director sees no outfit text and may write category keys into the prose');
  } else if (resolvedOutfits < characters.length) {
    // Loud on a PARTIAL resolve too: one silent character is one invented
    // outfit, and the quality evaluator then judges the render against it.
    log.error(`👕 [PROMPT] all-pages scene expansion resolved an outfit for only ${resolvedOutfits}/${characters.length} character(s) — the rest have no outfit text and the Art Director will invent one`);
  }

  const allBeats = beats
    .map(b => `## Page ${b.pageNumber}\nBEAT: ${b.beat}\nSCENE: ${b.scene}`)
    .join('\n\n');

  return fillTemplate(template, {
    PAGE_COUNT: beats.length,
    ALL_BEATS: allBeats,
    CHARACTER_DESCRIPTIONS: characterDescriptions,
    CHARACTER_COUNT: characters.length,
    HEIGHT_ORDER: buildRelativeHeightDescription(characters) || '',
    // The whole bible, unfiltered: each page draws on a different slice and a
    // per-page objects[] filter has nothing to key on in a single call.
    RECURRING_ELEMENTS: buildRecurringElementsText(options.visualBible || null),
    AVAILABLE_AVATARS: options.availableAvatars || buildAvailableAvatarsForPrompt(characters),
    MAX_CHARACTERS_PER_SCENE: options.maxCharactersPerScene || 3,
  });
}

/**
 * Build simplified scene expansion prompt for initial generation (fast/cheap)
 * Uses scene-expansion.txt template - no validation checks, no preview feedback
 * @param {number} pageNumber - Current page number
 * @param {string} pageContent - Text content for current page
 * @param {Array} characters - Character data array
 * @param {string} language - Output language
 * @param {Object} visualBible - Visual Bible data
 * @param {string} availableAvatars - Pre-built string of available avatars per character
 * @param {Object} rawOutlineContext - Raw outline blocks {previousPages: string, currentPage: string}
 */
function buildSceneExpansionPrompt(pageNumber, pageContent, characters, language = 'en', visualBible = null, availableAvatars = '', rawOutlineContext = null, options = {}) {
  // Build character names list ONLY (legacy placeholder for backwards-compat)
  const characterDetails = characters.map(c => `* **${c.name}**`).join('\n');

  // Build clothing description map (per character) from referencePhotos.
  // referencePhotos is the array returned by getCharacterPhotoDetails — it has the
  // resolved clothingDescription matching whichever avatar photo will be sent to Grok.
  // When not provided, we fall back to the character's avatar.clothing.standard map.
  const clothingMap = {};
  if (Array.isArray(options.referencePhotos)) {
    for (const photo of options.referencePhotos) {
      if (photo?.name && photo?.clothingDescription) {
        clothingMap[photo.name.toLowerCase()] = photo.clothingDescription;
      }
    }
  }

  // Build full physical descriptions per character (numbered list, for the expansion
  // prompt to weave into prose). Reuses buildCharacterDescriptionForExpansion which is
  // the same logic the legacy buildImagePrompt uses for CHARACTER REFERENCE PHOTOS.
  const characterDescriptions = characters
    .map((char, idx) => {
      // Sibling of the all-pages builder: when no referencePhotos were passed
      // (the beats per-page fallback passes none) the contract is the only
      // outfit source. Without it the Art Director invents one.
      const clothingDesc = clothingMap[char.name?.toLowerCase()]
        || buildUsedClothingText(char, options.clothingRequirements || null);
      return buildCharacterDescriptionForExpansion(char, clothingDesc, idx + 1);
    })
    .join('\n');

  // Relative height ordering (e.g. "Lukas (shortest) -> Manuel (slightly taller)")
  // Art style is NOT built here — it's prepended to the final image prompt by
  // buildImagePrompt directly, so Claude doesn't waste tokens copying it.
  const heightOrder = buildRelativeHeightDescription(characters) || '';

  // Extract object IDs from the scene hint (e.g., ["LOC003", "ANI002"]) to filter
  // recurring elements — only pass elements referenced by THIS scene, not the entire VB.
  let hintObjectIds = new Set();
  try {
    // Read the objects list straight from the raw scene hint. (Previously this
    // referenced `draftSceneDescription`, declared with `let` ~80 lines below —
    // a temporal-dead-zone ReferenceError that the catch swallowed, leaving
    // hintObjectIds empty and disabling the relevance filter entirely, so every
    // page shipped the whole Visual Bible.)
    const hintJson = rawOutlineContext?.currentPage || '';
    const objMatch = hintJson.match(/"objects"\s*:\s*\[(.*?)\]/s);
    if (objMatch) {
      const ids = objMatch[1].match(/"([^"]+)"/g);
      if (ids) ids.forEach(id => hintObjectIds.add(id.replace(/"/g, '').replace(/\.\d+$/, '').toUpperCase()));
    }
  } catch { /* ignore parse errors */ }

  // Build Visual Bible recurring elements — ONLY those referenced by this scene's objects[].
  const recurringElements = buildRecurringElementsText(visualBible, hintObjectIds);

  // Previous scenes are intentionally NOT passed — focus on this scene only.
  let sceneContextText = '';


  // Build draft scene description from scene hint
  let draftSceneDescription = '';
  if (rawOutlineContext?.currentPage) {
    // Try JSON scene hint first (new format: SCENE HINT:\n{...})
    const jsonHintMatch = rawOutlineContext.currentPage.match(/SCENE HINT:\s*(\{[\s\S]*?\})\s*(?=---|$)/);
    // Fall back to text scene hint (legacy format: SCENE HINT:\ntext...\nCharacters:...)
    const textHintMatch = rawOutlineContext.currentPage.match(/SCENE HINT:\s*(.+?)(?=\n[A-Z]|\n\n|$)/s);
    const sceneHintMatch = jsonHintMatch || textHintMatch;
    if (sceneHintMatch) {
      draftSceneDescription = sceneHintMatch[1].trim();
    } else {
      draftSceneDescription = rawOutlineContext.currentPage;
    }
  }

  // Scene summary: just the page label. The scene hint is in DRAFT_SCENE_DESCRIPTION
  // and story text in PAGE_CONTENT — don't duplicate by passing the raw outline block.
  let sceneSummary = '';

  // Mine LOCKED PERSPECTIVES from the raw outline current page (same logic as iteration)
  let lockedPerspectivesText = '';
  if (rawOutlineContext?.currentPage) {
    const lockEntries = [];
    // Bare `costumed` accepted (optional `:type` / `:{type}` suffix) — same
    // canonical clothing-token pattern as outlineParser/shared.js:117-126.
    // Requiring `costumed:type` silently dropped every bare-costumed
    // character's depth/perspective/position locks.
    const lineRegex = /[-*]?\s*([^(:\r\n]+(?:\([^)]*\))?)\s*:\s*(?:standard|winter|summer|formal|costumed(?::(?:\{[^}]*\}|[^\r\n,]+))?)((?:\s*,\s*(?:depth|perspective|position)\s*:\s*[^,\r\n]+)+)/gi;
    let lockMatch;
    const seen = new Set();
    while ((lockMatch = lineRegex.exec(rawOutlineContext.currentPage)) !== null) {
      const baseName = lockMatch[1].replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (!baseName || seen.has(baseName.toLowerCase())) continue;
      seen.add(baseName.toLowerCase());
      const annotationsRaw = lockMatch[2];
      const annPattern = /(depth|perspective|position)\s*:\s*([^,\r\n]+)/gi;
      const ann = {};
      let am;
      while ((am = annPattern.exec(annotationsRaw)) !== null) {
        ann[am[1].toLowerCase()] = am[2].trim().toLowerCase();
      }
      const parts = [];
      if (ann.perspective) parts.push(`perspective: ${ann.perspective}`);
      if (ann.depth) parts.push(`depth: ${ann.depth}`);
      if (parts.length > 0) {
        lockEntries.push(`- ${baseName}: ${parts.join(', ')}`);
      }
    }
    if (lockEntries.length > 0) {
      lockedPerspectivesText = `\n**Perspectives (from outline):**\n${lockEntries.join('\n')}\n`;
      log.info(`[SCENE EXPANSION P${pageNumber}] Perspectives: ${lockEntries.length} character(s)`);
    }
  }

  if (!PROMPT_TEMPLATES.sceneExpansion) {
    log.warn('[SCENE EXPANSION] Template not loaded, falling back to iteration prompt');
    // Fall back to the iteration prompt (same as old behavior)
    return buildSceneDescriptionPrompt(pageNumber, pageContent, characters, '', language, visualBible, [], {}, '', availableAvatars, rawOutlineContext, null);
  }

  // Compute text-zone overrides by SHIFTING every character one zone away from the
  // forbidden side. Preserves relative composition — avoids Haiku "rebalancing" the
  // scene and pulling a previously-safe character into the text zone.
  // Even pages → text on RIGHT → shift everyone LEFT (far-right→right, right→center, center→left, left→far-left).
  // Odd pages  → text on LEFT  → shift everyone RIGHT (far-left→left, left→center, center→right, right→far-right).
  //
  // PAGE-GATED: story pages only (pageNumber > 0). Covers use negative page
  // numbers and must never receive text-zone language (the model bakes
  // "open, darkening" empty space into the cover composition). The
  // template's {TEXT_ZONE_OVERRIDE} placeholder is filled '' for any
  // non-page call, so fillTemplate strips it and the fill stays clean.
  let textZoneOverride = '';
  if (pageNumber > 0) try {
    const hintObj = JSON.parse(draftSceneDescription.match(/\{[\s\S]*\}/)?.[0] || '{}');
    const forbiddenSide = pageNumber % 2 === 0 ? 'right' : 'left';
    const expectedTextPos = pageNumber % 2 === 0 ? 'bottom-right or top-right' : 'bottom-left or top-left';

    const shifts = forbiddenSide === 'left'
      ? { 'far left': 'left', 'far-left': 'left', 'left': 'center', 'center': 'right', 'right': 'far right' }
      : { 'far right': 'right', 'far-right': 'right', 'right': 'center', 'center': 'left', 'left': 'far left' };

    const shiftLateral = (position) => {
      const raw = position || 'center';
      const norm = raw.toLowerCase()
        .replace(/center[-\s]left/g, 'left')
        .replace(/center[-\s]right/g, 'right')
        .replace(/left[-\s]center/g, 'left')
        .replace(/right[-\s]center/g, 'right');
      for (const [from, to] of Object.entries(shifts)) {
        const re = new RegExp('^' + from.replace(/[-]/g, '[-\\s]') + '\\b', 'i');
        if (re.test(norm)) {
          const shifted = norm.replace(re, to);
          return { to: shifted, changed: shifted !== norm };
        }
      }
      return { to: raw, changed: false };
    };

    if (Array.isArray(hintObj.characters) && hintObj.characters.length > 0) {
      const results = hintObj.characters.map(c => ({ name: c.name, from: c.position || '(unspecified)', ...shiftLateral(c.position) }));
      if (results.some(r => r.changed)) {
        const moves = results.map(r => `- ${r.name}: ${r.from} → ${r.to}`).join('\n');
        const allowedRange = forbiddenSide === 'left' ? 'CENTER, RIGHT, or FAR RIGHT' : 'CENTER, LEFT, or FAR LEFT';
        textZoneOverride = `**TEXT ZONE POSITION FIXES (page ${pageNumber} → textPosition will be ${expectedTextPos}, text will cover the ${forbiddenSide} side of the image).**\nThe ${forbiddenSide} side of the image is reserved for printed text — NO characters, NO character bodies, NO shadows or parts of characters may appear on the ${forbiddenSide}. Every character must stand on the ${allowedRange} only.\nShift the entire composition one zone away from the ${forbiddenSide}. Use EXACTLY these positions for every character — do not re-arrange, do not invent new positions:\n${moves}\nThe relative order of characters stays the same. Apply these positions in your prose and metadata before writing anything else.\nREMINDER: text is on the ${forbiddenSide} → characters are only allowed on ${allowedRange}.\n`;
        log.info(`[SCENE EXPANSION P${pageNumber}] Text-zone shift: composition shifted away from ${forbiddenSide}`);
      }
    }
  } catch { /* non-JSON outline — skip */ }

  const languageInstruction = getLanguageInstruction(language);
  const languageName = getLanguageNameEnglish(language);

  return fillTemplate(PROMPT_TEMPLATES.sceneExpansion, {
    DRAFT_SCENE_DESCRIPTION: draftSceneDescription,
    SCENE_SUMMARY: sceneSummary,
    SCENE_CONTEXT: sceneContextText,
    PAGE_NUMBER: pageNumber.toString(),
    PAGE_CONTENT: pageContent,
    CHARACTERS: characterDetails,
    CHARACTER_DESCRIPTIONS: characterDescriptions,
    CHARACTER_COUNT: characters.length.toString(),
    HEIGHT_ORDER: heightOrder,
    RECURRING_ELEMENTS: recurringElements,
    // Honour the caller's value. This was hardcoded to '' on the assumption that
    // clothing always arrives via the scene hint — true in the unified pipeline,
    // where the writer bakes outfits into each hint, but false in beats mode,
    // where the hint is a one-line beat and clothingRequirements is the only
    // source. With it discarded the Art Director invented its own categories.
    // Every caller already passes a value; only this fill threw it away.
    AVAILABLE_AVATARS: availableAvatars || '',
    LOCKED_PERSPECTIVES: lockedPerspectivesText,
    TEXT_ZONE_OVERRIDE: textZoneOverride,
    LANGUAGE_NAME: languageName,
    LANGUAGE_INSTRUCTION: languageInstruction,
    LANGUAGE_NOTE: getLanguageNote(language),
    CORRECTION_NOTES: '',
    MAX_CHARACTERS_PER_SCENE: options.maxCharactersPerScene || 3
  });
}

/**
 * Build Art Director scene description prompt (iteration/retry - full validation)
 * Uses scene-iteration.txt template - includes all 18 checks, draft-then-validate, preview feedback
 * Alias: buildSceneDescriptionPrompt (backwards compat)
 * @param {number} pageNumber - Current page number
 * @param {string} pageContent - Text content for current page
 * @param {Array} characters - Character data array
 * @param {string} shortSceneDesc - Scene hint from outline (current page) - DEPRECATED when using rawOutlineContext
 * @param {string} language - Output language
 * @param {Object} visualBible - Visual Bible data
 * @param {Array} previousScenes - Array of {pageNumber, text, sceneHint, characterClothing} for previous pages (max 2) - DEPRECATED when using rawOutlineContext
 * @param {Object|string} characterClothing - Per-character clothing map {Name: 'category'} or legacy string - DEPRECATED when using rawOutlineContext
 * @param {string} correctionNotes - Notes from previous failed attempt (for regeneration)
 * @param {string} availableAvatars - Pre-built string of available avatars per character
 * @param {Object} rawOutlineContext - Optional: raw outline blocks {previousPages: string, currentPage: string} - skips complex parsing
 */
function buildSceneDescriptionPrompt(pageNumber, pageContent, characters, shortSceneDesc = '', language = 'en', visualBible = null, previousScenes = [], characterClothing = {}, correctionNotes = '', availableAvatars = '', rawOutlineContext = null, previewFeedback = null, options = {}) {
  const { freeIterate = false, textInImage = false, extraRule = null } = options;
  // Track Visual Bible matches for consolidated logging
  const vbMatches = [];
  const vbMisses = [];

  // FULL character blocks — age look, build, hair, eyes, features, outfit.
  // This block used to be names only ("* **Daniel**"), while the template right
  // beside it instructs the writer to "weave each named character's appearance
  // on first mention from CHARACTER DETAILS — age look, build, hair, eyes,
  // distinctive features, clothing". With nothing to weave, the rewrite invented
  // the traits or copied them out of the evaluator's feedback: a 38-year-old
  // came back as "Daniel — a kindergartner" because a bullet had called him
  // "kindergartner-aged" (job_1786053708336_8cdsca519 p10). The initial
  // Art Director (scene-expansion) has always received the full block via
  // buildCharacterDescriptionForExpansion; iterate now uses the same builder,
  // so both writers describe a character from one source.
  const perPageCategoryFor = (name) => {
    if (!characterClothing) return null;
    if (typeof characterClothing === 'string') return characterClothing;
    const key = Object.keys(characterClothing).find(k => k.trim().toLowerCase() === String(name).trim().toLowerCase());
    return key ? characterClothing[key] : null;
  };
  const characterDetails = characters.map((c, idx) => {
    // Track Visual Bible matches for logging
    if (visualBible && visualBible.mainCharacters) {
      const vbChar = visualBible.mainCharacters.find(vbc =>
        vbc.id === c.id || vbc.name.toLowerCase().trim() === c.name.toLowerCase().trim()
      );
      if (vbChar) {
        vbMatches.push(c.name);
      } else {
        vbMisses.push(c.name);
      }
    }
    const cat = perPageCategoryFor(c.name);
    const outfit = (options.clothingRequirements && cat)
      ? resolveClothingForPage(c, cat, options.clothingRequirements)
      : null;
    return buildCharacterDescriptionForExpansion(c, outfit || null, idx + 1);
  }).join('\n');

  // Build Visual Bible recurring elements section - include ALL entries (not filtered by page)
  // NOTE: Do NOT include element IDs (ART001, LOC001, etc.) — they leak into scene descriptions
  // and then into image prompts where they confuse image generators.
  let recurringElements = '';
  if (visualBible) {
    // Add ALL secondary characters
    if (visualBible.secondaryCharacters && visualBible.secondaryCharacters.length > 0) {
      for (const sc of visualBible.secondaryCharacters) {
        const description = sc.extractedDescription || sc.description;
        recurringElements += `* **${sc.name}** [${sc.id}] (secondary character): ${description}\n`;
      }
    }
    // Add ALL locations - with photo variants for real landmarks
    if (visualBible.locations && visualBible.locations.length > 0) {
      for (const loc of visualBible.locations) {
        recurringElements += buildVbLocationLines(loc);
      }
    }
    // Add ALL vehicles
    if (visualBible.vehicles && visualBible.vehicles.length > 0) {
      for (const veh of visualBible.vehicles) {
        const description = veh.extractedDescription || veh.description;
        recurringElements += `* **${veh.name}** [${veh.id}] (vehicle): ${description}\n`;
      }
    }
    // Add ALL animals
    if (visualBible.animals && visualBible.animals.length > 0) {
      for (const animal of visualBible.animals) {
        const description = animal.extractedDescription || animal.description;
        recurringElements += `* **${animal.name}** [${animal.id}] (animal): ${description}\n`;
      }
    }
    // Add ALL artifacts
    if (visualBible.artifacts && visualBible.artifacts.length > 0) {
      for (const artifact of visualBible.artifacts) {
        const description = artifact.extractedDescription || artifact.description;
        recurringElements += `* **${artifact.name}** [${artifact.id}] (object): ${description}\n`;
      }
    }
    // Add ALL clothing/costumes
    if (visualBible.clothing && visualBible.clothing.length > 0) {
      for (const item of visualBible.clothing) {
        const description = item.extractedDescription || item.description;
        const wornBy = item.wornBy ? ` (worn by ${item.wornBy})` : '';
        recurringElements += `* **${item.name}** [${item.id}]${wornBy} (clothing): ${description}\n`;
      }
    }
  }

  // Consolidated logging for scene prompt
  const vbEntryCount = (visualBible?.secondaryCharacters?.length || 0) +
                       (visualBible?.locations?.length || 0) +
                       (visualBible?.vehicles?.length || 0) +
                       (visualBible?.animals?.length || 0) +
                       (visualBible?.artifacts?.length || 0) +
                       (visualBible?.clothing?.length || 0);
  const matchInfo = vbMatches.length > 0 ? vbMatches.join(', ') : 'none';
  const missInfo = vbMisses.length > 0 ? `, missing: ${vbMisses.join(', ')}` : '';
  log.debug(`[SCENE PROMPT P${pageNumber}] ${characters.length} chars (VB: ${matchInfo}${missInfo}), ${vbEntryCount} recurring elements`);

  // Default message if no recurring elements
  if (!recurringElements) {
    recurringElements = '(None available)';
  }

  // Build previous scenes and current scene context
  // SIMPLE MODE: When rawOutlineContext is provided, use raw outline blocks directly (no parsing)
  // This avoids complex parsing bugs and passes the outline data exactly as generated
  let previousScenesText = '';
  let sceneContextText = '';

  if (rawOutlineContext) {
    // SIMPLE: Use raw outline blocks directly
    if (rawOutlineContext.previousPages) {
      previousScenesText = '**PREVIOUS SCENES (for context only - do NOT illustrate these):**\n';
      previousScenesText += rawOutlineContext.previousPages + '\n\n';
    }
    // Current page context is passed via rawOutlineContext.currentPage in SCENE_SUMMARY
    // The raw block already contains TEXT, SCENE HINT, Characters, Setting, etc.
    log.debug(`[SCENE PROMPT P${pageNumber}] Using raw outline context`);
  } else {
    // LEGACY: Parse and reconstruct from structured data (for backwards compatibility)
    if (previousScenes && previousScenes.length > 0) {
      previousScenesText = '**PREVIOUS SCENES (for context only - do NOT illustrate these):**\n';
      for (const prev of previousScenes) {
        // Include full text - context is valuable and tokens are cheap
        previousScenesText += `Page ${prev.pageNumber}: ${prev.text}\n`;
        if (prev.sceneHint) {
          previousScenesText += `  Scene: ${prev.sceneHint}\n`;
        }
        // Show per-character clothing for previous scenes
        if (prev.characterClothing && typeof prev.characterClothing === 'object') {
          const clothingList = Object.entries(prev.characterClothing)
            .map(([name, cat]) => `${name}: ${cat}`)
            .join(', ');
          if (clothingList) {
            previousScenesText += `  Clothing: ${clothingList}\n`;
          }
        } else if (prev.clothing) {
          // Legacy format fallback
          previousScenesText += `  Clothing: ${prev.clothing}\n`;
        }
      }
      previousScenesText += '\n';
    }

    // Extract scene context (characters, setting, time, weather) from scene hint
    const sceneMetadata = parseSceneHintMetadata(shortSceneDesc);
    if (sceneMetadata) {
      const contextParts = [];
      // Characters in this scene (with their clothing for this scene)
      if (sceneMetadata.characters) {
        contextParts.push(`- Characters in this scene: ${sceneMetadata.characters}`);
      }
      if (sceneMetadata.setting && sceneMetadata.setting.toLowerCase() !== 'n/a') {
        contextParts.push(`- Setting: ${sceneMetadata.setting}`);
      }
      if (sceneMetadata.time && sceneMetadata.time.toLowerCase() !== 'n/a') {
        contextParts.push(`- Time of day: ${sceneMetadata.time}`);
      }
      if (sceneMetadata.weather && sceneMetadata.weather.toLowerCase() !== 'n/a') {
        contextParts.push(`- Weather: ${sceneMetadata.weather}`);
      }
      if (contextParts.length > 0) {
        sceneContextText = '**Scene Context:**\n' + contextParts.join('\n') + '\n\n';
        log.debug(`[SCENE PROMPT P${pageNumber}] Scene context: ${JSON.stringify(sceneMetadata)}`);
      }
    }
  }

  // Use template from file if available. freeIterate switches to the looser
  // template (cast can change, scene can be reframed) — see scene-iteration-free.txt.
  // extraRule: Test-Lab rule experiments append to the template here (no
  // global PROMPT_TEMPLATES swap — safe under concurrency).
  const baseTemplate = freeIterate
    ? (PROMPT_TEMPLATES.sceneIterationFree || PROMPT_TEMPLATES.sceneDescriptions)
    : PROMPT_TEMPLATES.sceneDescriptions;
  const activeTemplate = baseTemplate && extraRule ? `${baseTemplate}\n${extraRule}` : baseTemplate;
  if (activeTemplate) {
    // Get the full language instruction with spelling rules (e.g., 'Write in German with Swiss spelling. Use ä,ö,ü...')
    const languageInstruction = getLanguageInstruction(language);
    const languageName = getLanguageNameEnglish(language);

    // Build scene summary - use raw outline block when available (contains all structured data)
    let sceneSummary = '';
    if (rawOutlineContext?.currentPage) {
      // Raw outline block already contains TEXT, SCENE HINT, Characters, Setting, Time, Weather
      sceneSummary = rawOutlineContext.currentPage + '\n\n';
    } else if (shortSceneDesc) {
      sceneSummary = `Scene Summary: ${shortSceneDesc}\n\n`;
    }

    // Build draft scene description from scene hint (the starting point for critique)
    let draftSceneDescription = '';
    if (rawOutlineContext?.currentPage) {
      // Try JSON scene hint first, fall back to text format
      const jsonHintMatch = rawOutlineContext.currentPage.match(/SCENE HINT:\s*(\{[\s\S]*?\})\s*(?=---|$)/);
      const textHintMatch = rawOutlineContext.currentPage.match(/SCENE HINT:\s*(.+?)(?=\n[A-Z]|\n\n|$)/s);
      const sceneHintMatch = jsonHintMatch || textHintMatch;
      if (sceneHintMatch) {
        draftSceneDescription = sceneHintMatch[1].trim();
      } else {
        draftSceneDescription = rawOutlineContext.currentPage;
      }
    } else if (shortSceneDesc) {
      draftSceneDescription = shortSceneDesc;
    }

    // Build preview feedback section. Two inputs may be present:
    //   - composition: vision-model analysis of the rendered image
    //   - fixIssues: evaluator-flagged bullets (quality + semantic)
    // Both feed Claude only — never the image API. Claude integrates them
    // into the corrected scene prose; the image model sees just the prose.
    let previewFeedbackText = '';
    if (previewFeedback && (previewFeedback.composition || previewFeedback.fixIssues?.length)) {
      const parts = [];
      if (previewFeedback.composition) {
        parts.push(`Rendered preview analysis (what the image generator produced):\n${previewFeedback.composition}`);
      }
      if (previewFeedback.fixIssues?.length > 0) {
        const bullets = previewFeedback.fixIssues.map(s => `- ${s}`).join('\n');
        const scoreLine = previewFeedback.previousScore != null ? ` (previous score: ${previewFeedback.previousScore})` : '';
        parts.push(`Evaluator findings on the previous render${scoreLine} — diagnose the root cause of each, then write the corrected scene prose so the image model fixes them implicitly. Do NOT pass these bullets to the image model:\n${bullets}`);
      }
      parts.push(`Your job:\n1. Identify mismatches (position, facing, missing characters, wrong setting)\n2. Diagnose root causes for each evaluator finding\n3. Output one corrected scene prose paragraph + metadata that will render better`);
      previewFeedbackText = parts.join('\n\n');
    } else {
      previewFeedbackText = '(No preview available - create scene from hint, run all checks)';
    }

    // Format expected clothing for the prompt. The Art Director MUST receive the
    // outfit TEXT, not just the category key: given only "Emma: standard" it has
    // nothing else to write and produces "wearing her standard clothes" — the
    // metadata key as an English phrase. That prose is the contract the quality
    // evaluator judges against, so the judge then scores a correct render as
    // off-spec ("clothing is non-standard"). Observed on staging
    // job_1786147254924_8nuyywjii p7/p10. Same rule as story-unified.txt:127.
    let expectedClothingText = '';
    const clothingReqsForPrompt = options.clothingRequirements || null;
    const describeOutfit = (name, category) => {
      if (!clothingReqsForPrompt || !category) return null;
      const char = (characters || []).find(c => String(c?.name || '').trim().toLowerCase() === String(name).trim().toLowerCase());
      if (!char) return null;
      return resolveClothingForPage(char, category, clothingReqsForPrompt) || null;
    };
    if (characterClothing) {
      if (typeof characterClothing === 'string' && characterClothing !== 'standard') {
        expectedClothingText = `- **This page's clothing**: ${characterClothing} (use this for all characters)`;
      } else if (typeof characterClothing === 'object' && Object.keys(characterClothing).length > 0) {
        const described = Object.entries(characterClothing)
          .map(([name, clothing]) => {
            const outfit = describeOutfit(name, clothing);
            return outfit ? `  - ${name} (${clothing}): ${outfit}` : null;
          })
          .filter(Boolean);
        if (described.length > 0) {
          expectedClothingText = `- **This page's clothing** — write these outfits into the prose. Never write the category name ("standard clothes", "a summer outfit"); it is a metadata key, not a description.\n${described.join('\n')}`;
        } else {
          const entries = Object.entries(characterClothing)
            .map(([name, clothing]) => `${name}: ${clothing}`)
            .join(', ');
          expectedClothingText = `- **This page's clothing**: ${entries}`;
          log.warn(`[SCENE PROMPT P${pageNumber}] No outfit text resolved for any character — the Art Director sees category keys only and will write them into the prose`);
        }
      }
    }

    // Build LOCKED PERSPECTIVES section by mining the raw outline (current page block).
    // Pattern: "- Name (...): clothing, depth: X, perspective: Y" anywhere in the page block.
    // This is the structured signal scene-iteration must honor — see CRITICAL RULE #15.
    let lockedPerspectivesText = '';
    const rawForLock = rawOutlineContext?.currentPage || '';
    if (rawForLock) {
      const lockEntries = [];
      // Match each Characters: line that has perspective or depth annotations.
      // Bare `costumed` accepted (optional `:type` / `:{type}` suffix) — same
      // canonical clothing-token pattern as outlineParser/shared.js:117-126.
      const lineRegex = /[-*]?\s*([^(:\r\n]+(?:\([^)]*\))?)\s*:\s*(?:standard|winter|summer|formal|costumed(?::(?:\{[^}]*\}|[^\r\n,]+))?)((?:\s*,\s*(?:depth|perspective|position)\s*:\s*[^,\r\n]+)+)/gi;
      let lockMatch;
      const seen = new Set();
      while ((lockMatch = lineRegex.exec(rawForLock)) !== null) {
        const baseName = lockMatch[1].replace(/\s*\([^)]*\)\s*$/, '').trim();
        if (!baseName || seen.has(baseName.toLowerCase())) continue;
        seen.add(baseName.toLowerCase());
        const annotationsRaw = lockMatch[2];
        const annPattern = /(depth|perspective|position)\s*:\s*([^,\r\n]+)/gi;
        const ann = {};
        let am;
        while ((am = annPattern.exec(annotationsRaw)) !== null) {
          ann[am[1].toLowerCase()] = am[2].trim().toLowerCase();
        }
        const parts = [];
        if (ann.perspective) parts.push(`perspective: ${ann.perspective}`);
        if (ann.depth) parts.push(`depth: ${ann.depth}`);
        if (parts.length > 0) {
          lockEntries.push(`- ${baseName}: ${parts.join(', ')}`);
        }
      }
      if (lockEntries.length > 0) {
        lockedPerspectivesText = `\n**Perspectives (from outline):**\n${lockEntries.join('\n')}\n`;
        log.info(`[SCENE PROMPT P${pageNumber}] Perspectives: ${lockEntries.length} character(s)`);
      }
    }

    // Look up maxCharactersPerScene from the current image model config
    const iterImageModelKey = MODEL_DEFAULTS.pageImage;
    const iterImageModelConfig = IMAGE_MODELS[iterImageModelKey];

    let filled = fillTemplate(activeTemplate, {
      DRAFT_SCENE_DESCRIPTION: draftSceneDescription,
      PREVIOUS_SCENES: previousScenesText,
      PREVIEW_FEEDBACK: previewFeedbackText,
      SCENE_SUMMARY: sceneSummary,
      SCENE_CONTEXT: sceneContextText,
      PAGE_NUMBER: pageNumber.toString(),
      PAGE_CONTENT: pageContent,
      CHARACTERS: characterDetails,
      RECURRING_ELEMENTS: recurringElements,
      AVAILABLE_AVATARS: availableAvatars || buildAvailableAvatarsForPrompt(characters),
      EXPECTED_CLOTHING: expectedClothingText,
      LOCKED_PERSPECTIVES: lockedPerspectivesText,
      LANGUAGE_NAME: languageName,
      LANGUAGE_INSTRUCTION: languageInstruction,
      LANGUAGE_NOTE: getLanguageNote(language),
      CORRECTION_NOTES: correctionNotes ? `\n**CORRECTION NOTES (from previous attempt - MUST be addressed):**\n${correctionNotes}\n` : '',
      MAX_CHARACTERS_PER_SCENE: iterImageModelConfig?.maxCharactersPerScene || 3
    });
    // Same gate as buildUnifiedStoryPrompt: text-overlay-only rules
    // (calmZoneCheck, calm-zone pose rule, textPosition in the JSON example,
    // emptyScenePrompt corner instruction) are wrapped in
    // <!-- TEXT_OVERLAY_BEGIN --> ... <!-- TEXT_OVERLAY_END --> markers in
    // scene-iteration.txt / scene-iteration-free.txt. When textInImage is
    // false, strip markers AND inner content so iterate prompts don't carry
    // overlay rules into non-overlay pages.
    if (textInImage) {
      filled = filled.replace(/<!-- TEXT_OVERLAY_(BEGIN|END) -->\n?/g, '');
    } else {
      filled = filled.replace(/<!-- TEXT_OVERLAY_BEGIN -->[\s\S]*?<!-- TEXT_OVERLAY_END -->\n?/g, '');
    }
    return filled;
  }

  // Fallback to hardcoded prompt if template not loaded
  return `**ROLE:**
You are an expert Art Director creating an illustration brief for a children's book.

${previousScenesText}**CURRENT SCENE (Page ${pageNumber}) - YOUR FOCUS:**
${shortSceneDesc ? `Scene Summary: ${shortSceneDesc}\n\n` : ''}Story Text:
${pageContent}

**AVAILABLE CHARACTERS & VISUAL REFERENCES:**
${characterDetails}
${recurringElements}
**TASK:**
Create a detailed visual description of ONE key moment from the scene context provided.

Focus on essential characters only (1-2 maximum unless the story specifically requires more). Choose the most impactful visual moment that captures the essence of the scene.

**OUTPUT FORMAT:**
1. **Setting & Atmosphere:** Describe the background, time of day, lighting, and mood.
2. **Composition:** Describe the camera angle (e.g., low angle, wide shot) and framing.
3. **Characters:**
   * **[Character Name]:** Exact action, body language, facial expression, and location in the frame.
   (Repeat for each character present in this specific scene)

**CONSTRAINTS:**
- Do not include dialogue or speech
- Focus purely on visual elements
- Use simple, clear language
- Only include characters essential to this scene
- If recurring elements appear, describe them consistently as specified above`;
}

/**
 * Build image generation prompt
 */
// ============================================================================
// WORN-VS-HELD / STATE-AWARE GUARDS (page siblings of the cover worn≠held
// dedupe in coverIterate.applyCoverWornHeldDedupe — docs/decisions.md
// 2026-07-31). A garment the scene holds/drops must not ALSO be described as
// worn ("tied around his neck" + "held overhead in his hands" is unpaintable —
// the model draws the item twice).
// ============================================================================

// Placement wording that means an item is NOT worn on the body: held/carried/
// waved, lying/dropped on a surface, or explicitly removed.
const NON_WORN_STRONG_RE = /\b(?:held|holds?|holding|clutch(?:es|ed|ing)?|grip(?:s|ped|ping)?|carr(?:y|ies|ied|ying)|wav(?:es|ed|ing)|swing(?:s|ing)?|brandish(?:es|ed|ing)?|overhead|in\s+(?:his|her|their|both|one)\s+hands?|l(?:ies|ying)|lays?|laid|crumpled|dropp(?:ed|ing)|drops?|on\s+the\s+(?:ground|floor|grass|sand|bench|chair|bed|rock|table)|tak(?:es|en|ing)\s+off|took\s+off|pull(?:s|ed|ing)\s+off|remov(?:es|ed|ing)|without\s+(?:the|his|her|their))\b/i;
// draped / hangs / slung are off-body ONLY when not anchored to a body part
// ("cape draped over his shoulders" is worn; "cape draped over the chair" is not).
const NON_WORN_WEAK_RE = /\b(?:drap(?:es|ed|ing)|hangs?|hanging|hung|slung)\b/i;
const BODY_ANCHORED_DRAPE_RE = /\b(?:drap(?:es|ed|ing)|hangs?|hanging|hung|slung)\b[^.;]{0,50}\b(?:shoulders?|neck|waist|head|back|hips?|arms?|torso|chest|body)\b/i;

function textDeclaresNonWornPlacement(text) {
  const t = String(text || '');
  if (!t) return false;
  if (NON_WORN_STRONG_RE.test(t)) return true;
  return NON_WORN_WEAK_RE.test(t) && !BODY_ANCHORED_DRAPE_RE.test(t);
}

/**
 * Does the scene place this VB entry somewhere other than ON a body?
 * Checks the structured interactions[] first (VB id match or token overlap),
 * then the prose sentences (token overlap + non-worn placement wording).
 * Overlap rule = the cover dedupe's: ≥2 shared significant tokens, or ≥1
 * token from the entry NAME (names are short and specific).
 *
 * Cross-language caveat: token matching cannot bridge a story-language entry
 * ("Roter Umhang") against English prose ("red cape") — that gap is closed at
 * the ROOT by the story-unified VB language rule (English name + description
 * for artifacts/locations/vehicles/clothing).
 */
function sceneDeclaresNonWornState(entry, proseText, interactions) {
  const nameTokens = significantEntityTokens(entry?.name);
  const allTokens = new Set([
    ...nameTokens,
    ...significantEntityTokens(entry?.extractedDescription || entry?.description),
  ]);
  if (allTokens.size === 0) return false;
  const entryId = String(entry?.id || '').toUpperCase();
  const overlaps = (text) => {
    const tokens = significantEntityTokens(text);
    let overlap = 0;
    let nameHit = false;
    for (const t of tokens) {
      if (allTokens.has(t)) overlap++;
      if (nameTokens.has(t)) nameHit = true;
    }
    return overlap >= 2 || nameHit;
  };
  for (const i of (Array.isArray(interactions) ? interactions : [])) {
    if (!i || typeof i !== 'object') continue;
    const combined = `${i.object || ''} ${i.where || ''}`;
    const idHit = entryId && combined.toUpperCase().includes(entryId);
    if (!idHit && !overlaps(combined)) continue;
    if (textDeclaresNonWornPlacement(combined)) return true;
  }
  const sentences = String(proseText || '').split(/(?<=[.!?])\s+|\n+/);
  for (const s of sentences) {
    if (!overlaps(s)) continue;
    if (textDeclaresNonWornPlacement(s)) return true;
  }
  return false;
}

// Attachment clauses ("tied at the neck", "fastened around her waist") inside
// an object description contradict a scene that holds/drops the item. The
// clause is dropped; the physical features stay. A clause conflicts when it
// pairs an attachment verb with a body part, or says "worn ...".
const WORN_ATTACHMENT_CLAUSE_RE = /\b(?:tied|fasten(?:ed|s)?|clasp(?:ed|s)?|button(?:ed|s)?|knott?(?:ed|s)?|secur(?:ed|es)?|wrapp?(?:ed|s)?|worn|wearing)\b[^,;.]*\b(?:neck|shoulders?|waist|head|chin|chest|back|hips?|torso|body)\b|\bworn\s+(?:by|over|under|around|on)\b/i;

/**
 * Strip worn-state attachment clauses from an object description when the
 * scene places the object off-body (fix for REQUIRED OBJECTS saying "tied at
 * the neck" while the scene holds/drapes the item).
 */
function stripWornStateFromDescription(description) {
  const raw = String(description || '').trim();
  if (!raw) return raw;
  const segments = raw.split(/\s*[,;]\s*/).filter(Boolean);
  const kept = segments.filter(s => !WORN_ATTACHMENT_CLAUSE_RE.test(s));
  if (kept.length > 0 && kept.length < segments.length) return kept.join(', ');
  if (kept.length === segments.length) return raw;
  // Every segment matched (single-clause description) — strip the matched
  // phrases inline rather than deleting the whole description.
  return raw.replace(new RegExp(WORN_ATTACHMENT_CLAUSE_RE.source, 'gi'), '').replace(/\s{2,}/g, ' ').replace(/[,\s]+$/, '').trim();
}

/**
 * REMOVED 2026-08-08: filterWornClothingAgainstScene, the worn-vs-held guard
 * for the injected CLOTHING wears-lines. It sieved an outfit description
 * clause by clause and dropped anything that looked like a garment the scene
 * placed off-body. Measured over 30 stories / 457 clothing lines: 34% GUTTED
 * (>60% of the text lost), only 34% untouched, on ordinary stories as much as
 * costumed ones — a clause died on token coincidence. A whole pirate costume
 * came out as "no brim, mid-thigh length, belt/waist: none, outer layer: none".
 *
 * The case it guarded is now handled in prose instead of by deletion:
 * clothingCheck's `removal_unstated` reports the page and the scene review
 * writes "she is without the bandana, it lies in the chest". See
 * docs/decisions.md, 2026-08-08.
 *
 * sceneDeclaresNonWornState / stripWornStateFromDescription survive — the
 * REQUIRED OBJECTS path still uses them to describe an object's own state.
 */

function buildImagePrompt(sceneDescription, inputData, sceneCharacters = null, visualBible = null, pageNumber = null, referencePhotos = null, options = {}) {
  // Build image generation prompt. The unified pipeline is the only generation
  // mode; legacy pictureBook / outlineAndText / sequential / language-variant
  // template paths were removed along with the isStorybook/isSequential flags.

  // Extract metadata BEFORE stripping (needed for objects lookup)
  const metadata = extractSceneMetadata(sceneDescription);
  if (metadata?.objects?.length > 0) {
    log.debug(`[IMAGE PROMPT] Page ${pageNumber}: metadata.objects = ${JSON.stringify(metadata.objects)}`);
  } else {
    log.debug(`[IMAGE PROMPT] Page ${pageNumber}: no metadata.objects (metadata=${metadata ? 'exists' : 'null'}, objects=${metadata?.objects?.length || 0})`);
  }

  // Detect scene description format. Scenes from `scene-expansion.txt` use the new
  // prose+metadata format and have character descriptions and art style already
  // woven into the prose by Claude. Scenes from `scene-iteration.txt` (used by
  // iteratePage repair) still output legacy JSON. For prose format we use the
  // minimal storybook template; for JSON we keep the legacy structured wrapping.
  const isProseFormat = parseProseMetadataFormat(sceneDescription) !== null;

  // Build text area instruction if textPosition is specified (keeps illustration uncluttered where text goes)
  // Enforce spread rule: odd pages = left, even pages = right.
  // options.textPositionOverride takes priority — used by iteratePageCore to carry
  // the locked first-generation textPosition through re-generation, since
  // scene-iteration.txt doesn't emit textPosition in its JSON.
  const rawTextPosition = options.textPositionOverride || metadata?.textPosition || null;
  const textPosition = enforceSpreadTextPosition(rawTextPosition, pageNumber);
  // If spread-rule enforcement flipped Sonnet's side, Sonnet's textZoneDescription
  // was written for the wrong side. Discard it and let the generic fallback drive
  // wording.
  const textZoneDescForPrompt = (rawTextPosition && textPosition && rawTextPosition !== textPosition)
    ? null
    : (metadata?.textZoneDescription || null);
  const langLevel = inputData?.languageLevel || 'standard';
  // textInImage: false ⇒ text is rendered in a separate strip below the image
  // (advanced reading level / square layout). The image has no text overlay,
  // so we MUST NOT inject COPY SPACE — let the model fill the whole frame.
  // Defaults to true for legacy callers that don't pass inputData.layout.
  const textInImage = inputData?.layout?.textInImage !== false;
  // Text area instruction: tell the model to keep an area calm for text overlay.
  // Critical: do NOT say "white", "blank", "empty", or "negative space" — the model
  // will paint a literal white box. Instead say "continue the scene but keep it simple".
  const areaPct = langLevel === '1st-grade' ? '10%' : langLevel === 'advanced' ? '40%' : '30%';
  const textAreaInstruction = (textInImage && textPosition)
    ? buildTextZoneInstruction(textPosition, textZoneDescForPrompt, areaPct, { isEmptyScene: false })
    : '';

  // Strip JSON metadata block from scene description (not needed in image prompt)
  let cleanSceneDescription = stripSceneMetadata(sceneDescription);

  // Append per-character perspective directives if scene-iteration assigned any.
  if (metadata?.characterPerspectives) {
    const lines = [];
    for (const [name, ann] of Object.entries(metadata.characterPerspectives)) {
      if (ann.perspective === 'back view' || ann.perspective === 'back-view') {
        lines.push(`- ${name}: back view — shoulders, head, hips, and both feet turned away from the camera. Back of head visible, heels visible, toes pointing away. No twisting; feet and body face the same direction.`);
      } else if (ann.perspective === 'side' || ann.perspective === 'profile') {
        lines.push(`- ${name}: side profile — shoulders, hips, and feet all line up sideways. Nose points to one edge, not at the camera.`);
      } else if (ann.perspective === 'over-the-shoulder') {
        lines.push(`- ${name}: over-the-shoulder — camera sits behind one shoulder; back of head and shoulder visible in near foreground, feet turned away from camera.`);
      }
    }
    if (lines.length > 0) {
      cleanSceneDescription += `\n\n**Perspective:**\n${lines.join('\n')}`;
      log.info(`[IMAGE PROMPT] Page ${pageNumber}: Perspective directives for ${lines.length} character(s)`);
    }
  }

  // Forward the scene hint's `background` field explicitly. It carries the
  // atmosphere AND any story-essential unnamed figures (antagonists, guards —
  // see story-unified.txt BACKGROUND rule). The prose is supposed to weave it
  // in but can drop the figures, and the evaluator scores against the hint —
  // generator and evaluator must receive the same contract.
  const sceneBackground = metadata?.background || metadata?.fullData?.background || null;
  if (sceneBackground && typeof sceneBackground === 'string') {
    cleanSceneDescription += `\n\n**BACKGROUND:** ${sceneBackground.trim()}`;
  }

  const artStyleId = inputData.artStyle || 'pixar';
  // Resolve backend for per-model style variants: use explicit option, or infer from default image model
  let effectiveBackend = options.imageBackend;
  if (!effectiveBackend) {
    try {
      const { IMAGE_MODELS, MODEL_DEFAULTS } = require('../config/models');
      const defaultModel = MODEL_DEFAULTS.pageImage || MODEL_DEFAULTS.image;
      if (defaultModel && IMAGE_MODELS[defaultModel]) effectiveBackend = IMAGE_MODELS[defaultModel].backend;
    } catch { /* config not available */ }
  }
  const styleDescription = options.customStyleDescription || resolveArtStyle(artStyleId, effectiveBackend) || resolveArtStyle('pixar');
  const language = (inputData.language || 'en').toLowerCase();

  // Build character reference list (Option B: explicit labeling in prompt)
  let characterReferenceList = '';
  if (sceneCharacters && sceneCharacters.length > 0) {
    log.debug(`[IMAGE PROMPT] Scene characters: ${sceneCharacters.map(c => c.name).join(', ')}`);

    // Per-character clothing reaches the image model through the scene prose
    // (SCENE_DESCRIPTION), written from each character's "Wearing:" input. That
    // input must resolve from the per-story clothingRequirements, never the
    // base-character avatars.clothing default — see the buildClothingDescription
    // routing in formatCharacterContext (sceneValidator.js), which was leaking
    // the default outfit into the vision analysis and, via iterate rounds, into
    // this prose.
    //
    // NO BACKSTOP (owner, 2026-08-09). This used to APPEND the canonical outfit
    // to the prompt whenever it thought the prose had omitted it. Two problems,
    // both observed in production:
    //
    //   - it decided by counting outfit WORDS in the prose, so it could not
    //     tell "wearing a hat" from "fully dressed". On p10 of
    //     job_1786235099497_ytd5c7eek it scored 9 hits for a girl in a shirt and
    //     a tricorn — five of them noise from "arms folded across her chest" —
    //     stayed silent, and the image model drew a child in underwear.
    //   - its companion filter used to DELETE garments from the line it
    //     appended, producing "wears: no brim, mid-thigh length" on the page
    //     that rendered a naked child.
    //
    // The prose is the single owner of what a character wears. An incomplete
    // brief is a writer bug, reported here and fixed in the writer — not
    // patched downstream by a second, worse copy of the same job.
    if (referencePhotos && referencePhotos.length > 0) {
      try {
        const { missingGarments } = require('./clothingCheck');
        // Slots that must be named, because an unstated garment is simply not
        // drawn. Deliberately stricter than clothingCheck's REVIEW rules, which
        // treat a partial omission as normal (a close-up need not mention
        // shoes) — right for nagging a reviewer, wrong for the image prompt.
        const pageLabel = pageNumber != null ? `page ${pageNumber}` : 'page';
        for (const photo of referencePhotos) {
          if (!photo?.name || !photo?.clothingDescription) continue;
          const missing = missingGarments(photo.clothingDescription, cleanSceneDescription || '', undefined, photo.name);
          if (missing.length > 0) {
            log.error(`👕 [CLOTHING] ${pageLabel}: the scene prose does not dress ${photo.name} — missing ${missing.join(', ')}. The prose is the only description the image model gets; fix the brief, nothing downstream will.`);
          }
        }
      } catch (err) {
        log.warn(`👕 [CLOTHING] slot check skipped: ${err.message}`);
      }
    }

    const heightDescription = buildRelativeHeightDescription(sceneCharacters);
    if (heightDescription) {
      characterReferenceList += `\n${heightDescription}\n`;
      log.debug(`[IMAGE PROMPT] Added relative heights: ${heightDescription}`);
    }

    // Age proportions per character — load-bearing and cheap (~60 chars each).
    // The full physical block was dropped above (prose carries it), but the
    // prose routinely omits age, and there is no relative-height signal for a
    // solo character — so a 1-year-old infant came through with NO size cue and
    // rendered as a toddler/preschooler. Worse, a freely-edited story idea
    // ("a 1-year-old who dives off a bridge") gives the model action cues that
    // imply an older child. This explicit proportion anchor counters that.
    // Characters in the same age bucket share identical marker text — emit
    // one merged line ("- Emma, Noah: kindergarten-age …") instead of a
    // verbatim copy per child (~230 chars saved per duplicate on prompts
    // that fight an 8k model cap).
    const ageCueGroups = new Map(); // markers text -> [names]
    for (const c of sceneCharacters) {
      const ageMarkers = extractCharacterVisualProfile(c).ageMarkers;
      if (!ageMarkers) continue;
      if (!ageCueGroups.has(ageMarkers)) ageCueGroups.set(ageMarkers, []);
      ageCueGroups.get(ageMarkers).push(c.name);
    }
    const ageCueLines = [...ageCueGroups.entries()].map(([markers, names]) => `- ${names.join(', ')}: ${markers}`);
    if (ageCueLines.length > 0) {
      characterReferenceList += `\nAGE & PROPORTIONS (render each character at their real age, regardless of the action described):\n${ageCueLines.join('\n')}\n`;
      log.debug(`[IMAGE PROMPT] Added age proportions for ${ageCueLines.length} character(s)`);
    }

    // Colour-frame mapping. Each reference card is framed in a colour (not
    // stamped with a name — Grok copies a printed name straight into the scene,
    // which is how child names leaked onto pages). Tell Grok which card is whom
    // by colour, and that the frame colour is an identifier only. Must use the
    // SAME frameColorForName() canon as the baked frames (grok.js).
    //
    // PIPE-5: grok.js frames cards ONLY for characters that actually have a
    // reference photo on this page (referencePhotos, after any OTS/background
    // filtering), so the colour canon MUST be that same filtered set. Building it
    // from ALL sceneCharacters diverges in membership → colours bind to the wrong
    // character (identity swap) whenever a character's photo is dropped.
    const frameLegend = buildReferenceCardColours(sceneCharacters, referencePhotos);
    if (frameLegend) {
      characterReferenceList += frameLegend;
      log.debug('[IMAGE PROMPT] Added colour-frame mapping');
    }
  }

  // (Removed 2026-06-09) SECONDARY CHARACTERS IN THIS SCENE block — was
  // injecting a third copy of each secondary character's appearance onto
  // pages where the SCENE prose already embeds it inline. story-unified.txt
  // explicitly instructs Sonnet to "Name each character explicitly on first
  // mention, THEN weave the physical description in" (prompts/story-
  // unified.txt:125). Trust the prose. If a future bug shows Sonnet
  // skipping the inline embed for secondaries, fix it at the Sonnet output
  // level — don't re-add a duplicate emitter here. Page 12 of the Miller
  // showcase wasted ~1050 chars triple-counting Sofia before this removal.

  // Build required objects section from metadata.objects by looking up in Visual Bible
  // This ensures objects listed in scene metadata are included with their full descriptions
  // Supports lookup by name OR identifier (e.g., "CLO001", "ART002", etc.)
  //
  // OPTIMIZATION: Scene description already selects which visual bible elements are needed
  // and outputs them in JSON metadata. We use ONLY those elements instead of the entire bible.
  let requiredObjectsSection = '';
  let hasRequiredObjects = false;
  if (metadata && metadata.objects && metadata.objects.length > 0 && visualBible) {
    const requiredObjects = [];

    // Helper function to match by name OR ID
    // NOTE: For character names, we use STRICT matching to avoid "Luis" matching "Luis' Mama"
    const matchesEntry = (entry, searchTerm, strictMode = false) => {
      const searchLower = searchTerm.toLowerCase().trim();
      const nameLower = (entry.name || '').toLowerCase().trim();
      const idLower = (entry.id || '').toLowerCase().trim();

      // Match by ID (exact match, e.g., "CLO001", "CHR002")
      if (idLower && idLower === searchLower) return true;

      // Extract ID from search term if present (e.g., "Der weise Ritter [CHR002]" -> "CHR002")
      const idMatch = searchTerm.match(/\[([A-Z]{3}\d{3})\]/);
      if (idMatch && idLower === idMatch[1].toLowerCase()) return true;

      // Exact name match (always allowed)
      if (nameLower === searchLower) return true;

      // For strict mode (characters), only allow exact matches or ID matches
      if (strictMode) return false;

      // For non-strict mode (objects/locations), allow partial matches
      if (nameLower.includes(searchLower)) return true;
      if (searchLower.includes(nameLower) && nameLower.length >= 3) return true;

      return false;
    };

    // (Removed 2026-06-09) Secondary-character lookups in this section.
    // Both the metadata.characters loop and the CHR-id detour inside the
    // metadata.objects loop emitted a SECOND copy (or with the now-removed
    // SECONDARY CHARACTERS block, a THIRD copy) of each secondary
    // character's full description. The prose already carries them inline.
    // CHR ids that slip into metadata.objects are now filtered below and
    // silently skipped — the prose is the canonical source.
    for (const objName of metadata.objects) {
      // Skip any character id in the objects list — the prose carries the
      // character's description (story-unified.txt instructs the model to
      // both name antagonists in the prose AND list their CHR id here; the
      // id is presence metadata for the pipeline, not a prompt input).
      // Re-injecting the VB description would duplicate the prose.
      const isChrId = typeof objName === 'string'
        ? /^\s*\[?CHR\d{3}\]?\s*$/i.test(objName) || /\[CHR\d{3}\]/i.test(objName)
        : (typeof objName?.id === 'string' && /^CHR\d{3}$/i.test(objName.id));
      if (isChrId) continue;

      // Look up in artifacts
      const artifact = (visualBible.artifacts || []).find(a => matchesEntry(a, objName));
      if (artifact) {
        const description = artifact.extractedDescription || artifact.description;
        requiredObjects.push({ name: artifact.name, id: artifact.id, type: 'object', description, entry: artifact });
        continue;
      }

      // Look up in animals
      const animal = (visualBible.animals || []).find(a => matchesEntry(a, objName));
      if (animal) {
        const description = animal.extractedDescription || animal.description;
        requiredObjects.push({ name: animal.name, id: animal.id, type: 'animal', description, entry: animal });
        continue;
      }

      // Look up in locations
      const location = (visualBible.locations || []).find(l => matchesEntry(l, objName));
      if (location) {
        const description = location.extractedDescription || location.description;
        requiredObjects.push({ name: location.name, id: location.id, type: 'location', description, entry: location });
        continue;
      }

      // Look up in vehicles
      const vehicle = (visualBible.vehicles || []).find(v => matchesEntry(v, objName));
      if (vehicle) {
        const description = vehicle.extractedDescription || vehicle.description;
        requiredObjects.push({ name: vehicle.name, id: vehicle.id, type: 'vehicle', description, entry: vehicle });
        continue;
      }

      // Look up in clothing/costumes
      const clothing = (visualBible.clothing || []).find(c => matchesEntry(c, objName));
      if (clothing) {
        const description = clothing.extractedDescription || clothing.description;
        requiredObjects.push({ name: clothing.name, id: clothing.id, type: 'clothing', description, wornBy: clothing.wornBy || null, entry: clothing });
      }
    }

    if (requiredObjects.length > 0) {
      hasRequiredObjects = true;
      // Image-facing prompts are English-only — single English header, no
      // de/fr variants. (The localized headers also broke the downstream
      // parseVisualBibleObjects, which matches /REQUIRED OBJECTS/ to build
      // the expected-objects list for eval/bbox.)
      const header = '**REQUIRED OBJECTS IN THIS SCENE (MUST appear in the image):**';

      // Skip location entries — the location is either visually attached
      // as the empty-scene / vantage backdrop reference image OR named in
      // the scene prose. Duplicating the location text description here
      // wastes ~200 chars per page with no model benefit.
      const promptObjects = requiredObjects.filter(o => o.type !== 'location');
      requiredObjectsSection = `\n${header}\n`;
      const GENERIC_NOUN_BY_TYPE = { object: 'object', vehicle: 'vehicle', clothing: 'outfit' };
      for (const obj of promptObjects) {
        // Note: obj.id exists for Visual Bible tracking but is not included in image prompts
        // as image models don't use these identifiers.
        // State-aware description: when the scene places the object off-body
        // (held, draped over furniture, lying on the ground), the emitted
        // description must not contradict it — attachment clauses like "tied
        // at the neck" and the clothing "(worn by X)" suffix are dropped.
        const placedElsewhere = sceneDeclaresNonWornState(obj.entry, cleanSceneDescription, metadata?.interactions);
        const description = placedElsewhere ? stripWornStateFromDescription(obj.description) : obj.description;
        const wornSuffix = (obj.type === 'clothing' && obj.wornBy && !placedElsewhere)
          ? ` (worn by ${obj.wornBy})`
          : '';
        if (placedElsewhere) {
          log.info(`🧥 [IMAGE PROMPT] Page ${pageNumber}: required ${obj.type} ${obj.id || ''} emitted state-aware (scene places it off-body)`);
        }
        // English-only entity refs: the VB NAME follows the story language, so
        // artifacts/vehicles/clothing lead with an English description-derived
        // ref. Animals keep their proper name (identity anchor). The ref is
        // built from the STATE-AWARE description so a stripped attachment
        // clause can't sneak back in via the lead.
        const refEntry = placedElsewhere ? { description } : obj.entry;
        // The lead is a LABEL — the full description follows on the same line,
        // so the 12-word englishEntityRef default just duplicates the
        // description's own opening (~60 wasted chars per object on prompts
        // that fight an 8k model cap). First comma clause, max 6 words.
        const shortRef = (r) => r.split(',')[0].split(/\s+/).slice(0, 6).join(' ');
        const lead = (obj.type === 'animal' && obj.name)
          ? `**${obj.name}** (animal)`
          : `**${shortRef(englishEntityRef(refEntry, GENERIC_NOUN_BY_TYPE[obj.type] || 'object'))}** (${obj.type})`;
        requiredObjectsSection += `* ${lead}: ${description}${wornSuffix}\n`;
      }
      if (promptObjects.length === 0) {
        // All entries were locations — nothing left to list.
        requiredObjectsSection = '';
      }

      log.debug(`[IMAGE PROMPT] Added ${promptObjects.length} required objects from metadata (skipped ${requiredObjects.length - promptObjects.length} location entries)`);
    }
  }

  // FALLBACK: Only add full Visual Bible if scene description didn't specify required objects
  // AND the image backend is not Grok (Grok has 8000 char limit, VB grid is sent as reference image)
  // This handles storybook mode where there's no separate scene description step
  let visualBibleSection = '';
  const skipVisualBible = options?.skipVisualBible === true;
  if (!hasRequiredObjects && !skipVisualBible && visualBible && pageNumber !== null) {
    const sceneCharacterNames = sceneCharacters ? sceneCharacters.map(c => c.name) : null;
    visualBibleSection = buildVisualBiblePrompt(visualBible, pageNumber, sceneCharacterNames, language);
    if (visualBibleSection) {
      log.debug(`[IMAGE PROMPT] Added full Visual Bible section for page ${pageNumber} (no metadata.objects)`);
    }
  } else if (!hasRequiredObjects && skipVisualBible) {
    log.debug(`[IMAGE PROMPT] Skipping Visual Bible text for page ${pageNumber} (visual reference sent as image)`);
  }

  // COVER OVERRIDES. A cover pre-computes these two blocks because its cast and
  // its Visual Bible are filtered by the cover hint (worn-vs-held dedupe,
  // allowedElementIds) before the prompt is built. Everything else — the
  // per-character wardrobe binding, the card-colour legend, heights, age
  // proportions, the VB-id sanitiser — is the page code, unchanged.
  if (options.characterReferenceListOverride) characterReferenceList = options.characterReferenceListOverride;
  if (options.visualBibleOverride !== undefined) visualBibleSection = options.visualBibleOverride;

  const template = options.promptTemplateOverride || PROMPT_TEMPLATES.imageGeneration || null;

  // Build an EXACT POSES block from the scene's declared interactions. Image
  // models (Grok Aurora especially) weight the end of the prompt heavily, and
  // interactions buried mid-paragraph in the prose get dropped — declared props
  // (crossbows, held objects, barrier arms) go missing even when the reference
  // image is attached. Terse imperatives at the end re-anchor the pose.
  // Pass scene characters (with per-character depth from metadata) so the
  // builder can fill in default "not looking at the viewer" lines for any
  // foreground/midground figure that has no declared interaction. This
  // closes the gap where Sonnet writes one interaction per page but leaves
  // other characters uncovered — those default to a camera-facing portrait.
  const metaCharacters = Array.isArray(metadata?.fullData?.characters) && metadata.fullData.characters.length > 0
    ? metadata.fullData.characters
    : (Array.isArray(metadata?.characters) ? metadata.characters : []);
  const exactPosesBlock = buildExactPosesBlock(metadata?.interactions, metaCharacters, visualBible);
  const eraGuard = buildEraGuard(metadata?.era);
  const sceneIntentLine = metadata?.sceneIntent
    ? `**THIS IMAGE DEPICTS:** ${String(metadata.sceneIntent).trim()}`
    : '';

  const appendExactPoses = (s) => exactPosesBlock ? `${s}\n\n${exactPosesBlock}` : s;
  // Final chokepoint — sanitises VB IDs that survived upstream builders.
  // Resolves CHR###/ANI###/ART###/LOC###/VEH###/CLO### tokens to their real
  // names from the Visual Bible. When an id has no matching VB entry,
  // substitutes a pool-generic noun and logs a WARN so we see upstream bugs
  // instead of letting the orphan id reach Grok as paintable text.
  const finalize = (s) => sanitizeVbIdsInPrompt(s, visualBible, pageNumber);

  // Use template if available, otherwise fall back to hardcoded prompt
  if (template) {
    log.debug(`[IMAGE PROMPT] Using image-generation template for language: ${language} (proseFormat=${isProseFormat})`);

    // Both prose and legacy-JSON scene formats use the same placeholder set:
    // the prose carries character descriptions + setting woven in by Sonnet
    // (sometimes with clothing dropped — observed: Emma's pirate costume
    // missing → Grok defaulted to yellow dress), and the JSON iterate path
    // has neither. In both cases we pass the explicit reference list /
    // clothing / heights / required objects blocks — redundant when the
    // prose is complete, load-bearing when not.
    return finalize(appendExactPoses(fillTemplate(template, {
      STYLE_DESCRIPTION: styleDescription,
      SCENE_DESCRIPTION: cleanSceneDescription,
      CHARACTER_REFERENCE_LIST: characterReferenceList,
      REQUIRED_OBJECTS: requiredObjectsSection,
      // Text fallback when the scene has no metadata.objects and no VB grid
      // image — '' on the normal path (fillTemplate strips the placeholder).
      // Was computed + logged but never passed (only the template-missing
      // hardcoded fallback below used it).
      VISUAL_BIBLE: visualBibleSection,
      TEXT_AREA_INSTRUCTION: textAreaInstruction,
      ERA_GUARD: eraGuard,
      // Cover-only composition bullets (title-safe top third, group
      // arrangement, bottom margin). '' for pages, so the placeholder is
      // stripped and a page prompt is byte-identical to before.
      COVER_COMPOSITION: options.coverComposition || '',
      SCENE_INTENT: sceneIntentLine
    })));
  }

  // Fallback to hardcoded prompt
  const fallback = `Create a cinematic scene in ${styleDescription}.

${characterReferenceList}
Scene Description: ${cleanSceneDescription}
${requiredObjectsSection}
${visualBibleSection}
Important:
- Match characters to the reference photos provided
- Show appropriate emotions on faces (happy, sad, surprised, worried, excited)
- Maintain consistent character appearance across ALL pages
- Clean, clear composition
- Age-appropriate for ${inputData.ageFrom || 3}-${inputData.ageTo || 8} years old`;
  return finalize(appendExactPoses(fallback));
}

/**
 * Final-pass sanitiser for image prompts. Walks the assembled prompt for
 * Visual Bible IDs (CHR### / ANI### / ART### / LOC### / VEH### / CLO###),
 * resolves each to an image-facing substitution: character/animal ids to the
 * entry's given name, artifact/vehicle/clothing ids to an ENGLISH
 * description-derived ref (VB names follow the story language), location ids
 * to the name with English visual fields inlined. When an id has no
 * matching entry — orphan — substitutes a generic noun for its pool
 * (ART→object, CHR→person, …) and logs a WARN so the upstream bug surfaces
 * in logs. (Never drops the line: the cover scene description is a single
 * line, and dropping it deleted the whole layout from the prompt.)
 *
 * Single chokepoint for the buildImagePrompt return path so adding a new
 * builder upstream (interactions, secondaries, brief, EXACT POSES, future)
 * automatically inherits the protection — no per-builder substitution to
 * forget.
 *
 * @param {string} prompt - The assembled image prompt.
 * @param {Object} visualBible - Story Visual Bible (mainCharacters,
 *                               secondaryCharacters, animals, artifacts,
 *                               locations, vehicles, clothing).
 * @param {number|null} pageNumber - For log attribution.
 * @returns {string} Sanitised prompt with VB IDs resolved or orphan lines
 *                   dropped.
 */
function sanitizeVbIdsInPrompt(prompt, visualBible, pageNumber = null) {
  if (!prompt || typeof prompt !== 'string') return prompt;
  if (!visualBible || typeof visualBible !== 'object') return prompt;

  // Build id → substitution lookup across every VB pool. Image-facing prompts
  // are English-only: characters and animals resolve to their given names
  // (identity anchors), but artifact/location/vehicle/clothing NAMES follow
  // the story language ("Roter Umhang" must not reach the English prompt), so
  // those resolve to an English description-derived ref instead. Locations
  // keep their name WITH the English visual fields inlined (real-landmark
  // names are real-world identifiers the model knows).
  const NAME_POOLS = ['mainCharacters', 'secondaryCharacters', 'animals'];
  const REF_POOLS = { artifacts: 'object', vehicles: 'vehicle', clothing: 'outfit' };
  const idToName = new Map();
  for (const pool of NAME_POOLS) {
    for (const entry of (Array.isArray(visualBible[pool]) ? visualBible[pool] : [])) {
      if (!entry?.id || !entry?.name) continue;
      idToName.set(String(entry.id).toUpperCase(), entry.name);
    }
  }
  for (const [pool, genericNoun] of Object.entries(REF_POOLS)) {
    for (const entry of (Array.isArray(visualBible[pool]) ? visualBible[pool] : [])) {
      if (!entry?.id) continue;
      idToName.set(String(entry.id).toUpperCase(), englishEntityRef(entry, genericNoun));
    }
  }
  for (const entry of (Array.isArray(visualBible.locations) ? visualBible.locations : [])) {
    if (!entry?.id) continue;
    const ref = entry.isRealLandmark
      ? (entry.name || englishLocationRef(entry))
      : (englishLocationRef(entry) || englishEntityRef(entry, 'place'));
    if (ref) idToName.set(String(entry.id).toUpperCase(), ref);
  }

  // PROPER NAMES of props, resolved the same way their ids are.
  //
  // Resolving the ids was only half the job. The Art Director does not write
  // "ART001" in prose — it writes the entity's NAME, and that name reaches the
  // model by four routes the id pass never sees: the prose itself, sceneIntent,
  // the object appended to an EXACT POSES line, and cross-references inside
  // another entry's description ("a narrower hull than the Goldene Möwe").
  // The model then letters the name onto the prop: measured on staging
  // job_1787514666616_yw9qsv1vf, p5 rendered "Fiona's Schatzkarte" painted
  // across the map and p4 "Goldene Möwe" across the hull. Nothing had quoted a
  // string, so rule 12c — which forbids quoting text to render — had nothing
  // to say about it.
  //
  // The substitution is the entry's own `type`, which is already English and
  // is a description rather than a label ("hand-drawn treasure map on aged
  // parchment"), falling back to the same englishEntityRef the id path uses.
  // Only the REF pools: character and animal names are identity anchors and
  // stay, exactly as they do above.
  const nameSubs = [];
  const protectedNames = new Set();
  for (const pool of NAME_POOLS) {
    for (const entry of (Array.isArray(visualBible[pool]) ? visualBible[pool] : [])) {
      if (entry?.name) protectedNames.add(String(entry.name).trim().toLowerCase());
    }
  }
  const seenAlias = new Map();
  for (const [pool, genericNoun] of Object.entries(REF_POOLS)) {
    for (const entry of (Array.isArray(visualBible[pool]) ? visualBible[pool] : [])) {
      const name = String((entry && entry.name) || '').trim();
      if (name.length < 4) continue;
      if (protectedNames.has(name.toLowerCase())) continue;   // also a person or animal
      const ref = String(entry.type || '').trim() || englishEntityRef(entry, genericNoun);
      if (!ref) continue;
      const aliases = [name];
      // "Fiona's Schatzkarte" also appears as bare "Schatzkarte". Register the
      // possessive-stripped tail too — but only once: if two entries reduce to
      // the same tail it is ambiguous and neither alias is safe.
      const bare = name.replace(/^\S+['’]s?\s+/u, '').trim();
      if (bare.length >= 4 && bare !== name) {
        seenAlias.set(bare.toLowerCase(), (seenAlias.get(bare.toLowerCase()) || 0) + 1);
        aliases.push(bare);
      }
      for (const alias of aliases) nameSubs.push({ alias, ref });
    }
  }
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Longest first, so "Fiona's Schatzkarte" is consumed before "Schatzkarte".
  const activeSubs = nameSubs
    .filter(s => !(seenAlias.get(s.alias.toLowerCase()) > 1))
    .sort((a, b) => b.alias.length - a.alias.length);
  const replaceNames = (line) => {
    let out = line;
    for (const { alias, ref } of activeSubs) {
      out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(alias)}(?![\\p{L}\\p{N}])`, 'giu'), `$1${ref}`);
    }
    return out;
  };

  const ID_PATTERN = /(CHR|ANI|ART|LOC|VEH|CLO)\d+/g;
  // Orphan ids (no VB entry) are replaced with a pool-generic noun instead of
  // dropping the containing line. Dropping was catastrophic for single-line
  // prose: the whole cover scene description lived on ONE line, so one orphan
  // "ART001" deleted every character position from the prompt (empty SCENE
  // section — observed 2026-07-19, initial page shuffled + missing object).
  // A generic noun keeps the layout and still prevents the model from
  // painting the raw id as lettering.
  const GENERIC_NOUN = { CHR: 'person', ANI: 'animal', ART: 'object', LOC: 'place', VEH: 'vehicle', CLO: 'outfit' };
  const lines = prompt.split('\n');
  const out = [];
  const orphans = [];
  for (const line of lines) {
    const lineOrphans = [];
    const resolved = line.replace(ID_PATTERN, (id) => {
      const name = idToName.get(id.toUpperCase());
      if (name) return name;
      lineOrphans.push(id);
      return GENERIC_NOUN[id.slice(0, 3).toUpperCase()] || 'object';
    });
    if (lineOrphans.length > 0) orphans.push({ line: line.trim(), ids: lineOrphans });
    // Names after ids: the id pass inserts refs, never names, so this cannot
    // re-process its own output.
    out.push(replaceNames(resolved));
  }

  if (orphans.length > 0) {
    const tag = pageNumber !== null && pageNumber !== undefined ? `[PROMPT-SANITISE P${pageNumber}]` : '[PROMPT-SANITISE]';
    for (const orphan of orphans) {
      log.warn(`${tag} Replaced unresolved VB id(s) ${orphan.ids.join(', ')} with generic noun in: "${orphan.line.slice(0, 160)}"`);
    }
  }
  return out.join('\n');
}

/**
 * Build a terse "EXACT POSES" imperative block from scene interactions[].
 * Appended at the END of the image prompt. Image models (Grok Aurora) weight
 * the tail of the prompt heavily — declared interactions buried mid-paragraph
 * in the prose drop out, re-anchoring them here preserves held props, barrier
 * arms, gaze directions, and pose constraints.
 *
 * Returns '' when no interactions — caller skips the append.
 *
 * @param {Array} interactions - metadata.interactions, array of {character, object, where}
 * @returns {string}
 */
// A visual-bible handle: three letters, three digits, optional landmark variant
// suffix. Shared by the actor resolver below and the object check further down.
const VB_HANDLE = /^(ART|LOC|CHR|VEH|ANI)(\d{3})(?:\.\d+)?$/i;
const VB_ACTOR_COLLECTIONS = ['animals', 'secondaryCharacters', 'vehicles', 'artifacts'];

/**
 * Turn a visual-bible handle into the name a person would use.
 *
 * An actor may legitimately be a visual-bible entity rather than a human cast
 * member — the dragon in a dragon story is the co-protagonist. Until 2026-08-24
 * `sanitizeInteractions` deleted those rows outright, so animals could never
 * act. They now survive, which makes resolution this function's job: an EXACT
 * POSES line reading `- ANI001: walks behind Levin` is noise to an image model,
 * while `- Drache (hatchling): walks behind Levin` is an instruction.
 *
 * Anything that is not a handle, or a handle the bible does not know, comes
 * back unchanged — a name we cannot improve is still better than a blank.
 */
function resolveVbActorName(name, visualBible) {
  const raw = String(name || '').trim();
  const m = VB_HANDLE.exec(raw);
  if (!m || !visualBible) return raw;
  const wanted = (m[1] + m[2]).toUpperCase();
  for (const key of VB_ACTOR_COLLECTIONS) {
    const entries = visualBible[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const id = String((entry && entry.id) || '').trim().toUpperCase();
      const label = String((entry && entry.name) || '').trim();
      if (id === wanted && label) return label;
    }
  }
  return raw;
}

function buildExactPosesBlock(interactions, sceneCharacters = [], visualBible = null) {
  const interactionList = Array.isArray(interactions) ? interactions : [];
  // Even with zero declared interactions, we may still emit fill lines for
  // uncovered fg/mg characters — so don't early-return on an empty list.
  const lines = [];
  const coveredNames = new Set();
  // Sort essentials before normal/low so the most important poses lead the
  // block. Image models weight prompt-tail content heavily — but within the
  // EXACT POSES section, the first lines also carry stronger signal because
  // longer blocks compete for attention.
  const PRIORITY_RANK = { essential: 0, normal: 1, low: 2 };
  const ranked = [...interactionList].sort((a, b) => {
    const ra = PRIORITY_RANK[(a?.priority || 'normal').toLowerCase()] ?? 1;
    const rb = PRIORITY_RANK[(b?.priority || 'normal').toLowerCase()] ?? 1;
    return ra - rb;
  });
  for (const i of ranked) {
    if (!i || typeof i !== 'object') continue;
    const who = (i.character || '').trim();
    const where = (i.where || '').trim();
    const object = (i.object || '').trim();
    if (!who || !where) continue;
    // Split multi-character interactions ("Hans + Emma + Noah") into one line
    // per character with the shared `where`. Image models parse each EXACT
    // POSES line as one figure; "Hans + Emma + Noah" gets read as a single
    // weird label, not three figures, so the third figure drifts to "looking
    // at viewer" by default. Allowed input separators: `+`, `&`, `and`, `,`.
    const splitChars = who
      .split(/\s*(?:\+|&|\band\b|,)\s*/i)
      .map(s => s.trim())
      .filter(Boolean);
    const targets = splitChars.length > 1 ? splitChars : [who];

    // The schema asks for `where` to be a complete sentence with the object
    // name already embedded ("holds the stuffed elephant in lap"). In
    // practice Sonnet often emits bare verb/adjective phrases like
    //   { object: "Rogers Armbrust", where: "holds horizontal, aims across the square" }
    //   { object: "Der Apfel",       where: "balanced on top of head" }
    // and the object name silently drops out of the EXACT POSES block — the
    // image model receives an unintelligible line ("Roger: holds horizontal,
    // aims across the square") and renders the wrong (or no) prop.
    //
    // Defensive fix: if `object` is set and `where` doesn't already mention
    // it, append the object name to the line so the model always sees it.
    let finalWhere = where;
    if (object) {
      // Visual Bible IDs (ART001 / LOC003 / CHR007 / VEH002 / ANI004) are
      // opaque handles — the human name lives in the prose / VB grid label,
      // not the ID itself. Skip the "object name in where" check for IDs.
      const isVbId = /^(ART|LOC|CHR|VEH|ANI)\d+/i.test(object);
      if (!isVbId) {
        const objLower = object.toLowerCase();
        const whereLower = where.toLowerCase();
        // Match the full object name OR (for multi-word names like
        // "wooden ladder") any salient ≥4-char token from the name.
        const tokens = object.split(/[\s\-_/]+/).filter(t => t.length >= 4);
        const mentioned = whereLower.includes(objLower)
          || tokens.some(tok => whereLower.includes(tok.toLowerCase()));
        if (!mentioned) {
          finalWhere = `${where} — ${object}`;
        }
      }
    }
    for (const target of targets) {
      // A visual-bible actor reaches the model by name, not by handle.
      const label = resolveVbActorName(target, visualBible);
      lines.push(`- ${label}: ${finalWhere}`);
      coveredNames.add(label.toLowerCase());
      coveredNames.add(target.toLowerCase());   // so the fill below skips it either way
    }
  }

  // Fill: every foreground/midground scene character without a declared
  // interaction gets a low-priority default line. Goal isn't a specific gaze
  // direction — it's to break the model's default "look at the camera"
  // portrait pose. Background characters skipped (tiny anyway).
  for (const c of (sceneCharacters || [])) {
    if (!c || typeof c !== 'object') continue;
    const name = (c.name || '').trim();
    if (!name) continue;
    if (coveredNames.has(name.toLowerCase())) continue;
    const depth = String(c.depth || '').toLowerCase();
    if (depth === 'background') continue;
    lines.push(`- ${name}: looking off into the scene, not at the viewer`);
  }

  // Re-anchor per-character expressions at the tail, same reason as the poses:
  // the metadata `expression` field ("alarmed, mouth open mid-shout, brows
  // pulled tight") is buried mid-prose and Grok defaults every face to a mild
  // pleasant smile — a stubborn/scared/angry story beat renders as smiling.
  // Background faces skipped (unreadable at frame size).
  const exprLines = [];
  for (const c of (sceneCharacters || [])) {
    if (!c || typeof c !== 'object') continue;
    const name = (c.name || '').trim();
    const expr = typeof c.expression === 'string' ? c.expression.trim() : '';
    if (!name || !expr) continue;
    if (String(c.depth || '').toLowerCase() === 'background') continue;
    exprLines.push(`- ${name}: ${expr}`);
  }
  const exprBlock = exprLines.length > 0
    ? `EXPRESSIONS (each face shows exactly this — no default smiles):\n${exprLines.join('\n')}`
    : '';

  if (lines.length === 0 && !exprBlock) return '';
  const poseBlock = lines.length > 0 ? `EXACT POSES:\n${lines.join('\n')}` : '';
  return [poseBlock, exprBlock].filter(Boolean).join('\n\n');
}

// ============================================================================
// UNIFIED STORY GENERATION
// ============================================================================

// Injected into {ANALYSIS_INSTRUCTIONS} when the split outline review is ON
// (MODEL_DEFAULTS.splitOutlineReview): the writer skips its self-critique and a
// separate reviewer model (see buildOutlineReviewPrompt) emits the ANALYSIS +
// FIXES REQUIRED + patches instead. The stub keeps the writer's output shape
// byte-compatible with the parsers: the ---ANALYSIS--- marker still appears
// (draft extraction ends there) and the bare ---STORY PAGES--- marker still
// closes the output (cover-hint extraction ends there), but no FIXES REQUIRED
// phrase and no patch blocks are emitted — those come from the reviewer, whose
// output is appended after this one.
const SPLIT_REVIEW_ANALYSIS_STUB = `The critique of this draft is performed by a SEPARATE external reviewer AFTER this response — not by you. In this section, write exactly one line and nothing else:

Reviewed externally.

Then continue directly with the ---TITLE--- section. Hard rules for this response:
- Do NOT write any analysis and do NOT emit a "FIXES REQUIRED" list — never write that phrase anywhere in your output.
- Do NOT emit any \`--- Page N ---\` patch blocks anywhere. Your draft is final as written; the external reviewer emits all patches.
- At the very end, still output the bare \`---STORY PAGES---\` marker on its own line, followed by NOTHING. Any patch-related instructions in the ---STORY PAGES--- section or the FINAL CHECKLIST do not apply to this response.`;

/**
 * Build the external outline-review prompt (split outline review, Call 2).
 *
 * The reviewer receives the writer's FULL output verbatim plus the SAME
 * analysis instructions the single-call mode would have used (variant-matched
 * body, one shared source file), and emits ---ANALYSIS--- + FIXES REQUIRED +
 * ---STORY PAGES--- patch blocks in the exact single-call format — so the
 * concatenation (writer output + reviewer output) parses through the unchanged
 * UnifiedStoryParser / ProgressiveUnifiedParser.
 *
 * @param {Object} inputData - Same story parameters given to buildUnifiedStoryPrompt
 * @param {string} writerOutput - Call 1's complete response text
 * @param {Array}  [sceneConsistencyIssues] - deterministic validator findings
 *   ([{page, issues:[{type, detail}]}]) surfaced to the reviewer as REVIEW HINTS
 * @returns {string|null} Filled reviewer prompt, or null when the template is missing
 */
// Slice the analysis instruction body to a single review aspect (Test Lab
// split-review experiment). TEXT keeps sections A/B/C (narrative, character,
// prose) + E (do-not-write); SCENE keeps section D (scene-hint mechanics).
// 'both' returns the body unchanged (production behaviour). If the section
// headers can't be located the body is returned intact (never silently blank).
function sliceAnalysisAspect(body, aspect, opts = {}) {
  // includeTail=false drops the FIXES REQUIRED block and its formatting rules,
  // keeping only the CRITERIA. The text-refinement stage reuses the same review
  // criteria but answers with rewritten pages instead of fix lines, so it must
  // not inherit an output contract that contradicts its own.
  const includeTail = opts.includeTail !== false;
  if (!body) return body;
  if (aspect === 'both' && includeTail) return body;
  const idxA = body.indexOf('**A. ');
  const idxD = body.indexOf('**D. ');
  const idxE = body.indexOf('**E. ');
  const idxFixes = body.indexOf('**FIXES REQUIRED**');
  if (idxA < 0 || idxD < 0 || idxE < 0 || idxFixes < 0 || !(idxA < idxD && idxD < idxE && idxE < idxFixes)) {
    return body;
  }
  const preamble = body.slice(0, idxA);
  const secABC = body.slice(idxA, idxD); // A + B + C
  const secD = body.slice(idxD, idxE);   // D
  const secE = body.slice(idxE, idxFixes); // E (do-not-write verification)
  const tail = includeTail ? body.slice(idxFixes) : '';  // FIXES REQUIRED + formatting rules
  if (aspect === 'both') return preamble + secABC + secD + secE + tail;
  return aspect === 'text'
    ? preamble + secABC + secE + tail   // drop D (scene mechanics)
    : preamble + secD + tail;           // drop A/B/C/E (all text checks)
}

// Strip the aspect-gated reference blocks in outline-review.txt. TEXT review
// drops SCENE_REVIEW blocks (CHARACTER DETAILS, SEMANTIC SCENE CONSISTENCY);
// SCENE review drops TEXT_REVIEW blocks (DO-NOT-WRITE LIST). 'both' keeps both
// (strips only the markers) — byte-equivalent to pre-split behaviour.
function stripReviewAspectMarkers(prompt, aspect) {
  const block = (name) => new RegExp(`<!-- ${name}_BEGIN -->[\\s\\S]*?<!-- ${name}_END -->\\n?`, 'g');
  const marks = (name) => new RegExp(`[ \\t]*<!-- ${name}_(BEGIN|END) -->\\n?`, 'g');
  if (aspect === 'text') return prompt.replace(block('SCENE_REVIEW'), '').replace(marks('TEXT_REVIEW'), '');
  if (aspect === 'scene') return prompt.replace(block('TEXT_REVIEW'), '').replace(marks('SCENE_REVIEW'), '');
  return prompt.replace(marks('TEXT_REVIEW'), '').replace(marks('SCENE_REVIEW'), '');
}

/**
 * @param {Object} [opts]
 * @param {'both'|'text'|'scene'} [opts.aspect] - split-review scope (Test Lab). Default 'both'.
 * @param {string[]} [opts.priorReviews] - earlier review passes to feed in as context
 *   (Test Lab repeated-review experiment): the reviewer is told to go deeper and
 *   only add genuinely new fixes, so we can measure convergence across rounds.
 */
function buildOutlineReviewPrompt(inputData, writerOutput, sceneConsistencyIssues = [], opts = {}) {
  const template = PROMPT_TEMPLATES.outlineReview;
  if (!template) {
    log.error('[PROMPT] outlineReview template not loaded — split outline review unavailable');
    return null;
  }

  const aspect = (opts.aspect === 'text' || opts.aspect === 'scene') ? opts.aspect : 'both';
  const priorReviews = Array.isArray(opts.priorReviews) ? opts.priorReviews.filter(Boolean) : [];

  const variant = inputData.storyPromptVariant || process.env.STORY_PROMPT_VARIANT || 'imageFirst';
  const useImageFirst = variant !== 'textFirst';
  const analysisBody = sliceAnalysisAspect((useImageFirst
    ? PROMPT_TEMPLATES.outlineAnalysisImageFirst
    : PROMPT_TEMPLATES.outlineAnalysisTextFirst) || '', aspect);
  if (!analysisBody) {
    log.error('[PROMPT] outline analysis instruction template missing — reviewer prompt will lack the check list');
  }

  // REVIEW HINTS block from the deterministic scene-consistency pre-check.
  // Facts only (string/set findings) — the semantic verdicts stay with the
  // reviewer (see the SEMANTIC SCENE CONSISTENCY section of the template).
  let reviewHintsSection = '';
  const flat = [];
  for (const entry of sceneConsistencyIssues || []) {
    for (const issue of entry.issues || []) {
      flat.push(`- Page ${entry.page}: [${issue.type}] ${issue.detail}`);
    }
  }
  if (flat.length > 0) {
    reviewHintsSection = `# REVIEW HINTS — deterministic pre-check findings\n\nAn automated string-level check compared each page's METADATA against its SCENE prose, its interactions, and the locked scene designs. These are mechanical facts, not judgments — verify each one against the draft and emit a fix line for every real finding (mechanical METADATA/SCENE corrections):\n\n${flat.join('\n')}`;
  }

  const characterNames = (inputData.characters || []).map(c => c.name).join(', ');
  const imageModelKey = inputData.modelOverrides?.imageModel || MODEL_DEFAULTS.pageImage;
  const maxCharsPerScene = IMAGE_MODELS[imageModelKey]?.maxCharactersPerScene || 3;

  // The reviewer's checks reference two source-of-truth blocks the WRITER OUTPUT
  // does not carry (they live in the writer PROMPT): the CHARACTER DETAILS trait
  // lock (needed by physical-trait fidelity, check 19b — main/primary chars are
  // excluded from the Visual Bible) and the DO-NOT-WRITE LIST (needed by check
  // 25). In single-call mode the writer had both in-context; the split removed
  // them from the reviewer's view. Rebuild/inject them here so both checks work.
  const characterDetails = (inputData.characters || [])
    .map(char => buildCharacterPromptBlock(char, { format: 'bullets', includeClothing: true }))
    .join('\n\n') || '(no character details available)';

  // Slice the canonical DO-NOT-WRITE LIST out of the matching writer template so
  // the two never drift. Drop its header and the writer-only "the analysis pass
  // does NOT need to re-check them" note (that guidance is for the writer's own
  // self-critique; in split mode the external reviewer IS the re-check).
  const writerTpl = (useImageFirst && PROMPT_TEMPLATES.storyUnifiedImageFirst)
    ? PROMPT_TEMPLATES.storyUnifiedImageFirst
    : PROMPT_TEMPLATES.storyUnified;
  let doNotWriteList = '';
  if (writerTpl) {
    const start = writerTpl.indexOf('## DO-NOT-WRITE LIST');
    if (start >= 0) {
      const rest = writerTpl.slice(start);
      const stops = ['\n**PACING:**', '\n---', '\n# OUTPUT FORMAT']
        .map(s => rest.indexOf(s)).filter(i => i > 0);
      const end = stops.length ? Math.min(...stops) : rest.length;
      doNotWriteList = rest.slice(0, end)
        .replace(/^##\s*DO-NOT-WRITE LIST[^\n]*\n+/, '')
        .replace(/^These appear nowhere[^\n]*\n+/m, '')
        .trim();
    }
  }
  if (!doNotWriteList) doNotWriteList = '(canonical DO-NOT-WRITE list unavailable — apply the ban categories named in check 25)';

  // Aspect scope note (split review) + prior-review context (repeated review).
  const aspectNote = aspect === 'text'
    ? '**SCOPE — TEXT REVIEW ONLY.** Review only narrative, character, prose and the DO-NOT-WRITE list (sections A, B, C, E). Do NOT review scene descriptions or metadata. In FIXES REQUIRED and STORY PAGES emit ONLY `TEXT` fixes — never SCENE or METADATA.'
    : aspect === 'scene'
      ? '**SCOPE — SCENE REVIEW ONLY.** Review only the scene designs, METADATA and spatial/semantic scene consistency (section D + SEMANTIC SCENE CONSISTENCY). Do NOT review the story prose/narrative. In FIXES REQUIRED and STORY PAGES emit ONLY `SCENE` and/or `METADATA` fixes — never TEXT.'
      : '';
  let priorReviewsSection = '';
  if (priorReviews.length > 0) {
    const CAP = 15000;
    const blocks = priorReviews.map((r, i) => {
      const t = String(r || '');
      return `## Prior review ${i + 1}\n${t.length > CAP ? t.slice(0, CAP) + '\n…[truncated]' : t}`;
    }).join('\n\n');
    priorReviewsSection = `# PRIOR REVIEW PASS(ES)\n\nEarlier reviewer(s) already critiqued this SAME draft — their output is below. Do a FRESH pass: catch real issues they MISSED and flag any of their fixes you judge wrong. Do NOT repeat fixes that are already correct above — emit a fix line ONLY for something genuinely new or a correction to theirs. If you find nothing to add, say so and emit an empty FIXES REQUIRED list.\n\n${blocks}`;
  }

  // Inject the analysis body BEFORE fillTemplate so its own placeholders
  // ({CHARACTER_NAMES}, {MAX_CHARACTERS_PER_SCENE}) get filled too.
  const templateWithAnalysis = template.replace('{ANALYSIS_INSTRUCTIONS}', () => analysisBody);

  let prompt = fillTemplate(templateWithAnalysis, {
    PAGES: inputData.pages || '',
    LANGUAGE: getLanguageNameEnglish(inputData.language || 'en'),
    CHARACTER_NAMES: characterNames,
    MAX_CHARACTERS_PER_SCENE: maxCharsPerScene,
    WRITER_OUTPUT: writerOutput,
    REVIEW_HINTS_SECTION: reviewHintsSection,
    CHARACTER_DETAILS: characterDetails,
    DO_NOT_WRITE_LIST: doNotWriteList,
    ASPECT_NOTE: aspectNote,
    PRIOR_REVIEWS_SECTION: priorReviewsSection
  });

  // Drop the aspect-gated reference blocks (text-only / scene-only reviews).
  prompt = stripReviewAspectMarkers(prompt, aspect);

  // Same text-overlay gating as the writer prompt: layouts that render text
  // below the image drop every overlay-only analysis check.
  const textInImage = inputData.layout?.textInImage === true;
  if (textInImage) {
    prompt = prompt.replace(/<!-- TEXT_OVERLAY_(BEGIN|END) -->\n?/g, '');
  } else {
    prompt = prompt.replace(/<!-- TEXT_OVERLAY_BEGIN -->[\s\S]*?<!-- TEXT_OVERLAY_END -->\n?/g, '');
  }
  return prompt;
}

/**
 * Build the iterative text-refinement prompt (Lab stage `text_refine`).
 *
 * Deliberately NOT the outline reviewer: that one reads the whole writer draft
 * and emits patches, and in repeated mode each round re-reads the SAME draft plus
 * a growing stack of prior critiques. Here the contract is full text in, full
 * text out, so round N+1's input is literally round N's output and no commentary
 * is ever carried forward.
 *
 * Scene outlines go in read-only: the illustrations already exist, so the prose
 * must bend to the pictures and never the reverse.
 *
 * @param {Object} inputData - story record fields (language, languageLevel, characters, …)
 * @param {Array<{pageNumber:number,text:string,sceneIntent:string}>} pages
 * @returns {string|null} filled prompt, or null when the template is unavailable
 */
function buildTextRefinePrompt(inputData, pages = [], auditFindings = '') {
  const template = PROMPT_TEMPLATES.textRefine;
  if (!template) {
    log.error('[PROMPT] textRefine template not loaded — text refinement unavailable');
    return null;
  }

  // The review CRITERIA are the outline reviewer's own text sections (A narrative,
  // B character/dialogue, C prose, E do-not-write) — the exact slice
  // `aspect: 'text'` uses. Reused rather than restated so the refiner and the
  // reviewer can never judge text by different standards; the tail is dropped
  // because that block dictates fix-line output and this stage returns pages.
  const variant0 = inputData.storyPromptVariant || process.env.STORY_PROMPT_VARIANT || 'imageFirst';
  const analysisBody = sliceAnalysisAspect(
    (variant0 !== 'textFirst'
      ? PROMPT_TEMPLATES.outlineAnalysisImageFirst
      : PROMPT_TEMPLATES.outlineAnalysisTextFirst) || '',
    'text',
    { includeTail: false }
  );
  if (!analysisBody) {
    log.error('[PROMPT] outline analysis template missing — text refinement would run without criteria');
    return null;
  }

  // Prefer the full brief (METADATA already stripped by extractRefinablePages)
  // over the one-line intent: the refiner must not change events, and it cannot
  // avoid changing what it cannot see. Falls back to the intent for stored
  // stories that predate the brief being carried.
  const sceneOutlines = pages
    .map(p => `## Page ${p.pageNumber}\n${p.sceneBrief || p.sceneIntent || '(no scene outline recorded)'}`)
    .join('\n\n');
  const currentText = pages
    .map(p => `## Page ${p.pageNumber}\n${p.text || '(empty)'}`)
    .join('\n\n');

  // PSYCHOLOGICAL profile, not the visual one. buildCharacterPromptBlock emits
  // hair/eyes/face/head-height — that exists so an image model can draw the
  // character, and it is useless here: section B judges consistency, voice,
  // motivation and growth. Feeding cheekbones to a prose reviewer invites it to
  // "fix" appearance details the illustrations have already locked. This mirrors
  // the characterSummary the WRITER prompt gets, so refiner and writer reason
  // about the same person.
  const mainIds = inputData.mainCharacters || [];
  const characterDetails = (inputData.characters || []).map(char => {
    const t = getTraits(char);
    const line = (label, v) => {
      const s = Array.isArray(v) ? v.filter(Boolean).join(', ') : v;
      return s ? `- ${label}: ${s}` : null;
    };
    return [
      `**${char.name}**${mainIds.includes(char.id) ? ' (main character)' : ''}:`,
      line('Age', char.age),
      line('Gender', char.gender),
      line('Personality', char.personality),
      line('Strengths', t.strengths),
      line('Flaws', t.flaws),
      line('Challenges', t.challenges),
      line('Special details', t.specialDetails),
    ].filter(Boolean).join('\n');
  }).join('\n\n') || '(no character details available)';

  // Story brief = what the book was ASKED to be. This mirrors the field set the
  // writer prompt receives, because a refiner working from less context than the
  // writer had will drift away from the commission — storyDetails in particular
  // is the user's own idea in their own words and is the strongest anchor here.
  // Absent fields are omitted rather than sent as "undefined".
  const loc = inputData.userLocation;
  const rel = inputData.relationshipTexts && Object.keys(inputData.relationshipTexts).length
    ? Object.entries(inputData.relationshipTexts).map(([k, v]) => `  ${k}: ${v}`).join('\n')
    : null;
  const brief = [
    inputData.title ? `Title: ${inputData.title}` : null,
    inputData.storyCategory ? `Category: ${inputData.storyCategory}` : null,
    inputData.storyTypeName || inputData.storyType ? `Type: ${inputData.storyTypeName || inputData.storyType}` : null,
    inputData.storyTheme ? `Theme: ${inputData.storyTheme}` : null,
    inputData.storyTopic ? `Topic: ${inputData.storyTopic}` : null,
    inputData.season ? `Season: ${inputData.season}` : null,
    loc?.city ? `Setting/location: ${[loc.city, loc.region, loc.country].filter(Boolean).join(', ')}` : null,
    rel ? `Relationships:\n${rel}` : null,
    // The commission itself, last so it reads as the payload — wrapped the same
    // way the writer wraps it, since it is untrusted user text.
    inputData.storyDetails ? `\nStory idea (the user's own words):\n${wrapUserInput(inputData.storyDetails)}` : null,
  ].filter(Boolean).join('\n') || '(no additional brief recorded)';

  // Reuse the canonical DO-NOT-WRITE list from the writer template so the ban
  // categories can never drift between writing and refining.
  const doNotWriteSection = buildDoNotWriteSection(inputData);

  // The COMPLETE language definition, not the bare name. getLanguageNameEnglish
  // returns "Swiss German" for de-ch, which a model reads as Schwyzerdütsch — it
  // duly rewrote the whole book into dialect ("S'Fescht", "blybt stoh"). The
  // refiner gets exactly what the writer gets: name + instruction + note, all
  // three, so the spelling, vocabulary and dialogue-typography rules are present
  // verbatim rather than implied by a label.
  const language = inputData.language || 'en';
  // Inject the criteria BEFORE fillTemplate so their own placeholders
  // ({CHARACTER_NAMES}, {MAX_CHARACTERS_PER_SCENE}) get filled too — same order
  // buildOutlineReviewPrompt uses.
  const templateWithAnalysis = template.replace('{ANALYSIS_INSTRUCTIONS}', () => analysisBody);
  return fillTemplate(templateWithAnalysis, {
    LANGUAGE: getLanguageNameEnglish(language),
    LANGUAGE_INSTRUCTION: getLanguageInstruction(language),
    LANGUAGE_NOTE: getLanguageNote(language),
    READING_LEVEL: getReadingLevel(inputData.languageLevel),
    PAGE_COUNT: pages.length,
    CHARACTER_NAMES: (inputData.characters || []).map(c => c.name).join(', '),
    STORY_BRIEF: brief,
    CHARACTER_DETAILS: characterDetails,
    SCENE_OUTLINES: sceneOutlines,
    CURRENT_TEXT: currentText,
    AUDIT_FINDINGS: String(auditFindings || '').trim() || '(no audit ran)',
    DO_NOT_WRITE_SECTION: doNotWriteSection,
  });
}

/**
 * Parse a text-refinement response back into per-page text.
 * Tolerates the model echoing the ---STORY TEXT--- marker or omitting it.
 * @returns {{pages: Array<{pageNumber:number,text:string}>, missing: number[]}}
 */
function parseRefinedText(raw, expectedPages = [], markerName = 'STORY TEXT') {
  const full = String(raw || '');
  // Built from markerName, not hardcoded: callers pass 'SCENES' for the scene
  // review. A literal /---\s*STORY TEXT\s*---/ here silently failed to match
  // those responses, so `marker` was null and the analysis came back empty for
  // every model. Internal whitespace is loosened so "STORY  TEXT" still hits.
  const markerRe = new RegExp(
    '---\\s*' + markerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '\\s*---',
    'i'
  );
  const marker = full.match(markerRe);
  const body = marker ? full.slice(marker.index + marker[0].length) : full;

  // Everything before the body marker is the analysis — the findings that
  // justify each rewrite. Returned so the Lab can show WHY a page changed, not
  // just that it did. The ---ANALYSIS--- header itself is stripped if present.
  const analysis = marker
    ? full.slice(0, marker.index).replace(/^[\s\S]*?---\s*ANALYSIS\s*---/i, '').trim()
    : '';

  const pages = [];
  // "## Page N" headings, tolerating bold/extra markup around the number.
  const re = /^\s*#{1,4}\s*\**\s*(?:Page|Seite|Pagina)\s*\**\s*(\d+)\s*\**\s*:?\s*\**\s*$/gim;
  const marks = [];
  let m;
  // headStart = where the "## Page N" line BEGINS, bodyStart = just after it.
  // A page's text runs from its own bodyStart to the next page's headStart —
  // using the next mark's END offset instead appended the literal "## Page N+1"
  // line to the previous page's text, which then shipped inside the book.
  while ((m = re.exec(body)) !== null) {
    marks.push({ page: parseInt(m[1], 10), headStart: m.index, bodyStart: re.lastIndex });
  }
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].headStart : body.length;
    const text = body.slice(marks[i].bodyStart, end).trim();
    if (text) pages.push({ pageNumber: marks[i].page, text });
  }

  const got = new Set(pages.map(p => p.pageNumber));
  const missing = expectedPages.filter(n => !got.has(n));
  return { pages, missing, analysis };
}

/**
 * The main characters of a story, oldest first, plus the one the book follows.
 *
 * At most 2, or half the cast when the cast is small. Older first: a 3-year-old
 * carries a moment, not a book.
 *
 * Mains arrive in three shapes. The story pipeline passes `mainCharacters` as an
 * array of ids and stamps `isMainCharacter` on the objects; the idea-generation
 * payload has neither and flags each character with `isMain`. All are read here,
 * ids first, so every stage agrees on who the book is about. With none of them,
 * the first character is the focus — the long-standing fallback.
 *
 * This is the ONE place that decides who the focus character is — the story
 * shape and the age mode must never disagree about it.
 */
function pickMainCharacters(inputData = {}) {
  const chars = inputData.characters || [];
  const declaredMain = inputData.mainCharacters || [];
  const declared = declaredMain.length
    ? chars.filter(c => declaredMain.includes(c.id))
    : chars.filter(c => c.isMain || c.isMainCharacter);
  const cap = Math.max(1, Math.min(2, Math.floor(chars.length / 2) || 1));
  const mains = declared
    .slice()
    .sort((a, b) => (parseInt(b.age, 10) || 0) - (parseInt(a.age, 10) || 0))
    .slice(0, cap);
  const focus = mains[0] || chars[0] || null;
  return { mains, focus, others: chars.filter(c => !mains.includes(c)) };
}

const TODDLER_MAX_AGE = 3;

/**
 * Does this character carry any usable trait at all?
 *
 * `traits` is either a flat array of strings or the structured
 * { strengths, flaws, challenges, specialDetails } shape, and either may be
 * present but empty — a character created without filling the traits step has
 * `{ strengths: [], flaws: [], challenges: [], specialDetails: '' }`, which is
 * truthy and would pass a naive check.
 */
function hasAnyTraits(char) {
  const t = char?.traits;
  if (Array.isArray(t)) return t.some(x => String(x || '').trim());
  if (t && typeof t === 'object') {
    const lists = [t.strengths, t.flaws, t.challenges];
    if (lists.some(l => Array.isArray(l) && l.some(x => String(x || '').trim()))) return true;
    return !!String(t.specialDetails || '').trim();
  }
  return false;
}

/**
 * Which age band the story is written for.
 *
 * Owner rule (2026-08-25): the OLDEST main character decides, and secondary
 * characters never do. Two mains aged 5 and 1 get a 5-year-old's story; a
 * 1-year-old main with a 5-year-old secondary gets a toddler's story. Because
 * pickMainCharacters already sorts mains oldest-first, the focus character IS
 * the oldest main.
 *
 * An unreadable or absent age falls back to 'standard' — the existing
 * behaviour, and the safe direction to be wrong in.
 */
function resolveAgeMode(inputData = {}) {
  const age = parseInt(pickMainCharacters(inputData).focus?.age, 10);
  return Number.isFinite(age) && age >= 0 && age <= TODDLER_MAX_AGE ? 'toddler' : 'standard';
}

/**
 * Content rules for a main character aged 3 or under (prompts/toddler-mode.txt),
 * or '' at every other age. Scope is deliberately narrow — WHAT the story is
 * about and what happens in it. Text length belongs to the reading level and is
 * not touched here (owner, 2026-08-25: tasks/toddler-mode-2026-08-25.md §0).
 */
function buildToddlerModeSection(inputData = {}) {
  if (resolveAgeMode(inputData) !== 'toddler') return '';
  return PROMPT_TEMPLATES.toddlerMode || '';
}

/**
 * Shared context block for the beats prompts — the same brief, language and
 * PSYCHOLOGICAL character profile the refiner gets. Extracted so beats, the
 * beats review and text refinement can never describe the same book differently.
 */
/**
 * The story's SHAPE, computed rather than left to the model: how many threads a
 * book this long carries, how many challenges its focus character gets, who that
 * focus character is, and how hard the story may be.
 *
 * getSceneComplexityGuide() has encoded the length thresholds since the unified
 * days, but only the idea generator ever received it — the beats planner got the
 * page count as a bare label and treated a 5-page board book like a 25-page one.
 *
 * Owner rules (2026-08-21): at most two main characters (or half the cast,
 * whichever is smaller); difficulty follows the reading level, lowered when the
 * focus character is very young; the simplest level is always simple.
 */
function buildStoryShapeSection(inputData, pageCount) {
  const pages = parseInt(pageCount, 10) || (inputData.sceneImages || []).length || 10;
  const chars = inputData.characters || [];
  const { mains, focus, others } = pickMainCharacters(inputData);
  const topic = String(inputData.storyTopic || inputData.storyTheme || '').trim();

  // A book for a child of three or under has no challenge to budget pages for,
  // so the arithmetic below is skipped entirely rather than run down to zero:
  // every line of it prices challenges the story is not allowed to contain.
  // The content rules themselves live in prompts/toddler-mode.txt.
  if (resolveAgeMode(inputData) === 'toddler') {
    return [
      '# STORY SHAPE (fixed by the age of the main character — not yours to change)',
      '',
      `Pages: ${pages}. ${pages} different moments, one per page — each shows something the page before it did not.`,
      topic
        ? `Subject: the ${topic} is what this book is about. It is in full view from the first page, stays present throughout, and looks friendly and fun.`
        : '',
      `Main character: ${focus ? `${focus.name}${focus.age ? ` (${focus.age})` : ''}` : 'the main character'} — every page is theirs to enjoy, none is theirs to solve.`,
      'Challenges: one, small. Something is taken, dropped or will not work, the main character minds, and it is put right within a page or two. Nothing they must work out, nothing frightening.',
      'Feelings: three different ones across the book, plain on the face — delight, surprise, and a moment of being upset. The last page is happy.',
      // Traits are optional — plenty of characters carry none (owner,
      // 2026-08-25). Asking for "a page per trait" against an empty list plans
      // nothing, so say what to fall back on instead of leaving it implied.
      hasAnyTraits(focus)
        ? 'Their traits are the page plan: give each one a page of its own, in the form a child this age can do it.'
        : 'No traits are recorded for them, so the pages come from what every small child is: hungry, sleepy, curious, delighted, grumpy.',
      others.length
        ? `Everyone else — ${others.map(c => c.name).join(', ')} — is simply there alongside the main character. No moment of their own, no arc.`
        : '',
      `Page budget: ${pages} pages, ${pages} distinct events. Never spend two pages on the same want, and never a page that only wants what the last page wanted.`,
    ].filter(Boolean).join('\n');
  }

  // The page budget is arithmetic, so code does it and the arc only fills it in.
  // A major challenge is worth 2-3 pages, a secondary character's moment 1-2, and
  // the opening and ending take 2 each. Asking a model to keep that sum straight
  // is how you get a rushed ending: it discovers the overrun at the last page.
  const openingPages = pages <= 10 ? 1 : 2;
  const endingPages = pages <= 10 ? 1 : 2;
  const perMajor = pages <= 10 ? 2 : 3;
  // Clamped so the stated budget can never exceed the book: a 12-page book at
  // 3x3 majors plus covers priced out at 13 pages and told the model both
  // "0 secondary moments" and "one moment each" in adjacent lines.
  let majors = pages <= 10 ? 2 : pages <= 20 ? 3 : 4;
  while (majors > 1 && openingPages + endingPages + majors * perMajor > pages) majors--;
  const majorPages = majors * perMajor;
  const spare = pages - openingPages - endingPages - majorPages;
  // Whatever is left pays for the secondary characters' moments, at ~2 pages each.
  const moments = Math.max(0, Math.floor(spare / 2));

  // Two strands need either a long book or a big cast in a mid-length one
  // (owner 2026-08-23): five figures kept in one place put five in every
  // picture, and a split is what licenses pages of one or two characters.
  const twoStrands = pages > 20 || (pages >= 14 && chars.length >= 5);
  const threads = pages <= 10
    ? 'One storyline. No subplot, no second party doing something else.'
    : twoStrands
      ? 'Two strands that run apart and meet: the cast is not in one place for the whole book. Split the cast into two groups ONCE, let each strand carry its own pages, and bring them together before the end — never split more than once.'
      : 'One main storyline plus ONE secondary strand that meets it before the end.';

  const challenges = `exactly ${majors}`;

  const level = String(inputData.languageLevel || 'standard').toLowerCase();
  const focusAge = parseInt(focus?.age, 10) || 0;
  const simplest = level.includes('1st') || level.includes('early') || pages <= 10;
  const difficulty = simplest
    ? 'Simplest level: every challenge is one a small child solves by trying, asking or noticing. Nothing frightening beyond a moment.'
    : (focusAge && focusAge <= 5)
      ? 'The focus character is very young, so the challenges stay simple even at this reading level: no long plans, no reasoning a small child could not follow.'
      : 'The reading level allows real difficulty: a setback that lasts, a choice with a cost, a darker middle — still resolved.';

  // What the book is ABOUT has to be on the page. A dragon story for the
  // youngest readers shows a dragon — whole, friendly, and early. Withholding
  // the subject behind eyes in the dark or a sound offstage is a technique for
  // longer books and older readers; in a picture book it just means the thing
  // the child was promised never turns up.
  const subjectName = topic;
  const subject = !subjectName ? '' : simplest
    ? `Subject: the ${subjectName} is what this book is about. It appears in full view early, stays present through the story, and looks friendly and fun — never suggested by eyes in the dark, a shadow, a rumble or a sound offstage, and never frightening to look at.`
    : `Subject: the ${subjectName} is what this book is about and drives the ending. It may be withheld or hinted at for part of the book, but it is seen and it matters.`;

  return [
    '# STORY SHAPE (fixed by length and reading level — not yours to change)',
    '',
    `Pages: ${pages}. Threads: ${threads}`,
    subject,
    mains.length >= 2
      ? `Main characters: ${mains.map(c => `${c.name}${c.age ? ` (${c.age})` : ''}`).join(' and ')} — at most two carry a book. They share the challenges, the ending belongs to them, and ONE of them carries the visible change.`
      : `Main character: ${focus ? `${focus.name}${focus.age ? ` (${focus.age})` : ''}` : 'the main character'} — carries the challenges and the one visible change; the ending belongs to them.`,
    `Challenges: ${challenges} between the main character${mains.length >= 2 ? 's' : ''}.`,
    `Page budget — this is what ${pages} pages buys, already counted for you: opening ${openingPages}, ` +
      `${majors} major challenge${majors === 1 ? '' : 's'} at ${pages <= 10 ? 2 : 3} pages each (${majorPages}), ` +
      `${moments} secondary moment${moments === 1 ? '' : 's'} at about 2 pages each, ending ${endingPages}. ` +
      'Write that many and no more: a challenge you add is a page taken from another one.',
    others.length
      ? (moments > 0
        ? `Everyone else — ${others.map(c => c.name).join(', ')} — shares the ${moments} secondary moment${moments === 1 ? '' : 's'} the budget allows: at most one each, doing what only they would do. Not a challenge of their own, not an arc.`
        : `Everyone else — ${others.map(c => c.name).join(', ')} — appears inside the focus character's challenges; the budget has no room for separate moments.`)
      : '',
    // Trait-showing entrance pictures are a strong recommendation, not a rule,
    // and only when the book has room: a joiner's intro can share their moment
    // or a challenge page, but seven figures in a ten-page book leave no room
    // at all (owner 2026-08-23).
    'Entrances: say who is there at the start, and who joins later and why then. They do not all arrive at once.' +
      (pages > 10 && others.length > 0 && others.length <= Math.floor(pages / 3)
        ? ' Where the pages allow, give each later joiner an entrance picture of their own — a page of at most two characters where their trait shows; fold it into their moment or a challenge page rather than adding pages.'
        : ''),
    difficulty,
  ].filter(Boolean).join('\n');
}

function buildStoryContextFields(inputData) {
  const language = inputData.language || 'en';
  const loc = inputData.userLocation;
  const rel = inputData.relationshipTexts && Object.keys(inputData.relationshipTexts).length
    ? Object.entries(inputData.relationshipTexts).map(([k, v]) => `  ${k}: ${v}`).join('\n')
    : null;
  const brief = [
    inputData.title ? `Title: ${inputData.title}` : null,
    inputData.storyCategory ? `Category: ${inputData.storyCategory}` : null,
    inputData.storyTypeName || inputData.storyType ? `Type: ${inputData.storyTypeName || inputData.storyType}` : null,
    inputData.storyTheme ? `Theme: ${inputData.storyTheme}` : null,
    inputData.storyTopic ? `Topic: ${inputData.storyTopic}` : null,
    inputData.season ? `Season: ${inputData.season}` : null,
    loc?.city ? `Setting/location: ${[loc.city, loc.region, loc.country].filter(Boolean).join(', ')}` : null,
    rel ? `Relationships:\n${rel}` : null,
    inputData.storyDetails ? `\nStory idea (the user's own words):\n${wrapUserInput(inputData.storyDetails)}` : null,
  ].filter(Boolean).join('\n') || '(no additional brief recorded)';

  const mainIds = inputData.mainCharacters || [];
  const characterDetails = (inputData.characters || []).map(char => {
    const t = getTraits(char);
    const line = (label, v) => {
      const s = Array.isArray(v) ? v.filter(Boolean).join(', ') : v;
      return s ? `- ${label}: ${s}` : null;
    };
    return [
      `**${char.name}**${mainIds.includes(char.id) ? ' (main character)' : ''}:`,
      line('Age', char.age),
      line('Gender', char.gender),
      line('Personality', char.personality),
      line('Strengths', t.strengths),
      line('Flaws', t.flaws),
      line('Challenges', t.challenges),
      line('Special details', t.specialDetails),
    ].filter(Boolean).join('\n');
  }).join('\n\n') || '(no character details available)';

  // The topic guide (historical event, educational subject, adventure setting).
  // The unified writer path has always had this (see the storyCategory branches
  // below); the beats prompts never did, so a historical plan could only be
  // reviewed for SHAPE — the reviewer had no dates, figures or event sequence to
  // check the beats against. Capped because some guides run long and this rides
  // on every beats call. `storyDetails` (which carries the ROLES casting) is
  // already in STORY_BRIEF above; this adds the facts behind it.
  const guideKey = inputData.storyCategory === 'adventure'
    ? (inputData.storyTheme || inputData.storyTopic)
    : (inputData.storyTopic || inputData.storyTheme);
  let guideSection = '';
  try {
    const guide = getTeachingGuide(inputData.storyCategory, guideKey);
    if (guide) guideSection = `# TOPIC GUIDE (facts and context for ${guideKey})\n\n${String(guide).slice(0, 4000)}`;
  } catch (err) {
    log.warn(`[PROMPT] topic guide unavailable for ${inputData.storyCategory}/${guideKey}: ${err.message}`);
  }

  const imageModelKey = inputData.modelOverrides?.imageModel || MODEL_DEFAULTS.pageImage;
  return {
    LANGUAGE: getLanguageNameEnglish(language),
    LANGUAGE_INSTRUCTION: getLanguageInstruction(language),
    LANGUAGE_NOTE: getLanguageNote(language),
    READING_LEVEL: getReadingLevel(inputData.languageLevel),
    CHARACTER_NAMES: (inputData.characters || []).map(c => c.name).join(', '),
    // Every injected block states its own standing. Without this the brief
    // arrived as bare text and each stage guessed: the planner was told to treat
    // it as a loose wish, the judge scored it as a commission, and the reviewer
    // was told it proves nothing — three readings of one input, none declared.
    // Owner ruling (2026-08-21): subject and world bind, mechanics do not.
    STORY_BRIEF: [
      '# THE COMMISSION',
      '',
      'What this names is binding: the subject the book is about, the world it happens in, and who is in it. The book delivers those.',
      'How the story gets there is not binding: any obstacle, object or trick the idea suggests may be replaced by something the story needs more. Dropping one of those is not a fault.',
      '',
      brief,
    ].join('\n'),
    STORY_GUIDE_SECTION: guideSection,
    CHARACTER_DETAILS: characterDetails,
    MAX_CHARACTERS_PER_SCENE: IMAGE_MODELS[imageModelKey]?.maxCharactersPerScene || 3,
  };
}

/** Beats + one-line scene intents for N pages. Structure only, no prose. */
function buildBeatsPrompt(inputData, pageCount) {
  const template = PROMPT_TEMPLATES.storyBeats;
  if (!template) {
    log.error('[PROMPT] storyBeats template not loaded — beats planning unavailable');
    return null;
  }
  return fillTemplate(template, {
    ...buildStoryContextFields(inputData),
    PAGE_COUNT: pageCount,
    STORY_SHAPE: buildStoryShapeSection(inputData, pageCount),
    TODDLER_MODE: buildToddlerModeSection(inputData),
    AVAILABLE_LANDMARKS_SECTION: buildAvailableLandmarksSection(inputData.availableLandmarks),
  });
}

/** Fast structural review of a beat plan. Returns analysis + rewritten pages. */
function buildBeatsReviewPrompt(inputData, beats, arc = '', pagePlan = '', auditFindings = '') {
  const template = PROMPT_TEMPLATES.storyBeatsReview;
  if (!template) {
    log.error('[PROMPT] storyBeatsReview template not loaded — beats review unavailable');
    return null;
  }
  const current = beats
    .map(b => `## Page ${b.pageNumber}\nBEAT: ${b.beat}\nSCENE: ${b.scene}`)
    .join('\n\n');
  return fillTemplate(template, {
    ...buildStoryContextFields(inputData),
    PAGE_COUNT: beats.length,
    STORY_SHAPE: buildStoryShapeSection(inputData, beats.length),
    TODDLER_MODE: buildToddlerModeSection(inputData),
    PAGE_PLAN: String(pagePlan || '').trim() || '(the planner emitted no page plan — check 6c falls back to the beats alone)',
    CURRENT_BEATS: current,
    CURRENT_ARC: String(arc || '').trim() || '(the planner authored no arc)',
    AUDIT_FINDINGS: String(auditFindings || '').trim() || '(no audit ran)',
    AVAILABLE_LANDMARKS_SECTION: buildAvailableLandmarksSection(inputData.availableLandmarks),
  });
}

/**
 * Audit FAULT-line parsing — one yardstick for every consumer. The audit
 * templates emit "FAULT[<QUESTION>]: ..." (tagged, 2026-08-26); older stored
 * reports carry the bare "FAULT: ..." form, so both are accepted forever.
 */
const FAULT_LINE_RE = /^FAULT(?:\[([A-Z]+)\])?:/gm;

/** Count FAULT lines (tagged or bare) in an audit's raw text. */
function countFaults(text) {
  return (String(text || '').match(FAULT_LINE_RE) || []).length;
}

/** Per-category tally of FAULT lines, e.g. { ASSUMED: 3, LIMIT: 1 }. Bare (untagged) lines count under UNTAGGED. */
function faultsByCategory(text) {
  const out = {};
  for (const m of String(text || '').matchAll(FAULT_LINE_RE)) {
    const cat = m[1] || 'UNTAGGED';
    out[cat] = (out[cat] || 0) + 1;
  }
  return out;
}

/** Blind audit of the arc: the auditor sees ONLY the commission and the arc. */
function buildArcAuditPrompt(inputData, arc) {
  const template = PROMPT_TEMPLATES.storyArcAudit;
  if (!template) {
    log.error('[PROMPT] storyArcAudit template not loaded — arc audit unavailable');
    return null;
  }
  return fillTemplate(template, {
    STORY_BRIEF: buildStoryContextFields(inputData).STORY_BRIEF,
    ARC: String(arc || '').trim(),
  });
}

/**
 * The age the judge role-plays: the youngest MAIN character, since the book has
 * to work for the youngest listener in the cast. Falls back to 5 when no main
 * character carries a usable age.
 */
// Reader age from the reading level — the title (and the child critic's ear)
// belong to the READER. Deriving age from the CAST broke on adult casts: a
// 25-year-old heroine made the title judge reason "a 25-year-old can say it
// effortlessly" and bless a ship-name title (2026-08-27).
function readerAge(inputData) {
  const lvl = String(inputData?.languageLevel || '').toLowerCase();
  if (lvl === '1st-grade') return 6;
  if (lvl === 'advanced') return 11;
  if (lvl === 'standard') return 8;
  return Math.min(8, youngestMainAge(inputData, 8));
}

function youngestMainAge(inputData, fallback = 5) {
  const mainIds = inputData?.mainCharacters || [];
  const chars = (inputData?.characters || []).filter(c => c && (!mainIds.length || mainIds.includes(c.id)));
  const ages = chars.map(c => parseInt(c.age, 10)).filter(n => Number.isFinite(n) && n > 0);
  return ages.length ? Math.min(...ages) : fallback;
}

/**
 * Child critic of the arc: a listener, not an editor. Runs alongside the hostile
 * audit and answers only comprehension and engagement.
 */
function buildChildCriticPrompt(inputData, arc) {
  const template = PROMPT_TEMPLATES.storyChildCritic;
  if (!template) {
    log.error('[PROMPT] storyChildCritic template not loaded — child critic unavailable');
    return null;
  }
  return fillTemplate(template, {
    AGE: readerAge(inputData),
    STORY_BRIEF: buildStoryContextFields(inputData).STORY_BRIEF,
    ARC: String(arc || '').trim(),
  });
}

/** Blind audit of the beats: the auditor sees ONLY the page plan and the beats. */
function buildBeatsAuditPrompt(beats, pagePlan = '') {
  const template = PROMPT_TEMPLATES.storyBeatsAudit;
  if (!template) {
    log.error('[PROMPT] storyBeatsAudit template not loaded — beats audit unavailable');
    return null;
  }
  const current = beats
    .map(b => `## Page ${b.pageNumber}\nBEAT: ${b.beat}\nSCENE: ${b.scene}`)
    .join('\n\n');
  return fillTemplate(template, {
    PAGE_PLAN: String(pagePlan || '').trim() || '(none)',
    BEATS: current,
  });
}

/**
 * Blind audit of the finished text as the audience receives it: back cover,
 * page prose, and what each picture shows (the DEPICTS block only — the rest
 * of a scene brief describes intent the viewer never sees).
 */
// Sentence-level proofread of the FINAL text (2026-08-26): article/gender,
// quote nesting, spelling, self-contradiction, non-words, repeats. Separate
// from the causality audit — a sixth question there catches a different 1-2 of
// 4 known defects per run (measured); a narrow pass is deterministic about them.
function buildTextProofreadPrompt(inputData, pages = []) {
  const template = PROMPT_TEMPLATES.storyTextProofread;
  if (!template) {
    log.error('[PROMPT] storyTextProofread template not loaded — proofread unavailable');
    return null;
  }
  const langNames = { 'de-ch': 'Swiss Standard German (ss, never ß)', de: 'German', fr: 'French', it: 'Italian', en: 'English' };
  const lang = langNames[String(inputData?.language || '').toLowerCase()] || inputData?.language || 'the language of the pages';
  const body = pages.map(p => `--- Page ${p.pageNumber} ---\n${String(p.text || '').trim()}`).join('\n\n');
  return fillTemplate(template, { LANGUAGE: lang, PAGES: body });
}

function buildTextAuditPrompt(inputData, pages = []) {
  const template = PROMPT_TEMPLATES.storyTextAudit;
  if (!template) {
    log.error('[PROMPT] storyTextAudit template not loaded — text audit unavailable');
    return null;
  }
  const depictsOf = (brief) => {
    const m = String(brief || '').match(/THIS IMAGE DEPICTS:\*{0,2}\s*([\s\S]*?)(?=\n\s*\n\s*(?:\*\*|#|[A-Z][A-Z ]{3,}:)|$)/);
    return (m ? m[1] : '').trim();
  };
  const body = pages.map(p =>
    `--- Page ${p.pageNumber} ---\nTEXT:\n${String(p.text || '').trim()}\n\nTHE PICTURE SHOWS:\n${depictsOf(p.sceneBrief) || '(no picture description)'}`
  ).join('\n\n');
  return fillTemplate(template, {
    STORY_BRIEF: buildStoryContextFields(inputData).STORY_BRIEF,
    PAGES: body,
  });
}

/** Review of the arc alone, before any page exists. Returns analysis + a corrected arc. */
function buildArcReviewPrompt(inputData, arc, auditFindings = '') {
  const template = PROMPT_TEMPLATES.storyArcReview;
  if (!template) {
    log.error('[PROMPT] storyArcReview template not loaded — arc review unavailable');
    return null;
  }
  return fillTemplate(template, {
    ...buildStoryContextFields(inputData),
    PAGE_COUNT: inputData.pages || (inputData.sceneImages || []).length || 10,
    STORY_SHAPE: buildStoryShapeSection(inputData, inputData.pages || (inputData.sceneImages || []).length || 10),
    TODDLER_MODE: buildToddlerModeSection(inputData),
    CURRENT_ARC: String(arc || '').trim(),
    AUDIT_FINDINGS: String(auditFindings || '').trim() || '(no audit ran)',
  });
}

/** Parse an ---ARC--- block (analysis before it, arc after), same shape as parseBeats. */
function parseArcReview(raw) {
  const full = String(raw || '');
  const marker = full.match(/---\s*ARC\s*---/i);
  const analysis = (marker ? full.slice(0, marker.index) : full)
    .replace(/^[\s\S]*?---\s*ANALYSIS\s*---/i, '').trim();
  // Lookahead to the next section marker: a reviewer that emits ---ARC--- first
  // and ---ANALYSIS--- second must not have the analysis absorbed into the arc.
  const arc = marker
    ? (full.slice(marker.index + marker[0].length).match(/^([\s\S]*?)(?=\n---\s*[A-Z][A-Z ]*---|$)/) || [, ''])[1].trim()
    : '';
  return { analysis, arc };
}

/**
 * Wardrobe review of the bible's clothing contract. Returns null when the
 * story has no dressed character to review — a bible that produced no usable
 * outfit has nothing for a reviewer to correct.
 */
function buildClothingReviewPrompt(inputData, clothingRequirements, beats = []) {
  const template = PROMPT_TEMPLATES.clothingReview;
  if (!template) {
    log.error('[PROMPT] clothingReview template not loaded — clothing review unavailable');
    return null;
  }
  const blocks = [];
  for (const [name, categories] of Object.entries(clothingRequirements || {})) {
    for (const [category, entry] of Object.entries(categories || {})) {
      if (!entry || typeof entry !== 'object' || !entry.used || !entry.description) continue;
      // The costume NAME is what check 1 measures the garments against. Without
      // it the reviewer can only guess which costume "striped shirt" belongs to.
      const costume = entry.costume ? ` (costume: ${entry.costume})` : '';
      blocks.push(`## ${name} / ${category}${costume}\n${entry.description}`);
    }
  }
  if (blocks.length === 0) return null;
  // The beats are what check 9 (coverage) reads: a transformation or costume a
  // beat gives a character is invisible from the wardrobe text alone — the
  // bible writer missed one from the same inputs, so the review must see them.
  const beatBlocks = (beats || [])
    .map(b => `## Page ${b.pageNumber}\nBEAT: ${b.beat}\nSCENE: ${b.scene}`)
    .join('\n\n') || '(beats not available)';
  return fillTemplate(template, {
    ...buildStoryContextFields(inputData),
    STYLE_WARDROBE: buildStyleWardrobeBlock(inputData.artStyle),
    CURRENT_CLOTHING: blocks.join('\n\n'),
    BEATS: beatBlocks,
  });
}

/**
 * Parse a ---CLOTHING--- block into {name, category, description}. Same shape
 * as parseBeats: analysis before the marker, entries after, omission allowed
 * (the review returns only the outfits it rewrote).
 */
function parseClothingReview(raw) {
  const full = String(raw || '');
  const marker = full.match(/---\s*CLOTHING\s*---/i);
  const stripAnalysisMarker = s => s.replace(/^[\s\S]*?---\s*ANALYSIS\s*---/i, '').trim();
  const analysis = marker
    ? stripAnalysisMarker(full.slice(0, marker.index))
    : stripAnalysisMarker(full);
  const body = marker ? full.slice(marker.index + marker[0].length) : '';
  if (!body.trim() || /^\s*NONE\s*$/i.test(body.trim())) return { analysis, entries: [] };

  // The heading carries a trailing "(costume: x)" when we echoed one back, so
  // the category match cannot be anchored to end-of-line.
  // `costumed:<name>` is how check 9 ADDS a category the bible missed — the
  // costume name rides in the heading and the merge needs it to mark the
  // category used.
  const re = /^[ \t]*#{1,4}[ \t]*\**([^/\n]+?)\**[ \t]*\/[ \t]*\**(standard|winter|summer|costumed(?::[\w-]+)?)\b[^\n]*$/gim;
  const marks = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    const [cat, colonCostume] = m[2].toLowerCase().split(':');
    // The costume name arrives in either notation — `costumed:mermaid` (what
    // check 9 prescribes) or the echo format `costumed (costume: mermaid)`
    // that the CURRENT WARDROBE block itself uses and reviewers mirror. A
    // valid addition was dropped as stray because only the colon form parsed.
    let costume = colonCostume || null;
    if (!costume && cat === 'costumed') {
      const cm = m[0].match(/costume:\s*([\w-]+)/i);
      if (cm) costume = cm[1].toLowerCase();
    }
    marks.push({
      name: m[1].replace(/\*/g, '').trim(),
      category: cat,
      costume,
      headStart: m.index,
      bodyStart: m.index + m[0].length,
    });
  }

  // Last write wins per character+category. A reviewer that catches itself
  // mid-outfit emits the flawed one, then a corrected heading for the same
  // slot; applying both in order happens to land on the right value, but only
  // because it arrived second. Deduping here makes that deliberate instead of
  // lucky, and drops the abandoned draft rather than recording it as a change.
  const byKey = new Map();
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].headStart : body.length;
    const description = body.slice(marks[i].bodyStart, end).trim();
    if (!marks[i].name || !description) continue;
    const key = `${marks[i].name.toLowerCase()}/${marks[i].category}`;
    byKey.set(key, { name: marks[i].name, category: marks[i].category, costume: marks[i].costume || null, description });
  }
  return { analysis, entries: [...byKey.values()] };
}

/**
 * Parse a ---BEATS--- block into {pageNumber, beat, scene}. Same shape as
 * parseRefinedText: analysis before the marker, pages after, omission allowed
 * (the review returns only rewritten pages).
 */
function parseBeats(raw, expectedPages = []) {
  const full = String(raw || '');
  const marker = full.match(/---\s*BEATS\s*---/i);
  const body = marker ? full.slice(marker.index + marker[0].length) : full;
  const analysis = marker
    ? full.slice(0, marker.index).replace(/^[\s\S]*?---\s*ANALYSIS\s*---/i, '').trim()
    : '';

  const re = /^\s*#{1,4}\s*\**\s*(?:Page|Seite|Pagina)\s*\**\s*(\d+)\s*\**\s*:?\s*\**\s*$/gim;
  const marks = [];
  let m;
  while ((m = re.exec(body)) !== null) marks.push({ page: parseInt(m[1], 10), headStart: m.index, bodyStart: re.lastIndex });

  const pages = [];
  // The last page's chunk must stop at the next ---SECTION--- marker, not at the
  // end of the response: a section emitted AFTER the beats (a reordered PAGE
  // PLAN, a stray postscript) would otherwise be absorbed into that page's SCENE.
  const trailing = body.search(/\n---\s*[A-Z][A-Z ]*---/);
  const bodyEnd = trailing >= 0 && marks.length && trailing > marks[marks.length - 1].bodyStart
    ? trailing
    : body.length;
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].headStart : bodyEnd;
    const chunk = body.slice(marks[i].bodyStart, end);
    // BEAT runs until SCENE; SCENE until the end of the chunk.
    const beat = (chunk.match(/BEAT\s*:\s*([\s\S]*?)(?=\n\s*SCENE\s*:|$)/i) || [])[1];
    const scene = (chunk.match(/SCENE\s*:\s*([\s\S]*)$/i) || [])[1];
    if (beat || scene) {
      pages.push({ pageNumber: marks[i].page, beat: (beat || '').trim(), scene: (scene || '').trim() });
    }
  }

  const got = new Set(pages.map(p => p.pageNumber));
  // The planner authors ---ARC--- before ---BEATS---; the reviewer puts its
  // ---ANALYSIS--- in the same place. Both land in the pre-marker text, so the
  // arc is whatever sits under an explicit ---ARC--- marker and nothing else.
  const arcMatch = full.match(/---\s*ARC\s*---([\s\S]*?)(?=\n---\s*[A-Z][A-Z ]*---|$)/i);
  const arc = arcMatch ? arcMatch[1].trim() : '';
  return { pages, missing: expectedPages.filter(n => !got.has(n)), analysis, arc };
}

/**
 * ONE review over ALL scene briefs. Repetition between pages, visual arc and
 * continuity are invisible to a per-scene reviewer, so the whole set goes in a
 * single call.
 */
function buildSceneReviewPrompt(inputData, scenes = [], options = {}) {
  const template = PROMPT_TEMPLATES.sceneReview;
  if (!template) {
    log.error('[PROMPT] sceneReview template not loaded — scene review unavailable');
    return null;
  }
  const all = scenes.map(s => ['## Page ' + s.pageNumber, s.brief].join(String.fromCharCode(10))).join(String.fromCharCode(10, 10));
  // Per-page beat lines so check 5 (character in the beat but absent from the
  // brief) has beats to compare against — without them the check was dead
  // (ALL_SCENES + STORY_BRIEF never carried per-page beats). One line per page,
  // truncated; "(no beat data)" tells the reviewer to skip the comparison
  // instead of hallucinating one (non-beats callers pass no beats).
  const beatLines = (Array.isArray(options.beats) ? options.beats : [])
    .filter(b => b && b.pageNumber != null && String(b.beat || '').trim())
    .map(b => `Page ${b.pageNumber}: ${String(b.beat).replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  return fillTemplate(template, {
    ...buildStoryContextFields(inputData),
    PAGE_COUNT: scenes.length,
    ALL_SCENES: all,
    PAGE_BEATS: beatLines.length ? beatLines.join('\n') : '(no beat data)',
    // Mechanical clothing faults (server/lib/clothingCheck.js) — free to
    // compute, and the review is the ONE place they get fixed (owner decision
    // 2026-08-08). Empty string when nothing was found, so fillTemplate drops
    // the placeholder and the prompt is unchanged for a clean story.
    CLOTHING_FINDINGS: options.clothingFindings || '',
    // Brief contradictions (server/lib/sceneBriefCheck.js) — prose vs the
    // brief's own metadata, same deal: free to compute, fixed here or nowhere.
    // Stated as contradictions, not orders: the reviewer wrote both halves and
    // may legitimately decline one.
    BRIEF_FINDINGS: options.briefFindings || '',
  });
}

/**
 * The canonical DO-NOT-WRITE list, lifted out of the writer template so every
 * prompt that produces narrative text bans the same categories. Shared by the
 * refiner and by the beats-first text writer.
 */
function buildDoNotWriteSection(inputData = {}) {
  const variant = inputData.storyPromptVariant || process.env.STORY_PROMPT_VARIANT || 'imageFirst';
  const writerTpl = (variant !== 'textFirst' && PROMPT_TEMPLATES.storyUnifiedImageFirst)
    ? PROMPT_TEMPLATES.storyUnifiedImageFirst
    : PROMPT_TEMPLATES.storyUnified;
  if (!writerTpl) return '';
  const start = writerTpl.indexOf('## DO-NOT-WRITE LIST');
  if (start < 0) return '';
  const rest = writerTpl.slice(start);
  const stops = ['\n**PACING:**', '\n---', '\n# OUTPUT FORMAT']
    .map(s => rest.indexOf(s)).filter(i => i > 0);
  const end = stops.length ? Math.min(...stops) : rest.length;
  const list = rest.slice(0, end).replace(/^##\s*DO-NOT-WRITE LIST[^\n]*\n+/, '').trim();
  return list ? `# DO-NOT-WRITE LIST\n\n${list}` : '';
}

/**
 * Page text written FROM the locked beats (beats-first pipeline, step 5).
 * Emits the same ---ANALYSIS--- / ---STORY TEXT--- shape the refiner emits, so
 * parseRefinedText() reads it with no new parser. A ---TITLE--- block precedes
 * both: in a beats run no other call produces a title.
 */
/**
 * @param {Object} inputData
 * @param {Array<{pageNumber:number, beat:string, scene:string}>} beats
 * @param {Array<{pageNumber:number, brief:string}>} [expansions] - the FINAL
 *   scene briefs, post scene-review. Text is written to match the picture that
 *   will actually be drawn; see the ordering note in beatsPipeline.
 */
function buildStoryTextFromBeatsPrompt(inputData, beats = [], expansions = [], arc = '') {
  const template = PROMPT_TEMPLATES.storyTextFromBeats;
  if (!template) {
    log.error('[PROMPT] storyTextFromBeats template not loaded — beats text writing unavailable');
    return null;
  }
  // Brief per page, trimmed to the prose the writer needs. The METADATA block
  // is machine data for the image call (zones, depths, bbox hints) — it would
  // only invite the writer to narrate staging.
  const briefByPage = new Map(
    (expansions || [])
      .filter(x => x && x.pageNumber != null)
      .map(x => [x.pageNumber, String(x.brief || '').split(/---\s*METADATA/i)[0].trim()])
  );
  const blocks = beats
    .map(b => {
      const brief = briefByPage.get(b.pageNumber);
      return `## Page ${b.pageNumber}\nBEAT: ${b.beat}\nSCENE: ${b.scene}`
        + (brief ? `\nILLUSTRATION (already locked — what the reader will SEE on this page):\n${brief}` : '');
    })
    .join('\n\n');
  return fillTemplate(template, {
    STORY_ARC: String(arc || '').trim() || '(no arc was recorded for this story)',
    ...buildStoryContextFields(inputData),
    PAGE_COUNT: beats.length,
    BEATS: blocks,
    TITLE_RULE: buildTitleRule(inputData),
    // The writer that produced the candidates also picks the shipped title
    // (2026-08-27) — the reader age is the "can a child say it" yardstick.
    AGE: readerAge(inputData),
    DO_NOT_WRITE_SECTION: buildDoNotWriteSection(inputData),
  });
}

/**
 * The title rule, by how many main characters the book has (owner, 2026-08-25).
 *
 * A trial story has exactly one child, so "the title contains the main
 * character's name" was written as an unconditional rule and then applied to
 * casts it does not fit: a four-lead story came back titled after one of them
 * ("<name> und der kleine Drache"), which reads as a two-hander. The name is
 * the personalised-book product for one or two children — a parent scanning a
 * shelf wants to see it — and stops being reachable past that.
 *
 * Mains arrive in three shapes, the same three `pickMainCharacters` reads: a
 * `mainCharacters` id array, an `isMainCharacter` stamp on the objects, or an
 * `isMain` flag from the idea-generation payload. All three are read here so a
 * cast flagged only on the objects is not mistaken for "none marked" and
 * silently counted as the whole cast.
 *
 * It does NOT delegate to `pickMainCharacters`: that caps the focus at two by
 * design, which is right for the story shape and wrong here — capping a
 * four-lead cast to two would make this demand both their names.
 *
 * @param {Object} inputData
 * @returns {string} one prompt line
 */
function buildTitleRule(inputData) {
  const mainIds = inputData?.mainCharacters || [];
  const chars = inputData?.characters || [];
  const declared = mainIds.length
    ? chars.filter(c => mainIds.includes(c.id))
    : chars.filter(c => c.isMain || c.isMainCharacter);
  const mainNames = declared.map(c => c.name).filter(Boolean);
  // Nothing marked at all (older jobs, trials mid-migration): fall back to the
  // whole cast, which is what the count is standing in for.
  const names = mainNames.length ? mainNames : chars.map(c => c.name).filter(Boolean);

  const base = 'Every title is in the story language and does not spoil the ending.';
  if (names.length === 1) return `${base} Each one contains ${names[0]}'s name.`;
  if (names.length === 2) return `${base} Each one contains both names: ${names[0]} and ${names[1]}.`;
  return `${base} A name in the title is optional: with this many main characters, prefer what they do together.`;
}

/**
 * Visual contract written FROM the locked beats (beats-first pipeline, step 3).
 * The unified writer emitted clothing requirements, the Visual Bible and the
 * cover scene hints as part of one call; no beats stage produced them, so a
 * beats run shipped with an empty VB, null clothing and no cover hints.
 *
 * It runs BEFORE scene expansion, not after: the Visual Bible feeds
 * buildSceneExpansionPrompt's {RECURRING_ELEMENTS}, so a brief written without
 * it has no location, artifact, animal or secondary-character continuity to
 * weave in. The clothing requirements also gate the styled-avatar kickoff.
 *
 * The three sections use the same markers/format the unified writer used, and
 * beatsPipeline splices them into the transcript that becomes
 * `unifiedResponse` — so UnifiedStoryParser.extractClothingRequirements() /
 * extractVisualBible() / extractCoverHints() work unchanged.
 *
 * @param {Object} inputData
 * @param {Array<{pageNumber:number, beat:string, scene:string}>} beats
 * @returns {string|null}
 */
function buildStoryBibleFromBeatsPrompt(inputData, beats = []) {
  const template = PROMPT_TEMPLATES.storyBibleFromBeats;
  if (!template) {
    log.error('[PROMPT] storyBibleFromBeats template not loaded — beats visual contract unavailable');
    return null;
  }
  const mainIds = inputData.mainCharacters || [];
  const chars = inputData.characters || [];
  const named = (predicate) => chars.filter(predicate).map(c => c.name).join(', ') || 'None';

  const beatBlocks = beats
    .map(b => `## Page ${b.pageNumber}\nBEAT: ${b.beat}\nSCENE: ${b.scene}`)
    .join('\n\n');

  return fillTemplate(template, {
    ...buildStoryContextFields(inputData),
    PAGE_COUNT: beats.length,
    // The contract's descriptions are copied verbatim into image prompts, so
    // the bible must know the rendering style — a style-blind contract wrote
    // luminous/iridescent fantasy specs into a photorealistic book
    // (job_1786737619634: 3D-render drift on every page that used them).
    ART_STYLE: resolveArtStyle(inputData.artStyle) || inputData.artStyle || 'not specified',
    STYLE_WARDROBE: buildStyleWardrobeBlock(inputData.artStyle),
    MAIN_CHARACTER_NAMES: named(c => mainIds.includes(c.id)),
    PRIMARY_CHARACTER_NAMES: named(c => !mainIds.includes(c.id)),
    CHARACTER_PHYSICAL_BLOCK: chars
      .map(char => buildCharacterPromptBlock(char, { format: 'bullets', includeClothing: true }))
      .join('\n\n') || '(no character appearance available)',
    AVAILABLE_LANDMARKS_SECTION: buildAvailableLandmarksSection(inputData.availableLandmarks),
    BEATS: beatBlocks,
  });
}

/**
 * Build unified story generation prompt
 * Generates complete story with character arcs, plot structure, visual bible, and all pages
 * @param {Object} inputData - Story parameters
 * @param {number} sceneCount - Number of story pages to generate
 * @returns {string} Filled prompt template
 */
function buildUnifiedStoryPrompt(inputData, sceneCount = null) {
  const pageCount = sceneCount || inputData.pages || 15;
  const readingLevel = getReadingLevel(inputData.languageLevel);
  const mainCharacterIds = inputData.mainCharacters || [];
  const language = inputData.language || 'en';

  // Extract character info with strengths/flaws for character arcs
  const characterSummary = (inputData.characters || []).map(char => {
    const traits = getTraits(char);
    return {
      name: char.name,
      isMainCharacter: mainCharacterIds.includes(char.id),
      gender: char.gender,
      age: char.age,
      personality: char.personality,
      strengths: traits.strengths,
      flaws: traits.flaws,
      challenges: traits.challenges,
      specialDetails: traits.specialDetails
    };
  });

  // Extract character names for Visual Bible exclusion
  const characterNames = characterSummary.map(c => c.name).join(', ');

  // Separate main and primary character names for prompt
  const mainCharacterNames = characterSummary
    .filter(c => c.isMainCharacter)
    .map(c => c.name)
    .join(', ') || 'None';
  const primaryCharacterNames = characterSummary
    .filter(c => !c.isMainCharacter)
    .map(c => c.name)
    .join(', ') || 'None';

  // Build relationship descriptions
  let relationshipDescriptions = '';
  if (inputData.relationships) {
    const relationships = inputData.relationships;
    const relationshipTexts = inputData.relationshipTexts || {};
    const characters = inputData.characters || [];

    const relationshipLines = Object.entries(relationships)
      .filter(([key, type]) => type && type !== 'Not Known to')
      .map(([key, type]) => {
        const [char1Id, char2Id] = key.split('-').map(Number);
        const char1 = characters.find(c => c.id === char1Id);
        const char2 = characters.find(c => c.id === char2Id);
        if (!char1 || !char2) return null;
        const customText = relationshipTexts[key] || '';
        const baseRelationship = `${char1.name} is ${type} ${char2.name}`;
        return customText ? `${baseRelationship}. ${customText}` : baseRelationship;
      })
      .filter(Boolean);

    if (relationshipLines.length > 0) {
      relationshipDescriptions = `\n**Relationships:**\n${relationshipLines.map(r => `- ${r}`).join('\n')}`;
    }
  }

  // Determine story category and build category-specific guidelines
  const storyCategory = inputData.storyCategory || 'adventure';
  const storyTopic = inputData.storyTopic || '';
  const storyTheme = inputData.storyTheme || inputData.storyType || 'adventure';

  // Get teaching guide from external file if available
  const teachingGuide = getTeachingGuide(storyCategory, storyTopic);

  let categoryGuidelines = '';
  if (storyCategory === 'life-challenge') {
    categoryGuidelines = `This is a LIFE SKILLS story about "<user_input>${storyTopic}</user_input>".

**IMPORTANT GUIDELINES for Life Skills Stories:**
- The story should help children understand and cope with the topic: <user_input>${storyTopic}</user_input>
- Show the main character(s) facing this challenge naturally within the story
- Provide positive, age-appropriate messages about handling this situation
- Include practical tips or coping strategies woven into the narrative
- End with a hopeful, empowering message
- Avoid being preachy - let the lesson emerge naturally from the story
${storyTheme && storyTheme !== 'realistic' ? `- The story is wrapped in a ${storyTheme} adventure setting - integrate the life lesson into this theme creatively` : '- This is a realistic story set in everyday life situations'}

${teachingGuide ? `**SPECIFIC GUIDANCE for "<user_input>${storyTopic}</user_input>":**
${teachingGuide}` : ''}`;
  } else if (storyCategory === 'educational') {
    categoryGuidelines = `This is an EDUCATIONAL story teaching about "<user_input>${storyTopic}</user_input>".

**IMPORTANT GUIDELINES for Educational Stories:**
- Weave the educational content naturally into an engaging narrative
- Include accurate, age-appropriate information about the topic
- Use repetition and reinforcement to help children learn
- Make the learning fun and memorable through story elements
- Include moments where characters discover or apply what they're learning
${storyTheme && storyTheme !== 'realistic' ? `- The story is wrapped in a ${storyTheme} adventure setting - make learning part of the adventure` : '- Use everyday situations to explore the educational topic'}

${teachingGuide ? `**SPECIFIC TEACHING GUIDE for "<user_input>${storyTopic}</user_input>":**
${teachingGuide}` : `- The story should teach children about: <user_input>${storyTopic}</user_input>`}`;
  } else if (storyCategory === 'historical') {
    // Get historical event context from txt guide
    const historicalGuide = getTeachingGuide('historical', storyTopic);
    const historicalEvent = getEventById(storyTopic);
    // Get pre-fetched location photos (unified prompt)
    const historicalLocations = getHistoricalLocations(storyTopic);
    const historicalObjects = getHistoricalObjects(storyTopic);
    if (historicalGuide) {
      const eventName = historicalEvent?.name || storyTopic;
      const eventYear = historicalEvent?.year || '';

      // Build location references section if locations are available
      let locationsSection = '';
      if (historicalLocations?.length > 0) {
        locationsSection = `

**PRE-POPULATED LOCATIONS (canonical reference images for these landmarks — USE AS-IS):**
${historicalLocations.map(loc => `- [dbKey: ${loc.dbKey}] ${loc.name} (${loc.type}): ${loc.description || 'Historical landmark'}`).join('\n')}
RULES for these locations:
1. Use the EXACT name shown above when referring to a location in scene descriptions, the Visual Bible, and cover hints. Do not translate, abbreviate, or invent variants.
2. **Set the \`dbKey\` field on every Visual Bible location entry** to the slug shown in brackets above (e.g. \`"dbKey": "marktplatz-altdorf"\`). This is the authoritative lookup key for attaching the reference photo — the linker uses it before falling back to name matching. Locations with no matching pre-populated entry get \`"dbKey": null\`.
3. When you write the Visual Bible entry for one of these locations, COPY THE DESCRIPTION ABOVE VERBATIM into the description field. Do NOT rewrite it, do NOT add new visual details, do NOT invent your own version — the reference photo was painted to match this exact description.
4. Prefer these locations over inventing new ones. If a story scene needs one of these settings, reuse the canonical entry instead of creating a parallel location with a different name.
5. **Per-scene composition must match the description.** When a page's primary location is one of these entries, copy the description verbatim into that page's \`landmarkContext\` metadata field, AND keep the page's character \`depth\` / \`position\` / prose composition consistent with what the description spells out. If the description says the child is "in the right background, against the tree", that page's matching character is \`depth: background\`, on the right — do not place them at midground or center. Re-read the description before composing each scene that uses it.`;
        log.debug(`[UNIFIED] Including ${historicalLocations.length} pre-fetched location photos for ${storyTopic}`);
      }

      // Build objects (Visual Bible) section if period objects are available
      let objectsSection = '';
      if (historicalObjects?.length > 0) {
        objectsSection = `

**PRE-POPULATED OBJECTS (canonical reference images for these period objects — USE AS-IS):**
${historicalObjects.map(o => `- ${o.name} (${o.type}): ${o.description || 'Historical object'}`).join('\n')}
RULES for these objects:
1. Use the EXACT name shown above whenever you mention one of these objects (scene descriptions, the Visual Bible artifacts list, cover hints). The name is the lookup key for the reference photo.
2. When you write the Visual Bible entry for one of these objects, COPY THE DESCRIPTION ABOVE VERBATIM into the description field. Do NOT invent alternative shapes, parts, or details — the reference photo was painted to match this exact description and any divergence will produce a different-looking object on the page.
3. Do not create a parallel artifact entry with a different name for the same physical object.`;
        log.debug(`[UNIFIED] Including ${historicalObjects.length} pre-fetched object photos for ${storyTopic}`);
      }

      categoryGuidelines = `This is a HISTORICAL story about the real event: "${eventName}"${eventYear ? ` (${eventYear})` : ''}.

**CRITICAL: HISTORICAL ACCURACY REQUIRED**
This story MUST be historically accurate. Do NOT invent facts. Use ONLY the verified information provided below.

${historicalGuide}${locationsSection}${objectsSection}

**GUIDELINES:**
- The main character(s) should witness or participate in this historical event
- Include historically accurate details about the time period
- Characters MUST use \`costumed:\` clothing for period-appropriate attire (e.g., costumed:1920s, costumed:medieval). Do NOT use \`standard\` — modern clothes in a historical setting looks wrong.
- Use the suggested story angles or create a similar child-appropriate perspective
- Make the history come alive through the eyes of a child character
- Balance historical education with an engaging adventure narrative
- The story should help children understand what life was like during this event`;
    } else {
      // Fallback if event not found
      categoryGuidelines = `This is a HISTORICAL story about "<user_input>${storyTopic}</user_input>".

**IMPORTANT GUIDELINES for Historical Stories:**
- Create a story set during this historical event or period
- Include historically accurate details about the time
- Characters should wear period-appropriate clothing
- Make history accessible and engaging for children
- Balance education with entertainment`;
    }
  } else if (storyCategory === 'swiss-stories') {
    const cityId = storyTopic.replace(/-\d+$/, '');
    const cityData = getSwissStoryResearch(cityId);
    const cityMeta = getSwissCityById(cityId);

    if (cityData) {
      const ideaNum = parseInt(storyTopic.split('-').pop());
      const idea = cityData.ideas[ideaNum - 1];
      // Support both localized {en,de,fr} and plain string formats
      const ideaTitle = (idea?.title && typeof idea.title === 'object' ? idea.title.en : idea?.title) || storyTopic;
      const ideaDesc = idea?.description && typeof idea.description === 'object' ? idea.description.en : idea?.description;
      const cityName = cityMeta?.name?.en || cityId;

      categoryGuidelines = `This is a SWISS LOCAL STORY set in ${cityName}, a real Swiss city.

**STORY IDEA:** "${ideaTitle}"
${ideaDesc ? `**CONCEPT:** ${ideaDesc}` : ''}

**HISTORICAL & CULTURAL CONTEXT (verified research — use for accuracy):**
${cityData.research}

**GUIDELINES:**
- Set the story in this specific Swiss city with real local landmarks
- Use historically accurate details from the research above
- Include local cultural elements, traditions, and geography
- Characters should interact with real places described in the context
- Make the local history and culture come alive for children
- The story should feel authentic to this specific Swiss place`;
    } else {
      categoryGuidelines = `This is a SWISS LOCAL STORY. Create an engaging story set in a Swiss city with local landmarks and cultural elements.`;
    }
  } else if (storyCategory === 'custom') {
    const customText = inputData.customThemeText || '';
    categoryGuidelines = `This is a CUSTOM story. The user provided their own story concept:

<user_input>${customText}</user_input>

**IMPORTANT GUIDELINES for Custom Stories:**
- Follow the user's concept closely - this is their creative vision
- Build the story around the description provided above
- Maintain age-appropriate content while honoring the user's idea
- Create engaging characters and plot points that serve the user's concept`;
  } else {
    // Adventure category - get theme-specific guide
    const adventureGuide = getTeachingGuide('adventure', storyTheme);

    categoryGuidelines = `This is an ADVENTURE story with a "${storyTheme || 'adventure'}" theme.

**IMPORTANT GUIDELINES for Adventure Stories:**
- Create an exciting, engaging adventure appropriate for the age group
- Include elements typical of the ${storyTheme || 'adventure'} theme
- Balance action and excitement with character development
- Include challenges that the characters must overcome
- Historical and fantasy themes SHOULD use costumed clothing for authenticity
- Signature theme props keep their full theme form even in a modern real-world setting: a pirate story's ship is a real pirate ship, a knight story's castle a real castle — never a scaled-down everyday stand-in

${adventureGuide ? `**THEME-SPECIFIC GUIDANCE for "${storyTheme}":**
${adventureGuide}` : ''}`;
  }

  // Build characters JSON with relationships
  const charactersJson = JSON.stringify(characterSummary, null, 2) + relationshipDescriptions;

  // Build the canonical per-character physical block. Sonnet is told to weave
  // physical description into each scene's prose, so it needs the actual traits.
  // Without this block it hallucinates — e.g. giving a character a beard when
  // facialHair is 'clean-shaven', or dropping glasses entirely.
  // Include the character's stored clothing description. Sonnet uses this as
  // the STARTING POINT for clothingRequirements[char][category].description —
  // it can keep it as-is, add an accessory, or change a garment for the story,
  // but the avatar generator no longer concatenates a separate "signature"
  // line that could conflict (Noah: green hoodie + signature "blue hoodie" =
  // two contradictory tops in the same prompt). One field, one full outfit.
  const characterPhysicalBlock = (inputData.characters || [])
    .map(char => buildCharacterPromptBlock(char, { format: 'bullets', includeClothing: true }))
    .join('\n\n');

  // Build available landmarks section if landmarks were pre-discovered
  const availableLandmarksSection = buildAvailableLandmarksSection(inputData.availableLandmarks);
  if (inputData.availableLandmarks?.length > 0) {
    log.debug(`[PROMPT] Including ${inputData.availableLandmarks.length} pre-discovered landmarks in unified prompt`);
  }

  // Use template if available
  // Look up maxCharactersPerScene from image model config
  const imageModelKey = inputData.modelOverrides?.imageModel || MODEL_DEFAULTS.pageImage;
  const imageModelConfig = IMAGE_MODELS[imageModelKey];
  const maxCharsPerScene = imageModelConfig?.maxCharactersPerScene || 3;

  // Prompt-variant seam (roadmap §4 image-first). DEFAULT = the image-first
  // template (owner 2026-07-31: arc → scenes → text is the production order).
  // storyPromptVariant === 'textFirst' opts back into the legacy text-then-scene
  // template (kept for the harness A/B via rerun-text inputOverrides; also set
  // STORY_PROMPT_VARIANT=textFirst to flip the fleet without a deploy).
  const variant = inputData.storyPromptVariant || process.env.STORY_PROMPT_VARIANT || 'imageFirst';
  const useImageFirst = variant !== 'textFirst';
  if (useImageFirst && !PROMPT_TEMPLATES.storyUnifiedImageFirst) {
    log.warn('[PROMPT] image-first template not loaded — falling back to storyUnified (text-first)');
  }
  const unifiedTemplate = (useImageFirst && PROMPT_TEMPLATES.storyUnifiedImageFirst)
    ? PROMPT_TEMPLATES.storyUnifiedImageFirst
    : PROMPT_TEMPLATES.storyUnified;

  if (unifiedTemplate) {
    // ── ANALYSIS placeholder (split outline review seam) ──
    // Both templates carry {ANALYSIS_INSTRUCTIONS} in their ---ANALYSIS---
    // section. Single-call mode injects the full self-critique instructions
    // (variant-matched body, one source shared with the external reviewer);
    // split mode injects a stub telling the writer the review happens
    // externally — no FIXES REQUIRED, no patch blocks, bare ---STORY PAGES---
    // marker so every parser boundary stays where it is today.
    // Per-job override first (the rerun-text harness A/B seam:
    // inputOverrides: { splitOutlineReview: false }), then the global default.
    const splitReview = inputData.splitOutlineReview !== undefined
      ? !!inputData.splitOutlineReview
      : !!MODEL_DEFAULTS.splitOutlineReview;
    const analysisBody = useImageFirst
      ? PROMPT_TEMPLATES.outlineAnalysisImageFirst
      : PROMPT_TEMPLATES.outlineAnalysisTextFirst;
    let analysisBlock;
    if (splitReview) {
      analysisBlock = SPLIT_REVIEW_ANALYSIS_STUB;
    } else if (analysisBody) {
      analysisBlock = analysisBody;
    } else {
      // Analysis body failed to load — ship the stub rather than an empty
      // critique section (the model would otherwise invent its own format).
      log.error('[PROMPT] outline analysis instruction template missing — falling back to reviewed-externally stub');
      analysisBlock = SPLIT_REVIEW_ANALYSIS_STUB;
    }
    // Inject BEFORE fillTemplate so placeholders inside the analysis body
    // ({CHARACTER_NAMES}, {MAX_CHARACTERS_PER_SCENE}) get filled below.
    const templateWithAnalysis = unifiedTemplate.replace('{ANALYSIS_INSTRUCTIONS}', () => analysisBlock);

    let prompt = fillTemplate(templateWithAnalysis, {
      LANGUAGE_INSTRUCTION: getLanguageInstruction(language),
      PAGES: pageCount,
      LANGUAGE: getLanguageNameEnglish(language),
      LANGUAGE_NOTE: getLanguageNote(language),
      READING_LEVEL: readingLevel,
      STORY_CATEGORY: storyCategory,
      STORY_TYPE: storyCategory === 'custom' ? 'custom' : storyTheme,
      STORY_TOPIC: wrapUserInput(storyTopic || (storyCategory === 'custom' ? (inputData.customThemeText || 'None') : 'None')),
      STORY_DETAILS: wrapUserInput(inputData.storyDetails || 'None'),
      CHARACTERS: charactersJson,
      CHARACTER_PHYSICAL_BLOCK: characterPhysicalBlock,
      CHARACTER_NAMES: characterNames,
      MAIN_CHARACTER_NAMES: mainCharacterNames,
      PRIMARY_CHARACTER_NAMES: primaryCharacterNames,
      CATEGORY_GUIDELINES: categoryGuidelines,
      AVAILABLE_LANDMARKS_SECTION: availableLandmarksSection,
      MAX_CHARACTERS_PER_SCENE: maxCharsPerScene,
      // Reader age for the title pick the writer makes in its ---TITLE---
      // section (2026-08-27, replaced the separate title-judge call).
      AGE: readerAge(inputData)
    });
    // Hard gate for all text-overlay-only instructions. Layouts that render
    // text BELOW the image (square-below, advanced reading level) don't
    // need textPosition / textZoneDescription / forbidden-side / calm-zone
    // rules — keeping them in the prompt makes Sonnet emit the fields and
    // bake the calm-corner constraints into scene prose, polluting non-
    // overlay stories. story-unified.txt wraps every overlay-only block
    // in <!-- TEXT_OVERLAY_BEGIN --> … <!-- TEXT_OVERLAY_END -->. With
    // overlay ON we strip just the markers; with overlay OFF we strip
    // the markers AND their contents.
    const textInImage = inputData.layout?.textInImage === true;
    if (textInImage) {
      prompt = prompt.replace(/<!-- TEXT_OVERLAY_(BEGIN|END) -->\n?/g, '');
    } else {
      prompt = prompt.replace(/<!-- TEXT_OVERLAY_BEGIN -->[\s\S]*?<!-- TEXT_OVERLAY_END -->\n?/g, '');
    }
    log.debug(`[PROMPT] Unified story prompt length: ${prompt.length} chars (textInImage=${textInImage}, variant=${useImageFirst ? 'imageFirst' : 'default'})`);
    return prompt;
  }

  // Fallback to hardcoded prompt
  log.warn('[PROMPT] storyUnified template not loaded, using fallback');
  return `Create a complete children's story with ${pageCount} pages.
Language: ${getLanguageNameEnglish(language)}
Reading Level: ${readingLevel}
Characters: ${charactersJson}
Story Type: ${storyTheme}
Story Details: <user_input>${inputData.storyDetails || 'None'}</user_input>

Output: Title, clothing requirements, character arcs, plot structure, visual bible, cover scenes, and all ${pageCount} pages with text and scene hints.`;
}

/**
 * Build a lightweight story prompt for trial stories.
 * Much simpler than the full unified prompt — no critical analysis, no character arcs,
 * no plot structure planning. Just generates the story directly.
 */
function buildTrialStoryPrompt(inputData, sceneCount = null) {
  const pageCount = sceneCount || inputData.pages || 5;
  const language = inputData.language || 'en';

  const characterDesc = (inputData.characters || []).map(char => {
    const parts = [char.name];
    if (char.age) parts.push(`age ${char.age}`);
    if (char.gender) parts.push(char.gender);
    // Physical traits: Gemini extracts hair/eyes/skin from the uploaded photo
    // (trial.js stamps them on character.physical). Without surfacing them here
    // the scene hints carry zero visual anchors ("the main character stands at
    // the gate") and Grok has to guess or fall back on the photo ref. These
    // descriptors are ILLUSTRATION context only — story-trial.txt forbids them
    // in the reader-facing page text (owner: the parent doesn't need to be told
    // the hair colour of their own child).
    const p = char.physical || {};
    const physicalParts = [];
    if (p.hairColor)   physicalParts.push(`${p.hairColor} hair`);
    if (p.eyeColor)    physicalParts.push(`${p.eyeColor} eyes`);
    if (p.skinTone)    physicalParts.push(`${p.skinTone} skin`);
    if (physicalParts.length) parts.push(physicalParts.join(', '));
    if (p.detailedHairAnalysis) parts.push(`hair detail: ${p.detailedHairAnalysis}`);
    // Traits can be a flat array or structured { strengths, flaws, challenges, specialDetails }
    const t = char.traits;
    if (Array.isArray(t) && t.length) {
      parts.push(`traits: ${t.join(', ')}`);
    } else if (t && typeof t === 'object') {
      const traitParts = [];
      if (t.strengths?.length) traitParts.push(t.strengths.join(', '));
      if (t.flaws?.length) traitParts.push(`flaws: ${t.flaws.join(', ')}`);
      if (t.challenges?.length) traitParts.push(`challenges: ${t.challenges.join(', ')}`);
      if (t.specialDetails) traitParts.push(t.specialDetails);
      if (traitParts.length) parts.push(`traits: ${traitParts.join('; ')}`);
    }
    return parts.join(', ');
  }).join('\n');

  if (PROMPT_TEMPLATES.storyTrial) {
    // Look up costume from config
    const { getTrialCostume } = require('../config/trialCostumes');
    const mainChar = (inputData.characters || [])[0];
    const topic = inputData.storyTopic || inputData.storyTheme || '';
    const category = inputData.storyCategory || 'adventure';
    const gender = mainChar?.gender || '';

    const costume = getTrialCostume(topic, category, gender);

    // Build avatar selection section (only if costume available)
    let avatarSelection = '';
    if (costume) {
      // Bare `costumed` — the flat clothing enum (one costume per character
      // per story; the specific costume lives in clothingRequirements, not
      // in the enum value). `costumed:subtype` was legacy shape.
      avatarSelection = `# Avatar Selection
The main character has two avatar styles available:
- \`standard\` — everyday modern clothes
- \`costumed\` — ${costume.description}

**IMPORTANT**: The MAJORITY of scenes (at least 3 out of 5) MUST use \`costumed\` for the main character's clothing in scene hints. Use \`standard\` only for 1-2 scenes where it makes narrative sense (e.g., before a transformation, or a brief real-world moment).`;
    }

    // Build landmarks instruction for the visual bible.
    // For each landmark we surface ALL indexed photo variants (interior /
    // exterior / detail / etc) with their descriptions so Claude can pick
    // the variant whose framing matches each scene. Without this, Claude
    // writes plain [LOC###] and the renderer always falls back to variant 1
    // — e.g. Holzbrücke (Baden) has 2 interior shots (variants 4 & 5)
    // perfect for "on the bridge" scenes, but they never get chosen.
    let landmarksInstruction = '';
    if (inputData.availableLandmarks?.length > 0) {
      const top3 = inputData.availableLandmarks.slice(0, 3);
      const cityName = inputData.userLocation?.city || '';
      const landmarkBlock = top3.map(l => {
        let entry = `- ${l.name}`;
        const variants = l.photoVariants || [];
        if (variants.length >= 2) {
          const angles = variants.map(v => `    ${v.variantNumber}: ${v.description}`).join('\n');
          entry += `\n  PHOTO ANGLES (pick the variant whose description matches your scene framing):\n${angles}`;
        }
        return entry;
      }).join('\n');
      const hasVariants = top3.some(l => (l.photoVariants?.length || 0) >= 2);
      const variantHint = hasVariants
        ? `\nWhen a landmark has PHOTO ANGLES, reference it as \`[LOC###.N]\` in the scene hint's \`setting.location\` (e.g. \`"setting": {"location": "Wooden Bridge [LOC001.4]"}\` to pick the interior shot). Use interior angles for inside/on-the-landmark scenes, exterior angles for distant/establishing shots. Plain \`[LOC###]\` defaults to variant 1.`
        : '';
      landmarksInstruction = `# Location${cityName ? `: ${cityName}` : ''}
The story takes place in ${cityName || 'the child\'s hometown'}. Use real place names — do NOT invent fictional city names.
At least one scene MUST take place at one of these real local landmarks:
${landmarkBlock}
Include the chosen landmark(s) in the visual bible locations section with their real name and accurate visual description.
Reference the landmark by its LOC ID in the relevant scene hints.${variantHint}`;
    } else if (inputData.userLocation?.city) {
      landmarksInstruction = `# Location: ${inputData.userLocation.city}
The story takes place in ${inputData.userLocation.city}. Use real place names — do NOT invent fictional city names.`;
    }

    return fillTemplate(PROMPT_TEMPLATES.storyTrial, {
      LANGUAGE_INSTRUCTION: getLanguageInstruction(language),
      PAGES: pageCount,
      LANGUAGE: getLanguageNameEnglish(language),
      LANGUAGE_NOTE: getLanguageNote(language),
      CHARACTERS: characterDesc || 'A child',
      STORY_DETAILS: wrapUserInput(inputData.storyDetails || inputData.storyTheme || 'A fun adventure'),
      TODDLER_MODE: buildToddlerModeSection(inputData),
      AVATAR_SELECTION: avatarSelection,
      LANDMARKS: landmarksInstruction,
      MAIN_CHARACTER_NAME: mainChar?.name || 'the main character',
    });
  }

  // Fallback
  return `Create a ${pageCount}-page children's story in ${getLanguageNameEnglish(language)}.
Character: ${characterDesc}
Story: <user_input>${inputData.storyDetails || 'A fun adventure'}</user_input>
Output: Title, then each page with story text and a scene hint for illustration.`;
}

// ============================================================================
// LANDMARK PHOTO HELPERS
// ============================================================================


/**
 * Build the available landmarks section for the outline prompt
 * @param {Array} landmarks - Pre-discovered landmarks from userLandmarkCache
 * @returns {string} - Prompt section with available landmarks, or empty string if none
 */
/**
 * One VB location as prompt lines — SINGLE source for both Art Director
 * builders (all-pages + per-page). Real landmarks with any photo list their
 * dotted variant ids (vantage-labelled) so the AD can cite them in objects[];
 * without a listed id the photo never attaches.
 */
function buildVbLocationLines(loc) {
  const description = loc.extractedDescription || loc.description;
  const vantageTag = (v) => v.vantage ? `(${v.vantage}) ` : (v.variantNumber >= 4 ? '(interior) ' : '(exterior) ');
  if (loc.isRealLandmark && loc.photoVariants && loc.photoVariants.length > 1) {
    const variantStrs = loc.photoVariants.map(v =>
      `[${loc.id}.${v.variantNumber}] ${vantageTag(v)}${v.description || `Photo ${v.variantNumber}`}`);
    return `* **${loc.name}** [${loc.id}] (real landmark): ${description}\n`
      + `  Photo variants: ${variantStrs.join(', ')}\n`;
  }
  if (loc.isRealLandmark && (loc.photoVariants?.length === 1 || loc.referencePhotoUrl || loc.referencePhotoData)) {
    const v1 = loc.photoVariants?.[0];
    return `* **${loc.name}** [${loc.id}] (real landmark): ${description}\n`
      + `  Photo variants: [${loc.id}.1] ${v1 ? vantageTag(v1) : '(exterior) '}${v1?.description || 'reference photo'}\n`;
  }
  const locType = loc.isRealLandmark ? 'real landmark' : 'location';
  return `* **${loc.name}** [${loc.id}] (${locType}): ${description}\n`;
}

function buildAvailableLandmarksSection(landmarks) {
  if (!landmarks || landmarks.length === 0) {
    return '';
  }

  // Format with Wikipedia descriptions (what the landmark IS, not what photos look like)
  // "- Kurpark (Baden) [Park]: A historic spa park in the town center..."
  const landmarkList = landmarks
    .map(l => {
      let entry = `- ${l.name}`;
      if (l.type) entry += ` [${l.type}]`;
      // Use Wikipedia extract for outline (describes what landmark IS)
      // NOT photo description (describes what a photo looks like)
      const description = l.wikipediaExtract || l.wikipedia_extract;
      if (description) entry += `\n  DESCRIPTION: ${description}`;
      return entry;
    })
    .join('\n');

  const hasDescriptions = landmarks.some(l => l.wikipediaExtract || l.wikipedia_extract);

  return `**REAL LANDMARKS — pick two to four for the whole story, and only ones that already belong to the world the story is in. Never bend the plot to fit one in; a landmark carried as background scenery counts as used:**

${landmarkList}

When you use a landmark from the list (even if you rename it in your story):
- Set "isRealLandmark": true
- Set "landmarkQuery": copy-paste the EXACT name from the list above (WITHOUT the [type])
${hasDescriptions ? `- Use the DESCRIPTION above to understand what the landmark is and incorporate it authentically into your story
- The DESCRIPTION is reference for you, not wording for the page. Never carry an abbreviation, acronym or technical term from it into the story — name the thing the way a child would say it` : ''}

EXAMPLE - Using "Ruine Stein [Ruins]" as "The Enchanted Castle" in your story:
{
  "name": "The Enchanted Castle",
  "isRealLandmark": true,
  "landmarkQuery": "Ruine Stein",
  "description": "<write a scene description appropriate for your story>"
}

Your "name" can be creative, but "landmarkQuery" MUST match the original name exactly (without the [type] suffix)!
`;
}

// ============================================================================
// LOCATION VANTAGES (canvas-per-vantage pipeline)
// ============================================================================

/**
 * Build previous scenes context for scene description prompts
 * Used when regenerating images to provide context from earlier pages
 * @param {Array} sceneDescriptions - Array of scene description objects with pageNumber and description
 * @param {number} currentPage - The current page number being generated
 * @param {number} maxPrevious - Maximum number of previous scenes to include (default 2)
 * @returns {Array} Array of {pageNumber, summary} objects for previous scenes
 */
function buildPreviousScenesContext(sceneDescriptions, currentPage, maxPrevious = 2) {
  if (!sceneDescriptions || !Array.isArray(sceneDescriptions)) return [];

  return sceneDescriptions
    .filter(s => s.pageNumber < currentPage)
    .sort((a, b) => b.pageNumber - a.pageNumber)  // Most recent first
    .slice(0, maxPrevious)
    .map(s => ({
      pageNumber: s.pageNumber,
      summary: s.description?.substring(0, 200) || ''
    }));
}

// ============================================================================
// CLOTHING FORMAT CONVERSION
// ============================================================================


module.exports = {
  wrapUserInput,
  getPhysicalFromChar,
  stripAgeWords,
  getAgeMarkers,
  getGenderTerm,
  buildHairDescription,
  buildCharacterDescriptionsForBbox,
  buildSecondaryCharacterDescriptions,
  buildSecondaryExpectedCharacters,
  buildCastIdentityDescription,
  buildIdentityClothingText,
  buildIdentityLine,
  buildSecondaryExpectedForPage,
  buildTextZoneInstruction,
  buildEraGuard,
  buildLandmarkFidelityBlock,
  getAgeCategory,
  getAgeCategoryLabel,
  AGE_CATEGORY_ORDER,
  getAgeCategoryIndex,
  clampApparentAge,
  parseTeachingGuideFile,
  PROMPTS_DIR,
  EDUCATIONAL_GUIDES,
  LIFE_CHALLENGE_GUIDES,
  ADVENTURE_GUIDES,
  HISTORICAL_GUIDES,
  SWISS_SAGEN_GUIDES,
  getTeachingGuide,
  HISTORICAL_LOCATIONS_FILE,
  preloadHistoricalLocations,
  loadHistoricalLocationsDatabank,
  getHistoricalLocations,
  locationNameToDbKey,
  preloadHistoricalObjects,
  getHistoricalObjects,
  getAdventureGuide,
  getSceneComplexityGuide,
  ART_STYLES,
  WORLD_ART_STYLES,
  buildStyleWardrobeBlock,
  resolveArtStyle,
  resolveArtStyleForEmptyScene,
  resolveArtStyleForSheet,
  LANGUAGE_LEVELS,
  getReadingLevel,
  getTokensPerPage,
  NONE_WORDS,
  isNone,
  extractCharacterVisualProfile,
  buildLabeledPhysicalParts,
  buildCharacterPhysicalDescription,
  buildGroundingPrompt,
  estimateHeightFromAgeGender,
  buildCharacterDescriptionForExpansion,
  buildCharacterPromptBlock,
  buildRelativeHeightDescription,
  buildCharacterRestriction,
  buildCharacterReferenceList,
  buildReferenceCardColours,
  buildCoverPrompt,
  buildBasePrompt,
  buildRecurringElementsText,
  buildSceneExpansionAllPrompt,
  buildSceneExpansionPrompt,
  buildSceneDescriptionPrompt,
  NON_WORN_STRONG_RE,
  NON_WORN_WEAK_RE,
  BODY_ANCHORED_DRAPE_RE,
  textDeclaresNonWornPlacement,
  sceneDeclaresNonWornState,
  WORN_ATTACHMENT_CLAUSE_RE,
  stripWornStateFromDescription,
  buildImagePrompt,
  sanitizeVbIdsInPrompt,
  buildExactPosesBlock,
  SPLIT_REVIEW_ANALYSIS_STUB,
  sliceAnalysisAspect,
  stripReviewAspectMarkers,
  buildOutlineReviewPrompt,
  buildTextRefinePrompt,
  parseRefinedText,
  buildStoryContextFields,
  buildBeatsPrompt,
  buildBeatsReviewPrompt,
  buildArcReviewPrompt,
  buildArcAuditPrompt,
  buildChildCriticPrompt,
  youngestMainAge,
  buildBeatsAuditPrompt,
  buildTextAuditPrompt,
  buildTextProofreadPrompt,
  countFaults,
  faultsByCategory,
  buildStoryShapeSection,
  pickMainCharacters,
  resolveAgeMode,
  buildToddlerModeSection,
  parseArcReview,
  buildClothingReviewPrompt,
  parseClothingReview,
  parseBeats,
  buildSceneReviewPrompt,
  buildDoNotWriteSection,
  buildStoryTextFromBeatsPrompt,
  buildTitleRule,
  buildStoryBibleFromBeatsPrompt,
  buildUnifiedStoryPrompt,
  buildTrialStoryPrompt,
  buildAvailableLandmarksSection,
  buildPreviousScenesContext
};

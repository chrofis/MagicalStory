/**
 * COVER BEATS (owner, 2026-09-24): "Do it the same as a page. The AD makes full
 * briefs of the image. No code telling the AD what is in the code. Basically
 * what is in the code should be the beats for the cover pages, and the AD
 * treats it like any other page."
 *
 * A full-story cover is a PAGE the all-pages Art Director briefs, under the
 * page number `coverKeys.COVER_PAGE_NUMBERS` gives it (-1 / -2 / -3). What code
 * knows about a cover — its purpose, its cast, costumes, the landmark rule, the
 * element budget, gaze and the copy space the book's text needs — is written
 * into that page's BEAT (its plan line), and the Art Director writes the brief
 * exactly as for any page. There is no cover section in the Art Director
 * template and no cover scene built in code.
 *
 * The trial is NOT on this path: its writer streams its own cover JSON and the
 * trial cover builder renders it first, for speed (owner, 2026-09-24).
 *
 * Plan-line shape (the same four parts every page beat has):
 *   shot — who is in frame — the instant — what is true after
 */

const { COVER_PAGE_NUMBERS, COVER_TEXT_POSITION } = require('./coverKeys');
const { MAX_COVER_CHARACTERS } = require('./coverCastRoster');
const { VB_ELEMENT_BUDGET } = require('./vbElementBudget');

/** The instant and the copy space of each cover, in beat words. */
const COVER_BEAT_TEXT = Object.freeze({
  frontCover: {
    label: 'BOOK FRONT COVER, not a story moment',
    instant: 'the cast stand together in a bright, welcoming portrait, every figure whole in frame',
    space: 'the top third of the picture is open sky or background, clear of every figure, prop and effect, for the book title (textPosition "top-full")',
    after: 'the reader sees the book\'s title picture',
  },
  initialPage: {
    label: 'BOOK OPENING PAGE (the dedication page), not a story moment',
    instant: 'the cast share an inviting, warm opening moment that draws the reader in, every figure whole in frame',
    space: 'the bottom fifth of the picture is calm ground, clear of every figure, face and prop, for the dedication (textPosition "bottom-full")',
    after: 'the book is opened',
  },
  backCover: {
    label: 'BOOK BACK COVER, not a story moment',
    instant: 'the cast are happy and relaxed after the adventure, every figure whole in frame',
    space: 'the bottom tenth of the picture is calm ground, clear of every figure, face and prop (textPosition "bottom-full")',
    after: 'the book is closed',
  },
});

/** The story's main characters, in the order the story lists its cast. */
function mainCharactersOf(inputData = {}) {
  const all = Array.isArray(inputData.characters) ? inputData.characters : [];
  const ids = Array.isArray(inputData.mainCharacters) ? inputData.mainCharacters : [];
  const flagged = all.filter(c => c && c.isMainCharacter === true);
  if (flagged.length > 0) return flagged;
  return all.filter(c => c && ids.includes(c.id));
}

/**
 * The cast of each cover — the rule the Art Director's cover section carried
 * until 2026-09-24 (the former `buildCoverCastLines`), now decided in code:
 * the front cover shows only the main characters; the opening page and the
 * back cover show the main characters plus the other characters, in the order
 * the story lists them, up to MAX_COVER_CHARACTERS (owner, 2026-09-15:
 * "max 5"). With no main character the whole cast stands in for them.
 *
 * @returns {Object<string, string[]>} coverKey → names
 */
function coverCasts(inputData = {}) {
  const all = (Array.isArray(inputData.characters) ? inputData.characters : []).filter(c => c && c.name);
  let mains = mainCharactersOf(inputData);
  if (mains.length === 0) mains = all;
  const mainNames = new Set(mains.map(c => c.name));
  const others = all.filter(c => !mainNames.has(c.name));
  const mainCapped = mains.slice(0, MAX_COVER_CHARACTERS).map(c => c.name);
  const group = [...mainCapped, ...others.map(c => c.name)].slice(0, MAX_COVER_CHARACTERS);
  return { frontCover: mainCapped, initialPage: group, backCover: group };
}

/** True when any cast member's wardrobe contract uses a costumed outfit. */
function anyCostumed(names, clothingRequirements) {
  if (!clothingRequirements || typeof clothingRequirements !== 'object') return false;
  return names.some((n) => {
    const req = clothingRequirements[n];
    return !!(req && req.costumed && req.costumed.used);
  });
}

/**
 * The cover beats for a full story, in page shape: `{pageNumber, planLine,
 * coverKey}`. Only the covers `coverTypes` asks for.
 *
 * @param {Object} inputData - the job's inputData (characters, mainCharacters)
 * @param {Object} [opts]
 * @param {Array<string>} opts.coverTypes - cover keys to brief (frontCover / initialPage / backCover)
 * @param {Object} [opts.clothingRequirements] - the wardrobe contract (step 3)
 * @param {Array<string>|null} [opts.centralFigure] - the arc's STORY LOGIC "Central
 *   figure:" names (beatsPipeline `arcCentralFigure`), null for "none"
 */
function buildCoverBeats(inputData = {}, { coverTypes = ['frontCover', 'initialPage', 'backCover'], clothingRequirements = null, centralFigure = null } = {}) {
  const casts = coverCasts(inputData);
  // THE FRONT COVER NAMES THE STORY'S CENTRAL FIGURE (2026-09-25). The beat used
  // to say "a creature the story centres on appears" — and the Art Director is
  // bound to stage exactly the cast its plan line NAMES (rule 3; a tracked
  // animal's entry claims only pages whose plan line names it), so it left the
  // unnamed creature out (staging job_1790277448294_5herh01j7: the front cover
  // held the four children and no dragon). The figure comes from the arc's
  // structured "Central figure:" line; where it changes name (an egg that
  // hatches into a named creature) the cover shows the last one, the state the
  // story ends in. "none" (null) → the cast alone.
  const centralNames = (Array.isArray(centralFigure) ? centralFigure : []).map(n => String(n || '').trim()).filter(Boolean);
  const central = centralNames.length ? centralNames[centralNames.length - 1] : null;
  const beats = [];
  for (const coverKey of ['frontCover', 'initialPage', 'backCover']) {
    if (!coverTypes.includes(coverKey)) continue;
    const t = COVER_BEAT_TEXT[coverKey];
    const cast = casts[coverKey];
    if (!cast.length) {
      throw new Error(`coverBeats: ${coverKey} has no cast — the story has no characters`);
    }
    const inFrame = (coverKey === 'frontCover' && central && !cast.includes(central)) ? [...cast, central] : cast;
    const facts = [
      t.label,
      t.instant,
      'at the story\'s key place: a real landmark from the Visual Bible (`isRealLandmark: true`) that the pages use; with no real landmark in the bible, the most story-defining invented place; a place the cast stand in on solid ground, never under water or in the air',
      COVER_OWN_PLACE,
      'every figure looks at the viewer (`looksAt: "viewer"`)',
      anyCostumed(cast, clothingRequirements) ? 'every figure wears their costumed outfit' : null,
      `any animal, artifact or vehicle from the Visual Bible the picture calls for, at most ${VB_ELEMENT_BUDGET}`,
      t.space,
    ].filter(Boolean).join('; ');
    beats.push({
      pageNumber: COVER_PAGE_NUMBERS[coverKey],
      coverKey,
      planLine: `wide — ${inFrame.join(', ')} — ${facts} — ${t.after}`,
    });
  }
  return beats;
}

/**
 * EACH COVER ITS OWN PLACE (2026-09-25). "A different place from the other
 * covers" left the Art Director free to read one location seen from one spot as
 * "the key place" three times: all three covers of staging
 * job_1790277448294_5herh01j7 cited LOC001.2. The rule now names the unit — a
 * location id, else a vantage id — and `sceneBriefCheck.checkCoverLocations`
 * holds the briefs to it before the scene review.
 */
const COVER_OWN_PLACE = 'its own place: a Visual Bible location no other cover cites while the bible holds one no cover uses yet, otherwise a vantage (`LOC###.N`) of it no other cover cites';

/** True for a cover page number (-1 / -2 / -3). */
function isCoverPage(pageNumber) {
  return Object.values(COVER_PAGE_NUMBERS).includes(Number(pageNumber));
}

/** The cover key of a cover page number, or null. */
function coverKeyOfPage(pageNumber) {
  const n = Number(pageNumber);
  return Object.keys(COVER_PAGE_NUMBERS).find(k => COVER_PAGE_NUMBERS[k] === n) || null;
}

/**
 * WHICH PATH A STORED COVER ITERATES, REGENERATES AND REPAIRS THROUGH
 * (owner, 2026-09-24 — plan Q1 (b) and Q7 (a)).
 *   'trial' — a trial story: the trial-only cover builder and `iterateCover`.
 *   'page'  — a full-story cover the Art Director briefed as a page
 *             (`briefedAsPage: true`, written by storyJobPipeline): the page
 *             path, `iteratePageCore`, exactly like a story page.
 * Anything else is a full-story cover made before covers became pages. It has
 * no brief to rewrite, and it is refused loudly — there is no second cover
 * path to fall back on.
 */
function coverIteratePath(storyData, coverKey) {
  if (storyData && storyData.trialMode === true) return 'trial';
  const rec = storyData && storyData.coverImages ? storyData.coverImages[coverKey] : null;
  if (rec && rec.briefedAsPage === true) return 'page';
  throw new Error(`${coverKey}: this story's cover has no Art Director brief — it was made before full-story covers became pages (2026-09-24), so it cannot be iterated, regenerated or repaired`);
}

module.exports = {
  COVER_OWN_PLACE,
  coverIteratePath,
  buildCoverBeats,
  coverCasts,
  COVER_TEXT_POSITION,
  isCoverPage,
  coverKeyOfPage,
};

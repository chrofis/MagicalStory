/**
 * JEV PICKS THE CHALLENGES AND LANDMARKS THAT FIT (owner, 2026-09-27: "We
 * inject ideas from the 200+ list, as well as landmarks. Now we just select
 * randomly which ones. Could we ask Jev to select the ones that fit the story?").
 *
 * Jev answers one yes/no (`noul`) per item over a text state; code ranks and
 * draws. The question wording, the states and the draw sizes are the measured
 * ones (scripts/analysis/eval-jev-selection.js imports them from HERE — one
 * copy):
 *
 *   challenges    CB2 per eligible catalogue entry, setup + premise → the arc
 *                 is offered 12 drawn at random from the top 20
 *   story places  LB2 per landmark, setup + premise → full story: the list in
 *                 Jev order; trial story: 3 at random from the top 5. A place
 *                 the premise names stays pinned first either way.
 *   idea places   LB1 per landmark, setup only (no premise exists yet) → the
 *                 wizard idea gets 2, the trial idea 3, at random from the top
 *                 5. Ranked OFF the idea request (a prepare call when the
 *                 theme/topic is picked, cached per town + story kind + age
 *                 bands); an idea request whose ranking is not ready keeps
 *                 today's order and logs it — the owner's latency rule, never
 *                 a wait.
 *
 * OUTAGES: the story steps run inside the Jev layer's one switch
 * (jevDecisions.jevActive / jevFallBack, owner exception to NO FALLBACKS,
 * docs/decisions.md 2026-09-27 "Jev outage"): on the backup the challenge draw
 * is today's random 25 and the landmark list keeps today's order.
 *
 * see DECISIONS: docs/decisions.md 2026-09-27 "Jev selection built"
 */

const JD = require('./jevDecisions');
const { JevDecisionError } = JD;
const { log } = require('../utils/logger');

// ───────────────────────── the questions and states (measured) ─────────────────────────

const chLabel = c => `${c.text} (tests: ${c.tests})`;
const lmLabel = l => `${l.name}${l.type ? ` (${l.type})` : ''}${l.desc ? `: ${l.desc.slice(0, 160)}` : ''}`;
const Q = {
  CB: c => `A trial or obstacle like this fits this book: it can happen naturally in its world and to its cast, and it serves the kind of story it is. The trial: ${chLabel(c)}`,
  LB: l => `This real place fits this book: a story of this kind, with this cast, would naturally happen at or around it. The place: ${lmLabel(l)}`,
};

function castLine(it) {
  const ages = it.cast.map(c => Number(c.age)).filter(Number.isFinite);
  const kids = ages.filter(a => a < 16), adults = ages.filter(a => a >= 16);
  return [kids.length ? `children aged ${kids.join(', ')}` : '', adults.length ? `${adults.length} grown-up${adults.length > 1 ? 's' : ''} (aged ${adults.join(', ')})` : ''].filter(Boolean).join(' and ');
}

/** What the idea stage knows: who, what kind of story, where. No premise. */
function setupState(it) {
  return [
    '# A CHILDREN\'S PICTURE BOOK, BEFORE ITS STORY IS WRITTEN',
    `Cast: ${castLine(it)}.`,
    `Kind of story: ${[it.category, it.theme && `theme "${it.theme}"`, it.topic && `topic "${it.topic}"`].filter(Boolean).join(', ')}.`,
    it.city ? `Home town: ${it.city}.` : 'No home town given.',
  ].join('\n');
}

/** What the story stage knows: the setup plus the commissioned premise. */
function premiseState(it) {
  return `${setupState(it).replace('BEFORE ITS STORY IS WRITTEN', 'AND ITS COMMISSIONED IDEA')}\n\n# THE COMMISSIONED IDEA\n${it.premise || '(none — the family wrote no idea)'}`;
}

/** The setup a state is built from, read off a story's inputData (or an idea request's body). */
function selectionSetup(inputData = {}) {
  return {
    cast: (inputData.characters || []).map(c => ({ age: c.age, gender: c.gender })),
    category: inputData.storyCategory || null,
    theme: inputData.storyTheme || null,
    topic: inputData.storyTopic || null,
    city: inputData.userLocation?.city || null,
    premise: String(inputData.storyDetails || '').trim(),
  };
}

/** A served landmark as the questions read it. */
function landmarkItem(l) {
  return { name: l.name, type: l.type || null, desc: String(l.wikipediaExtract || l.photoDescription || '').replace(/\s+/g, ' ').slice(0, 220) };
}

// ───────────────────────── scoring and drawing ─────────────────────────

/** One Jev call, one noul per item. Returns P(yes) per question id; throws JevDecisionError. */
async function scoreNouls(key, state, questions, { callImpl, usageLabel }) {
  const stats = JD.newStats();
  const ans = await JD.runJevRequests([{ key, state, questions }], { callImpl, usageLabel, stats });
  const a = ans.get(key);
  const out = new Map();
  for (const id of Object.keys(questions)) {
    let p;
    try { p = JD.meanNoul(a, id); } catch (e) { throw new JevDecisionError(`Jev "${key}" answer ${id}: ${e.message}`); }
    if (!Number.isFinite(p)) throw new JevDecisionError(`Jev "${key}" answer ${id} is not a probability`);
    out.set(id, p);
  }
  return { scores: out, stats: JD.summarise(stats) };
}

/** CB2 over the pool entries → Map catalogue id → P(fits). */
async function scoreChallenges(setup, entries, { callImpl } = {}) {
  const questions = Object.fromEntries(entries.map(e => [`c${e.id}`, { type: 'noul', instructions: Q.CB(e) }]));
  const { scores, stats } = await scoreNouls('challenges', premiseState(setup), questions, { callImpl, usageLabel: 'jev_selection_challenges' });
  return { scores: new Map(entries.map(e => [e.id, scores.get(`c${e.id}`)])), stats };
}

/** LB1 / LB2 over a landmark list → P(fits) per index. */
async function scoreLandmarks(state, landmarks, { callImpl, usageLabel = 'jev_selection_landmarks' } = {}) {
  const questions = Object.fromEntries(landmarks.map((l, i) => [`l${i}`, { type: 'noul', instructions: Q.LB(landmarkItem(l)) }]));
  const { scores, stats } = await scoreNouls('landmarks', state, questions, { callImpl, usageLabel });
  return { scores: landmarks.map((_, i) => scores.get(`l${i}`)), stats };
}

/** Stable descending rank of `items` by `score(item, index)`. */
function rankBy(items, score) {
  return items.map((x, i) => ({ x, i, s: score(x, i) })).sort((a, b) => (b.s - a.s) || (a.i - b.i)).map(o => o.x);
}

/** `k` items at random from the first `top` of `ranked`, returned in rank order. Pure given `rng`. */
function drawFromTop(ranked, k, top, rng = Math.random) {
  const window = ranked.slice(0, top);
  const idx = window.map((_, i) => i);
  // Partial Fisher-Yates: k distinct positions, whatever rng returns.
  const n = Math.min(k, idx.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.min(idx.length - i - 1, Math.floor(rng() * (idx.length - i)));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const chosen = new Set(idx.slice(0, n));
  return window.filter((_, i) => chosen.has(i));
}

const r3 = x => +Number(x).toFixed(3);

// ───────────────────────── CHALLENGES for the arc ─────────────────────────

/**
 * The arc is offered JEV_CHALLENGE_COUNT drawn at random from Jev's
 * JEV_CHALLENGE_TOP best (3× oversupply of the ~4 the arc takes). The
 * randomness of the 2026-08-29 draw survives inside the top 20; the bad fits
 * it offered do not (58% bad → 13% on the eval's worst-case first book).
 */
const JEV_CHALLENGE_COUNT = 12;
const JEV_CHALLENGE_TOP = 20;

/**
 * The challenge draw of a beats story. Jev live → CB2 ranks the eligible pool
 * and 12 are drawn from the top 20; Jev on the backup (the story's switch was
 * already thrown, or this call fails after the outage wait) → today's random
 * 25, and the switch is thrown here with step 'challenges'.
 *
 * @returns {Promise<{section:string, ids:number[], offeredStories:number, effectiveStories:number, selection:Object}>}
 */
async function selectChallengeDraw({ inputData, excludeIds = [], jevReport, gl = null, callImpl, rng = Math.random }) {
  const PB = require('./promptBuilders');
  const today = (reason) => {
    const d = PB.drawChallengeIdeas(inputData, { excludeIds });
    return { ...d, selection: d.ids.length ? { method: 'random', reason, picked: d.ids } : null };
  };
  if (!JD.jevActive(jevReport)) return today(`Jev backup from step "${jevReport.fallback.step}"`);
  let pool;
  try {
    pool = PB.challengePool(inputData, { need: JEV_CHALLENGE_TOP, excludeIds });
  } catch (err) {
    log.warn(`[PROMPT] challenge catalogue unavailable: ${err.message}`);
    return { section: '', ids: [], offeredStories: 0, effectiveStories: 0, selection: null };
  }
  if (!pool.entries.length) return { section: '', ids: [], offeredStories: pool.offeredStories, effectiveStories: pool.effectiveStories, selection: null };
  let scored;
  try {
    scored = await scoreChallenges(selectionSetup(inputData), pool.entries, { callImpl });
  } catch (err) {
    if (!(err instanceof JevDecisionError)) throw err;
    JD.jevFallBack(jevReport, 'challenges', err, gl);
    return today(`Jev failed at step "challenges"`);
  }
  const ranked = rankBy(pool.entries, e => scored.scores.get(e.id));
  const picked = drawFromTop(ranked, JEV_CHALLENGE_COUNT, JEV_CHALLENGE_TOP, rng);
  const draw = { section: PB.challengeSection(picked), ids: picked.map(e => e.id), top: ranked.slice(0, JEV_CHALLENGE_TOP).map(e => e.id) };
  const selection = {
    method: 'jev', question: 'CB2', count: JEV_CHALLENGE_COUNT, top: draw.top, picked: draw.ids, pool: pool.entries.length,
    scores: Object.fromEntries(pool.entries.map(e => [e.id, r3(scored.scores.get(e.id))])), stats: scored.stats,
  };
  log.info(`🎯 [JEV/challenges] ranked ${pool.entries.length} eligible, offered ${draw.ids.length} of the top ${draw.top.length}: ${draw.ids.map(id => `C${id}`).join(' ')}`);
  if (gl) gl.info('jev_challenge_selection', `Jev ranked ${pool.entries.length} catalogue challenge(s); ${draw.ids.length} drawn at random from the top ${draw.top.length}`, null, { top: draw.top, picked: draw.ids });
  return { section: draw.section, ids: draw.ids, offeredStories: pool.offeredStories, effectiveStories: pool.effectiveStories, selection };
}

// ───────────────────────── LANDMARKS in the story ─────────────────────────

/** How many landmarks the trial story is given (promptBuilders.trialFillValues reads the first 3). */
const TRIAL_STORY_LANDMARKS = 3;
/** The Jev window those are drawn from, story and idea alike. */
const LANDMARK_TOP = 5;
/** The town list the ideas and the story share: the same resolver, the same limit. */
const STORY_LANDMARK_LIMIT = 20;

/**
 * Order the story's landmark list by LB2 on the commissioned idea, IN PLACE on
 * inputData.availableLandmarks, once per job (`inputData.landmarkSelection`
 * records it and is stored on the story).
 *
 *   mode 'full'   every writer prompt (arc, planner, Art Director) reads the
 *                 list in Jev order, the premise-named place(s) first
 *   mode 'trial'  the first 3 (what the trial writer reads) are the pinned
 *                 place(s) then a random draw from the top 5; the rest follow
 *                 in Jev order. `probe: true` runs the story-level health check
 *                 first (the trial has no other Jev step).
 *
 * On the backup the list keeps the resolver's order (today's shuffle + pin).
 */
async function selectStoryLandmarks(inputData, { jevReport, gl = null, mode = 'full', probe = false, callImpl, rng = Math.random } = {}) {
  if (inputData.landmarkSelection) return inputData.landmarkSelection;
  const list = Array.isArray(inputData.availableLandmarks) ? inputData.availableLandmarks : [];
  const record = (rec) => { inputData.landmarkSelection = { mode, ...rec, order: (inputData.availableLandmarks || []).map(l => l.name) }; return inputData.landmarkSelection; };
  if (!list.length) return record({ method: 'none', reason: 'no landmarks' });
  if (mode === 'trial' && inputData.ideaKind === 'fantasy') return record({ method: 'none', reason: 'make-believe idea: no landmark mandate' });
  if (probe && JD.jevActive(jevReport)) {
    const p = await JD.probeJev({ callImpl });
    jevReport.probe = p;
    if (p.ok) log.info(`🩺 [JEV] probe ok (${p.ms} ms) — landmark selection by Jev`);
    else JD.jevFallBack(jevReport, 'start', new Error(`pre-start probe failed: ${p.error}`), gl);
  }
  if (!JD.jevActive(jevReport)) return record({ method: 'today', reason: `Jev backup from step "${jevReport.fallback.step}"` });
  let scored;
  try {
    scored = await scoreLandmarks(premiseState(selectionSetup(inputData)), list, { callImpl, usageLabel: 'jev_selection_story_landmarks' });
  } catch (err) {
    if (!(err instanceof JevDecisionError)) throw err;
    JD.jevFallBack(jevReport, 'landmarks', err, gl);
    return record({ method: 'today', reason: 'Jev failed at step "landmarks"' });
  }
  const p = new Map(list.map((l, i) => [l, scored.scores[i]]));
  const pinned = list.filter(l => l.premisePinned);
  const ranked = rankBy(list.filter(l => !l.premisePinned), l => p.get(l));
  let ordered;
  let picked = null;
  if (mode === 'trial') {
    const drawn = drawFromTop(ranked, Math.max(0, TRIAL_STORY_LANDMARKS - pinned.length), LANDMARK_TOP, rng);
    ordered = [...pinned, ...drawn, ...ranked.filter(l => !drawn.includes(l))];
    picked = ordered.slice(0, TRIAL_STORY_LANDMARKS).map(l => l.name);
  } else {
    ordered = [...pinned, ...ranked];
  }
  inputData.availableLandmarks = ordered;
  log.info(`📍 [JEV/landmarks] ${mode}: ${ordered.slice(0, 5).map(l => `${l.name} ${r3(p.get(l))}${l.premisePinned ? ' (pinned)' : ''}`).join(', ')}${picked ? ` → story gets ${picked.join(', ')}` : ''}`);
  if (gl) gl.info('jev_landmark_selection', `Jev ranked ${list.length} landmark(s) on the commissioned idea (${mode})`, null, { order: ordered.map(l => l.name), picked });
  return record({
    method: 'jev', question: 'LB2', picked,
    scores: list.map(l => ({ name: l.name, p: r3(p.get(l)), pinned: !!l.premisePinned })), stats: scored.stats,
  });
}

// ───────────────────────── LANDMARKS for the idea cards ─────────────────────────

/** How many places each idea prompt names. */
const IDEA_LANDMARKS = { wizard: 2, trial: 3 };
const IDEA_RANK_TTL_MS = 24 * 60 * 60 * 1000;
const IDEA_RANK_MAX = 2000;
/** key → { status: 'pending'|'ready', startedAt, readyAt?, scores?: Map(landmark id → p) } */
const ideaRankings = new Map();

/**
 * The age bands a cache key carries: the catalogue's age thresholds
 * (challengeCatalogueBands: ≤5, ≤8, older) plus grown-ups, as a set. Two casts
 * in the same bands read the same list of places the same way.
 */
function ideaAgeBands(cast) {
  const bands = new Set(cast.map(c => Number(c.age)).filter(Number.isFinite)
    .map(a => (a >= 16 ? 'adult' : a <= 5 ? '0-5' : a <= 8 ? '6-8' : '9-15')));
  return [...bands].sort().join('+') || 'unknown';
}

function ideaRankKey(setup, language) {
  return [setup.city, language, setup.category, setup.theme, setup.topic, ideaAgeBands(setup.cast)]
    .map(x => String(x || '').trim().toLowerCase()).join('|');
}

const landmarkId = l => (l.landmarkIndexId != null ? `id:${l.landmarkIndexId}` : `name:${l.name}`);

function freshEntry(key) {
  const e = ideaRankings.get(key);
  if (!e) return null;
  if (Date.now() - e.startedAt > IDEA_RANK_TTL_MS && e.status === 'ready') { ideaRankings.delete(key); return null; }
  return e;
}

/**
 * Start (or reuse) the LB1 ranking of a town's list for one setup. Never
 * awaited on an idea request. A failure (after the Jev outage wait) is logged
 * at error level and forgotten, so the next prepare starts again.
 *
 * @param {{setup:Object, language:string, landmarks:Array, callImpl?:Function}} args
 * @returns {{key:string, entry:Object}}
 */
function startIdeaLandmarkRanking({ setup, language, landmarks, callImpl }) {
  const key = ideaRankKey(setup, language);
  const existing = freshEntry(key);
  const covers = e => e.status === 'pending' || landmarks.every(l => e.scores.has(landmarkId(l)));
  if (existing && covers(existing)) return { key, entry: existing };
  const entry = { status: 'pending', startedAt: Date.now() };
  ideaRankings.set(key, entry);
  if (ideaRankings.size > IDEA_RANK_MAX) ideaRankings.delete(ideaRankings.keys().next().value);
  entry.promise = scoreLandmarks(setupState(setup), landmarks, { callImpl, usageLabel: 'jev_selection_idea_landmarks' })
    .then(({ scores, stats }) => {
      entry.scores = new Map(landmarks.map((l, i) => [landmarkId(l), scores[i]]));
      entry.status = 'ready';
      entry.readyAt = Date.now();
      log.info(`📍 [JEV/idea-landmarks] ranked ${landmarks.length} for "${key}" in ${entry.readyAt - entry.startedAt} ms ($${stats.costUsd})`);
    })
    .catch(err => {
      if (ideaRankings.get(key) === entry) ideaRankings.delete(key);
      log.error(`🚨 [JEV/idea-landmarks] ranking for "${key}" failed — idea requests keep today's order: ${String(err.message || err).slice(0, 300)}`);
    });
  return { key, entry };
}

/**
 * The places an idea prompt names. Ranking ready → `n` at random from Jev's
 * top 5. Not ready (still running, never prepared, or the list changed) →
 * today's order for THIS request, logged, and the ranking is started for the
 * next one: the owner's latency rule (docs/decisions.md 2026-09-27 "Jev
 * selection built"), never a wait.
 *
 * @returns {{landmarks: Array, source: 'jev'|'pending'|'absent'|'none', key: string}}
 */
function pickIdeaLandmarks({ setup, language, landmarks, n, rng = Math.random, callImpl }) {
  const key = ideaRankKey(setup, language);
  if (!landmarks || !landmarks.length) return { landmarks: [], source: 'none', key };
  const e = freshEntry(key);
  if (e && e.status === 'ready' && landmarks.every(l => e.scores.has(landmarkId(l)))) {
    const ranked = rankBy(landmarks, l => e.scores.get(landmarkId(l)));
    return { landmarks: drawFromTop(ranked, n, LANDMARK_TOP, rng), source: 'jev', key };
  }
  const source = e && e.status === 'pending' ? 'pending' : 'absent';
  startIdeaLandmarkRanking({ setup, language, landmarks, callImpl });
  log.warn(`⏱️ [JEV/idea-landmarks] ranking ${source} for "${key}" — this idea request keeps today's order (owner latency rule)`);
  return { landmarks: landmarks.slice(0, n), source, key };
}

/** Test Lab only: start the ranking and wait for it, then pick (the Lab is not on a latency path). */
async function awaitIdeaLandmarks(args) {
  const { entry } = startIdeaLandmarkRanking(args);
  await entry.promise;
  return pickIdeaLandmarks(args);
}

/**
 * The trial idea's town list: the SAME resolver call and limit the trial story
 * makes (storyJobPipeline), so an idea never names a place the story's list
 * does not hold. It was getIndexedLandmarks(loc, 3): below the resolver's own
 * five-row locality floor, so it always widened to the municipality and could
 * name a lake or a river the story never saw (tasks/bugs.json
 * trial-idea-landmarks-outside-story-list).
 */
async function resolveTrialIdeaLandmarks(location, language) {
  if (!location?.city) return [];
  const { resolveAvailableLandmarks } = require('./landmarkPhotos');
  return resolveAvailableLandmarks(location, { limit: STORY_LANDMARK_LIMIT, discoverOnMiss: false, language, placesOnly: true });
}

/**
 * The trial idea's landmark mandate, for the /try route and its Lab mirror
 * alike: the story's list, Jev's pick of 3 (or today's order when the ranking
 * is not ready), the shared sentence. `wait` is the Lab's: it awaits the
 * ranking, which the route never does.
 *
 * @returns {Promise<{names: string[], text: string, source: string}>}
 */
async function trialIdeaLandmarks({ characters, storyCategory, storyTheme, storyTopic, language, userLocation }, { wait = false, callImpl } = {}) {
  if (!userLocation?.city || storyCategory === 'historical') return { names: [], text: '', source: 'none' };
  const landmarks = await resolveTrialIdeaLandmarks(userLocation, language);
  const setup = selectionSetup({ characters, storyCategory, storyTheme, storyTopic, userLocation });
  const args = { setup, language, landmarks, n: IDEA_LANDMARKS.trial, callImpl };
  const pick = wait && landmarks.length ? await awaitIdeaLandmarks(args) : pickIdeaLandmarks(args);
  const names = pick.landmarks.map(l => l.name);
  return { names, text: require('./promptBuilders').trialIdeaLandmarksText(names), source: pick.source };
}

/** The trial's prepare call: resolve the story's list and start the ranking. Never awaited by a request. */
async function prepareTrialIdeaLandmarks({ characters, storyCategory, storyTheme, storyTopic, language, userLocation }) {
  if (!userLocation?.city || storyCategory === 'historical') return null;
  const landmarks = await resolveTrialIdeaLandmarks(userLocation, language);
  if (!landmarks.length) return null;
  const setup = selectionSetup({ characters, storyCategory, storyTheme, storyTopic, userLocation });
  return startIdeaLandmarkRanking({ setup, language, landmarks }).key;
}

module.exports = {
  chLabel,
  lmLabel,
  trialIdeaLandmarks,
  prepareTrialIdeaLandmarks,
  Q,
  castLine,
  setupState,
  premiseState,
  selectionSetup,
  landmarkItem,
  scoreChallenges,
  scoreLandmarks,
  rankBy,
  drawFromTop,
  selectChallengeDraw,
  JEV_CHALLENGE_COUNT,
  JEV_CHALLENGE_TOP,
  selectStoryLandmarks,
  TRIAL_STORY_LANDMARKS,
  LANDMARK_TOP,
  STORY_LANDMARK_LIMIT,
  IDEA_LANDMARKS,
  ideaAgeBands,
  ideaRankKey,
  startIdeaLandmarkRanking,
  pickIdeaLandmarks,
  awaitIdeaLandmarks,
  resolveTrialIdeaLandmarks,
  _ideaRankings: ideaRankings,
};

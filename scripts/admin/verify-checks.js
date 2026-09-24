/**
 * The checks behind tasks/verify.json — one small function per registry entry.
 *
 * Every function reads ONE stored run (the ctx verify-run.js builds from
 * stories.data, story_images and story_jobs) and returns
 *
 *     { covered: bool, pass: true | false | null, detail: string, human?: string }
 *
 *   covered  false  the run could not exercise the claim (no over-the-shoulder
 *                   page, no iterate repair, ...). NEVER a pass.
 *   pass     true   the stored data shows the claim holding.
 *            false  the stored data shows it NOT holding.
 *            null   the data cannot decide; `human` says what to look at.
 *   human           optional even with pass true: the part a person must still
 *                   look at (an image, a read of the text). A result with a
 *                   human part is never auto-confirmed.
 *
 * Pure reads. No model call, no network, no write. The run shapes an entry may
 * require live in SHAPES below, next to the checks, so a new shape is one line.
 *
 * Measurement, not classification: a few checks count phrases in text (size
 * comparisons, mood tags). That is measuring how often the generator wrote a
 * thing — it never decides what a judge's finding means (CLAUDE.md eval rule).
 */
'use strict';

const path = require('path');

const LIB = path.join(__dirname, '..', '..', 'server', 'lib');
// Leaf modules only (no requires of their own) — safe to load from a script.
const shotVocabulary = () => require(path.join(LIB, 'shotVocabulary.js'));
const emotionVocabulary = () => require(path.join(LIB, 'emotionVocabulary.js'));

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function pages(ctx) {
  const si = Array.isArray(ctx.data?.sceneImages) ? ctx.data.sceneImages : [];
  return [...si].filter(Boolean).sort((a, b) => (a.pageNumber || 0) - (b.pageNumber || 0));
}

/** The page's structured brief (fullData is the parsed JSON brief; older rows kept it flat). */
function brief(page) {
  const sm = page?.sceneMetadata || {};
  return sm.fullData || sm;
}

function versions(page) {
  return Array.isArray(page?.imageVersions) ? page.imageVersions : [];
}

function shotOf(page) {
  return String(brief(page)?.shot || '').trim().toLowerCase();
}

function castNames(ctx) {
  return (Array.isArray(ctx.data?.characters) ? ctx.data.characters : [])
    .map(c => String(c?.name || '').trim()).filter(Boolean);
}

function imageRow(ctx, type, pn, vi) {
  const rows = (ctx.images || []).filter(r => r.image_type === type && Number(r.page_number) === Number(pn));
  if (!rows.length) return null;
  if (vi != null) return rows.find(r => Number(r.version_index) === Number(vi)) || null;
  return rows.sort((a, b) => b.version_index - a.version_index)[0];
}

/** URL of the version the book shows for a page (image_version_meta.activeVersion). */
function activeImageUrl(ctx, pn) {
  const active = ctx.versionMeta?.[String(pn)]?.activeVersion;
  const row = imageRow(ctx, 'scene', pn, active != null ? active : null);
  return row?.image_url || null;
}

function plateUrl(ctx, pn) {
  return imageRow(ctx, 'empty_scene', pn, null)?.image_url || null;
}

/** Every finding object stored on a page (all versions + the page), deduped. */
function pageFindings(page) {
  const out = [];
  const seen = new Set();
  const add = (list, vi) => {
    for (const f of Array.isArray(list) ? list : []) {
      if (!f || typeof f !== 'object') continue;
      const key = `${f.source}|${f.type}|${f.severity}|${f.character}|${f.description}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...f, _version: vi });
    }
  };
  versions(page).forEach((v, i) => add(v.fixableIssues, i));
  add(page.fixableIssues, null);
  return out;
}

function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…»])\s+(?=[«"A-ZÄÖÜ])/)
    .map(s => s.trim()).filter(Boolean);
}

function squash(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const trunc = (s, n = 90) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const notCovered = (detail) => ({ covered: false, pass: null, detail });

// ---------------------------------------------------------------------------
// Run shapes: what a run must contain before an entry can be judged on it.
// ---------------------------------------------------------------------------

const SHAPES = {
  any: () => ({ ok: true }),
  'full-story': (ctx) => ctx.data?.trialMode === true ? { ok: false, why: 'trial run' } : { ok: true },
  trial: (ctx) => ctx.data?.trialMode === true ? { ok: true } : { ok: false, why: 'not a trial run' },
  'age-band': (ctx, arg) => {
    const ages = (ctx.data?.characters || []).map(c => String(c?.age ?? '').trim());
    const wanted = String(arg).split('|');
    return ages.some(a => wanted.includes(a)) ? { ok: true } : { ok: false, why: `no character aged ${wanted.join(' or ')} (ages: ${ages.join(', ') || 'none'})` };
  },
  'needs-shot': (ctx, arg) => pages(ctx).some(p => shotOf(p) === arg) ? { ok: true } : { ok: false, why: `no ${arg} page` },
  'needs-iterate-repair': (ctx) => pages(ctx).some(p => versions(p).some(v => /^iterate/.test(v.source || '')))
    ? { ok: true } : { ok: false, why: 'no iterate repair ran' },
  'needs-char-fix': (ctx) => pages(ctx).some(p => versions(p).some(v => /^char-fix/.test(v.source || '')))
    ? { ok: true } : { ok: false, why: 'no char-fix repair ran' },
  'needs-inpaint': (ctx) => pages(ctx).some(p => versions(p).some(v => v.inpaintInstruction))
    ? { ok: true } : { ok: false, why: 'no inpaint repair ran' },
  'needs-fresh-idea': (ctx) => /^ours/.test(String(ctx.row?.idea_source || ''))
    ? { ok: true } : { ok: false, why: `idea_source is "${ctx.row?.idea_source ?? 'null'}", not a generated idea` },
  'needs-worn-off': (ctx) => pages(ctx).some(p => (brief(p).wornItems || []).some(w => w?.state === 'off'))
    ? { ok: true } : { ok: false, why: 'no page takes a worn garment off' },
  'needs-fresh-avatar-sheet': (ctx) => (ctx.data?.styledAvatarGeneration || []).some(s => s?.success !== false && /2x4/.test(String(s?.sheetFormat || '')))
    ? { ok: true } : { ok: false, why: 'no 2x4 avatar sheet was generated (saved styled avatars reused)' },
  'needs-composite': (ctx) => pages(ctx).some(p => p.compositeOutcome && p.compositeOutcome.status !== 'disabled')
    ? { ok: true } : { ok: false, why: 'scene composite did not run (disabled)' },
};

/** runShape: array of "name" or "name:arg"; every one must hold. */
function evalRunShape(runShape, ctx) {
  for (const raw of Array.isArray(runShape) ? runShape : [runShape || 'any']) {
    const [name, ...rest] = String(raw).split(':');
    const fn = SHAPES[name];
    if (!fn) return { ok: false, why: `unknown runShape "${raw}" — add it to SHAPES in verify-checks.js` };
    const r = fn(ctx, rest.join(':'));
    if (!r.ok) return { ok: false, why: `${raw}: ${r.why}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Checks (keyed by the `check.fn` names in tasks/verify.json)
// ---------------------------------------------------------------------------

const checks = {};

/** 147ce6a96 — the planner is not told it owes an aerial page. */
checks.aerialNotOwed = (ctx) => {
  const b = ctx.data?.beatsReviewReport;
  if (!b?.plannerPrompt) return notCovered('no beats planner prompt stored');
  const owed = /\b\d+\s+aerial pages?\b/i.exec(b.plannerPrompt);
  const counterAerial = (b.counterFindings || []).filter(f => /SHOT_AERIAL_COUNT/.test(String(f)));
  const aerialPages = pages(ctx).filter(p => shotOf(p) === 'aerial').map(p => p.pageNumber);
  const info = `aerial pages in the book: ${aerialPages.length ? aerialPages.join(', ') : 'none'}`;
  if (owed || counterAerial.length) {
    return { covered: true, pass: false, detail: `planner still owes an aerial ("${owed ? owed[0] : counterAerial[0]}"); ${info}` };
  }
  return { covered: true, pass: true, detail: `planner prompt names no aerial floor, no SHOT_AERIAL_COUNT finding; ${info}` };
};

/** replan-round-1-regression — no KEPT re-plan round raised the cast/focal must-fix count. */
checks.replanRoundNeverRegresses = (ctx) => {
  const b = ctx.data?.beatsReviewReport;
  if (!b) return notCovered('no beats plan report stored');
  const discarded = Array.isArray(b.discardedRounds) ? b.discardedRounds : [];
  const kept = Array.isArray(b.replanPrompts) ? b.replanPrompts.map(e => e.round) : [];
  if (!kept.length && !discarded.length) return notCovered('no re-plan round ran');
  const { replanRoundRegressed } = require('../../server/lib/promptBuilders');
  const structured = rec => [
    ...(rec?.counterFindings || []).map(line => ({ kind: 'counter', code: (/^PLAN\[([A-Z_0-9]+)\]/.exec(String(line)) || [])[1], line })),
    ...(rec?.modelFindings || []).map(f => ({ kind: 'check', check: f.check, line: `CHECK[${f.check}]: ${f.text}` })),
  ];
  const fired = discarded.filter(d => /raised the cast\/focal must-fix count/.test(String(d.reason || '')));
  // Only a single kept round can be re-measured from the row: the report keeps
  // the first check and the LAST kept round's recheck.
  if (kept.length === 1 && b.recheck) {
    const v = replanRoundRegressed({ findings: structured(b) }, { findings: structured(b.recheck) }, b.changedPages || [], { round: 1 });
    if (v.regressed) return { covered: true, pass: false, detail: `round 1 was KEPT with cast/focal must-fix ${v.before} → ${v.after}` };
    return { covered: true, pass: true, detail: `round 1 kept at cast/focal must-fix ${v.before} → ${v.after}${fired.length ? `; guard discarded round(s) ${fired.map(d => d.round).join(', ')}` : ''}` };
  }
  if (fired.length) return { covered: true, pass: true, detail: `the guard discarded round(s) ${fired.map(d => d.round).join(', ')}: ${trunc(fired[0].reason, 120)}` };
  return notCovered(`${kept.length} kept round(s), ${discarded.length} discarded for other reasons — nothing the guard judged`);
};

/** 1d4f1bcf1 + 67c617743 — unrequested lettering becomes a lettering-check finding. */
checks.letteringFindings = (ctx) => {
  const ps = pages(ctx);
  if (!ps.length) return notCovered('no scene pages');
  const hits = [];
  for (const p of ps) for (const f of pageFindings(p)) if (f.source === 'lettering-check') hits.push({ pn: p.pageNumber, f });
  if (hits.length) {
    const list = hits.slice(0, 8).map(h => `p${h.pn}[${h.f.severity}] ${trunc(h.f.description, 70)}`).join('; ');
    return { covered: true, pass: true, detail: `${hits.length} lettering-check finding(s): ${list}` };
  }
  return {
    covered: true, pass: null,
    detail: 'no lettering-check finding stored (the inventory lettering itself is not persisted, so "ran and found nothing" cannot be told from "did not run")',
    human: `look for unrequested writing on the active images: ${ps.map(p => `p${p.pageNumber} ${activeImageUrl(ctx, p.pageNumber) || '(no url)'}`).slice(0, 18).join(' | ')}`,
  };
};

/** 8dfdb2b0d — a cover is briefed the way a page is: Scene prose + REQUIRED OBJECTS, no KEY STORY ELEMENTS. */
checks.coverBriefedLikeAPage = (ctx) => {
  const hints = ctx.data?.coverHints || {};
  const covers = ctx.data?.coverImages || {};
  const keys = ['frontCover', 'initialPage', 'backCover'].filter(k => covers[k]?.prompt);
  if (!keys.length) return notCovered('no stored cover prompt');
  const bad = [];
  const good = [];
  for (const k of keys) {
    const prompt = String(covers[k].prompt);
    const hint = hints[k] || {};
    const elements = (hint.objects || []).filter(id => /^(ART|ANI|VEH)\d+/i.test(String(id)));
    const faults = [];
    if (prompt.includes('KEY STORY ELEMENTS')) faults.push('KEY STORY ELEMENTS present');
    if (prompt.includes('---METADATA---')) faults.push('METADATA block leaked');
    if (!String(hint.scene || '').trim()) faults.push('hint has no Scene prose');
    else if (!prompt.includes(String(hint.scene).trim().slice(0, 40))) faults.push('Scene prose not in the sent prompt');
    if (elements.length && !prompt.includes('**REQUIRED OBJECTS')) faults.push(`no REQUIRED OBJECTS for ${elements.join(', ')}`);
    (faults.length ? bad : good).push(`${k}: ${faults.length ? faults.join('; ') : `ok (${elements.length} element(s))`}`);
  }
  return { covered: true, pass: bad.length === 0, detail: [...bad, ...good].join(' | ') };
};

/**
 * covers-as-pages (2026-09-24) — every full-story cover is a page the Art
 * Director briefed from its cover beat: the stored record is marked
 * `briefedAsPage`, carries its brief (prose + METADATA) and its plan line,
 * every figure looks at the viewer, the copy space is the beat's textPosition,
 * and the sent prompt has no KEY STORY ELEMENTS and no leaked METADATA.
 */
checks.coversArePages = (ctx) => {
  const { COVER_TEXT_POSITION } = require(path.join(LIB, 'coverKeys.js'));
  const covers = ctx.data?.coverImages || {};
  const keys = ['frontCover', 'initialPage', 'backCover'].filter(k => covers[k] && (covers[k].prompt || covers[k].sceneDescription));
  if (!keys.length) return notCovered('no stored cover');
  const bad = [];
  const good = [];
  for (const k of keys) {
    const c = covers[k];
    const meta = c.sceneMetadata?.fullData || c.sceneMetadata || {};
    const faults = [];
    if (c.briefedAsPage !== true) faults.push('not marked briefedAsPage');
    if (!String(c.sceneDescription || '').includes('---METADATA---')) faults.push('no Art Director brief (prose + METADATA)');
    if (!/^PLAN:/.test(String(c.outlineExtract || ''))) faults.push('no plan line');
    const figs = Array.isArray(meta.characters) ? meta.characters : [];
    const off = figs.filter(f => !/^(viewer|the viewer|camera)$/i.test(String(f?.looksAt || '').trim())).map(f => f?.name);
    if (!figs.length) faults.push('brief declares no cast');
    if (off.length) faults.push(`gaze not at the viewer: ${off.join(', ')}`);
    if (String(meta.textPosition || '') !== COVER_TEXT_POSITION[k]) faults.push(`textPosition "${meta.textPosition || ''}" (beat: ${COVER_TEXT_POSITION[k]})`);
    const prompt = String(c.prompt || '');
    if (prompt.includes('KEY STORY ELEMENTS')) faults.push('KEY STORY ELEMENTS present');
    if (prompt.includes('---METADATA---')) faults.push('METADATA block leaked');
    (faults.length ? bad : good).push(`${k}: ${faults.length ? faults.join('; ') : `ok (${figs.length} figure(s))`}`);
  }
  const log = Array.isArray(ctx.data?.generationLog) ? ctx.data.generationLog : [];
  const coverErrors = log.filter(e => /^(cover_failed|beats_cover_brief_missing)$/.test(String(e?.event || '')));
  if (coverErrors.length) bad.push(`${coverErrors.length} cover error event(s): ${coverErrors.map(e => trunc(e.message || e.event, 80)).join('; ')}`);
  return {
    covered: true,
    pass: bad.length === 0,
    detail: [...bad, ...good].join(' | '),
    human: `look at each cover: the title / dedication band clear, the cast whole and facing the viewer — ${keys.map(k => `${k} ${imageRow(ctx, k, null, ctx.versionMeta?.[k]?.activeVersion ?? null)?.image_url || '(no url)'}`).join(' | ')}`,
  };
};

const MOOD_TAG = /\b(mood|atmosphere|tension|standoff|feeling)\b/i;
/** 67c617743 + the 2026-09-24 rule change — sceneIntent carries no mood sentence at all (baseline 36/177 = 20%). */
checks.sceneIntentMoodTag = (ctx) => {
  const intents = pages(ctx).map(p => ({ pn: p.pageNumber, s: String(brief(p).sceneIntent || '').trim() })).filter(x => x.s);
  if (!intents.length) return notCovered('no sceneIntent on any brief');
  const tagged = intents.filter(x => { const ss = splitSentences(x.s); return MOOD_TAG.test(ss[ss.length - 1] || ''); });
  const share = tagged.length / intents.length;
  const detail = `${tagged.length}/${intents.length} briefs (${Math.round(share * 100)}%) end sceneIntent on a mood sentence (baseline 20%; pass = none)`
    + (tagged.length ? `: ${tagged.slice(0, 6).map(x => `p${x.pn} "${trunc(splitSentences(x.s).pop(), 60)}"`).join('; ')}` : '');
  return { covered: true, pass: tagged.length === 0, detail };
};

/** 3d8f4871d — briefs declare characters[].emotion from the enum; emotion-check emits findings. */
checks.emotionEnum = (ctx) => {
  const { EMOTIONS } = emotionVocabulary();
  const enumSet = new Set(EMOTIONS);
  let rows = 0; let valid = 0;
  for (const p of pages(ctx)) for (const c of brief(p).characters || []) {
    rows += 1;
    if (enumSet.has(String(c?.emotion || '').trim().toLowerCase())) valid += 1;
  }
  if (!rows) return notCovered('no characters[] rows on any brief');
  const findings = [];
  for (const p of pages(ctx)) for (const f of pageFindings(p)) if (f.source === 'emotion-check') findings.push({ pn: p.pageNumber, f });
  const crit = findings.filter(x => x.f.severity === 'CRITICAL');
  const detail = `${valid}/${rows} brief character rows carry an enum emotion; ${findings.length} emotion-check finding(s), ${crit.length} CRITICAL`;
  if (valid / rows < 0.9) return { covered: true, pass: false, detail };
  return {
    covered: true, pass: true, detail,
    human: crit.length
      ? `false-CRITICAL risk — look at each: ${crit.map(x => `p${x.pn}${x.f._version != null ? ` v${x.f._version}` : ''} ${trunc(x.f.description, 60)} ${activeImageUrl(ctx, x.pn) || ''}`).join(' | ')}`
      : undefined,
  };
};

/** a11662c21 + 725a4cd45 — the arc panel ran with the SENSE lens. */
checks.arcSenseLens = (ctx) => {
  const rounds = ctx.data?.arcReviewReport?.rounds;
  if (!Array.isArray(rounds) || !rounds.length) return notCovered('no arc panel round stored');
  const withLens = rounds.filter(r => /^-\s*SENSE\b/m.test(String(r.panelPrompt || '')));
  if (!withLens.length) return { covered: true, pass: false, detail: 'the panel prompt carries no SENSE lens' };
  const faults = rounds.flatMap(r => (r.panel || []).map(x => `${x.letter || '?'}: ${trunc(x.text, 160)}`));
  return {
    covered: true, pass: true,
    detail: `SENSE lens in ${withLens.length}/${rounds.length} panel prompt(s)`,
    human: `read the panel faults for "a reader would stop here" turns (arcReviewReport.rounds[].panel): ${faults.join(' | ')}`,
  };
};

const SIZE_PATTERNS = [
  /\bas (?:big|large|tall|small|long|wide|heavy|high) as\b[^.,;]{0,30}/gi,
  /\bthe size of\b[^.,;]{0,30}/gi,
  /\b[\w-]+-sized\b/gi,
  /\bno (?:bigger|larger|smaller|taller) than\b[^.,;]{0,30}/gi,
  /\b(?:bigger|larger|smaller|taller) than\b[^.,;]{0,30}/gi,
  /\bso (?:gross|klein|lang|breit|schwer|hoch) wie\b[^.,;]{0,30}/gi,
  /\b(?:grösser|kleiner|länger) als\b[^.,;]{0,30}/gi,
  /\bin der Grösse (?:eines|einer)\b[^.,;]{0,30}/gi,
  /\b\w{3,}(?:gross|grosse|grossen|grosser|grosses)\b/gi,
  /\baussi (?:grand|petit)e? que\b[^.,;]{0,30}/gi,
  /\bde la taille d['e]\b[^.,;]{0,30}/gi,
];
function sizeHits(text) {
  const hits = [];
  for (const re of SIZE_PATTERNS) { re.lastIndex = 0; let m; while ((m = re.exec(String(text || ''))) !== null) hits.push(m[0].trim()); }
  return hits;
}
/** 2e696f6ed — sizes and looks leave the arc and the plan; the prose makes no size comparisons. */
checks.sizeComparisons = (ctx) => {
  const arc = ctx.data?.arcReviewReport?.finalArc;
  const plan = ctx.data?.beatsReviewReport?.pagePlan;
  if (!arc && !plan) return notCovered('no arc or page plan stored');
  const text = pages(ctx).map(p => p.text || '').join('\n');
  const a = sizeHits(arc); const pl = sizeHits(plan); const t = sizeHits(text);
  const fmt = (xs) => xs.length ? xs.slice(0, 6).map(x => `"${x}"`).join(', ') : 'none';
  return {
    covered: true, pass: a.length + pl.length + t.length === 0,
    detail: `size comparisons — arc ${a.length} (${fmt(a)}); plan ${pl.length} (${fmt(pl)}); text ${t.length} (${fmt(t)})`,
  };
};

/** 728494663 + 4434e7ca9 — a VB animal description states no scale. */
checks.vbCellNoScale = (ctx) => {
  const animals = ctx.data?.visualBible?.animals;
  if (!Array.isArray(animals) || !animals.length) return notCovered('no Visual Bible animals');
  // The phrases are the SCALE_PHRASES values in visualBible.js. That module pulls
  // the prompt loader and text models, so the check reads it lazily and only here.
  let phrases;
  try { phrases = Object.values(require(path.join(LIB, 'visualBible.js')).SCALE_PHRASES); } catch (e) {
    return { covered: true, pass: null, detail: `could not load SCALE_PHRASES (${e.message})` };
  }
  const bad = animals.filter(a => phrases.some(ph => String(a?.description || '').includes(ph)));
  return {
    covered: true, pass: bad.length === 0,
    detail: bad.length
      ? `${bad.length}/${animals.length} animal description(s) carry a scale phrase: ${bad.map(a => `${a.id || a.name}: "${trunc(a.description, 70)}"`).join('; ')}`
      : `${animals.length} animal description(s), none states a scale`,
  };
};

/** b2751c799 + 5beac7c16 — an ultra-wide page on a shared vantage gets a derived, sized pull-back plate. */
checks.ultraWideDerivedPlate = (ctx) => {
  const ps = pages(ctx);
  const uw = ps.filter(p => shotOf(p) === 'ultra-wide');
  if (!uw.length) return notCovered('no ultra-wide page');
  const shared = uw.filter(p => p.vantageId && ps.some(o => o !== p && o.vantageId === p.vantageId && shotOf(o) !== 'ultra-wide'));
  if (!shared.length) return notCovered(`ultra-wide page(s) ${uw.map(p => p.pageNumber).join(', ')} have their own vantage — no plate is derived`);
  const instr = shotVocabulary().buildPlateDeriveInstruction('', 'ultra-wide') || '';
  const move = (instr.split('of a place. ')[1] || '').split(' The buildings')[0].trim();
  const bad = [];
  for (const p of shared) {
    if (p.plateDerivedFor !== 'ultra-wide') bad.push(`p${p.pageNumber} plateDerivedFor=${p.plateDerivedFor ?? 'missing'}`);
    else if (move && !String(p.emptyScenePrompt || '').includes(move)) bad.push(`p${p.pageNumber} plate prompt lacks the sized pull-back`);
  }
  const look = shared.map(p => {
    const base = ps.find(o => o.vantageId === p.vantageId && shotOf(o) !== 'ultra-wide');
    return `p${p.pageNumber} plate ${plateUrl(ctx, p.pageNumber) || '(none)'} vs base p${base?.pageNumber} ${plateUrl(ctx, base?.pageNumber) || '(none)'}`;
  }).join(' | ');
  if (bad.length) return { covered: true, pass: false, detail: bad.join('; ') };
  return { covered: true, pass: true, detail: `${shared.length} derived ultra-wide plate(s) recorded with the sized pull-back`, human: `is the plate pulled far back, same place? ${look}` };
};

/** 50e150c21 + be213ec9a — over-the-shoulder: near figure is a crop, prompt has the crop, no contact. */
checks.otsCropAndNoContact = (ctx) => {
  const sv = shotVocabulary();
  const ots = pages(ctx).filter(p => shotOf(p) === 'over-the-shoulder');
  if (!ots.length) return notCovered('no over-the-shoulder page');
  const cropHead = sv.OTS_NEAR_FIGURE_CROP.split(';')[0];
  const bad = [];
  for (const p of ots) {
    const b = brief(p);
    const near = (b.characters || []).filter(c => sv.isOverTheShoulderPerspective(c?.perspective)).map(c => c.name);
    if (!near.length) { bad.push(`p${p.pageNumber}: no character has perspective over-the-shoulder`); continue; }
    const v0 = versions(p)[0];
    if (!String(v0?.prompt || '').includes(cropHead)) bad.push(`p${p.pageNumber}: built prompt lacks the crop directive`);
    const touch = (b.interactions || []).filter(i => i?.hands === true && near.includes(i.character));
    if (touch.length) bad.push(`p${p.pageNumber}: near figure ${touch[0].character} touches (${trunc(touch[0].where || touch[0].action, 50)})`);
  }
  if (bad.length) return { covered: true, pass: false, detail: bad.join('; ') };
  return {
    covered: true, pass: true, detail: `${ots.length} over-the-shoulder page(s): crop declared, crop in prompt, no contact`,
    human: `camera behind a cropped near figure, subject small and deep? ${ots.map(p => `p${p.pageNumber} ${activeImageUrl(ctx, p.pageNumber) || ''}`).join(' | ')}`,
  };
};

const SLOT_LABEL = /\b(?:Satz|Sentence|Phrase|Slot)\s*\d+\s*[—–:-]/i;
/** c7b4eb1e1 — a story started from generated ideas records which card was picked. */
checks.ideaPickRecorded = (ctx) => {
  const pick = ctx.data?.ideaPick;
  if (!pick) return { covered: true, pass: false, detail: 'stories.data.ideaPick is missing on a run started from a generated idea' };
  return { covered: true, pass: true, detail: `ideaPick recorded (index ${pick.index ?? 'own premise'}, world ${pick.world ?? '-'})` };
};

/** 1d6598368 — a generated idea reaches the story with no slot labels. */
checks.ideaNoSlotLabels = (ctx) => {
  const texts = [ctx.row?.idea_original, ctx.row?.idea_used].filter(Boolean);
  if (!texts.length) return notCovered('no stored idea text');
  const hit = texts.map(t => SLOT_LABEL.exec(t)).find(Boolean);
  return { covered: true, pass: !hit, detail: hit ? `idea carries a slot label: "${hit[0]}"` : 'idea text carries no slot label' };
};

/** 32dce4da9 — an iterate rewrite's figures are exactly its characters[]. */
checks.iterateCastFromRewrite = (ctx) => {
  const bad = []; let n = 0;
  for (const p of pages(ctx)) versions(p).forEach((v, i) => {
    if (!/^iterate/.test(v.source || '')) return;
    n += 1;
    const b = v.sceneMetadata?.fullData || v.sceneMetadata || {};
    const listed = new Set((b.characters || []).map(c => String(c?.name || '').trim().toLowerCase()));
    const extra = (v.sceneCharacters || []).map(c => c?.name).filter(nm => nm && !listed.has(String(nm).trim().toLowerCase()));
    if (extra.length) bad.push(`p${p.pageNumber} v${i}: ${extra.join(', ')} not in the rewrite's characters[] (${[...listed].join(', ') || 'empty'})`);
  });
  if (!n) return notCovered('no iterate version');
  return { covered: true, pass: bad.length === 0, detail: bad.length ? bad.join('; ') : `${n} iterate version(s): cast = the rewrite's list` };
};

/** 319fa6054 — a char-fix prompt carries no judge sentence. */
checks.charFixNoJudgeText = (ctx) => {
  const bad = []; let n = 0;
  for (const p of pages(ctx)) versions(p).forEach((v, i) => {
    if (!/^char-fix/.test(v.source || '')) return;
    n += 1;
    const m = /Issues to fix:[^\n]*/.exec(String(v.prompt || ''));
    if (m) bad.push(`p${p.pageNumber} v${i}: "${trunc(m[0], 110)}"`);
  });
  if (!n) return notCovered('no char-fix version');
  return { covered: true, pass: bad.length === 0, detail: bad.length ? bad.join('; ') : `${n} char-fix prompt(s), none carries judge text` };
};

/** 17bbd887a — a page with a garment off is judged in the owner's off grid, never the wearing one. */
checks.wornOffGrid = (ctx) => {
  const offs = [];
  for (const p of pages(ctx)) for (const w of brief(p).wornItems || []) {
    if (w?.state === 'off' && w.owner) offs.push({ owner: w.owner, pn: p.pageNumber, id: w.id });
  }
  if (!offs.length) return notCovered('no garment is off on any page');
  const reports = [ctx.data?.finalChecksReport?.entity, ...(ctx.data?.finalChecksReport?.entityHistory || []).map(h => h?.report)].filter(Boolean);
  if (!reports.length) return notCovered('no entity report stored');
  const bad = []; const good = []; const absent = [];
  for (const o of offs) {
    const keys = new Set();
    for (const r of reports) {
      const byC = r.characters?.[o.owner]?.byClothing || {};
      for (const [k, g] of Object.entries(byC)) if ((g?.appearances || []).some(a => Number(a?.pageNumber) === o.pn)) keys.add(k);
    }
    if (!keys.size) absent.push(`${o.owner} p${o.pn}`);
    else if ([...keys].every(k => k.includes('--off:'))) good.push(`${o.owner} p${o.pn}`);
    else bad.push(`${o.owner} p${o.pn} under ${[...keys].join('/')}`);
  }
  const detail = `off pages: ${good.length} in an off grid${good.length ? ` (${good.join(', ')})` : ''}; ${bad.length} in a wearing grid${bad.length ? ` (${bad.join(', ')})` : ''}; ${absent.length} not in any grid${absent.length ? ` (${absent.join(', ')})` : ''}`;
  if (bad.length) return { covered: true, pass: false, detail };
  if (!good.length) return { covered: false, pass: null, detail: `${detail} — the entity grids never reached an off page` };
  return { covered: true, pass: true, detail };
};

/** 5a4672c7a — the diff pass is shown the findings; count corrections that invent a sentence. */
checks.diffPassLedger = (ctx) => {
  const t = ctx.data?.textRefineReport;
  const diff = (t?.roundTrace || []).find(r => r?.kind === 'diff');
  if (!diff) return notCovered('no diff round stored');
  if (!/FINDINGS THE REWRITE ANSWERED:/.test(String(diff.prompt || ''))) {
    return { covered: true, pass: false, detail: 'the diff prompt does not carry the findings the rewrite answered' };
  }
  const byPage = new Map((t.pages || []).map(p => [p.pageNumber, p]));
  const invented = [];
  for (const c of t.diffApplied || []) {
    const pg = byPage.get(c.pageNumber) || {};
    const known = new Set([...splitSentences(pg.before), ...splitSentences(pg.after), ...splitSentences(c.quote)].map(squash));
    for (const s of splitSentences(c.correction)) {
      if (known.has(squash(s))) continue;
      const words = new Set(squash(c.quote) ? String(c.quote).toLowerCase().match(/\p{L}+/gu) || [] : []);
      const sw = String(s).toLowerCase().match(/\p{L}+/gu) || [];
      const overlap = sw.filter(w => words.has(w)).length / Math.max(1, sw.length);
      if (overlap < 0.5) invented.push(`p${c.pageNumber}: "${trunc(s, 70)}"`);
    }
  }
  return {
    covered: true, pass: null,
    detail: `diff prompt carries the findings; ${(t.diffApplied || []).length} diff correction(s), ${invented.length} introduce a sentence neither text had`,
    human: invented.length ? `read these diff sentences against BEFORE/AFTER: ${invented.join(' | ')}` : 'no invented sentence found by the word-overlap measure; spot-read textRefineReport.diffApplied',
  };
};

/** 6d75a7efc + 2da73ff15 + 668ab8809 + f3f0b1af2 — style audit runs; the repair may decline. */
checks.styleAuditAndDecline = (ctx) => {
  const t = ctx.data?.textRefineReport;
  if (!t || !Array.isArray(t.audits)) return notCovered('no text-refine audits stored');
  const styleFaults = t.audits.flatMap(a => String(a?.raw || '').split('\n').filter(l => /FAULT\[STYLE\]/.test(l)));
  const repair = (t.roundTrace || []).find(r => r?.kind === 'repair');
  const declined = String(repair?.analysis || t.analysis || '').split('\n').filter(l => /declin/i.test(l));
  const text = pages(ctx).map(p => ({ pn: p.pageNumber, s: splitSentences(String(p.text || '').replace(/«[^»]*»/g, ' ')) }));
  const fragments = text.flatMap(x => x.s.filter(s => (s.match(/\p{L}+/gu) || []).length <= 3).map(s => `p${x.pn} "${s}"`));
  const negations = text.flatMap(x => x.s.filter(s => /\bnicht\b[^.]*\bsondern\b|\bkein\w*\b[^.]{0,40}\bkein\w*\b|\bnot\b[^.]{0,40}\bbut\b|\bnot\b[^.]{0,30}\bnot\b/i.test(s)).map(s => `p${x.pn} "${trunc(s, 60)}"`));
  const last = text[text.length - 1];
  const ending = last ? last.s.slice(-2).join(' ') : '';
  return {
    covered: true,
    pass: styleFaults.length ? true : null,
    detail: `${styleFaults.length} FAULT[STYLE] line(s) from the audits; ${declined.length} decline line(s) in the repair analysis; narration fragments <=3 words: ${fragments.length}; paired negations: ${negations.length}`,
    human: `read for style: fragments ${fragments.slice(0, 8).join(', ') || 'none'}; negations ${negations.slice(0, 5).join(', ') || 'none'}; ending "${trunc(ending, 160)}"${declined.length ? `; declines: ${declined.slice(0, 3).map(l => trunc(l, 100)).join(' | ')}` : ''}`,
  };
};

/** dbdc6b1c2 — an inpaint instruction identifies figures visually, never by cast name or "N-year-old male figure". */
checks.repairDescriptorNoNames = (ctx) => {
  const cast = castNames(ctx);
  const creatures = (ctx.data?.visualBible?.animals || []).map(a => a?.name).filter(Boolean);
  const bad = []; const creatureLeaks = []; let n = 0;
  for (const p of pages(ctx)) versions(p).forEach((v, i) => {
    if (!v.inpaintInstruction || /^char-fix/.test(v.source || '')) return;
    n += 1;
    const s = String(v.inpaintInstruction);
    const names = cast.filter(nm => new RegExp(`\\b${nm}\\b`).test(s));
    if (names.length) bad.push(`p${p.pageNumber} v${i} names ${names.join(', ')}`);
    if (/\b\d+-year-old (?:male|female) figure\b/i.test(s)) bad.push(`p${p.pageNumber} v${i} uses the age/gender fallback`);
    const cn = creatures.filter(nm => new RegExp(`\\b${nm}\\b`).test(s));
    if (cn.length) creatureLeaks.push(`p${p.pageNumber} v${i} ${cn.join(', ')}`);
  });
  if (!n) return notCovered('no inpaint instruction');
  const extra = creatureLeaks.length ? `; outside this entry, a creature NAME reached Grok: ${creatureLeaks.join(', ')}` : '';
  return { covered: true, pass: bad.length === 0, detail: (bad.length ? bad.join('; ') : `${n} inpaint instruction(s), no cast name, no fallback descriptor`) + extra };
};

/**
 * 2026-09-24 — no image-model repair text names a figure the model has no reference for:
 * inpaint instructions (no bible creature / secondary character), char-fix prompts (no
 * figure but the target), manual-repair payloads (no cast or bible name).
 */
checks.repairDescriptorNoVbFigureNames = (ctx) => {
  const vb = ctx.data?.visualBible || {};
  const figs = ['animals', 'secondaryCharacters']
    .flatMap(pool => (vb[pool] || []).flatMap(e => [e?.name, e?.properName]))
    .filter(nm => typeof nm === 'string' && nm.trim())
    .map(nm => nm.trim());
  const cast = castNames(ctx);
  if (!figs.length && cast.length < 2) return notCovered('no bible figure and no second cast member to leak');
  const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = (s, list) => list.filter(nm => new RegExp(`(?<![\\p{L}\\p{N}])${esc(nm)}(?![\\p{L}\\p{N}])`, 'u').test(s));
  const bad = []; const seen = { inpaint: 0, charFix: 0, manual: 0 };
  for (const p of pages(ctx)) {
    versions(p).forEach((v, i) => {
      if (!v.inpaintInstruction) return;
      const s = String(v.inpaintInstruction);
      if (/^char-fix/.test(v.source || '')) {
        // Char-fix targets a cast member (it needs an avatar), so a bible figure is never
        // the target. Other cast names are judged only when the stored record says who
        // the target was — the prompt is never read to find out.
        const target = (p.retryHistory || []).find(r => r?.versionIndex === i && r?.charName)?.charName || null;
        seen.charFix += 1;
        const hit = named(s, [...figs, ...(target ? cast.filter(c => c !== target) : [])]);
        if (hit.length) bad.push(`p${p.pageNumber} v${i} char-fix${target ? ` ${target}` : ''} names ${hit.join(', ')}`);
        return;
      }
      seen.inpaint += 1;
      const hit = named(s, figs);
      if (hit.length) bad.push(`p${p.pageNumber} v${i} inpaint names ${hit.join(', ')}`);
    });
    (p.retryHistory || []).forEach((r, k) => {
      if (!r?.editInstruction) return;
      seen.manual += 1;
      const hit = named(String(r.editInstruction), [...figs, ...cast]);
      if (hit.length) bad.push(`p${p.pageNumber} manual repair #${k} names ${hit.join(', ')}`);
    });
  }
  const n = seen.inpaint + seen.charFix + seen.manual;
  if (!n) return notCovered('no inpaint, char-fix or manual-repair text stored');
  return {
    covered: true, pass: bad.length === 0,
    detail: (bad.length ? bad.join('; ') : 'no figure named that the model has no reference for')
      + ` (inpaint ${seen.inpaint}, char-fix ${seen.charFix}, manual repair ${seen.manual}; ${figs.length} bible figure name(s))`,
  };
};

/** d49cbf0e0 — a grouped face fix names each child by clothing and states remove AND show. */
checks.groupedFaceFix = (ctx) => {
  const cast = castNames(ctx);
  const grouped = [];
  for (const p of pages(ctx)) versions(p).forEach((v, i) => {
    const sf = v.consolidatedPlan?.scene_fix;
    if (!sf || !(sf.types || []).includes('emotion')) return;
    const clauses = String(sf.instruction || '').split(/;\s*/).filter(c => c.trim());
    if (clauses.length >= 2) grouped.push({ pn: p.pageNumber, i, clauses, s: sf.instruction });
  });
  if (!grouped.length) return notCovered('no grouped (multi-face) emotion fix');
  const bad = [];
  for (const g of grouped) {
    const names = cast.filter(nm => new RegExp(`\\b${nm}\\b`).test(g.s));
    if (names.length) bad.push(`p${g.pn} v${g.i} names ${names.join(', ')}`);
    const half = g.clauses.filter(c => !(/\bremove\b/i.test(c) && /\bshow\b/i.test(c)));
    if (half.length) bad.push(`p${g.pn} v${g.i} clause without remove+show: "${trunc(half[0], 60)}"`);
  }
  return {
    covered: true, pass: bad.length === 0,
    detail: bad.length ? bad.join('; ') : `${grouped.length} grouped face fix(es): clothing identifiers, remove + show per clause`,
    human: bad.length ? undefined : `did the faces change as asked? ${grouped.map(g => `p${g.pn} ${activeImageUrl(ctx, g.pn) || ''}`).join(' | ')}`,
  };
};

/** Backlog — vb_element_overflow at birth: measure the count before deciding. */
checks.vbElementOverflowCount = (ctx) => {
  const log = Array.isArray(ctx.data?.generationLog) ? ctx.data.generationLog : [];
  const ev = log.filter(e => e?.event === 'beats_vb_element_overflow');
  const n = pages(ctx).length;
  if (!n) return notCovered('no pages');
  return {
    covered: true, pass: null,
    detail: `${ev.length}/${n} pages over the VB element budget after the scene review (${ev.map(e => `p${e.details?.pageNumber}: ${(e.details?.requested || []).length}`).join(', ') || 'none'})`,
    human: 'owner decision: count one side, or make the AD cite from the trimmed claims (docs/decisions.md 2026-09-08 "Art Director second pass")',
  };
};

/** Backlog — the full sibling's name-opening rate and EXACT POSES, measured on a trial. */
checks.trialPromptParity = (ctx) => {
  const ps = pages(ctx);
  if (!ps.length) return notCovered('no pages');
  const names = castNames(ctx);
  const opens = ps.filter(p => { const first = splitSentences(p.text)[0] || ''; return names.some(nm => first.replace(/^[«"]/, '').startsWith(nm)); });
  const poses = ps.filter(p => /EXACT POSES/.test(String(versions(p)[0]?.prompt || p.prompt || '')));
  const rate = opens.length / ps.length;
  return {
    covered: true, pass: rate <= 0.35 && poses.length === ps.length,
    detail: `${opens.length}/${ps.length} pages open on a name (${Math.round(rate * 100)}%; baseline trial 45-48%, full 23%; pass <= 35%); EXACT POSES in ${poses.length}/${ps.length} built prompts`,
  };
};

/** Backlog T5 — styled avatars finish before page images start. */
checks.avatarsBeforePages = (ctx) => {
  const styled = (ctx.data?.styledAvatarGeneration || []).filter(s => s?.timestamp);
  const start = (ctx.data?.generationLog || []).find(e => e?.stage === 'images' && e?.event === 'stage_start');
  if (!styled.length) return notCovered('no styled avatar was generated in this run');
  if (!start) return notCovered('no images stage_start in the generation log');
  const last = styled.map(s => Date.parse(s.timestamp)).reduce((a, b) => Math.max(a, b), 0);
  const gap = Math.round((Date.parse(start.timestamp) - last) / 1000);
  return { covered: true, pass: gap >= 0, detail: `last styled avatar ${gap >= 0 ? `${gap}s before` : `${-gap}s AFTER`} the page-image stage started (${styled.length} styled)` };
};

/** e4d4fe113 — arc create at effort max, re-tell at medium: cost and time for the owner's read. */
checks.arcEffortCost = (ctx) => {
  const bf = ctx.data?.tokenUsage?.byFunction || {};
  const c = bf.arc_create; const r = bf.arc_retell;
  if (!c) return notCovered('no arc_create usage recorded');
  const fmt = (u) => u ? `$${Number(u.cost || 0).toFixed(2)}, ${Math.round((u.elapsed_ms || 0) / 1000)}s, ${u.output_tokens || 0} out` : 'not run';
  return {
    covered: true, pass: null,
    detail: `arc_create ${fmt(c)}; arc_retell ${fmt(r)}`,
    human: 'read arcReviewReport.create / .critique / .finalArc against the high/high arcs before any master push; is the re-tell needed when the first arc is good?',
  };
};

/** bc8c55dd6 — the trial renders one backdrop plate per vantage, not per page. */
checks.trialPlatePerVantage = (ctx) => {
  const groups = new Map();
  for (const p of pages(ctx)) {
    if (!p.vantageId) continue;
    if (!groups.has(p.vantageId)) groups.set(p.vantageId, new Set());
    groups.get(p.vantageId).add(squash(p.emptyScenePrompt || ''));
  }
  const shared = [...groups.entries()].filter(([, s]) => s.size >= 1);
  if (!shared.length) return notCovered('no page carries a vantageId');
  const split = shared.filter(([, s]) => s.size > 1).map(([v, s]) => `${v}: ${s.size} plate prompts`);
  return { covered: true, pass: split.length === 0, detail: split.length ? split.join('; ') : `${shared.length} vantage(s), one plate prompt each` };
};

/** Backlog — redo counts after the clothing fixes: a number for the owner to compare. */
checks.redoCount = (ctx) => {
  const m = ctx.data?.runMetrics;
  if (!m) return notCovered('no runMetrics');
  return { covered: true, pass: null, detail: `redo_trigger ${m.redo_trigger ?? 0}, consistency_regen ${m.consistency_regen ?? 0}, char_repair_run ${m.char_repair_run ?? 0} over ${pages(ctx).length} pages`, human: 'compare with the pre-fix baseline in tasks/redo-clothing-analysis-2026-07-20.md' };
};

module.exports = { checks, SHAPES, evalRunShape, helpers: { pages, brief, versions, shotOf, activeImageUrl, plateUrl, pageFindings, splitSentences, sizeHits } };

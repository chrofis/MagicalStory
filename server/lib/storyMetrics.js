/**
 * Story metrics collector (stats framework — docs/plans/story-stats-page.md).
 *
 * Computes the per-story scorecard (A: extracted scores, B: change magnitude,
 * C: runtime counters) from stories.data + the story_jobs row and UPSERTs one
 * row into story_metrics (migrations/014_story_metrics.sql).
 *
 * Called fire-and-forget at job completion (server.js) and by
 * scripts/admin/backfill-story-metrics.js.
 *
 * Contract: collectStoryMetrics NEVER throws — any failure is logged and
 * returns null. Missing data => NULL columns, never guessed values.
 *
 * ── Observed data shapes (staging, 2026-08-09, e.g. story job_1786277779744_vorw1f7ve) ──
 * - Scores are on a 0–100 scale already (no 0–10 anywhere). Page-level
 *   `qualityScore` is the active version's post-deduction score and CAN GO
 *   NEGATIVE (observed -77) when deductions exceed the base — analytics.
 *   {avg,min,max}QualityScore match page.qualityScore, so that is the field
 *   used here (fallback: page.finalScore). No normalization needed.
 * - `qualityReasoning` is a JSON *string* (figures/matches/verdict) — not the
 *   typed findings. The typed eval categories live in page-level `fixTargets[]`
 *   ({type, severity, issue, …}; e.g. clothing, action_interaction,
 *   missing_character) — findings_by_category counts those.
 * - `imageVersions[]`: per version {type: 'original'|'repair', source,
 *   evalScore, finalScore, deductions{entity,quality,semantic,compliance,
 *   consolidated[]}, …}. Repair delta = last.finalScore − first.finalScore.
 * - `retryHistory[]`: entries all have type 'unified_pipeline' in current data;
 *   NO consistency-typed entries exist => consistency_mean stays NULL unless a
 *   /consist/ entry with a numeric score shows up.
 * - Cost/duration: stories.data.analytics {totalCost (USD), totalDurationMs,
 *   …} is the stored total (same numbers analyze-story-log derives); fallback
 *   story_jobs.result_data->>'estimatedCost' and completed_at − created_at.
 * - Outline (beats mode, live on staging): sections ---TITLE--- / ---BEATS--- /
 *   ---BEATS REVIEW--- / ---SCENE REVIEW--- / … / ---STORY PAGES---, and
 *   before/after page lists in data.beatsReviewReport / sceneReviewReport /
 *   textRefineReport. Unified mode: ---STORY DRAFT--- / ---CRITICAL ANALYSIS---
 *   / ---STORY PAGES--- (draft-vs-final comparison ported from
 *   scripts/analysis/fetch-story-data.js). data.outlineReview.fixCount exists
 *   on some stories (e.g. 20 on job_1786053708336_8cdsca519).
 * - Test stories: stories.data has NO isTest/is_test flag in practice —
 *   Test Lab sandboxing is per image *version* (story_images.is_test), not per
 *   story. We still honor data.isTest/data.is_test if ever set, and skip
 *   partial rescues (data.isPartial). See "test detection" note in the plan.
 */
'use strict';

const { ch } = require('../../scripts/lib/chTime');

const log = {
  info: (msg) => console.log(`[${ch(new Date())}] [storyMetrics] ${msg}`),
  warn: (msg) => console.warn(`[${ch(new Date())}] [storyMetrics] ${msg}`),
};

// ---------------------------------------------------------------------------
// Outline helpers — ported from scripts/analysis/fetch-story-data.js
// (that file runs main() on require, so it cannot be required from server code)
// ---------------------------------------------------------------------------

/** Split a unified/beats outline into its ---SECTION--- blocks. */
function extractOutlineSections(outline) {
  if (!outline || typeof outline !== 'string') return null;
  const result = {};
  const sectionRegex = /---([A-Z\s]+)---/g;
  const positions = [];
  let match;
  while ((match = sectionRegex.exec(outline)) !== null) {
    positions.push({ name: match[1].trim(), start: match.index, headerEnd: match.index + match[0].length });
  }
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].headerEnd;
    const end = positions[i + 1]?.start || outline.length;
    result[positions[i].name] = outline.substring(start, end).trim();
  }
  return Object.keys(result).length ? result : null;
}

/**
 * Compare STORY DRAFT vs STORY PAGES text (unified mode).
 * Returns { pageCount, changedPages } or null when sections are missing.
 * Ported from compareStoryDraftVsFinal in scripts/analysis/fetch-story-data.js.
 */
function compareStoryDraftVsFinal(draftSection, pagesSection) {
  if (!draftSection || !pagesSection) return null;

  const draftPages = {};
  const draftBlocks = draftSection.split(/\*\*Draft (\d+)\*\*/);
  for (let i = 1; i < draftBlocks.length; i += 2) {
    const pageNum = parseInt(draftBlocks[i]);
    let text = draftBlocks[i + 1] || '';
    text = text
      .replace(/\n\s*\(?\*?\(Word count:.*?\)\*?\)?\s*/g, '\n')
      .replace(/\nSCENE HINT:[\s\S]*?(?=\n\*\*Draft|\n--- Page|$)/g, '')
      .trim();
    draftPages[pageNum] = text;
  }

  const finalPages = {};
  const pageRegex = /--- Page (\d+) ---\s*TEXT:\s*([\s\S]*?)(?=SCENE HINT:|--- Page \d|$)/g;
  let pm;
  while ((pm = pageRegex.exec(pagesSection)) !== null) {
    finalPages[parseInt(pm[1])] = pm[2].trim();
  }

  // Compare only pages present on BOTH sides — a page that parsed on one side
  // only says nothing about churn (observed: 14 draft blocks vs 10 final
  // blocks on a real story) and would inflate the percentage.
  const bothPageNums = Object.keys(draftPages).filter(n => n in finalPages).map(Number);
  if (bothPageNums.length === 0) return null;

  let changedPages = 0;
  for (const pageNum of bothPageNums) {
    if (draftPages[pageNum] !== finalPages[pageNum]) changedPages++;
  }
  return { pageCount: bothPageNums.length, changedPages };
}

// ---------------------------------------------------------------------------
// Metric computation
// ---------------------------------------------------------------------------

const round2 = (n) => (n == null || !Number.isFinite(n)) ? null : Math.round(n * 100) / 100;

/**
 * Churn % from a beats-mode review report ({pages:[{pageNumber, before,
 * after}]}): share of story pages the review actually changed. Reports list
 * touched pages only; entries whose before === after (trimmed) don't count.
 */
function churnFromReport(report, totalPages) {
  if (!report || !Array.isArray(report.pages) || !totalPages) return null;
  // `before` is the PRE-REVIEW brief, and `briefsIn` already holds it for every
  // page — changed or not. The scene review stopped duplicating it into each
  // row (2026-09-21, 32k of JSONB per story); rows written before that still
  // carry their own copy, which is read when the snapshot has no entry.
  const sentByPage = new Map(
    (Array.isArray(report.briefsIn) ? report.briefsIn : [])
      .filter(b => b && b.pageNumber != null)
      .map(b => [Number(b.pageNumber), String(b.brief ?? b.text ?? '')])
  );
  const beforeOf = (p) => {
    const sent = sentByPage.get(Number(p.pageNumber));
    return String((sent !== undefined ? sent : p.before) ?? '');
  };
  const changed = report.pages.filter(p =>
    beforeOf(p).trim() !== String(p.after ?? '').trim()
  ).length;
  return round2((changed / totalPages) * 100);
}

/** Scene churn for unified mode: sceneDescriptions[].description {draft, output}. */
function sceneChurnUnified(sceneDescriptions, totalPages) {
  if (!Array.isArray(sceneDescriptions) || !sceneDescriptions.length || !totalPages) return null;
  let comparable = 0, changed = 0;
  for (const desc of sceneDescriptions) {
    let parsed = desc.description;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch { parsed = null; }
    }
    if (!parsed?.draft || !parsed?.output) continue;
    comparable++;
    if (JSON.stringify(parsed.draft) !== JSON.stringify(parsed.output)) changed++;
  }
  if (!comparable) return null;
  return round2((changed / totalPages) * 100);
}

/** Count "FIXES REQUIRED" bullets in a unified-mode CRITICAL ANALYSIS section. */
function countCriticalAnalysisFixes(criticalAnalysis) {
  if (!criticalAnalysis) return null;
  const m = criticalAnalysis.match(/FIXES REQUIRED[:*\s]*([\s\S]*)$/i);
  if (!m) return null;
  return m[1].split(/\n-\s+/).filter(s => s.trim()).length || 0;
}

/**
 * Compute the scorecard from stories.data + the story_jobs row.
 * Pure function — exported for tests. Every metric that cannot be computed
 * from stored data is null.
 */
function computeMetrics(data, jobRow) {
  const pages = Array.isArray(data.sceneImages) ? data.sceneImages : [];
  const analytics = data.analytics || {};

  // --- A: page scores (0–100 scale, negatives possible — see header) ---
  const scores = pages
    .map(p => (typeof p.qualityScore === 'number' ? p.qualityScore
      : (typeof p.finalScore === 'number' ? p.finalScore : null)))
    .filter(s => s != null);
  const meanScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const minScore = scores.length ? Math.min(...scores) : null;
  const pagesBelow80 = scores.length ? scores.filter(s => s < 80).length : null;

  // --- A: findings by typed category (page-level fixTargets on the final image) ---
  let findingsByCategory = null;
  {
    const counts = {};
    let sawAny = false;
    for (const p of pages) {
      if (!Array.isArray(p.fixTargets)) continue;
      sawAny = true;
      for (const f of p.fixTargets) {
        const cat = f.type || f.element || 'unknown';
        counts[cat] = (counts[cat] || 0) + 1;
      }
    }
    if (sawAny) findingsByCategory = counts;
  }

  // --- A: repair rate / versions per page / repair delta ---
  let repairRate = null, versionsPerPageMean = null, repairDeltaMean = null;
  {
    const vLens = pages.map(p => Array.isArray(p.imageVersions) ? p.imageVersions.length : null)
      .filter(n => n != null);
    if (vLens.length) {
      versionsPerPageMean = vLens.reduce((a, b) => a + b, 0) / vLens.length;
      repairRate = vLens.filter(n => n > 1).length / vLens.length;
    }
    const deltas = [];
    for (const p of pages) {
      const vs = Array.isArray(p.imageVersions) ? p.imageVersions : [];
      if (vs.length < 2) continue;
      const scoreOf = (v) => (typeof v.finalScore === 'number' ? v.finalScore
        : (typeof v.evalScore === 'number' ? v.evalScore : null));
      const first = scoreOf(vs[0]);
      const last = scoreOf(vs[vs.length - 1]);
      if (first != null && last != null) deltas.push(last - first);
    }
    if (deltas.length) repairDeltaMean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  }

  // --- A: consistency mean — retryHistory consistency entries. Observed
  // staging data has none (all entries are type 'unified_pipeline'), so this
  // is normally NULL; kept for when a consistency pass writes scored entries.
  let consistencyMean = null;
  {
    const cs = [];
    for (const p of pages) {
      for (const r of (Array.isArray(p.retryHistory) ? p.retryHistory : [])) {
        if (/consist/i.test(`${r.type || ''} ${r.source || ''}`) && typeof r.score === 'number') {
          cs.push(r.score);
        }
      }
    }
    if (cs.length) consistencyMean = cs.reduce((a, b) => a + b, 0) / cs.length;
  }

  // --- A: outline fixes + churn (B) — mode-dependent ---
  const outlineSections = extractOutlineSections(data.outline);
  const isBeats = !!(outlineSections?.BEATS || data.beatsReviewReport);
  const pipelineMode = outlineSections
    ? (isBeats ? 'beats' : 'unified')
    : (process.env.PIPELINE_MODE || (data.generationMode === 'unified' ? 'unified' : null));

  // outline_fix_count: prefer the stored reviewer meta (data.outlineReview.
  // fixCount); beats fallback = pages actually changed by the beats review;
  // unified fallback = FIXES REQUIRED bullets in CRITICAL ANALYSIS.
  let outlineFixCount = null;
  if (typeof data.outlineReview?.fixCount === 'number') {
    outlineFixCount = data.outlineReview.fixCount;
  } else if (isBeats && Array.isArray(data.beatsReviewReport?.pages)) {
    outlineFixCount = data.beatsReviewReport.pages
      .filter(p => String(p.before ?? '').trim() !== String(p.after ?? '').trim()).length;
  } else {
    // Section is named CRITICAL ANALYSIS in some outlines, ANALYSIS in others.
    outlineFixCount = countCriticalAnalysisFixes(
      outlineSections?.['CRITICAL ANALYSIS'] ?? outlineSections?.ANALYSIS);
  }
  // outline_fixes_by_category: no typed categories are stored for outline
  // fixes (reports are before/after prose only) — NULL until the reviewer
  // emits categories.
  const outlineFixesByCategory = null;

  // --- B: churn ---
  const pageCount = pages.length || (Array.isArray(data.pages) ? data.pages.length : null);
  let textChurnPct = null;
  if (isBeats) {
    // Beats mode: text refine report lists before/after per touched page.
    textChurnPct = churnFromReport(data.textRefineReport, pageCount);
  } else {
    const cmp = compareStoryDraftVsFinal(outlineSections?.['STORY DRAFT'], outlineSections?.['STORY PAGES']);
    if (cmp) textChurnPct = round2((cmp.changedPages / cmp.pageCount) * 100);
  }
  const sceneChurnPct = isBeats
    ? churnFromReport(data.sceneReviewReport, pageCount)
    : sceneChurnUnified(data.sceneDescriptions, pageCount);
  // beats_churn_pct: beats-mode outline delta; unified stories have no beats.
  const beatsChurnPct = isBeats ? churnFromReport(data.beatsReviewReport, pageCount) : null;

  // repair_pixel_change_pct: image bytes live in the story_images table (R2
  // URLs / DB versions), not in stories.data — computing a normalized pixel
  // diff needs image fetch + sharp. Deliberately left NULL here; follow-up
  // task per docs/plans/story-stats-page.md.
  const repairPixelChangePct = null;

  // --- A: covers ---
  let coverScores = null;
  if (data.coverImages && typeof data.coverImages === 'object') {
    coverScores = {};
    for (const key of ['frontCover', 'initialPage', 'backCover']) {
      const c = data.coverImages[key];
      if (!c || typeof c !== 'object') continue;
      coverScores[key] = {
        quality: typeof c.qualityScore === 'number' ? c.qualityScore : null,
        semantic: typeof c.semanticScore === 'number' ? c.semanticScore : null,
        versions: Array.isArray(c.imageVersions) ? c.imageVersions.length : null,
        ...(key === 'frontCover' ? { titlePainted: c.titlePainted ?? null } : {}),
      };
    }
    if (!Object.keys(coverScores).length) coverScores = null;
  }

  // avatar_fallback_count: styledAvatarGeneration/costumedAvatarGeneration logs
  // carry no explicit fallback marker in observed data — NULL until the
  // runtime recorder (data.runMetrics) counts avatar fallbacks.
  const avatarFallbackCount = null;

  // --- A: duration / cost — stored totals only (data.analytics is written at
  // finalize; job row is the fallback). Never parsed from logs.
  let durationS = null;
  if (typeof analytics.totalDurationMs === 'number') {
    durationS = Math.round(analytics.totalDurationMs / 1000);
  } else if (jobRow?.created_at && jobRow?.completed_at) {
    durationS = Math.round((new Date(jobRow.completed_at) - new Date(jobRow.created_at)) / 1000);
  }
  let costUsd = null;
  if (typeof analytics.totalCost === 'number') {
    costUsd = analytics.totalCost;
  } else if (jobRow?.estimated_cost != null && Number.isFinite(parseFloat(jobRow.estimated_cost))) {
    costUsd = parseFloat(jobRow.estimated_cost);
  }

  // --- C: runtime counters ({} tolerated — recorder ships separately) ---
  const counters = (data.runMetrics && typeof data.runMetrics === 'object') ? data.runMetrics : {};

  return {
    environment: null, // filled by caller (env override for backfill)
    pipeline_mode: pipelineMode,
    art_style: data.artStyle || null,
    language: data.language || null,
    pages: pageCount,

    duration_s: durationS,
    cost_usd: costUsd == null ? null : Math.round(costUsd * 10000) / 10000,
    mean_page_score: round2(meanScore),
    min_page_score: round2(minScore),
    pages_below_80: pagesBelow80,
    findings_by_category: findingsByCategory,
    repair_rate: repairRate == null ? null : Math.round(repairRate * 10000) / 10000,
    versions_per_page_mean: round2(versionsPerPageMean),
    consistency_mean: round2(consistencyMean),
    outline_fix_count: outlineFixCount,
    outline_fixes_by_category: outlineFixesByCategory,
    cover_scores: coverScores,
    avatar_fallback_count: avatarFallbackCount,

    text_churn_pct: textChurnPct,
    scene_churn_pct: sceneChurnPct,
    beats_churn_pct: beatsChurnPct,
    repair_delta_mean: round2(repairDeltaMean),
    repair_pixel_change_pct: repairPixelChangePct,

    counters,

    // D: judge scores — not implemented yet (Task 6 in the plan).
    title_score: null,
    text_score: null,

    detail: {
      title: data.title || null,
      pageScores: pages.map(p => ({
        page: p.pageNumber,
        score: typeof p.qualityScore === 'number' ? p.qualityScore : null,
        semantic: typeof p.semanticScore === 'number' ? p.semanticScore : null,
        versions: Array.isArray(p.imageVersions) ? p.imageVersions.length : null,
        findings: Array.isArray(p.fixTargets) ? p.fixTargets.length : null,
      })),
      analytics: {
        // Carried so a reader can tell a null score apart from a missing one:
        // false = the run skipped evaluation entirely (trials), null = the
        // story predates the flag (2026-09-13).
        qualityEvaluated: analytics.qualityEvaluated ?? null,
        // Same distinction one level down: false = evaluated run whose pages
        // carried no attempt counter, so the two fields below are null by
        // honesty, not by absence of retries (2026-09-14).
        attemptsMeasured: analytics.attemptsMeasured ?? null,
        // Which code produced the story (null on a local run with no SHA).
        build: analytics.build ?? null,
        avgQualityScore: analytics.avgQualityScore ?? null,
        firstAttemptPassRate: analytics.firstAttemptPassRate ?? null,
        totalRetries: analytics.totalRetries ?? null,
        contentBlocked: analytics.contentBlocked ?? null,
      },
    },
  };
}

/**
 * Collect + UPSERT metrics for one story. Never throws; returns the computed
 * metrics object or null (missing story / test story / error).
 *
 * @param {string} storyId
 * @param {{ pool: import('pg').Pool, environment?: string }} opts
 */
async function collectStoryMetrics(storyId, { pool, environment } = {}) {
  try {
    if (!pool) { log.warn(`no pool passed for ${storyId} — skipping`); return null; }

    const sr = await pool.query('SELECT id, data FROM stories WHERE id = $1', [storyId]);
    if (!sr.rows.length) { log.warn(`story ${storyId} not found — skipping`); return null; }
    let data = sr.rows[0].data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
    if (!data || typeof data !== 'object') { log.warn(`story ${storyId} has unparseable data — skipping`); return null; }

    // Test/partial stories never get a metrics row. Note: stories.data carries
    // no isTest flag in practice (Test Lab sandboxes per-VERSION via
    // story_images.is_test, not per-story) — checked defensively anyway.
    if (data.isTest || data.is_test) { log.info(`story ${storyId} is a test story — skipping`); return null; }
    if (data.isPartial) { log.info(`story ${storyId} is a partial rescue — skipping`); return null; }

    // Job row (may be pruned for old stories — every field from it is optional).
    let jobRow = null;
    try {
      const jr = await pool.query(
        `SELECT id, created_at, completed_at, result_data->>'estimatedCost' AS estimated_cost
         FROM story_jobs
         WHERE id = $1 OR result_data->>'storyId' = $1
         ORDER BY created_at DESC LIMIT 1`,
        [storyId]
      );
      jobRow = jr.rows[0] || null;
    } catch (e) {
      log.warn(`job lookup failed for ${storyId}: ${e.message}`);
    }

    const m = computeMetrics(data, jobRow);
    m.environment = environment || process.env.RAILWAY_ENVIRONMENT_NAME || 'local';

    // created_at is copied from stories.created_at IN SQL — round-tripping a
    // naive TIMESTAMP through a JS Date shifts it by the local offset
    // (node-pg naive-timestamp trap, see scripts/lib/chTime.js).
    await pool.query(
      `INSERT INTO story_metrics (
         story_id, created_at, collected_at, environment, pipeline_mode, art_style, language, pages,
         duration_s, cost_usd, mean_page_score, min_page_score, pages_below_80,
         findings_by_category, repair_rate, versions_per_page_mean, consistency_mean,
         outline_fix_count, outline_fixes_by_category, cover_scores, avatar_fallback_count,
         text_churn_pct, scene_churn_pct, beats_churn_pct, repair_delta_mean, repair_pixel_change_pct,
         counters, title_score, text_score, detail
       )
       SELECT s.id, s.created_at, CURRENT_TIMESTAMP, $2, $3, $4, $5, $6,
              $7, $8, $9, $10, $11,
              $12, $13, $14, $15,
              $16, $17, $18, $19,
              $20, $21, $22, $23, $24,
              $25, $26, $27, $28
       FROM stories s WHERE s.id = $1
       ON CONFLICT (story_id) DO UPDATE SET
         created_at = EXCLUDED.created_at,
         collected_at = EXCLUDED.collected_at,
         environment = EXCLUDED.environment,
         pipeline_mode = EXCLUDED.pipeline_mode,
         art_style = EXCLUDED.art_style,
         language = EXCLUDED.language,
         pages = EXCLUDED.pages,
         duration_s = EXCLUDED.duration_s,
         cost_usd = EXCLUDED.cost_usd,
         mean_page_score = EXCLUDED.mean_page_score,
         min_page_score = EXCLUDED.min_page_score,
         pages_below_80 = EXCLUDED.pages_below_80,
         findings_by_category = EXCLUDED.findings_by_category,
         repair_rate = EXCLUDED.repair_rate,
         versions_per_page_mean = EXCLUDED.versions_per_page_mean,
         consistency_mean = EXCLUDED.consistency_mean,
         outline_fix_count = EXCLUDED.outline_fix_count,
         outline_fixes_by_category = EXCLUDED.outline_fixes_by_category,
         cover_scores = EXCLUDED.cover_scores,
         avatar_fallback_count = EXCLUDED.avatar_fallback_count,
         text_churn_pct = EXCLUDED.text_churn_pct,
         scene_churn_pct = EXCLUDED.scene_churn_pct,
         beats_churn_pct = EXCLUDED.beats_churn_pct,
         repair_delta_mean = EXCLUDED.repair_delta_mean,
         repair_pixel_change_pct = EXCLUDED.repair_pixel_change_pct,
         counters = EXCLUDED.counters,
         title_score = EXCLUDED.title_score,
         text_score = EXCLUDED.text_score,
         detail = EXCLUDED.detail`,
      [
        storyId, m.environment, m.pipeline_mode, m.art_style, m.language, m.pages,
        m.duration_s, m.cost_usd, m.mean_page_score, m.min_page_score, m.pages_below_80,
        m.findings_by_category == null ? null : JSON.stringify(m.findings_by_category),
        m.repair_rate, m.versions_per_page_mean, m.consistency_mean,
        m.outline_fix_count,
        m.outline_fixes_by_category == null ? null : JSON.stringify(m.outline_fixes_by_category),
        m.cover_scores == null ? null : JSON.stringify(m.cover_scores),
        m.avatar_fallback_count,
        m.text_churn_pct, m.scene_churn_pct, m.beats_churn_pct, m.repair_delta_mean, m.repair_pixel_change_pct,
        JSON.stringify(m.counters || {}),
        m.title_score, m.text_score,
        JSON.stringify(m.detail || {}),
      ]
    );

    log.info(`collected metrics for ${storyId} (mean=${m.mean_page_score}, min=${m.min_page_score}, cost=$${m.cost_usd ?? '?'}, mode=${m.pipeline_mode})`);
    return m;
  } catch (err) {
    log.warn(`collection failed for ${storyId}: ${err.message}`);
    return null;
  }
}

/**
 * How many times a page was actually rendered.
 *
 * SOURCE OF TRUTH = `retryHistory` (2026-09-14). The repair pipeline builds it
 * with exactly one entry per persisted version — `{attempt: idx+1, type:
 * 'unified_pipeline', source: 'original' | 'inpaint-round-1' | 'char-fix-2' …}`
 * (`server/lib/repairPipeline.js`, buildVersionEntry/retryHistory) — so its
 * length IS the attempt count. `totalAttempts` is NOT written by any generation
 * path: it survives only on the regeneration/iterate endpoints
 * (`server/routes/regeneration.js`, `server/lib/images.js`, `coverIterate.js`),
 * where it means "provider attempts inside one regen call". It is honoured as a
 * fallback for pages that carry it and no history.
 *
 * Returns null when NEITHER exists — an absent counter is not "1 attempt".
 *
 * @param {object} img
 * @returns {number|null}
 */
function pageAttemptCount(img) {
  if (!img) return null;
  const rh = Array.isArray(img.retryHistory) ? img.retryHistory : null;
  if (rh && rh.length > 0) {
    // Prefer the larger of length and the highest `attempt` index: a history
    // that lost an entry still cannot under-report the attempts it recorded.
    const maxIdx = rh.reduce(
      (m, e) => (e && Number.isFinite(e.attempt) ? Math.max(m, e.attempt) : m), 0);
    return Math.max(rh.length, maxIdx);
  }
  if (Number.isFinite(img.totalAttempts) && img.totalAttempts >= 1) return img.totalAttempts;
  return null;
}

/**
 * Build provenance for a run: which code produced this story.
 *
 * Reads the SAME env var `/api/health` and `/api/admin/diagnostics` already
 * report (`RAILWAY_GIT_COMMIT_SHA`, with Railway's `SOURCE_VERSION` alias) —
 * no second mechanism. A local dev run has neither and records null; nothing
 * throws.
 */
function getBuildInfo() {
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_VERSION || null;
  return {
    commit: sha ? String(sha).slice(0, 8) : null,
    commitFull: sha ? String(sha) : null,
    branch: process.env.RAILWAY_GIT_BRANCH || null,
    environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || null,
  };
}

/**
 * Quality aggregates for stories.data.analytics.
 *
 * NOT MEASURED is not MEASURED ZERO (2026-09-13). A run with
 * `skipQualityEval` (trials) never evaluates a page, never records an attempt
 * count and never keeps a retry history — so every aggregate is null and
 * `qualityEvaluated: false` says why. A run that WAS evaluated reports its real
 * numbers, including a truthful `pagesWithIssues: 0` /
 * `firstAttemptPassRate: 100`.
 *
 * Evidence: prod trial job_1789292742265_mgxmrkfpd shipped
 * `firstAttemptPassRate: 100, pagesWithIssues: 0, totalRetries: 0` over zero
 * eval records while four of its six pages had real defects.
 *
 * @param {Array<object>} images - the final sceneImages (+ covers) of the run
 * @param {{ skipQualityEval?: boolean }} opts
 * @returns {{qualityEvaluated: boolean, attemptsMeasured: boolean,
 *   attemptSource: 'retryHistory'|'totalAttempts'|null, qualityEvalSkipReason: string|null,
 *   avgQualityScore: number|null, minQualityScore: number|null,
 *   maxQualityScore: number|null, firstAttemptPassRate: number|null,
 *   totalRetries: number|null, pagesWithIssues: number|null,
 *   contentBlocked: number|null}}
 */
function computeQualityAnalytics(images, { skipQualityEval = false } = {}) {
  const all = Array.isArray(images) ? images : [];
  const qualityEvaluated = !skipQualityEval;

  const scores = qualityEvaluated
    ? all.map(img => img && img.qualityScore).filter(s => s != null && !isNaN(s))
    : [];

  // contentBlocked is counted off retryHistory, which the skip-eval path never
  // attaches — "0 blocked" there would mean "no history was kept". Report it
  // only when at least one image actually carries a history to count.
  const sawRetryHistory = all.some(img => img && Array.isArray(img.retryHistory));

  // Attempts: measured per page, and only over the pages that actually carry a
  // counter. The 2026-09-13 fix closed this hole for SKIPPED runs only; on an
  // EVALUATED beats run every page had `totalAttempts: undefined` and the
  // absent counter was read as "1 attempt, passed first time" — staging
  // job_1789348171785_9oxos7dwv shipped firstAttemptPassRate 100 / totalRetries
  // 0 over 18 pages whose retryHistory arrays were 1-3 entries long (14 real
  // retries, 9 of 18 pages clean = 50%).
  const attempts = qualityEvaluated ? all.map(pageAttemptCount) : [];
  const measured = attempts.filter(n => n != null);
  const attemptsMeasured = measured.length > 0;

  return {
    qualityEvaluated,
    // false = the run was evaluated but no page carried an attempt counter, so
    // firstAttemptPassRate/totalRetries are null rather than a flattering 100/0.
    attemptsMeasured: qualityEvaluated ? attemptsMeasured : false,
    attemptSource: (qualityEvaluated && attemptsMeasured)
      ? (all.some(img => Array.isArray(img?.retryHistory) && img.retryHistory.length > 0)
        ? 'retryHistory' : 'totalAttempts')
      : null,
    qualityEvalSkipReason: qualityEvaluated ? null : 'skipQualityEval',
    avgQualityScore: scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    minQualityScore: scores.length > 0 ? Math.min(...scores) : null,
    maxQualityScore: scores.length > 0 ? Math.max(...scores) : null,
    firstAttemptPassRate: attemptsMeasured
      ? Math.round(measured.filter(n => n <= 1).length / measured.length * 100)
      : null,
    totalRetries: attemptsMeasured
      ? measured.reduce((sum, n) => sum + (n - 1), 0)
      : null,
    pagesWithIssues: qualityEvaluated ? scores.filter(s => s < 70).length : null,
    contentBlocked: sawRetryHistory
      ? all.reduce((sum, img) => sum + ((img.retryHistory || []).filter(r => r && r.blocked).length), 0)
      : null,
  };
}

module.exports = { collectStoryMetrics, computeMetrics, extractOutlineSections, compareStoryDraftVsFinal, computeQualityAnalytics, pageAttemptCount, getBuildInfo };


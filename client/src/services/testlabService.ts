/**
 * Test Lab API client — /api/admin/testlab/* (admin only).
 */
import { api } from './api';

export interface TestLabStory {
  id: string;
  title: string | null;
  artStyle: string | null;
  storyType: string | null;
  language: string | null;
  languageLevel: string | null;
  pages: number;
  userEmail: string | null;
  username: string | null;
  createdAt: string;
  hasBenchmark: boolean;
}

export interface TestLabPagination {
  page: number;
  limit: number;
  totalStories: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface BenchmarkScene {
  id: number;
  storyId: string;
  pageNumber: number;
  label: string | null;
  tags: {
    artStyle?: string;
    storyType?: string;
    language?: string;
    characterCount?: number;
    hasLandmark?: boolean;
  };
  snapshot: {
    title?: string;
    sceneDescription?: string;
    sceneText?: string;
    textPosition?: string;
    characterNames?: string[];
    snapshotAt?: string;
  };
  storyTitle: string | null;
  createdAt: string;
}

export interface ExperimentSummary {
  id: number;
  stage: string;
  label: string | null;
  status: string;
  hasOverride: boolean;
  targetCount: number;
  doneCount: number;
  createdBy: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ScoreRow {
  id: number;
  story_id: string;
  title: string | null;
  language: string | null;
  art_style: string | null;
  artifact: string;              // 'full' | 'beats' | 'scene' | 'storyText' | 'visualBible'
  model: string | null;          // generating model — the comparison axis
  judge_model: string | null;
  eval_version: string;
  eval_hash: string | null;
  score: number | null;
  dims: unknown;
  notes: string | null;
  artifact_text: string | null;
  round: number;
  source: string | null;
  label: string | null;
  gen_cost_usd: number | null;
  gen_ms: number | null;
  judge_cost_usd: number | null;
  judge_ms: number | null;
  // full review chain that produced this round's artifact (null for raw rounds
  // and pre-chain rows): reviewer analysis + exact per-page before→after.
  chain: { reviewModel?: string; pass?: number; fromRound?: number; analysis?: string; rewrites?: { page: number; before: string; after: string }[] } | null;
  created_at: string;
}

export interface StoryScorecard {
  artifacts: Record<string, { dims: Record<string, number>; score: number; notes: string }>;
  overall: number;
  title?: string | null;
  language?: string | null;
  artStyle?: string | null;
  models?: Record<string, string | null>;
  judgeModel?: string;
  evaluatorVersion?: string;
  evaluatorHash?: string;
}

export interface EvalSpread {
  values: number[]; min: number; max: number; range: number; mean: number; stdev: number;
  median?: number;
  /** Median absolute deviation — unmoved by a single outlying repeat, unlike range. */
  mad?: number;
  /** 'low' below 5 repeats: read the set aggregate, not this page's range alone. */
  reliability?: 'ok' | 'low';
  reliabilityNote?: string;
}

export interface EvalConcept {
  label: string;
  sources: string[];
  types: string[];
  seenIn: number[];
  of: number;
  severities: Record<string, number>;
  minPoints: number;
  maxPoints: number;
  swing: number;
  verdict: 'detection-flip' | 'severity-flip' | 'stable';
  duplicatesWithinRun?: number;
}

export interface ExperimentResult {
  storyId: string;
  pageNumber: number;
  character?: string;
  realisticVersionIndex?: number | null;
  finalScore?: number | null;
  scorecard?: StoryScorecard | null;
  // beats_review_replay: one arm per reviewer model, each with per-pass results
  arms?: Array<{
    model: string;
    convergedAtPass: number | null;
    passes: Array<{ pass: number; rewrittenPages: number[]; converged: boolean; check8?: string; scorecard?: StoryScorecard | null }>;
  }> | null;
  beatCount?: number;
  passesRequested?: number;
  ok: boolean;
  error?: string;
  imageType?: string;
  versionIndex?: number;
  promptUsed?: string;
  modelId?: string;
  elapsedMs?: number;
  scores?: {
    quality?: number | null;
    final?: number | null;
    semantic?: number | null;
    verdict?: string | null;
    issuesSummary?: string | null;
    error?: string;
  };
  issuesSummary?: string | null;
  fixableIssues?: unknown[];
  semanticIssues?: unknown[];
  figures?: { name?: string; bbox?: number[]; match?: unknown; confidence?: number }[];
  objects?: { name?: string; bbox?: number[] }[];
  detectionBackend?: string | null;
  identity?: { method?: string; answers?: Record<string, string>; somFailure?: string } | null;
  // Which stored version the bbox stage actually detected on (pinned, or the
  // active-version resolution incl. whether the v0 fallback fired).
  loadedFrom?: { pinned?: number; activeIdx?: number; loadedVersion?: number; fellBackToV0?: boolean } | null;
  somPrompt?: string | null;
  report?: unknown;
  // eval_variance: the same image scored N times, nothing else changed.
  repeats?: number;
  okRuns?: number;
  // entity stage with params.repeats: how much the consistency check disagrees
  // with itself on the same frozen story.
  issueCountSpread?: { values: number[]; min: number; max: number; range: number };
  penaltySpread?: { values: number[]; min: number; max: number; range: number };
  evalFailureSpread?: { values: number[]; min: number; max: number; range: number };
  consolidated?: boolean;
  scoreSpread?: EvalSpread;
  rawSpread?: EvalSpread;
  countSpread?: EvalSpread;
  pointSpread?: { quality: EvalSpread; semantic: EvalSpread; compliance: EvalSpread };
  attribution?: {
    stablePoints: number;
    detectionFlipCount: number;
    severityFlipCount: number;
    stableCount: number;
    potentialSwing: number;
    bySource: Record<string, { pointRange: number; detectionFlips: number; severityFlips: number }>;
  };
  concepts?: EvalConcept[];
  runs?: Array<{
    run: number; ok: boolean; error?: string; elapsedMs?: number; finalScore?: number;
    points?: { quality: number; semantic: number; compliance: number; total: number };
    counts?: { quality: number; semantic: number; compliance: number };
    findings?: Array<{ source: string; type: string | null; severity: string; points: number; description: string }>;
    issuesSummary?: string | null;
  }>;
  storedBaseline?: {
    qualityScore?: number | null; semanticScore?: number | null; finalScore?: number | null;
    source?: string; pageActiveFinalScore?: number | null;
  };
  characterName?: string;
  qc?: { pass?: boolean; issues?: string[]; visionFeedback?: string | null; error?: string };
  method?: string | null;
  backend?: string;
  model?: string;
  repairMode?: string;
  coverType?: string;
  decision?: { method: string; reason: string; charName?: string | null };
  skippedRepair?: boolean;
  inpaintInstruction?: string | null;
  plan?: unknown;
  dedupedIssues?: unknown;
  textZone?: { candidates: unknown[]; winnerSource?: string | null };
  artifactRepair?: { fixedCount: number; failedCount: number; totalIssues: number };
  newSceneDescription?: string | null;
  storedSceneDescription?: string | null;
  // scene_expansion_ab: variant B rides alongside the standard (A) fields
  variantVersionIndex?: number;
  comparedVersions?: { original: number | string; repaired: number };
  note?: string;
  active?: { activeVersion: number | null; pinned: boolean } | null;
  consolidateError?: string | null;
  skipped?: boolean;
  boxSource?: string;
  samBlend?: boolean;
  blendRule?: string;
  styleMatch?: { sameStyle: boolean; styleA?: string; styleB?: string };
  logWarnings?: string[];
  logLines?: string[];
  cost?: number;
  crop?: { x: number; y: number; w: number; h: number };
  bbox?: number[];
  faceBbox?: number[];
  // pageNumber is per-step: a story-level stage (style_repair) emits steps for
  // SEVERAL pages in one entry, where the entry itself has no pageNumber.
  steps?: { label: string; imageType: string; versionIndex: number; pageNumber?: number | null }[];
  // cover_title_paintin: deterministic OCR gate on the painted title
  alignGate?: { offMaskMeanDiff: number; threshold: number; pass: boolean; verdict: string; inkCoverage?: number; reworkMean?: number };
  titleGate?: { expected: string; ocr: string | null; pass: boolean | null; error?: string | null; verdict: string };
  typography?: { fontId?: string; layout?: string; face?: string; lines?: string[] };
  paintinSetup?: {
    cropPx: string; cropPctOfCover: string; renderedAt: string; marginPct: number;
    dilatePx: number; contextRef: boolean; recolor: boolean; refsSent: number; backend?: string; mode?: string; searchPx?: number;
    deterministicColour: string | null;
  };
  variantScores?: ExperimentResult['scores'];
  newSceneDescriptionA?: string | null;
  newSceneDescriptionB?: string | null;
  extraRule?: string | null;
  imagePrompt?: string | null;
  baselinePrompt?: string | null;
  promptUsedA?: string | null;
  promptUsedB?: string | null;
  // Multi-call stages (avatar_eval split) expose each call's prompt separately.
  prompts?: { label: string; text: string }[];
  versions?: unknown[];
  winner?: unknown;
  styled?: boolean;
  artStyle?: string;
  pass?: number;
  label?: string;
  redoOf?: number | string;
  redoneAt?: string;
  promptOverridden?: boolean;
  // outline_review: one shared writer draft, then either compare mode
  // (reviewRuns, one per model) or iterate mode (rounds, each feeding the next).
  stageKind?: string;
  mode?: 'compare' | 'iterate';
  aspect?: 'both' | 'text' | 'scene';
  writerModel?: string;
  writerModelId?: string;
  writerElapsedMs?: number;
  writerChars?: number;
  writerTruncated?: boolean;
  writerDraft?: string;
  hintCount?: number;
  reviewPromptChars?: number;
  // Every prompt this stage actually sent, captured at the text/image
  // chokepoints — present for ALL stages, not only the ones that stash their own.
  sentPrompts?: SentPrompt[];
  reviewRuns?: ReviewRun[];
  rounds?: ReviewRound[];
  // text_refine: each round rewrites the WHOLE text and feeds it to the next.
  title?: string;
  language?: string;
  pageCount?: number;
  refineRounds?: RefineRound[];
  finalPages?: { pageNumber: number; original: string; final: string; changed: boolean }[];
  // beats_scenes
  timeToLockMs?: number;
  beatsPlan?: BeatsCall;
  beatsReview?: BeatsReview | null;
  /** One entry per scene-review arm; all judged the same frozen briefs. */
  sceneReviews?: SceneReviewArm[] | null;
  finalBeats?: { pageNumber: number; beat: string; planLine?: string; scene?: string }[];
  timeToScenesMs?: number | null;
  sceneExpansions?: {
    pageNumber: number; ok: boolean; error?: string; elapsedMs?: number;
    modelId?: string; provider?: string | null; ttftMs?: number | null;
    usage?: { input_tokens?: number; output_tokens?: number }; cost?: number;
    promptChars?: number; prompt?: string;
    fromBeats?: string; storedProduction?: string;
  }[] | null;
}

export interface RefineRound {
  round: number;
  ok: boolean;
  error?: string;
  modelKey?: string;
  modelId?: string;
  provider?: string | null;
  elapsedMs?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  cost?: number;
  promptChars?: number;
  prompt?: string;
  rawResponse?: string;
  analysis?: string;
  returnedPages?: number[];
  strayPages?: number[];
  changedPages?: number[];
  ttftMs?: number | null;
  changedFromOriginal?: number[];
  converged?: boolean;
  pages?: { pageNumber: number; before: string; after: string; original: string; sceneIntent?: string }[];
}

// beats_scenes: plan + fast review, and the number that matters — time to lock.
export interface BeatsCall {
  modelKey: string;
  modelId?: string;
  provider?: string | null;
  elapsedMs?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  cost?: number;
  promptChars?: number;
  prompt?: string;
  rawResponse?: string;
  ttftMs?: number | null;
  pages?: { pageNumber: number; beat: string; planLine?: string; scene?: string }[];
  missingPages?: number[];
}

export interface BeatsReview extends BeatsCall {
  analysis?: string;
  changedPages?: number[];
  strayPages?: number[];
}

export interface SceneReviewArm extends BeatsCall {
  analysis?: string;
  rewrotePages?: number[];
  error?: string;
}

export interface SentPrompt {
  label: string;
  modelId: string | null;
  chars: number;
  truncated?: boolean;
  text: string;
  kind?: 'text' | 'image';
  aspectRatio?: string;
  referenceImages?: number;
}

export interface ReviewRun {
  modelKey: string;
  modelId?: string;
  aspect?: 'both' | 'text' | 'scene';
  ok: boolean;
  elapsedMs?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  cost?: number;
  fixCount?: number;
  reviewText?: string;
  reviewTruncated?: boolean;
  error?: string;
}

export interface ReviewRound {
  round: number;
  split?: boolean;
  ok?: boolean;
  error?: string;
  totalFixCount?: number;
  converged?: boolean;
  elapsedMs?: number;
  review?: ReviewRun;   // non-split rounds
  text?: ReviewRun;     // split rounds
  scene?: ReviewRun;    // split rounds
}

export interface TextModelInfo {
  id: string;
  modelId: string;
  provider: string;
  maxOutputTokens: number;
  description: string;
  pricing: { input: number; output: number } | null;
}

export interface ExperimentDetail {
  id: number;
  stage: string;
  label: string | null;
  status: string;
  promptOverride: string | null;
  params: Record<string, unknown>;
  targets: { storyId: string; pageNumber: number }[];
  results: ExperimentResult[];
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  completedAt: string | null;
}

/**
 * A durable eval finding. The prompt carries `ruleText`; `rationale` is the part
 * that must NOT live in a prompt — the incident, the measurement, the reason.
 */
export interface EvalFinding {
  id: number;
  slug: string;
  title: string;
  category: string;
  prompt_file: string | null;
  prompt_section: string | null;
  rule_text: string | null;
  rationale: string;
  evidence: Record<string, unknown>;
  status: string;
  superseded_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const TESTLAB_STAGES = [
  { id: 'image', label: 'Page image', producesImage: true, overridable: true },
  { id: 'empty_scene', label: 'Empty scene', producesImage: true, overridable: true },
  { id: 'quality_eval', label: 'Quality eval', producesImage: false, overridable: true },
  { id: 'eval_variance', label: 'Eval variance (same image × N)', producesImage: false, overridable: false },
  { id: 'inventory_ab', label: 'Inventory A/B (split vs unified, blind)', producesImage: false, overridable: false },
  { id: 'semantic_eval', label: 'Semantic eval', producesImage: false, overridable: true },
  { id: 'bbox', label: 'Bbox detection', producesImage: false, overridable: false },
  { id: 'char_repair', label: 'Character repair', producesImage: true, overridable: false },
  { id: 'entity', label: 'Entity consistency', producesImage: false, overridable: false },
  { id: 'text_zone', label: 'Text zone (calm + wash)', producesImage: true, overridable: false },
  { id: 'consolidate', label: 'Feedback consolidator', producesImage: false, overridable: true },
  { id: 'inpaint', label: 'Inpaint repair', producesImage: true, overridable: false },
  { id: 'iterate', label: 'Iterate (full regen)', producesImage: true, overridable: false },
  { id: 'scene_composite', label: 'Scene composite (silhouette → paste avatars)', producesImage: true, overridable: false },
  { id: 'repair_round', label: 'Auto repair round', producesImage: true, overridable: false },
  { id: 'edit_image', label: 'Edit image (freeform)', producesImage: true, overridable: true, noTemplate: true },
  { id: 'artifact_repair', label: 'Artifact repair (grid)', producesImage: true, overridable: false },
  { id: 'scale_repair', label: 'Scale repair (bg figures)', producesImage: true, overridable: false },
  { id: 'style_transfer', label: 'Style transfer', producesImage: true, overridable: false },
  { id: 'pick_best', label: 'Pick-best report', producesImage: false, overridable: false },
  { id: 'scene_expansion', label: 'Scene expansion (Art Director)', producesImage: false, overridable: true },
  { id: 'scene_variant', label: 'Scene variant (rule attempt → image)', producesImage: true, overridable: true },
  { id: 'scene_expansion_ab', label: 'Scene expansion A/B → image (extra-rule test)', producesImage: true, overridable: true },
  { id: 'scene_description', label: 'Scene description (iterate)', producesImage: false, overridable: true },
  { id: 'rewrite_blocked', label: 'Rewrite blocked scene', producesImage: false, overridable: true },
  { id: 'repair_verify', label: 'Repair verification (diff)', producesImage: true, overridable: false },
  { id: 'empty_scene_adherence', label: 'Empty-scene adherence (bg survives? action space? landmark fidelity?)', producesImage: false, overridable: false, noTemplate: true },
  { id: 'qwen_insert', label: 'Qwen insert (crop-bounded)', producesImage: true, overridable: true, noTemplate: true },
  { id: 'cover', label: 'Cover render', producesImage: true, overridable: true, storyLevel: true },
  { id: 'cover_title_paintin', label: 'Cover title paint-in (glyph-masked Qwen + OCR gate)', producesImage: true, overridable: true, storyLevel: true, noTemplate: true },
  { id: 'style_check', label: 'Style consistency check', producesImage: false, overridable: false, storyLevel: true },
  // Reader's-eye pass: each page's text next to the image that shipped on it.
  { id: 'book_audit', label: 'Book audit — page text + shipped image, in reading order', producesImage: false, overridable: true, storyLevel: true },
  // Auditor bake-off: the frozen artifact of one level vs a list of models.
  { id: 'audit_replay', label: 'Audit replay — arc/beats/text audit on stored artifact, per model', producesImage: false, overridable: true, storyLevel: true },
  // The measurement for the hazard-reduction loop: how many render hazards do
  // this book's briefs (or beat SCENE lines) demand, by class.
  { id: 'scene_hazard_count', label: 'Scene hazard count — render hazards per page in the briefs, by class', producesImage: false, overridable: true, storyLevel: true },
  { id: 'outline_review', label: 'Outline review — compare reviewer models', producesImage: false, overridable: false, storyLevel: true },
  { id: 'text_refine', label: 'Text refine — full text in, full text out (rounds)', producesImage: false, overridable: true, storyLevel: true },
  { id: 'beats_scenes', label: 'Beats + scenes → fast review (time-to-lock)', producesImage: false, overridable: true, storyLevel: true },
  // Replays the scene review over a story's STORED briefs, so a reviewer-prompt
  // change is measurable: the clothing findings are deterministic, and the
  // briefs are frozen, so the only variable is the prompt (or the model).
  { id: 'scene_review_replay', label: 'Scene review replay (frozen briefs → does it fix the faults?)', producesImage: false, overridable: true, storyLevel: true },
  // Re-derives the clothing contract for an existing story and puts the new
  // costume descriptions next to the ones it shipped with — the way to measure a
  // change to the costume/distinguishability rules without generating a book.
  { id: 'story_bible_replay', label: 'Story bible replay (new costume rules vs what shipped)', producesImage: false, overridable: true, storyLevel: true },
  // The last untested writer stage: page text. Without it ~19% of the Sonnet
  // writer spend could not be compared against a cheaper model.
  { id: 'story_text_replay', label: 'Story text replay (writer A/B vs shipped text)', producesImage: false, overridable: true, storyLevel: true },
  // Every writer model x every writer stage in ONE experiment, scored. Add a
  // model via params.models, add a story via a testlab_sets member — the
  // comparison is re-run, never re-invented.
  { id: 'writer_compare', label: 'Writer compare (models x plan/bible/scenes/text, scored)', producesImage: false, overridable: false, storyLevel: true },
  // Runs the wardrobe review over a story's OWN shipped contract — does the
  // reviewer catch the costume fault that reached the page? Text only, no
  // avatar or image spend, so it can be run across several stories cheaply.
  { id: 'clothing_review', label: 'Wardrobe review (does it catch the bad costume?)', producesImage: false, overridable: true, storyLevel: true },
  // LLM judge rates the four final artifacts (beats / scene briefs / story text /
  // visual bible) on a 4×5 dimension rubric — one scorecard per story, comparable
  // across generation models. params.model picks the judge (default reviewer model).
  { id: 'story_scorecard', label: 'Story scorecard (LLM judge → beats/scene/text/VB scores)', producesImage: false, overridable: true, storyLevel: true },
  // Re-run the beats review on frozen beats: A/B the reviewer prompt (override) and
  // models (params.reviewModel CSV), iterate params.passes times, and with
  // params.scoreOutput the one evaluator scores the beats after each pass.
  { id: 'beats_review_replay', label: 'Beats review replay (prompt/model A/B, multi-pass, scored)', producesImage: false, overridable: true, storyLevel: true },
  // Arc only — cents per round instead of francs, so "how many review rounds
  // still pay" and "does rotating the reviewer beat repeating one" are
  // measurable. params.variants asks for N arcs in ONE call plus a merge pass,
  // to compare best-of-N against sequential review.
  { id: 'arc_rounds', label: 'Arc rounds (plan the arc, review it N times / best-of-N, scored each round)', producesImage: false, overridable: true, storyLevel: true },
  // Re-judge stored rounds with a DIFFERENT judge (params.scoreIds + params.judgeModel).
  // Nothing is rewritten — it measures the judge, so two judges' scores of the
  // identical text sit side by side on the Scores page.
  { id: 'score_rejudge', label: 'Re-judge stored scores with another judge (params.scoreIds, judgeModel)', producesImage: false, overridable: false, storyLevel: true },
  // Both runners existed server-side but were absent from this list, so the
  // dropdown could never select them — unreachable except by hand-posting.
  { id: 'garment_colour_fix', label: 'Garment colour fix (DINO+SAM mask → L*a*b* match)', producesImage: true, overridable: false },
  { id: 'style_repair', label: 'Style repair (story-wide)', producesImage: true, overridable: false, storyLevel: true },
  { id: 'avatar_realistic', label: 'Avatar pass 1 (realistic anchor)', producesImage: true, overridable: false, characterLevel: true },
  { id: 'avatar_style', label: 'Avatar pass 2 (style transfer)', producesImage: true, overridable: true, characterLevel: true },
  { id: 'avatar_eval', label: 'Avatar sheet eval', producesImage: false, overridable: true, characterLevel: true },
] as const;

export const testlabService = {
  getStories(params: { page?: number; limit?: number; artStyle?: string; storyType?: string; language?: string; search?: string; days?: number } = {}) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    });
    return api.get<{ stories: TestLabStory[]; pagination: TestLabPagination }>(`/api/admin/testlab/stories?${qs.toString()}`);
  },

  getTemplates() {
    return api.get<{ templates: Record<string, string | null> }>('/api/admin/testlab/templates');
  },

  getTextModels() {
    return api.get<{ models: TextModelInfo[]; defaultReviewModel: string; defaultWriterModel: string }>('/api/admin/testlab/text-models');
  },

  getBenchmarks() {
    return api.get<{ benchmarks: BenchmarkScene[] }>('/api/admin/testlab/benchmark');
  },

  addBenchmark(storyId: string, pageNumber: number, label?: string) {
    return api.post<{ id: number }>('/api/admin/testlab/benchmark', { storyId, pageNumber, label });
  },

  deleteBenchmark(id: number) {
    return api.delete<{ success: boolean }>(`/api/admin/testlab/benchmark/${id}`);
  },

  createExperiment(body: {
    stage: string;
    label?: string;
    promptOverride?: string | null;
    params?: Record<string, unknown>;
    targets?: { storyId: string; pageNumber?: number; coverType?: string; character?: string }[];
    benchmarkIds?: number[];
  }) {
    return api.post<{ id: number }>('/api/admin/testlab/experiments', body);
  },

  getExperiments(opts?: { limit?: number; days?: number; all?: boolean }) {
    const q = new URLSearchParams();
    if (opts?.limit) q.set('limit', String(opts.limit));
    if (opts?.all) q.set('all', '1');
    else if (opts?.days != null) q.set('days', String(opts.days));
    const qs = q.toString();
    return api.get<{ experiments: ExperimentSummary[] }>(`/api/admin/testlab/experiments${qs ? `?${qs}` : ''}`);
  },

  getExperiment(id: number) {
    return api.get<ExperimentDetail>(`/api/admin/testlab/experiments/${id}`);
  },

  getScores(storyId?: string) {
    const qs = storyId ? `?storyId=${encodeURIComponent(storyId)}` : '';
    return api.get<{ scores: ScoreRow[] }>(`/api/admin/testlab/scores${qs}`);
  },

  getEvalVersionPrompt(version: string) {
    return api.get<{ version: string; hash: string | null; prompt: string }>(`/api/admin/testlab/eval-version/${encodeURIComponent(version)}`);
  },

  redo(experimentId: number, resultIndex: number, promptOverride?: string | null, useCurrentTemplates?: boolean, extraRule?: string | null) {
    return api.post<{ started: boolean }>(
      `/api/admin/testlab/experiments/${experimentId}/redo`,
      { resultIndex, promptOverride: promptOverride || undefined, ...(useCurrentTemplates ? { useCurrentTemplates: true } : {}), ...(extraRule ? { extraRule } : {}) }
    );
  },

  getTestImage(storyId: string, imageType: string, pageNumber: number | null, versionIndex: number) {
    return api.get<{ imageData: string; isTest: boolean }>(
      `/api/admin/testlab/test-image/${encodeURIComponent(storyId)}/${imageType}/${pageNumber ?? 'null'}/${versionIndex}`
    );
  },

  getBaselineImage(storyId: string, pageNumber: number) {
    return api.get<{ imageData: string }>(
      `/api/admin/testlab/baseline-image/${encodeURIComponent(storyId)}/${pageNumber}`
    );
  },

  getBaselineCover(storyId: string, coverType: string) {
    return api.get<{ imageData: string }>(
      `/api/admin/testlab/baseline-cover/${encodeURIComponent(storyId)}/${coverType}`
    );
  },

  promote(storyId: string, pageNumber: number | null, versionIndex: number, setActive = true, imageType?: string) {
    return api.post<{ success: boolean }>('/api/admin/testlab/promote', { storyId, pageNumber, versionIndex, setActive, ...(imageType ? { imageType } : {}) });
  },

  // Test Lab sets — named, stage-typed collections of failing cases (any stage).
  getSets() {
    return api.get<{ sets: TestLabSet[] }>('/api/admin/testlab/sets');
  },
  createSet(name: string, stage: string, params?: Record<string, unknown>) {
    return api.post<{ id: number; name: string; stage: string }>('/api/admin/testlab/sets', { name, stage, params });
  },
  getSet(id: number) {
    return api.get<{ id: number; name: string; stage: string; params: Record<string, unknown>; members: TestLabSetMember[] }>(`/api/admin/testlab/sets/${id}`);
  },
  deleteSet(id: number) {
    return api.delete<{ success: boolean }>(`/api/admin/testlab/sets/${id}`);
  },
  pinToSet(setId: number, member: { target: Record<string, unknown>; params?: Record<string, unknown>; label?: string }) {
    return api.post<{ id: number }>(`/api/admin/testlab/sets/${setId}/members`, member);
  },
  unpinFromSet(setId: number, memberId: number) {
    return api.delete<{ success: boolean }>(`/api/admin/testlab/sets/${setId}/members/${memberId}`);
  },
  // opts.promptOverride is the reason sets exist: same cases, new prompt.
  runSet(setId: number, params?: Record<string, unknown>, opts: { promptOverride?: string | null; label?: string } = {}) {
    return api.post<{ id: number; members: number }>(`/api/admin/testlab/sets/${setId}/run`, { params, ...opts });
  },


  listFindings(filters: { category?: string; status?: string; file?: string } = {}) {
    const qs = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => { if (v) qs.set(k, v); });
    const q = qs.toString();
    return api.get<{ findings: EvalFinding[]; total: number }>(`/api/admin/testlab/findings${q ? `?${q}` : ''}`);
  },

  saveFinding(body: Partial<EvalFinding>) {
    return api.post<{ id: number; slug: string }>('/api/admin/testlab/findings', body);
  },

  setFindingStatus(slug: string, status: string, supersededBy?: string) {
    return api.patch<{ slug: string; status: string }>(`/api/admin/testlab/findings/${slug}`, {
      status, superseded_by: supersededBy,
    });
  },
};

export interface TestLabSet {
  id: number;
  name: string;
  stage: string;
  createdBy: string | null;
  createdAt: string;
  memberCount: number;
  // Recent runs of THIS set. The set is what anyone remembers three months on
  // ("the hard-to-segment cases"); an experiment number is not.
  runs?: { id: number; label: string | null; status: string; createdAt: string }[];
}

export interface TestLabSetMember {
  id: number;
  target: Record<string, unknown>;
  params: Record<string, unknown>;
  label: string | null;
  storyTitle: string | null;
  addedAt: string;
}

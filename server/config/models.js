/**
 * AI Model Configuration
 *
 * Centralized configuration for all AI models used in the application.
 * Change these values to update models across the entire pipeline.
 */

// Image aspect presets — the exact strings Grok Imagine and Gemini
// imageConfig.aspectRatio both accept. Use these everywhere instead of
// scattering '1:1' / '3:4' literals through the code.
const IMAGE_ASPECTS = {
  SQUARE: '1:1',
  A4: '3:4',          // portrait, matches A4 book format
  LANDSCAPE: '4:3',
  AVATAR: '9:16',     // tall portrait for character reference sheets
};

// Available text models
const TEXT_MODELS = {
  'claude-sonnet': {
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    maxOutputTokens: 64000,
    description: 'Claude Sonnet 4.6 - Best narrative quality'
  },
  'claude-opus': {
    provider: 'anthropic',
    modelId: 'claude-opus-5',
    maxOutputTokens: 32000,
    description: 'Claude Opus 5 - Strongest reviewer/critic ($5/$25 per 1M). Used for the split outline review (cross-model: Sonnet writes, Opus reviews).'
  },
  'claude-haiku': {
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5-20251001',
    maxOutputTokens: 8192,
    description: 'Claude Haiku 4.5 - Fast and affordable'
  },
  'gemini-2.5-pro': {
    provider: 'google',
    modelId: 'gemini-2.5-pro',
    maxOutputTokens: 65536,
    description: 'Gemini 2.5 Pro - High quality, large output'
  },
  'gemini-2.5-flash': {
    provider: 'google',
    modelId: 'gemini-2.5-flash',
    maxOutputTokens: 65536,
    description: 'Gemini 2.5 Flash - Fast with large output'
  },
  'gemini-2.5-flash-lite': {
    provider: 'google',
    modelId: 'gemini-2.5-flash-lite',
    maxOutputTokens: 65536,
    description: 'Gemini 2.5 Flash Lite - Cheapest ($0.10/$0.40 per 1M, ~6× cheaper than Flash)'
  },
  'gemini-2.0-flash': {
    provider: 'google',
    modelId: 'gemini-2.0-flash',
    maxOutputTokens: 8192,
    description: 'Gemini 2.0 Flash - Very fast'
  },
  'gemini-pro-latest': {
    provider: 'google',
    modelId: 'gemini-pro-latest',
    maxOutputTokens: 65536,
    description: 'Gemini Pro Latest (2.5 Pro) - High quality'
  },
  'grok-3-mini': {
    provider: 'xai',
    modelId: 'grok-3-mini',
    maxOutputTokens: 32768,
    description: 'Grok 3 Mini - Fast and cheap ($0.30/$0.50 per 1M tokens)'
  },
  'grok-3': {
    provider: 'xai',
    modelId: 'grok-3',
    maxOutputTokens: 32768,
    description: 'Grok 3 - Good quality ($3.00/$15.00 per 1M tokens)'
  },
  'grok-4-fast': {
    provider: 'xai',
    modelId: 'grok-4-1-fast-non-reasoning',
    maxOutputTokens: 65536,
    description: 'Grok 4 Fast - Very cheap, 2M context ($0.20/$0.50 per 1M tokens)'
  },
  // Latest Grok (2026-08-12) via OpenRouter. No separate 4.x "flash" exists —
  // grok-4-fast above is the cheap tier. Pricing from the OpenRouter catalogue.
  'grok-4.6': {
    provider: 'openrouter',
    modelId: 'x-ai/grok-4.6',
    maxOutputTokens: 32768,
    description: 'Grok 4.6 (xAI, latest) via OpenRouter (~$2.00/$6.00 per 1M)'
  },
  // OpenRouter-hosted models (OpenAI-compatible) for A/B testing cheap
  // alternatives on eval/consolidation. Needs OPENROUTER_API_KEY. Use via
  // model override (dev panel / MODEL_DEFAULTS), never the default for German
  // story prose until a quality A/B proves it.
  'qwen-max': {
    provider: 'openrouter',
    modelId: 'qwen/qwen-max',
    maxOutputTokens: 8192,
    description: 'Qwen-Max (Alibaba) via OpenRouter - strongest Qwen, ~$1.6/$6.4 per 1M'
  },
  'qwen-plus': {
    provider: 'openrouter',
    modelId: 'qwen/qwen-plus',
    maxOutputTokens: 8192,
    description: 'Qwen-Plus (Alibaba) via OpenRouter - cheap reasoning, ~$0.26/$0.78 per 1M'
  },
  // Compliance-eval candidates (A/B 2026-07-18). Stronger reasoners than
  // qwen-plus for severity discipline, still far cheaper than Sonnet.
  'qwen3-max': { provider: 'openrouter', modelId: 'qwen/qwen3-max', maxOutputTokens: 8192, description: 'Qwen3-Max via OpenRouter (~$0.78/$3.9)' },
  'deepseek-v32': { provider: 'openrouter', modelId: 'deepseek/deepseek-v3.2', maxOutputTokens: 8192, description: 'DeepSeek V3.2 via OpenRouter (~$0.27/$0.4)' },
  'glm-46': { provider: 'openrouter', modelId: 'z-ai/glm-4.6', maxOutputTokens: 8192, description: 'GLM-4.6 (Zhipu) via OpenRouter (~$0.5/$2.0)' },
  'kimi-k2': { provider: 'openrouter', modelId: 'moonshotai/kimi-k2', maxOutputTokens: 8192, description: 'Kimi K2 (Moonshot) via OpenRouter (~$0.57/$2.3)' },
  'qwen-vl': {
    provider: 'openrouter',
    modelId: 'qwen/qwen2.5-vl-72b-instruct',
    maxOutputTokens: 8192,
    description: 'Qwen2.5-VL 72B (vision) via OpenRouter - for image-eval A/B vs Gemini'
  },
  // Qwen3-VL (2026): strong bbox/spatial grounding, cheap. Candidate to A/B
  // against Gemini for image quality/semantic eval + bbox (Lab). NOTE: Qwen bbox
  // format is [x0,y0,x1,y1] 0-1000 vs Gemini [y0,x0,y1,x1] — parsing must adapt.
  'qwen3-vl': {
    provider: 'openrouter',
    modelId: 'qwen/qwen3-vl-32b-instruct',
    maxOutputTokens: 8192,
    description: 'Qwen3-VL 32B (vision) via OpenRouter - spatial/bbox leader, ~$0.10/$0.42 per 1M'
  },
  'qwen3-vl-235b': {
    provider: 'openrouter',
    modelId: 'qwen/qwen3-vl-235b-a22b-instruct',
    maxOutputTokens: 8192,
    description: 'Qwen3-VL 235B (vision) via OpenRouter - larger, ~$0.21/$1.90 per 1M'
  },
  'gpt-4o-mini': {
    provider: 'openrouter',
    modelId: 'openai/gpt-4o-mini',
    maxOutputTokens: 8192,
    description: 'GPT-4o mini (vision) via OpenRouter - cheap image-eval A/B (~$0.15/$0.60 per 1M)'
  },
  // GPT-5.6 family (2026-07-09) via OpenRouter. Luna = cheap tier, Sol = strong
  // tier. Pricing from the OpenRouter catalogue. For scoring/writer A/B in the Lab.
  'gpt-5.6-luna': { provider: 'openrouter', modelId: 'openai/gpt-5.6-luna', maxOutputTokens: 16384, description: 'GPT-5.6 Luna (OpenAI) via OpenRouter - cheap tier (~$0.10/$0.60 per 1M)' },
  // Cheap reviewer candidates (2026-08-15 beats-reviewer bake-off; see docs/decisions.md)
  'gemini-3.7-flash': { provider: 'openrouter', modelId: 'google/gemini-3.7-flash', maxOutputTokens: 16384, description: 'Gemini 3.7 Flash (Google, 2026-08-13) via OpenRouter (~$0.38/$1.88 per 1M)' },
  'deepseek-v4-pro-0813': { provider: 'openrouter', modelId: 'deepseek/deepseek-v4-pro-0813', maxOutputTokens: 16384, description: 'DeepSeek V4 Pro 0813 rev via OpenRouter (~$0.43/$0.87 per 1M)' },
  'glm-5.2': { provider: 'openrouter', modelId: 'z-ai/glm-5.2', maxOutputTokens: 16384, description: 'GLM 5.2 (Z-ai) via OpenRouter (~$0.49/$1.54 per 1M)' },
  'minimax-m3': { provider: 'openrouter', modelId: 'minimax/minimax-m3', maxOutputTokens: 16384, description: 'MiniMax M3 via OpenRouter (~$0.30/$1.20 per 1M)' },
  // Neutral judge for reviewer bake-offs: third vendor, so it has no
  // self-preference stake when comparing Anthropic/xAI/DeepSeek reviewers.
  // Pinned to the explicit id, not the '-latest' alias, so scores stay comparable.
  'gemini-3.1-pro': { provider: 'openrouter', modelId: 'google/gemini-3.1-pro-preview', maxOutputTokens: 16384, description: 'Gemini 3.1 Pro (Google) via OpenRouter (~$2.00/$12.00 per 1M) — neutral judge' },
  'qwen3.8-max': { provider: 'openrouter', modelId: 'qwen/qwen3.8-max', maxOutputTokens: 16384, description: 'Qwen3.8 Max (Alibaba flagship) via OpenRouter (~$2.00/$6.00 per 1M)' },
  'qwen3.8-27b': { provider: 'openrouter', modelId: 'qwen/qwen3.8-27b', maxOutputTokens: 16384, description: 'Qwen3.8 27B (2026-08-14) via OpenRouter (~$0.45/$3.20 per 1M)' },
  'gpt-5.6-luna-pro': { provider: 'openrouter', modelId: 'openai/gpt-5.6-luna-pro', maxOutputTokens: 16384, description: 'GPT-5.6 Luna Pro (OpenAI) via OpenRouter (~$0.10/$0.60 per 1M)' },
  'gpt-5.6-sol': { provider: 'openrouter', modelId: 'openai/gpt-5.6-sol', maxOutputTokens: 16384, description: 'GPT-5.6 Sol (OpenAI) via OpenRouter - strong tier (~$5.00/$30.00 per 1M)' },
  'gpt-5.6-sol-pro': { provider: 'openrouter', modelId: 'openai/gpt-5.6-sol-pro', maxOutputTokens: 16384, description: 'GPT-5.6 Sol Pro (OpenAI) via OpenRouter (~$5.00/$30.00 per 1M)' },
  'deepseek-v3': {
    provider: 'openrouter',
    modelId: 'deepseek/deepseek-chat',
    maxOutputTokens: 8192,
    description: 'DeepSeek V3 via OpenRouter - cheapest strong reasoner, ~$0.26/$1.03 per 1M'
  },
  // DeepSeek V4 (GA 2026-07-20) via OpenRouter. 1M context, up to 384K output —
  // high maxOutputTokens so the split outline-review call (asks 32K) and even
  // the full writer draft (64K) aren't truncated. Cheap reviewer candidate vs
  // Opus 5 ($5/$25): Flash is ~85× cheaper output, Pro ~29×.
  'deepseek-v4-pro': {
    provider: 'openrouter',
    modelId: 'deepseek/deepseek-v4-pro',
    maxOutputTokens: 64000,
    description: 'DeepSeek V4 Pro via OpenRouter - top reasoning, 1M context (~$0.44/$0.87 per 1M)'
  },
  'deepseek-v4-flash': {
    provider: 'openrouter',
    modelId: 'deepseek/deepseek-v4-flash',
    maxOutputTokens: 64000,
    description: 'DeepSeek V4 Flash via OpenRouter - fast & very cheap, 1M context (~$0.14/$0.28 per 1M)'
  }
};

// Default model selections for each task
const MODEL_DEFAULTS = {
  // Text generation models
  idea: 'claude-sonnet',               // Story idea generation
  outline: 'claude-sonnet',            // Story outline generation

  // ── Split outline review (testing-backlog #2: cross-model review) ──
  // When splitOutlineReview is true (default), the unified story call (writer,
  // Sonnet) SKIPS its self-critique; a second call by outlineReviewModel (Opus)
  // receives the full writer output + the same analysis instructions and emits
  // ---ANALYSIS--- + FIXES REQUIRED + ---STORY PAGES--- patches. The two
  // outputs are concatenated and parsed by the unchanged parsers. Reviewer
  // failure never blocks generation (unpatched draft ships with a loud
  // warning). Env overrides let staging flip either knob without a deploy.
  //
  // Reviewer = DeepSeek V4 Pro (was claude-opus). Test Lab compare runs on the
  // same shared draft: pro raised 58 fixes vs claude-sonnet's 15 locally and 16
  // vs 14 on staging — more findings per pass, at roughly a tenth of the
  // Anthropic cost ($0.02 vs $0.22 per review). It is an OpenRouter model, so
  // its wall-clock depends on which upstream serves it; textModels.js sorts
  // OpenRouter routing by throughput for exactly that reason. Reviewer failure
  // is already non-fatal, so a bad route degrades to the unpatched draft rather
  // than blocking a story.
  // Beats reviewer. grok-4.6 since 2026-08-15: measured best of 8 candidates on
  // a stored story under THREE independent judges (Lab experiments 655/656/669/
  // 672) — neutral judge 8.4 vs raw 5.7, while the previous default landed at
  // 5.8 (flat). See docs/decisions.md. Slower (~277s vs ~90s) for ~$0.03 more.
  outlineReviewModel: process.env.OUTLINE_REVIEW_MODEL || 'grok-4.6',
  // The three reviews used to share outlineReviewModel, so switching the BEATS
  // reviewer silently moved the scene and wardrobe reviews too. They are
  // separate decisions with separate evidence and now separate keys.
  // Scene: measured on a stored story (Lab 677/680/681/682, three judges) —
  // reviewers cannot beat leaving good briefs alone (baseline 8.6/7.8/9.2), and
  // grok was the WORST arm (8.6 neutral) because it rewrites most. deepseek is
  // best-or-tied under two judges, and is what produced these briefs.
  sceneReviewModel: process.env.SCENE_REVIEW_MODEL || 'deepseek-v4-pro',
  // Wardrobe review: never measured. Pinned to the pre-2026-08-15 model so it
  // does not inherit a reviewer chosen on beats evidence.
  clothingReviewModel: process.env.CLOTHING_REVIEW_MODEL || 'deepseek-v4-pro',
  // Judge for the model-comparison scorecard. At-least-Sonnet-level on purpose —
  // a cheap judge (Luna, flash) scores too loosely to compare generators fairly.
  scorecardJudge: process.env.SCORECARD_JUDGE || 'claude-sonnet',
  splitOutlineReview: process.env.SPLIT_OUTLINE_REVIEW
    ? process.env.SPLIT_OUTLINE_REVIEW !== 'false'
    : true,
  storyText: 'claude-sonnet',          // Story narrative text
  sceneDescription: 'claude-sonnet',    // Initial scene expansion — Sonnet only. Haiku produced
                                        // unstable clothing labels (e.g. "costumed:medieval swiss
                                        // huntsman" instead of the canonical "costumed:medieval")
                                        // and inconsistent metadata. Unified mode normally skips
                                        // this call entirely; only used when prose is missing.
  // Scene iteration/retry — the full-scene re-expansion during repair. Moved to
  // Qwen for cost (2026-07-12): its diagnosis + fix quality matched Sonnet in the
  // A/B; the one gap (copying German Visual-Bible names into English prose) is
  // handled by the tightened LANGUAGE RULES in scene-iteration.txt. Key-guarded
  // to sonnet via resolveSceneIterationModel(). NOTE: initial sceneDescription
  // expansion stays on Sonnet — only the repair-iterate moved.
  sceneIteration: process.env.SCENE_ITERATE_MODEL || 'qwen-plus',

  // Eval/consolidation model — the swappable, cost-sensitive stage (NOT story
  // prose). Changed to Qwen for the cost A/B (2026-07-12). resolveEvalModel()
  // below falls back to claude-sonnet when OPENROUTER_API_KEY is unset, so a
  // forgotten key degrades to Sonnet rather than breaking generation.
  // Env override (EVAL_MODEL) lets staging flip without a deploy.
  evalModel: process.env.EVAL_MODEL || 'qwen-plus',

  // Stage-2 prompt-compliance model — SEPARATE from evalModel (2026-07-19).
  // A/B on the Pixar showcase: qwen-plus/haiku/deepseek/kimi all flood false
  // CRITICALs (expression, left/right mirror, motion verbs, "missing" on a
  // matched figure) → tanked good pages to 0 and drove 12-13 wasted repair
  // units/round. qwen3-max + the fixed compliance prompt (presence-is-input +
  // never-CRITICAL gate) tracks Sonnet on the good pages at ~$0.56/story vs
  // Sonnet's $2.16. Sonnet stays the key-missing fallback. Env COMPLIANCE_MODEL.
  complianceModel: process.env.COMPLIANCE_MODEL || 'qwen3-max',

  // Image models
  pageImage: 'grok-imagine',                 // Regular page images ($0.02/image — vs $0.04 Gemini)
  coverImage: 'grok-imagine',                // Cover images ($0.02/image)
  avatar: 'grok-imagine',                    // Character avatars (clothing variants). Switched from
                                              // Gemini 2.5 Flash Image because Gemini's safety filter
                                              // rejects adult-face photos with IMAGE_OTHER, leaving
                                              // characters stuck at avatars.status='pending' forever.

  // Per-page routing by scene complexity (sceneRouting = 'auto')
  simplePageImage: 'grok-imagine',            // Simple scenes: all chars foreground ($0.02)
  complexPageImage: 'grok-imagine',           // Complex scenes: also Grok by default ($0.02, was Gemini $0.04)

  // Quality evaluation models
  // Grok vision is supported via callGrokVisionAPI() — set qualityEval to a grok model to use it
  qualityEval: 'gemini-2.5-flash',          // Image quality evaluation. Lite missed small distant targets (e.g. paper-on-bench) and produced confused "X pointing at Y" reads — the resulting bad fix-targets triggered repair loops that cost more than the eval-tier upgrade.
  bboxDetection: 'gemini-2.5-flash',        // Bounding box detection — kept on the same tier as qualityEval so missing-object detection lines up with the eval that uses it.

  // Image-prompt compression — the head rewrite in shrinkPromptForModel when a
  // page prompt exceeds the backend's char budget. NOT a utility call: what it
  // deletes never reaches the image model. Flash was measured returning 2,130
  // chars against a 5,452 allowance on p9 of job_1786484554633 (39% of what it
  // was given, a 71% cut of the prose when 26% would have fit) — four of five
  // characters lost their hats. Owner decision 2026-08-12: DeepSeek V4 Pro.
  promptCompress: process.env.PROMPT_COMPRESS_MODEL || 'deepseek-v4-pro',

  // Utility models (inspection, visual bible, etc.)
  utility: 'gemini-2.5-flash',         // Fast utility tasks. 2.0-flash RETIRED by Google
                                       // (404 "no longer available", found 2026-07-18 when the
                                       // Test Lab style gate silently skipped) — every
                                       // compareImageStyles/analyzeImageStyle/VB-utility call
                                       // was failing with it.

  // Two rescue-path calls moved OFF Sonnet for cost (owner Pt 9 "Downgrade them",
  // 2026-07-26) — but to qwen3-max, NOT gemini-flash (owner correction same day:
  // "those have spatial reasoning, they probably need qwen max"). scene_validation
  // repairs a scene DESCRIPTION from composition issues (left/right, counts, who's
  // where) — real spatial/compositional text reasoning that flash reasons poorly
  // about; scene_rewrite paraphrases a blocked scene. qwen3-max is the codebase's
  // already-trusted spatial reasoner (see complianceModel) and still ~4× cheaper
  // than Sonnet. Resolved via guardModel() → falls back to claude-sonnet (NOT a
  // weak model) when OPENROUTER_API_KEY is unset. Env-overridable for staging.
  sceneValidationRepair: process.env.SCENE_VALIDATION_MODEL || 'qwen3-max', // sceneValidator.repairScene JSON fix (spatial)
  sceneRewrite: process.env.SCENE_REWRITE_MODEL || 'qwen3-max',             // rewriteBlockedScene safety rewrite

  // DEAD CONFIG (audit 2026-07-09): only read by the never-wired mask-inpaint
  // dispatcher (inpaintWithMask etc. in images.js — see DEAD CODE banners).
  // Live inpaint dispatches via IMAGE_MODELS[pageImage].backend instead.
  // Changing this value changes NOTHING. Kept per user decision (mark, not delete).
  inpaintBackend: 'grok',              // 'gemini', 'runware', or 'grok' ($0.02/repair via Grok edit)

  // Figure-silhouette backend for char-repair blend masks.
  // 'rembg' = U2-Net salient-object (masks every figure in the crop);
  // 'mobilesam' = box-prompted MobileSAM in photo_analyzer (/figure-mask) —
  // selects only the target figure, won the 2026-07-10 mask shootout
  // (docs/research-log.html). Falls back to rembg when the endpoint is
  // unavailable or returns nothing. Default since 2026-07-15: box-prompted SAM
  // isolates the single figure; rembg (salient-object, no box) grabbed the
  // wrong object on loose boxes that also span a bright doorway/window. Set
  // FIGURE_MASK_BACKEND=rembg to revert.
  figureMaskBackend: process.env.FIGURE_MASK_BACKEND || 'mobilesam',

  // Figure DETECTION backend (which figure boxes the pipeline uses).
  // 'gemini' = the Gemini vision bbox call (detectAllBoundingBoxes) — today's
  // default, cheap + fast. 'grounding-dino' = local Grounded-SAM: GroundingDINO
  // (photo_analyzer /detect-figures-text) text->box from each character's full
  // identity, then MobileSAM (/figure-mask) box->silhouette. Validated 5/5 on a
  // 5-figure page incl. an occluded figure (docs/research-log.html). Free/local
  // but ~15s/figure CPU + ~1.9GB RAM. Fully local — on a collision it retries
  // in DINO, else falls back to today's Gemini 2-pass bbox (no external API).
  //
  // DEFAULT EVERYWHERE, INCLUDING PRODUCTION (owner, 2026-08-17). The staged
  // rollout is over: Test Lab set #12 ("Hard to segment", 6 pages / 27 figures)
  // comes back clean on 5 of 6 pages, and the sixth is a man ~80% hidden behind
  // two children — what is occluded cannot be extracted, and the owner has
  // accepted that as the ceiling. Verified at exp #739; the set's run history is
  // linked from the Sets tab, so this is re-checkable without an experiment id.
  //
  // Two operational facts that come with the flip, neither a defect:
  //   - The analyzer loads GroundingDINO lazily (~90s) and unloads it after
  //     600s idle, but that load is not meant to land on a story: /warmup
  //     preloads it while the user is still in the wizard, and `ensureWarm`
  //     TELLS it to (`{dino: …}` from runtime()) rather than letting it guess
  //     from an env var of its own — that guess is what made it skip DINO while
  //     detection asked for it. A Gemini fallback is resilience if it happens,
  //     not the expected path; EVERY story falling back means the model cannot
  //     load there at all (RAM), which is a different failure.
  //   - Cost is CPU and RAM on the analyzer (~15s/figure, ~1.9GB), not an API
  //     bill. Detection itself becomes free.
  // Value lives in server/config/runtime.js — same in every environment, so
  // staging tests what production runs. No env override: that is how prod and
  // staging silently diverged on the pipeline mode.
  figureDetectionBackend: require('./runtime').runtime('figureDetectionBackend'),

  // Art styles GroundingDINO detection is allowed on. GDINO grounds on the
  // clothed-figure shape + clothing colour (via the concise buildGroundingPrompt),
  // so any style that renders a recognisable human figure works — validated
  // 2026-07-15 across the range: realistic 0.69, anime 0.59, watercolor 0.63.
  // The ONLY exclusions are styles that break the human-figure assumption:
  // chibi (super-deformed head/body), pixel (blocky low-res), lowpoly (geometric
  // faceted). steampunk/cyber/comic/cartoon/manga/concept/oil/pixar all render a
  // clothed human and are eligible. The list lives in config/runtime.js.
  figureDetectionEligibleStyles: require('./runtime').runtime('figureDetectionEligibleStyles'),

  // Image generation backend (can be overridden in dev mode)
  // 'grok' = Grok Imagine (default — $0.02/image, half of Gemini)
  // 'gemini' = Gemini 2.5 Flash Image ($0.04/image, better cross-page style consistency)
  // 'runware' = Runware FLUX Schnell (super cheap, testing only)
  // Tradeoff with grok: weaker style consistency across pages — auto-repair
  // and character-repair passes catch most of it.
  imageBackend: 'grok',

  // Feature flags for generation pipeline
  // DEAD CONFIG (audit 2026-07-09): enableAutoRepair is read by nothing — the
  // in-generation auto-repair branch it gated is unreachable (its function
  // param defaults false and no caller flips it). Repair happens in
  // runUnifiedRepairPipeline instead. Kept per user decision (mark, not delete).
  enableAutoRepair: false,             // Auto-repair: inpaint fixable issues (Runware SDXL/FLUX)
  useGridRepair: false,                // Grid-based artifact repair: OFF - we only want character fixes
  enableQualityRetry: false,           // Quality retry: regenerate images scoring below threshold
  enableFinalChecks: false,            // Final checks: run entity consistency + one character fix pass
  checkOnlyMode: false,                // Check-only mode: run checks but skip all regeneration
  generateEmptyScenes: true,           // Pre-generate one empty scene per page (no characters) so
                                       // scene-composite step 1 can REUSE it instead of regenerating
                                       // (saves ~$0.02 + ~5s per page, and keeps the BG consistent
                                       // with anything else that wants to use it). When false,
                                       // composite generates its own clean BG from emptyScenePrompt
                                       // and direct-path pages skip the empty-scene step entirely.
  // Scene composite was killed 2026-05-16 (score-0 outputs; depopulate/diff/
  // blend stages unreliable). This flag is now the single source of truth for
  // the gate — false → decidePageRoute always returns path:'direct', so every
  // page goes through the direct-prompt path. refMode is computed independently
  // and is unaffected. The composite pipeline (sceneComposite.js) survives only
  // in the admin test-models route. Do not re-enable without passing an
  // end-to-end gate (see docs/decisions.md + project memory).
  // (phantomPoseRender MODEL_DEFAULTS flag removed 2026-07-04 — it was read by
  // no code; imageRouter reads the per-request inputData.phantomPoseRender.)
  enableSceneComposite: false,
  enableTextOverlay: true,             // Global kill switch for the text-overlay pipeline. ON by
                                       // default — `1st-grade` stories use the a4-overlay layout
                                       // (text composited onto image, calm-zone reserved). Set to
                                       // false to disable the entire post-gen text-region phase
                                       // for every story regardless of layout. The per-story
                                       // `inputData.layout.textInImage === false` (set by
                                       // resolveLayout for `standard`/`advanced`) is the normal
                                       // route to skip overlay; this flag is the kill switch.
  // Reference mode for character refs / VB grid attached to page generation.
  //   'strict'      — photo + costumed + styled avatars; full VB grid (current default)
  //   'loose'       — costumed + styled; photo only on close-ups; identity cells without grid frame
  //   'styled-only' — only the in-art-style avatar; identity cells without grid frame
  //   'off'         — no character refs, no VB grid (single-pass, prose-only)
  // Looser modes trade identity stability for painterly cohesion.
  referenceMode: 'loose',
  // Single-pass scene mode — when true, skip empty-scene plate generation
  // and render the page in one pass (populated prose only). Recommended
  // pairing with referenceMode != 'strict'.
  // Re-enabled empty-scene plate generation (singlePassScene: false) after
  // observing that comic-style stories rendered pages in generic semi-painted
  // realism instead of comic, because Grok had no style-anchored backdrop to
  // commit to. Empty-scene pass renders the location IN the art style first
  // and feeds it back as sceneBackground for the page-render call — Grok then
  // composites characters onto a style-consistent canvas. Adds 1 image gen
  // per location vantage (cached across pages sharing the vantage). Cost:
  // ~$0.02/vantage × usually 2-3 vantages = ~$0.04-0.06/story.
  singlePassScene: false,
  // Unified scene prose: Sonnet writes the ~300-word scene paragraph directly
  // in the unified story pass (instead of emitting a tight JSON hint that Haiku
  // then expands). Eliminates the Haiku scene-expansion call for initial gen.
  // Haiku keeps its classifier roles (iterate repair, feedback consolidator).
  // false = legacy Haiku-expansion path. Flip to true once the new parser
  // path is validated on a test story.
  unifiedSceneProse: true,

  // Mechanical garment-colour repair (server/lib/garmentColourFix.js), the
  // consumer of the entity check's `garmentColourMismatches` channel. Runs as
  // Step 1b on ONLY the pages that channel names — DINO garment box -> SAM mask
  // -> L*a*b* match toward the styled avatar, scaled by a skin-probed lighting
  // factor. Needs the local photo_analyzer (GroundingDINO + MobileSAM); fails
  // soft, so pages ship uncorrected if it is unavailable.
  // Env: GARMENT_COLOUR_FIX=false to disable without a deploy.
  garmentColourFix: process.env.GARMENT_COLOUR_FIX
    ? process.env.GARMENT_COLOUR_FIX !== 'false'
    : true,

  // Identity TIEBREAKER — DEFAULT OFF, deliberately, and NOT IMPLEMENTED yet.
  // The cross-check itself (server/lib/figureIdentityCheck.js) always runs and
  // is free: it compares the Set-of-Mark naming on the detection boxes against
  // the quality eval's independent matches[] and blocks a garment recolour on a
  // `disputed` figure. This flag governs only the follow-up MODEL CALL that
  // would RESOLVE a dispute (SAM cutout of the figure + candidate styled
  // avatars → "which avatar is this?"), which costs money per disputed figure
  // and does not exist yet — resolveIdentityTiebreak() is a stub returning
  // null. Turning this on today changes nothing except an extra no-op branch.
  // Env: IDENTITY_TIEBREAK=true.
  identityTiebreak: process.env.IDENTITY_TIEBREAK === 'true',


  // ─── Style-repair production wiring (Pt 10, owner directive 2026-07-31) ──
  // When true (default), the Step-5 style-consistency audit's outliers —
  // pages AND covers — are repainted toward the dominant style cluster via
  // server/lib/styleRepair.js (planStyleRepair → repairPageStyle), one
  // repaint attempt per outlier, gated by checkStyleMatch. The repainted
  // image is stored as a new version through the normal version plumbing.
  // Env override: STYLE_REPAIR_PRODUCTION=false to fall back to
  // detection-only. Model per styleRepairModel ('gemini' | 'grok').
  // RE-ENABLED 2026-08-09 with a WORKING recipe (supersedes the 2026-08-09
  // disable): repairPageStyle now sends a validated, character-focused,
  // feature-preserving prompt RAW to the Gemini image edit (prompt-only, no
  // style-reference image, temp 0.7, retry on safety no-image). Validated on
  // p3/p10/initial page — photographic adult faces become watercolor while
  // eyes/eyewear/identity are preserved (keeps glasses if present, never
  // invents them). GEMINI is the engine (it restyles faces; Grok no-ops on
  // this edit — the earlier "Gemini refuses" verdict was a prompt bug, not a
  // real refusal). A page Gemini refuses after retries keeps its original.
  styleRepairProduction: process.env.STYLE_REPAIR_PRODUCTION
    ? process.env.STYLE_REPAIR_PRODUCTION !== 'false'
    : true,
  styleRepairModel: process.env.STYLE_REPAIR_MODEL || 'gemini',

  // Output aspect ratios — one config per image type, read by every
  // generation / iterate / repair path. Defaults: A4 portrait for pages
  // and covers; 9:16 for avatars. Change the default here to reshape
  // every generated image in the pipeline.
  pageAspect: IMAGE_ASPECTS.A4,
  coverAspect: IMAGE_ASPECTS.A4,
  avatarAspect: IMAGE_ASPECTS.AVATAR,

  // ─── Avatar 2×4 sheet: per-pass backend ──────────────────────────────
  // Round 1 (realistic identity anchor) stays on Grok — it preserves hair
  // length + outfit better than Gemini (which drifts identity). Round 2
  // (art/style transfer) is now ALSO Grok. Re-tested 2026-08-06 (Test Lab
  // exps #336/#341/#344): gemini-2.5-flash-image barely stylises — it returns a
  // near-photographic sheet regardless of prompt strength (prompt A/B #339
  // moved it almost nothing) — while Grok produces strong, correct watercolour /
  // pixar / anime AND handled an adult face (Hans) with no content-moderation
  // refusals. This reverses the 2026-07-19 verdict (that A/B was gemini-3-pro).
  // Grok's occasional child-avatar moderation false-reject is covered by the
  // 3-attempt retry in runStyleTransferPass. Revert via AVATAR_STYLE_BACKEND.
  avatarStyleTransferBackend: process.env.AVATAR_STYLE_BACKEND || 'grok', // 'gemini' | 'grok'
  avatarStyleTransferModel: process.env.AVATAR_STYLE_MODEL || 'gemini-2.5-flash-image', // only used when backend='gemini'

  // Vision judge for the 2×4 sheet split eval (evaluateSheetSplit). gemini-2.5-flash:
  // qwen3-vl is ~6× cheaper but WON'T apply the strict "whole head" rule — it
  // counts a top-cropped chin as head=yes, so it misses headless/partial-head
  // body crops (verified: Lukas chin-only crop → qwen head=yes, gemini head=no,
  // both consistent across runs). Eval is ~$0.002/sheet either way, so
  // correctness wins. Set SHEET_EVAL_MODEL=qwen3-vl to trade it back for cost.
  // Must be a TEXT_MODELS key.
  sheetEvalModel: process.env.SHEET_EVAL_MODEL || 'gemini-2.5-flash',
  // The BODY-row head check is NOT done by Gemini at all: any VLM hallucinates a
  // head on a headless torso because head+body co-occur in training (POPE-
  // adversarial object hallucination — verified deterministically, even
  // gemini-2.5-pro is only a partial mitigation and costs ~2.4¢/call). Head
  // presence on the body row is owned by local YOLO pose (Python /pose-heads,
  // detectBodyRowHeads in character2x4Sheet.js — $0, deterministic; validated on
  // set #2 / exp #419: headed 0.86–1.00, headless 0.00–0.10, no overlap). The
  // bodies row eval therefore runs on the cheap sheetEvalModel (flash) for
  // feet/angles/outfit/proportions/background, and pose gates the head axis.

  // ─── Composite Cover mode ────────────────────────────────────────────
  // When true, cover pages (frontCover, initialPage, backCover) skip the
  // normal direct render path and instead use a manual
  // composite + 2-pass Grok edit:
  //   1. Pull the story's costumed avatars for each character.
  //   2. Background-remove via Python rembg service.
  //   3. Composite onto white canvas with prop layered in front, in a
  //      gender-alternated centre-out arrangement (mains in centre).
  //   4. Pass 1: Grok edit with strict pose-redraw prompt.
  //   5. Cut figures from pass 1, composite onto landmark photo.
  //   6. Pass 2: Grok edit applies watercolor + ground material + title.
  // Off by default — flip to true once validated on production stories.
  // Both initial cover gen and iterate-cover honor this flag.
  compositeCovers: true,

  // ─── App-side cover typography ───────────────────────────────────────
  // When true, covers are generated TEXTLESS (no baked title / dedication /
  // "magicalstory.ch") and the typography is composited app-side by
  // server/lib/coverTypography.js onto the textless art:
  //   • frontCover → colored 3D title (colour + font + placement from the art
  //     and the hero garment, placed clear of the figure boxes)
  //   • initialPage → the user's dedication (Widmung), high-contrast script
  //   • backCover → "magicalstory.ch", consistent small mark in a bottom corner
  // The textless art is stored alongside the composited image so title /
  // dedication edits re-render instantly with no AI call.
  // ON by default — set APP_SIDE_COVER_TYPE=false to fall back to baked-in cover text.
  appSideCoverType: process.env.APP_SIDE_COVER_TYPE !== 'false',
};

// Available inpaint backends
const INPAINT_BACKENDS = {
  'gemini': {
    name: 'Gemini',
    description: 'Gemini 2.5 Flash Image - High quality, more expensive (~$0.03/image)',
    costPerImage: 0.03,
    model: 'gemini-2.5-flash-image'
  },
  'runware-sdxl': {
    name: 'Runware SDXL',
    description: 'Runware SDXL - Good quality for objects/backgrounds (~$0.002/image)',
    costPerImage: 0.002,
    model: 'runware:101@1'
  },
  'runware-flux-fill': {
    name: 'Runware FLUX Fill',
    description: 'FLUX Fill - Best quality for face repair (~$0.05/image)',
    costPerImage: 0.05,
    model: 'runware:102@1'
  },
  // Legacy alias
  'runware': {
    name: 'Runware SDXL',
    description: 'Runware SDXL - Good quality, cheap (~$0.002/image)',
    costPerImage: 0.002,
    model: 'runware:101@1'
  }
};

// Image generation backends
const IMAGE_BACKENDS = {
  'gemini': {
    name: 'Gemini',
    description: 'Google Gemini - Best quality, higher cost (~$0.03-0.04/image)',
    costPerImage: 0.035
  },
  'runware': {
    name: 'Runware FLUX Schnell',
    description: 'FLUX Schnell via Runware - Ultra cheap ($0.0006/image), good for testing',
    costPerImage: 0.0006
  },
  'grok': {
    name: 'Grok Imagine (xAI Aurora)',
    description: 'xAI Grok Imagine - Good quality, cheap ($0.02/image), supports reference images',
    costPerImage: 0.02
  }
};

// Image model configurations
// maxPromptLength: Maximum characters for the prompt (API limit)
// maxCharactersPerScene: Max characters in scene hints (Grok handles more faces via ref images)
const IMAGE_MODELS = {
  'gemini-2.5-flash-image': {
    modelId: 'gemini-2.5-flash-image',
    description: 'Gemini 2.5 Flash Image - Fast image generation',
    backend: 'gemini',
    supportsThinking: false,
    temperature: 0.5,  // Lower temp for more consistent character reproduction
    maxPromptLength: 30000,  // Gemini supports very long prompts
    maxCharactersPerScene: 5
  },
  'gemini-3-pro-image-preview': {
    modelId: 'gemini-3-pro-image-preview',
    description: 'Gemini 3 Pro Image Preview - Higher quality images',
    backend: 'gemini',
    supportsThinking: true,  // Thinks by default; thinkingConfig.includeThoughts returns thought text
    temperature: 0.5,  // Lower temp for more consistent character reproduction
    maxPromptLength: 30000,
    maxCharactersPerScene: 5
  },
  'flux-schnell': {
    modelId: 'runware:5@1',
    description: 'FLUX Schnell via Runware - Ultra fast, cheap ($0.0006/image)',
    backend: 'runware',
    maxPromptLength: 2900,  // Runware limit is 3000, leave margin
    maxCharactersPerScene: 5
  },
  'flux-dev': {
    modelId: 'runware:6@1',
    description: 'FLUX Dev via Runware - Better quality ($0.004/image)',
    backend: 'runware',
    maxPromptLength: 2900,
    maxCharactersPerScene: 5
  },
  'ace-plus-plus': {
    modelId: 'ace-plus-plus',
    description: 'ACE++ via Runware - Face-consistent avatar generation (~$0.005/image)',
    backend: 'runware',
    maxPromptLength: 2900,
    maxCharactersPerScene: 5
  },
  'grok-imagine': {
    modelId: 'grok-imagine-image',
    description: 'Grok Imagine Standard - Good quality ($0.02/image), ref image support',
    backend: 'grok',
    // Grok's API limit is 8000 chars. The 500-char margin was costing more than
    // it protected: page 9 of job_1786484554633 built to 7534 — 34 over this
    // budget, 466 UNDER what Grok accepts — and that 34 triggered an LLM
    // compression pass that deleted four characters' hats. 100 chars of margin
    // is enough for the assembly slack; the compressor is the expensive guard.
    maxPromptLength: 7900,
    maxCharactersPerScene: 5
  },
  'grok-imagine-pro': {
    modelId: 'grok-imagine-image-pro',
    description: 'Grok Imagine Pro - Higher quality ($0.07/image), ref image support',
    backend: 'grok',
    // Grok's API limit is 8000 chars. The 500-char margin was costing more than
    // it protected: page 9 of job_1786484554633 built to 7534 — 34 over this
    // budget, 466 UNDER what Grok accepts — and that 34 triggered an LLM
    // compression pass that deleted four characters' hats. 100 chars of margin
    // is enough for the assembly slack; the compressor is the expensive guard.
    maxPromptLength: 7900,
    maxCharactersPerScene: 5
  }
};

// Repair workflow thresholds — single source of truth for server-side pipeline.
// scoreThreshold was previously 80, calibrated when Gemini quality eval was the
// only scorer. Now finalScore subtracts THREE penalties (qualityScore −
// semanticPenalty − entityPenalty), so a single moderate issue flagged by all
// three evaluators triple-counts to −30 from a perfect 100 → 70 < 80 → redo.
// Lowered to 60 so a single moderate issue stays above the bar; only genuinely
// bad pages (multiple issues OR one critical penalty) trip a regenerate.
// Judgment calls (image evaluation, semantic fidelity, compliance, feedback
// consolidation) run at this temperature. 0 by default: two identical baseline
// runs over the same six pages returned 10 and 4 findings respectively because
// only the Gemini visual eval was pinned — the compliance and semantic judges
// ran at 0.7 / the provider default, which makes any prompt or model A/B
// unmeasurable. Override with EVAL_TEMPERATURE to explore judge variance.
const EVAL_TEMPERATURE = process.env.EVAL_TEMPERATURE != null ? Number(process.env.EVAL_TEMPERATURE) : 0;

// Repair passes are environment-split (owner, 2026-08-08). Production keeps 3
// — a paying customer's book should get every recovery attempt. Staging runs 1
// so a showcase finishes in a reviewable time: rounds 2 and 3 of the Berger run
// (job_1786193650012_7baiaeftb) cost ~15 minutes of a 50-minute story and the
// owner is watching the result, not the convergence.
// The per-environment values live in server/config/runtime.js, where every
// deliberate prod/staging difference is declared in one place.
const REPAIR_MAX_PASSES = require('./runtime').runtime('repairMaxPasses');

const REPAIR_DEFAULTS = {
  scoreThreshold: 50,       // Pages scoring below this need redo (0-100). Lowered
                            // from 60 (2026-08-09): measured, a page entering
                            // repair at 50-59 was regenerated and came back
                            // WORSE far more often than better.
  issueThreshold: 5,        // Pages with this many fixable issues need redo
  maxPasses: REPAIR_MAX_PASSES,  // Global passes over all pages — 1 on staging, 3 on prod
  maxCharRepairPages: 20,   // Max pages to character-repair per run (hard ceiling: bounds the worst-case spend even on "Repair All" against a 32-page story)
  // WIRED 2026-08-09. These were dead config for a month while
  // decideRepairMethod hardcoded visualScore<50 / semanticScore<30, and the two
  // sources DISAGREED (config said 20, code did 50). Resolved toward the
  // documented intent — 20 — which also cuts full regenerations: measured on a
  // 14-page story, 13 pages were regenerated and 8 came back worse.
  // SALVAGE FLOOR (2026-08-09): a page at or above this finalScore is never sent
  // for a full regenerate by the two NUMERIC gates — it still gets char-fix or
  // inpaint. Regenerating discards an image that already has something worth
  // keeping, and measured it came back worse 6 times out of 7 above this line.
  // A spec conflict and a CATASTROPHIC finding still iterate regardless.
  iterateSalvageFloor: 0,
  semanticThresholdForIterate: 30, // Below this semantic score → iterate (scene fundamentally wrong)
  qualityThresholdForIterate: 20,  // Below this quality score → iterate immediately
  inpaintMaxPasses: 1,             // Inpaint attempts per page per round
};

// Approximate pricing per 1M tokens (USD)
// Updated Feb 2026 - check provider websites for latest pricing
// Source: https://platform.claude.com/docs/en/about-claude/pricing
const MODEL_PRICING = {
  // Anthropic Claude models (Feb 2026)
  'claude-opus-5': { input: 5.00, output: 25.00, thinking: 25.00 },
  'claude-opus': { input: 5.00, output: 25.00, thinking: 25.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, thinking: 15.00 },
  'claude-sonnet-4-5-20250929': { input: 3.00, output: 15.00, thinking: 15.00 },
  'claude-sonnet-4-5': { input: 3.00, output: 15.00, thinking: 15.00 },
  'claude-sonnet': { input: 3.00, output: 15.00, thinking: 15.00 },
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00, thinking: 5.00 },
  'claude-haiku-4-5': { input: 1.00, output: 5.00, thinking: 5.00 },
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00, thinking: 4.00 },
  'claude-haiku': { input: 1.00, output: 5.00, thinking: 5.00 },

  // Google Gemini models (per 1M tokens) - Updated Jan 2026
  // Source: https://ai.google.dev/gemini-api/docs/pricing
  'gemini-2.5-pro': { input: 1.25, output: 10.00, thinking: 10.00 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50, thinking: 2.50 },
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40, thinking: 0.40 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40, thinking: 0.40 },
  'gemini-pro-latest': { input: 1.25, output: 10.00, thinking: 10.00 },

  // xAI Grok models (Mar 2026)
  // Source: https://docs.x.ai/docs/models
  'grok-3-mini': { input: 0.30, output: 0.50 },
  'grok-3': { input: 3.00, output: 15.00 },
  'grok-4-1-fast-non-reasoning': { input: 0.20, output: 0.50 },

  // OpenRouter-hosted Qwen / DeepSeek (approx list prices — verify at
  // openrouter.ai; they vary by upstream provider and shift often).
  'qwen/qwen-max': { input: 1.60, output: 6.40 },
  'qwen/qwen-plus': { input: 0.26, output: 0.78 },
  'qwen/qwen3-max': { input: 0.78, output: 3.9 },
  'deepseek/deepseek-v3.2': { input: 0.27, output: 0.4 },
  'z-ai/glm-4.6': { input: 0.5, output: 2.0 },
  'moonshotai/kimi-k2': { input: 0.57, output: 2.3 },
  'qwen/qwen2.5-vl-72b-instruct': { input: 0.25, output: 0.75 },
  'qwen/qwen3-vl-32b-instruct': { input: 0.104, output: 0.416 },
  'qwen/qwen3-vl-235b-a22b-instruct': { input: 0.21, output: 1.90 },
  'deepseek/deepseek-chat': { input: 0.2574, output: 1.0287 },
  'deepseek/deepseek-v4-pro': { input: 0.435, output: 0.87 },
  'deepseek/deepseek-v4-flash': { input: 0.14, output: 0.28 },

  // Grok Imagine models (fixed cost per image)
  'grok-imagine-image': { perImage: 0.02 },
  'grok-imagine-image-pro': { perImage: 0.07 },

  // Image generation models (fixed cost per image, not per token)
  'gemini-2.5-flash-image': { perImage: 0.04 },
  'gemini-3-pro-image-preview': { perImage: 0.15 },
  'runware:5@1': { perImage: 0.0006 },  // FLUX Schnell
  'runware:6@1': { perImage: 0.004 },   // FLUX Dev
  'ace-plus-plus': { perImage: 0.005 }
};

/**
 * Calculate the cost for a text model API call
 * @param {string} modelId - The model ID used (e.g., 'claude-sonnet-4-5-20250929', 'gemini-2.5-flash')
 * @param {object} usage - Token usage: { inputTokens, outputTokens, thinkingTokens? }
 * @returns {number} Estimated cost in USD
 */
function calculateTextCost(modelId, usage) {
  // Find pricing - try exact match first, then normalize
  let pricing = MODEL_PRICING[modelId];

  if (!pricing) {
    // OpenRouter models are keyed with their vendor prefix ('qwen/qwen-plus'),
    // but MODEL_DEFAULTS refers to them bare ('qwen-plus'), and neither branch
    // below matches across the slash: 'qwen/qwen-plus'.startsWith('qwen-plus')
    // is false, and 'qwen-plus'.includes('qwen/qwen-plus') is false too.
    // Result: every eval/compliance call through OpenRouter priced at $0 —
    // silent under-reporting in the pipeline's own cost accounting, not just in
    // reports built on top of it. Match the part after the slash as well.
    const lower = modelId.toLowerCase();
    for (const [key, value] of Object.entries(MODEL_PRICING)) {
      const bare = key.includes('/') ? key.split('/').pop() : key;
      if (bare.toLowerCase() === lower) {
        pricing = value;
        break;
      }
    }
  }

  if (!pricing) {
    // Try to find a matching key by normalizing the model ID
    const normalizedId = modelId.toLowerCase().replace(/-\d+$/, '');
    for (const [key, value] of Object.entries(MODEL_PRICING)) {
      if (key.toLowerCase().startsWith(normalizedId) || modelId.includes(key)) {
        pricing = value;
        break;
      }
    }
  }

  if (!pricing || pricing.perImage) {
    // Unknown text model or this is an image model
    console.warn(`[COST] No token pricing found for model: ${modelId}`);
    return 0;
  }

  const inputTokens = usage.inputTokens || usage.input_tokens || 0;
  const outputTokens = usage.outputTokens || usage.output_tokens || 0;
  const thinkingTokens = usage.thinkingTokens || usage.thinking_tokens || 0;

  // Calculate cost: price per 1M tokens * (tokens / 1M)
  const inputCost = (pricing.input * inputTokens) / 1_000_000;
  const outputCost = (pricing.output * outputTokens) / 1_000_000;
  const thinkingCost = (pricing.thinking || pricing.output) * thinkingTokens / 1_000_000;

  return inputCost + outputCost + thinkingCost;
}

/**
 * Calculate the cost for an image generation API call
 * @param {string} modelId - The model ID or backend used
 * @param {number} imageCount - Number of images generated (default: 1)
 * @returns {number} Estimated cost in USD
 */
function calculateImageCost(modelId, imageCount = 1) {
  // Check IMAGE_BACKENDS first (e.g. 'grok', 'gemini', 'runware')
  if (IMAGE_BACKENDS[modelId]) {
    return IMAGE_BACKENDS[modelId].costPerImage * imageCount;
  }

  // Check MODEL_PRICING for image models (e.g. 'grok-imagine-image')
  const pricing = MODEL_PRICING[modelId];
  if (pricing?.perImage) {
    return pricing.perImage * imageCount;
  }

  // Resolve display name → backend via IMAGE_MODELS (e.g. 'grok-imagine' → backend 'grok')
  const imageModelConfig = IMAGE_MODELS[modelId];
  if (imageModelConfig?.backend && IMAGE_BACKENDS[imageModelConfig.backend]) {
    return IMAGE_BACKENDS[imageModelConfig.backend].costPerImage * imageCount;
  }
  // Also check the internal modelId (e.g. 'grok-imagine' → modelId 'grok-imagine-image')
  if (imageModelConfig?.modelId) {
    const internalPricing = MODEL_PRICING[imageModelConfig.modelId];
    if (internalPricing?.perImage) {
      return internalPricing.perImage * imageCount;
    }
  }

  // Default to Gemini pricing if unknown
  console.warn(`[COST] No image pricing found for model: ${modelId}, using default`);
  return 0.035 * imageCount;
}

/**
 * Get a summary of cost breakdown for logging
 * @param {string} modelId - The model ID used
 * @param {object} usage - Token usage or image count
 * @param {number} cost - Calculated cost
 * @returns {string} Human-readable cost summary
 */
function formatCostSummary(modelId, usage, cost) {
  if (usage.inputTokens || usage.input_tokens) {
    const input = usage.inputTokens || usage.input_tokens || 0;
    const output = usage.outputTokens || usage.output_tokens || 0;
    const thinking = usage.thinkingTokens || usage.thinking_tokens || 0;
    const thinkingStr = thinking > 0 ? ` + ${thinking.toLocaleString()} thinking` : '';
    return `${modelId}: ${input.toLocaleString()} in / ${output.toLocaleString()} out${thinkingStr} = $${cost.toFixed(6)}`;
  } else {
    return `${modelId}: $${cost.toFixed(6)}`;
  }
}

/**
 * Guard any model key against a missing OpenRouter key: if it resolves to an
 * OpenRouter model (Qwen/DeepSeek) but OPENROUTER_API_KEY isn't set, fall back
 * to claude-sonnet so a forgotten key degrades quality instead of throwing
 * mid-generation. Warns once per label.
 */
const _guardWarned = new Set();
function guardModel(modelKey, label = 'model') {
  const m = modelKey || 'claude-sonnet';
  const cfg = TEXT_MODELS[m];
  if (cfg?.provider === 'openrouter' && !process.env.OPENROUTER_API_KEY) {
    if (!_guardWarned.has(label)) {
      _guardWarned.add(label);
      try { require('../utils/logger').log.warn(`⚠️ [${label}] "${m}" needs OPENROUTER_API_KEY (not set) — falling back to claude-sonnet`); } catch { /* logger optional */ }
    }
    return 'claude-sonnet';
  }
  return m;
}
function resolveEvalModel() { return guardModel(MODEL_DEFAULTS.evalModel, 'EVAL MODEL'); }
function resolveComplianceModel() { return guardModel(MODEL_DEFAULTS.complianceModel, 'COMPLIANCE MODEL'); }
function resolveSceneIterationModel() { return guardModel(MODEL_DEFAULTS.sceneIteration, 'SCENE ITERATE MODEL'); }
function resolveSceneValidationModel() { return guardModel(MODEL_DEFAULTS.sceneValidationRepair, 'SCENE VALIDATION MODEL'); }
function resolveSceneRewriteModel() { return guardModel(MODEL_DEFAULTS.sceneRewrite, 'SCENE REWRITE MODEL'); }
function resolvePromptCompressModel() { return guardModel(MODEL_DEFAULTS.promptCompress, 'PROMPT COMPRESS MODEL'); }

module.exports = {
  EVAL_TEMPERATURE,
  TEXT_MODELS,
  MODEL_DEFAULTS,
  resolveEvalModel,
  resolveComplianceModel,
  resolveSceneIterationModel,
  resolveSceneValidationModel,
  resolveSceneRewriteModel,
  resolvePromptCompressModel,
  IMAGE_MODELS,
  IMAGE_BACKENDS,
  IMAGE_ASPECTS,
  MODEL_PRICING,
  INPAINT_BACKENDS,
  REPAIR_DEFAULTS,
  // Cost calculation utilities
  calculateTextCost,
  calculateImageCost,
  formatCostSummary
};

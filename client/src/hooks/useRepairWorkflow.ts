import { useState, useCallback, useMemo, useRef } from 'react';
import type {
  RepairWorkflowStep,
  RepairWorkflowState,
  PageFeedback,
  SceneImage,
  CoverImages,
  EntityConsistencyReport,
  EvaluationData,
  FinalChecksImageCheck,
} from '../types/story';
import type { Character } from '../types/character';
import { storyService } from '../services/storyService';
import { REPAIR_DEFAULTS } from '../config/repairDefaults';

// Cover type ↔ virtual page number mapping
const COVER_PAGES: Record<string, number> = { frontCover: -1, initialPage: -2, backCover: -3 };

// Concurrency limit for parallel image operations (redo, character repair)
const IMAGE_CONCURRENCY = 50;

// Entity penalty values by severity (must match backend re-evaluate logic)
const ENTITY_PENALTIES = { critical: 30, major: 20, minor: 10 } as const;

/** Simple concurrency limiter (like p-limit) */
function pLimit(concurrency: number) {
  const queue: Array<() => void> = [];
  let active = 0;

  function next() {
    if (queue.length > 0 && active < concurrency) {
      active++;
      const run = queue.shift()!;
      run();
    }
  }

  return <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(() => {
          active--;
          next();
        });
      });
      next();
    });
  };
}

// Initial state factory
function createInitialState(): RepairWorkflowState {
  return {
    currentStep: 'idle',
    stepStatus: {
      'idle': 'completed',
      'collect-feedback': 'pending',
      'identify-redo-pages': 'pending',
      'redo-pages': 'pending',
      're-evaluate': 'pending',
      'consistency-check': 'pending',
      'character-repair': 'pending',
      'artifact-repair': 'pending',
      'cover-repair': 'pending',
    },
    collectedFeedback: {
      pages: {},
      totalIssues: 0,
    },
    redoPages: {
      pageNumbers: [],
      reasons: {},
    },
    redoResults: {
      pagesCompleted: [],
      newVersions: {},
      pageDetails: {},
    },
    reEvaluationResults: {
      pages: {},
    },
    consistencyResults: {},
    characterRepairResults: {
      charactersProcessed: [],
      pagesRepaired: {},
      pagesFailed: {},
    },
    artifactRepairResults: {
      pagesProcessed: [],
      issuesFixed: 0,
    },
    sessionId: `repair-${Date.now()}`,
  };
}

// Step order for progression
const STEP_ORDER: RepairWorkflowStep[] = [
  'idle',
  'collect-feedback',
  'identify-redo-pages',
  'redo-pages',
  're-evaluate',
  'consistency-check',
  'character-repair',
  'artifact-repair',
  'cover-repair',
];

export interface UseRepairWorkflowProps {
  storyId: string | null;
  sceneImages: SceneImage[];
  coverImages?: CoverImages | null;
  characters: Character[];
  finalChecksReport?: {
    entity?: EntityConsistencyReport;
    imageChecks?: FinalChecksImageCheck[];
  } | null;
  imageModel?: string;
  qualityModel?: string | null;
  onImageUpdate?: (pageNumber: number, imageData: string, versionIndex: number, metadata?: {
    description?: string;
    prompt?: string;
    qualityScore?: number;
    qualityReasoning?: string;
    modelId?: string;
    fixTargets?: Array<{ boundingBox: number[]; issue: string; fixPrompt: string }>;
    totalAttempts?: number;
    type?: string;
  }) => void;
}

export interface UseRepairWorkflowReturn {
  // State
  workflowState: RepairWorkflowState;
  isRunning: boolean;
  runningSteps: Set<string>;  // Which specific steps are currently in-progress
  resetWorkflow: () => void;

  // Step 1: Collect feedback
  collectFeedback: () => Promise<void>;

  // Step 2: Identify redo pages
  toggleRedoPage: (pageNumber: number, reason?: string) => void;
  autoIdentifyRedoPages: (scoreThreshold?: number, issueThreshold?: number) => void;

  // Step 3: Redo pages (uses existing iterate function)
  redoMarkedPages: (options?: { useOriginalAsReference?: boolean; blackoutIssues?: boolean }) => Promise<void>;
  redoProgress: { current: number; total: number; currentPage?: number };

  // Step 4: Re-evaluate
  reEvaluatePages: (pageNumbers?: number[]) => Promise<{
    evalPages: Record<number, {
      score?: number;
      qualityScore: number;
      fixableIssues?: unknown[];
    }>;
    badPages: number[];
  } | undefined>;

  // Step 5: Consistency check
  runConsistencyCheck: () => Promise<void>;

  // Step 6: Character repair
  repairCharacter: (characterName: string, pages: number[], options?: { useMagicApiRepair?: boolean; grokRepairMode?: 'blended' | 'cutout' | 'blackout'; whiteoutTarget?: 'face' | 'body' }) => Promise<void>;

  // Step 7: Artifact repair
  repairArtifacts: (pageNumbers: number[]) => Promise<void>;

  // Step 8: Cover repair
  regenerateCovers: (coverTypes: ('front' | 'back' | 'initial')[]) => Promise<void>;
  coverRepairProgress: { current: number; total: number; currentCover?: string };

  // Full automated workflow
  runFullWorkflow: (options?: {
    maxPasses?: number;
    onProgress?: (step: string, detail: string) => void;
  }) => Promise<void>;

  // Abort running workflow
  abortWorkflow: () => void;
  isAborted: boolean;

  // Computed helpers
  getStepNumber: (step: RepairWorkflowStep) => number;
  getCharactersWithIssues: () => string[];
  getPagesWithSevereIssuesForCharacter: (characterName: string) => number[];
}

export function useRepairWorkflow({
  storyId,
  sceneImages,
  coverImages,
  characters: _characters,
  finalChecksReport: _finalChecksReport,
  imageModel,
  qualityModel,
  onImageUpdate,
}: UseRepairWorkflowProps): UseRepairWorkflowReturn {
  const [workflowState, setWorkflowState] = useState<RepairWorkflowState>(createInitialState);
  const [redoProgress, setRedoProgress] = useState({ current: 0, total: 0, currentPage: undefined as number | undefined });

  // Abort mechanism for stopping runaway workflows
  const abortControllerRef = useRef<AbortController | null>(null);
  const [isAborted, setIsAborted] = useState(false);

  // Computed: which steps are running, and is anything running
  const runningSteps = useMemo(() => {
    const steps = new Set<string>();
    for (const [step, status] of Object.entries(workflowState.stepStatus)) {
      if (status === 'in-progress') steps.add(step);
    }
    return steps;
  }, [workflowState.stepStatus]);
  const isRunning = runningSteps.size > 0;

  // Step control
  const startStep = useCallback((step: RepairWorkflowStep) => {
    setWorkflowState(prev => ({
      ...prev,
      currentStep: step,
      stepStatus: {
        ...prev.stepStatus,
        [step]: 'in-progress',
      },
    }));
  }, []);

  const completeStep = useCallback((step: RepairWorkflowStep, result?: unknown) => {
    setWorkflowState(prev => ({
      ...prev,
      stepStatus: {
        ...prev.stepStatus,
        [step]: 'completed',
      },
      // Store results based on step type
      ...(step === 'collect-feedback' && result ? { collectedFeedback: result as RepairWorkflowState['collectedFeedback'] } : {}),
      ...(step === 're-evaluate' && result ? { reEvaluationResults: result as RepairWorkflowState['reEvaluationResults'] } : {}),
      ...(step === 'consistency-check' && result ? { consistencyResults: result as RepairWorkflowState['consistencyResults'] } : {}),
    }));
  }, []);

  const failStep = useCallback((step: RepairWorkflowStep, _error?: string) => {
    setWorkflowState(prev => ({
      ...prev,
      stepStatus: {
        ...prev.stepStatus,
        [step]: 'failed',
      },
    }));
  }, []);

  const skipStep = useCallback((step: RepairWorkflowStep) => {
    setWorkflowState(prev => ({
      ...prev,
      stepStatus: {
        ...prev.stepStatus,
        [step]: 'skipped',
      },
    }));
  }, []);

  const resetWorkflow = useCallback(() => {
    setWorkflowState(createInitialState());
    setRedoProgress({ current: 0, total: 0, currentPage: undefined });
    setIsAborted(false);
    abortControllerRef.current = null;
  }, []);

  // Abort a running workflow
  const abortWorkflow = useCallback(() => {
    console.log('[useRepairWorkflow] Aborting workflow');
    abortControllerRef.current?.abort();
    setIsAborted(true);
  }, []);

  // Step 1: Collect feedback from existing evaluation data
  // Fetches evaluation fields from the server (fixableIssues, fixTargets, semanticResult, etc.)
  // since these are stored in the story JSONB blob but not loaded by the fast metadata path.
  const collectFeedback = useCallback(async () => {
    if (!storyId) return;

    startStep('collect-feedback');

    try {
      // Fetch evaluation data from the server (not available in scene metadata)
      const evalData = await storyService.getEvaluationData(storyId);
      const evalByPage = new Map(evalData.sceneEvaluations.map(e => [e.pageNumber, e]));
      const fcReport = evalData.finalChecksReport;

      const pages: Record<number, PageFeedback> = {};
      let totalIssues = 0;

      // Process each scene image, enriching with server-side evaluation data
      console.log(`[collectFeedback] Processing ${sceneImages.length} scene images, ${evalByPage.size} eval entries from server`);
      for (const scene of sceneImages) {
        const evalPage = evalByPage.get(scene.pageNumber);

        const feedback: PageFeedback = {
          pageNumber: scene.pageNumber,
          qualityScore: evalPage?.qualityScore ?? scene.qualityScore,
          semanticScore: evalPage?.semanticScore ?? scene.semanticScore ?? null,
          verdict: evalPage?.verdict ?? scene.verdict,
          issuesSummary: evalPage?.issuesSummary ?? scene.issuesSummary,
          semanticResult: evalPage?.semanticResult ?? scene.semanticResult ?? null,
          fixableIssues: [],
          entityIssues: [],
          objectIssues: [],
          semanticIssues: [],
          needsFullRedo: false,
        };

        // Collect fixable issues from ALL evaluation sources (tagged with source)
        // Use a Set to deduplicate by description
        const seenDescriptions = new Set<string>();
        const addIssue = (issue: any, source: string) => {
          const desc = issue.description || issue.issue || '';
          if (desc && seenDescriptions.has(desc)) return;
          if (desc) seenDescriptions.add(desc);
          feedback.fixableIssues.push({ ...issue, source });
        };

        // Source 1: Scene-level fixableIssues (from server evaluation data)
        if (evalPage?.fixableIssues?.length) {
          for (const i of evalPage.fixableIssues) addIssue(i, (i as any).source || 'quality eval');
        }

        // Source 2: Fix targets with bounding boxes (from server evaluation data)
        if (evalPage?.fixTargets?.length) {
          for (const t of evalPage.fixTargets) {
            addIssue({
              description: t.issue || 'Quality issue detected',
              severity: 'medium',
              type: 'visual',
              fix: t.fixPrompt || '',
            }, 'fix targets');
          }
        }

        // Source 3: Semantic evaluation issues (from server evaluation data)
        if (evalPage?.semanticResult) {
          for (const si of (evalPage.semanticResult.semanticIssues || [])) {
            addIssue({
              description: si.problem || `${si.type || 'semantic'}: ${si.item || ''}`,
              severity: si.severity?.toLowerCase() || 'medium',
              type: si.type || 'semantic',
              fix: si.expected ? `Expected: ${si.expected}` : '',
            }, 'semantic eval');
          }
          for (const si of (evalPage.semanticResult.issues || [])) {
            addIssue({
              description: si.problem || `${si.type}: ${si.item || ''}`,
              severity: si.severity?.toLowerCase() || 'medium',
              type: si.type || 'semantic',
              fix: '',
            }, 'semantic eval');
          }
        }

        // Source 4: Consistency regen issues (from server evaluation data)
        if (evalPage?.consistencyRegen?.issues?.length) {
          for (const ci of evalPage.consistencyRegen.issues) {
            addIssue({
              description: ci.description,
              severity: ci.severity,
              type: ci.type || 'consistency',
              fix: ci.recommendation || '',
              character: ci.characterInvolved,
            }, 'consistency regen');
          }
        }

        // Get entity issues from finalChecksReport - CHARACTERS
        if (fcReport?.entity) {
          for (const [charName, charResult] of Object.entries((fcReport.entity as any).characters || {})) {
            const cr = charResult as any;
            // Mutually exclusive: prefer byClothing (detailed), fall back to root issues (legacy flattening)
            const allIssues: any[] = [];
            if (cr.byClothing && Object.keys(cr.byClothing).length > 0) {
              for (const clothingResult of Object.values(cr.byClothing) as any[]) {
                if (clothingResult.issues) {
                  allIssues.push(...clothingResult.issues);
                }
              }
            } else if (cr.issues) {
              allIssues.push(...cr.issues);
            }

            // Filter to issues affecting this page
            const charIssues = allIssues.filter((i: any) =>
              i.pagesToFix?.includes(scene.pageNumber) || i.pageNumber === scene.pageNumber
            );

            for (const issue of charIssues) {
              feedback.entityIssues.push({
                character: charName,
                issue: issue.description,
                severity: issue.severity,
                source: 'entity check',
              });
            }
          }

          // Get entity issues from finalChecksReport - OBJECTS
          for (const [objectName, objectResult] of Object.entries((fcReport.entity as any).objects || {})) {
            const or = objectResult as any;
            const allIssues: any[] = [];
            if (or.byClothing && Object.keys(or.byClothing).length > 0) {
              for (const clothingResult of Object.values(or.byClothing) as any[]) {
                if (clothingResult.issues) {
                  allIssues.push(...clothingResult.issues);
                }
              }
            } else if (or.issues) {
              allIssues.push(...or.issues);
            }

            // Filter to issues affecting this page
            const objectIssues = allIssues.filter((i: any) =>
              i.pagesToFix?.includes(scene.pageNumber) || i.pageNumber === scene.pageNumber
            );

            for (const issue of objectIssues) {
              feedback.objectIssues.push({
                object: objectName,
                issue: issue.description,
                severity: issue.severity,
                source: 'entity check',
              });
            }
          }
        }

        // Get semantic/legacy image check issues from finalChecksReport.imageChecks
        if (fcReport?.imageChecks) {
          for (const imageCheck of (fcReport.imageChecks as any[])) {
            for (const issue of imageCheck.issues || []) {
              // Check if this issue affects this page
              const affectsPage = issue.pagesToFix?.includes(scene.pageNumber) ||
                                  issue.images?.includes(scene.pageNumber);
              if (affectsPage) {
                feedback.semanticIssues.push({
                  type: issue.type,
                  description: issue.description,
                  severity: issue.severity,
                  characterInvolved: issue.characterInvolved,
                  recommendation: issue.recommendation,
                  source: 'image checks',
                });
              }
            }
          }
        }

        // Compute entity penalty (same model as backend re-evaluate)
        let entityPenalty = 0;
        for (const ei of feedback.entityIssues) {
          entityPenalty += ENTITY_PENALTIES[ei.severity as keyof typeof ENTITY_PENALTIES] ?? ENTITY_PENALTIES.minor;
        }
        for (const oi of feedback.objectIssues) {
          entityPenalty += ENTITY_PENALTIES[oi.severity as keyof typeof ENTITY_PENALTIES] ?? ENTITY_PENALTIES.minor;
        }
        for (const si of feedback.semanticIssues) {
          entityPenalty += ENTITY_PENALTIES[si.severity as keyof typeof ENTITY_PENALTIES] ?? ENTITY_PENALTIES.minor;
        }
        feedback.entityPenalty = entityPenalty;
        // Use qualityScore (visual-quality-only) as base; scene.score already has entity
        // penalties baked in from the last evaluation, so using it would double-penalise.
        const baseScore = feedback.qualityScore ?? 100;
        feedback.score = Math.max(0, baseScore - entityPenalty);

        totalIssues += feedback.fixableIssues.length + feedback.entityIssues.length +
                       feedback.objectIssues.length + feedback.semanticIssues.length;
        pages[scene.pageNumber] = feedback;
      }

      // Process cover images the same way as scenes (errors don't block scene feedback)
      try { if (coverImages) {
        const coverEntries: Array<[string, number]> = [
          ['frontCover', -1], ['initialPage', -2], ['backCover', -3]
        ];
        for (const [coverType, pageNum] of coverEntries) {
          const cover = coverImages[coverType as keyof typeof coverImages];
          if (!cover) continue;
          const evalPage = evalByPage.get(pageNum);

          const feedback: PageFeedback = {
            pageNumber: pageNum,
            qualityScore: evalPage?.qualityScore ?? cover.qualityScore ?? undefined,
            semanticScore: evalPage?.semanticScore ?? null,
            verdict: evalPage?.verdict ?? undefined,
            issuesSummary: evalPage?.issuesSummary ?? undefined,
            semanticResult: evalPage?.semanticResult ?? null,
            fixableIssues: [],
            entityIssues: [],
            objectIssues: [],
            semanticIssues: [],
            needsFullRedo: false,
          };

          // Collect fixable issues (same dedup logic as scenes)
          const seenDescriptions = new Set<string>();
          const addIssue = (issue: any, source: string) => {
            const desc = issue.description || issue.issue || '';
            if (desc && seenDescriptions.has(desc)) return;
            if (desc) seenDescriptions.add(desc);
            feedback.fixableIssues.push({ ...issue, source });
          };

          if (evalPage?.fixableIssues?.length) {
            for (const i of evalPage.fixableIssues) addIssue(i, (i as any).source || 'quality eval');
          }
          if (evalPage?.fixTargets?.length) {
            for (const t of evalPage.fixTargets) {
              addIssue({
                description: t.issue || 'Quality issue detected',
                severity: 'medium',
                type: 'visual',
                fix: t.fixPrompt || '',
              }, 'fix targets');
            }
          }
          if (evalPage?.semanticResult) {
            for (const si of (evalPage.semanticResult.semanticIssues || [])) {
              addIssue({
                description: si.problem || `${si.type || 'semantic'}: ${si.item || ''}`,
                severity: si.severity?.toLowerCase() || 'medium',
                type: si.type || 'semantic',
                fix: si.expected ? `Expected: ${si.expected}` : '',
              }, 'semantic eval');
            }
            for (const si of (evalPage.semanticResult.issues || [])) {
              addIssue({
                description: si.problem || `${si.type}: ${si.item || ''}`,
                severity: si.severity?.toLowerCase() || 'medium',
                type: si.type || 'semantic',
                fix: '',
              }, 'semantic eval');
            }
          }

          // Compute entity penalty (covers typically have no entity issues, but handle uniformly)
          let entityPenalty = 0;
          for (const ei of feedback.entityIssues) {
            entityPenalty += ENTITY_PENALTIES[ei.severity as keyof typeof ENTITY_PENALTIES] ?? ENTITY_PENALTIES.minor;
          }
          feedback.entityPenalty = entityPenalty;
          const baseScore = feedback.qualityScore ?? 100;
          feedback.score = Math.max(0, baseScore - entityPenalty);

          totalIssues += feedback.fixableIssues.length + feedback.entityIssues.length +
                         feedback.objectIssues.length + feedback.semanticIssues.length;
          pages[pageNum] = feedback;
        }
      } } catch (coverErr) {
        console.error('Cover feedback collection failed (scenes unaffected):', coverErr);
      }

      console.log(`[collectFeedback] Completed: ${Object.keys(pages).length} pages (scenes: ${sceneImages.length}, covers: ${Object.keys(pages).filter(k => parseInt(k) < 0).length}), ${totalIssues} total issues`);
      completeStep('collect-feedback', { pages, totalIssues });

      // Seed consistency results from existing entity report so the
      // consistency step shows data without requiring a manual re-run
      if (fcReport?.entity) {
        setWorkflowState(prev => ({
          ...prev,
          consistencyResults: { report: fcReport.entity as any },
          stepStatus: { ...prev.stepStatus, 'consistency-check': 'completed' },
        }));
      }
    } catch (error) {
      console.error('Failed to collect feedback:', error);
      failStep('collect-feedback', error instanceof Error ? error.message : 'Unknown error');
    }
  }, [storyId, sceneImages, coverImages, startStep, completeStep, failStep]);

  // Step 2: Toggle page for redo
  const toggleRedoPage = useCallback((pageNumber: number, reason?: string) => {
    setWorkflowState(prev => {
      const isCurrentlyMarked = prev.redoPages.pageNumbers.includes(pageNumber);
      const newPageNumbers = isCurrentlyMarked
        ? prev.redoPages.pageNumbers.filter(p => p !== pageNumber)
        : [...prev.redoPages.pageNumbers, pageNumber].sort((a, b) => a - b);

      const newReasons = { ...prev.redoPages.reasons };
      if (isCurrentlyMarked) {
        delete newReasons[pageNumber];
      } else if (reason) {
        newReasons[pageNumber] = reason;
      }

      return {
        ...prev,
        redoPages: {
          pageNumbers: newPageNumbers,
          reasons: newReasons,
        },
      };
    });
  }, []);

  // Auto-identify pages needing redo based on thresholds
  const autoIdentifyRedoPages = useCallback((scoreThreshold: number = REPAIR_DEFAULTS.scoreThreshold, issueThreshold: number = REPAIR_DEFAULTS.issueThreshold) => {
    startStep('identify-redo-pages');

    const pagesToRedo: number[] = [];
    const reasons: Record<number, string> = {};

    for (const [pageNum, feedback] of Object.entries(workflowState.collectedFeedback.pages)) {
      const page = parseInt(pageNum);
      const totalIssues = feedback.fixableIssues.length + feedback.entityIssues.length
        + (feedback.objectIssues?.length ?? 0) + (feedback.semanticIssues?.length ?? 0);

      // Prefer re-evaluation scores when available (more current than collectedFeedback)
      const reEval = workflowState.reEvaluationResults.pages?.[page];
      const score = reEval?.score ?? reEval?.qualityScore ?? feedback.qualityScore ?? 100;
      const issueCount = reEval
        ? (reEval.fixableIssues?.length ?? 0)
        : totalIssues;

      // Mark for redo if score is low or too many issues
      if (score < scoreThreshold) {
        pagesToRedo.push(page);
        reasons[page] = `Low quality score: ${score}`;
      } else if (issueCount >= issueThreshold) {
        pagesToRedo.push(page);
        reasons[page] = `Too many issues: ${issueCount}`;
      } else if (feedback.needsFullRedo) {
        pagesToRedo.push(page);
        reasons[page] = 'Manually marked for redo';
      }
    }

    setWorkflowState(prev => ({
      ...prev,
      redoPages: {
        pageNumbers: pagesToRedo.sort((a, b) => a - b),
        reasons,
      },
      stepStatus: {
        ...prev.stepStatus,
        'identify-redo-pages': 'completed',
      },
    }));
  }, [workflowState.collectedFeedback.pages, workflowState.reEvaluationResults.pages, startStep]);

  // Helper: redo a single page or cover, returning a normalised result
  const redoCoverOrPage = useCallback(async (
    pageNumber: number,
    evalFeedback?: { score: number; reasoning?: string; fixableIssues?: Array<{ description?: string; issue?: string }> },
  ) => {
    if (pageNumber < 0) {
      const coverTypeMap: Record<number, 'front' | 'back' | 'initial'> = { [-1]: 'front', [-2]: 'initial', [-3]: 'back' };
      const coverType = coverTypeMap[pageNumber];
      if (!coverType) throw new Error(`Unknown cover page number: ${pageNumber}`);
      const coverResult = await storyService.regenerateCover(storyId!, coverType);
      return { success: true, imageData: coverResult.imageData, qualityScore: coverResult.qualityScore, sceneDescription: coverResult.description, imagePrompt: coverResult.prompt, modelId: coverResult.modelId, totalAttempts: 1 };
    }
    return storyService.iteratePage(storyId!, pageNumber, imageModel, { evaluationFeedback: evalFeedback });
  }, [storyId, imageModel]);

  // Step 3: Redo marked pages using existing iterate function
  const redoMarkedPages = useCallback(async (options?: { useOriginalAsReference?: boolean; blackoutIssues?: boolean }) => {
    if (!storyId || workflowState.redoPages.pageNumbers.length === 0) return;

    startStep('redo-pages');
    const pageNumbers = workflowState.redoPages.pageNumbers;
    setRedoProgress({ current: 0, total: pageNumbers.length, currentPage: undefined });

    const pagesCompleted: number[] = [];
    const newVersions: Record<number, number> = {};
    const pageDetails: Record<number, {
      previousScore: number | null;
      newScore: number | null;
      previousImage: string | null;
      newImage: string | null;
      blackoutImage: string | null;
    }> = {};

    try {
      let completed = 0;
      const limit = pLimit(IMAGE_CONCURRENCY);

      await Promise.all(pageNumbers.map((pageNumber) => limit(async () => {
        setRedoProgress({ current: completed, total: pageNumbers.length, currentPage: pageNumber });

        try {
          // Use existing iteratePage function, passing evaluation feedback if available
          const reEval = workflowState.reEvaluationResults.pages?.[pageNumber];
          const pageFeedback = workflowState.collectedFeedback.pages?.[pageNumber];
          const evalSource = reEval || pageFeedback;
          const evalFeedback = evalSource ? {
            score: ('score' in evalSource ? evalSource.score : undefined) ?? evalSource.qualityScore,
            reasoning: 'reasoning' in evalSource ? evalSource.reasoning : undefined,
            fixableIssues: evalSource.fixableIssues as Array<{ description?: string; issue?: string }>,
          } : undefined;
          let result: any;
          if (pageNumber < 0) {
            result = await redoCoverOrPage(pageNumber, evalFeedback);
          } else {
            result = await storyService.iteratePage(storyId, pageNumber, imageModel, {
              useOriginalAsReference: options?.useOriginalAsReference,
              blackoutIssues: options?.blackoutIssues,
              evaluationFeedback: evalFeedback,
            });
          }

          if (result?.success) {
            pagesCompleted.push(pageNumber);

            // Find version index (imageVersions length after update)
            const scene = sceneImages.find(s => s.pageNumber === pageNumber);
            const versionIndex = (scene?.imageVersions?.length ?? 0);
            newVersions[pageNumber] = versionIndex;

            // Capture before/after details for comparison display
            pageDetails[pageNumber] = {
              previousScore: result.previousScore ?? null,
              newScore: result.qualityScore ?? null,
              previousImage: result.previousImage ?? null,
              newImage: result.imageData ?? null,
              blackoutImage: result.blackoutImage ?? null,
            };

            // Notify parent of image update (include metadata for version details)
            if (onImageUpdate) {
              onImageUpdate(pageNumber, result.imageData, versionIndex, {
                description: result.sceneDescription,
                prompt: result.imagePrompt,
                qualityScore: result.qualityScore,
                qualityReasoning: result.qualityReasoning,
                modelId: result.modelId,
                totalAttempts: result.totalAttempts,
                type: 'repair',
              });
            }
          }
        } catch (pageError) {
          console.error(`Failed to redo page ${pageNumber}:`, pageError);
          // Continue with other pages
        }

        completed++;
        setRedoProgress({ current: completed, total: pageNumbers.length, currentPage: undefined });
      })));

      setWorkflowState(prev => ({
        ...prev,
        redoResults: {
          pagesCompleted,
          newVersions,
          pageDetails,
        },
        stepStatus: {
          ...prev.stepStatus,
          'redo-pages': 'completed',
        },
      }));

      setRedoProgress({ current: pageNumbers.length, total: pageNumbers.length, currentPage: undefined });
    } catch (error) {
      console.error('Redo pages failed:', error);
      failStep('redo-pages', error instanceof Error ? error.message : 'Unknown error');
    }
  }, [storyId, workflowState.redoPages.pageNumbers, workflowState.reEvaluationResults.pages, workflowState.collectedFeedback.pages, imageModel, sceneImages, onImageUpdate, startStep, failStep, redoCoverOrPage]);

  // Step 4: Re-evaluate pages
  type EvalPageResult = {
    score?: number;
    qualityScore: number;
    semanticScore?: number | null;
    entityPenalty?: number;
    rawScore?: number;
    verdict?: string;
    issuesSummary?: string;
    reasoning?: string;
    fixableIssues: EvaluationData['fixableIssues'];
  };

  const reEvaluatePages = useCallback(async (pageNumbers?: number[]): Promise<{ evalPages: Record<number, EvalPageResult>; badPages: number[] } | undefined> => {
    if (!storyId) return undefined;

    startStep('re-evaluate');

    // Default to pages that were just redone, or all pages
    const pagesToEvaluate = pageNumbers ?? workflowState.redoResults.pagesCompleted;

    if (pagesToEvaluate.length === 0) {
      skipStep('re-evaluate');
      return undefined;
    }

    try {
      const result = await storyService.reEvaluatePages(storyId, pagesToEvaluate, qualityModel);

      const evalResults: Record<number, EvalPageResult> = {};

      for (const [pageNum, pageResult] of Object.entries(result.pages || {})) {
        const pr = pageResult as EvalPageResult;
        evalResults[parseInt(pageNum)] = {
          score: pr.score,
          qualityScore: pr.qualityScore,
          semanticScore: pr.semanticScore,
          entityPenalty: pr.entityPenalty,
          rawScore: pr.rawScore,
          verdict: pr.verdict,
          issuesSummary: pr.issuesSummary,
          reasoning: pr.reasoning,
          fixableIssues: pr.fixableIssues,
        };
      }

      completeStep('re-evaluate', { pages: evalResults });
      return { evalPages: evalResults, badPages: result.badPages ?? [] };
    } catch (error) {
      console.error('Re-evaluation failed:', error);
      failStep('re-evaluate', error instanceof Error ? error.message : 'Unknown error');
      return undefined;
    }
  }, [storyId, qualityModel, workflowState.redoResults.pagesCompleted, startStep, completeStep, failStep, skipStep]);

  // Step 5: Run consistency check
  const runConsistencyCheck = useCallback(async () => {
    if (!storyId) return;

    startStep('consistency-check');

    try {
      const result = await storyService.runEntityConsistency(storyId);
      completeStep('consistency-check', { report: result.report });
    } catch (error) {
      console.error('Consistency check failed:', error);
      failStep('consistency-check', error instanceof Error ? error.message : 'Unknown error');
    }
  }, [storyId, startStep, completeStep, failStep]);

  // Step 6: Repair character on specific pages
  const repairCharacter = useCallback(async (characterName: string, pages: number[], options?: { useMagicApiRepair?: boolean; grokRepairMode?: 'blended' | 'cutout' | 'blackout'; whiteoutTarget?: 'face' | 'body' }) => {
    if (!storyId || pages.length === 0) return;

    startStep('character-repair');

    try {
      const result = await storyService.repairCharacters(storyId, [{ character: characterName, pages }], options);

      // Get pages repaired and failed from the result
      const pagesRepaired = result.results?.[0]?.pagesRepaired || [];
      const pagesFailed = result.results?.[0]?.pagesFailed || [];

      // Notify parent of image updates for each repaired page
      for (const repair of pagesRepaired) {
        if (repair.imageData && onImageUpdate) {
          try {
            onImageUpdate(repair.pageNumber, repair.imageData, repair.versionIndex, {
              type: 'character-repair',
            });
          } catch (err) {
            console.error(`[RepairWorkflow] Failed to notify parent of image update for page ${repair.pageNumber}:`, err);
          }
        }
      }

      // Log failed pages
      if (pagesFailed.length > 0) {
        console.warn(`[RepairWorkflow] ${pagesFailed.length} pages failed repair for ${characterName}:`,
          pagesFailed.map(f => `page ${f.pageNumber}: ${f.reason}`).join(', '));
      }

      // Store full repair details (comparison, verification, method) for debug UI
      const repairedDetails = pagesRepaired.map((r: any) => ({
        pageNumber: typeof r === 'number' ? r : r.pageNumber,
        comparison: r.comparison || null,
        verification: r.verification || null,
        method: r.method || 'gemini',
        debug: r.debug || null,
      }));
      const failedPages = pagesFailed.map(f => ({
        pageNumber: f.pageNumber,
        reason: f.reason,
        rejected: f.rejected,
        comparison: f.comparison || null,
      }));

      setWorkflowState(prev => ({
        ...prev,
        characterRepairResults: {
          charactersProcessed: [...prev.characterRepairResults.charactersProcessed, characterName],
          pagesRepaired: {
            ...prev.characterRepairResults.pagesRepaired,
            [characterName]: repairedDetails,
          },
          pagesFailed: {
            ...prev.characterRepairResults.pagesFailed,
            [characterName]: failedPages,
          },
        },
        stepStatus: {
          ...prev.stepStatus,
          'character-repair': pagesFailed.length > 0 && pagesRepaired.length === 0 ? 'failed' : 'completed',
        },
      }));

      // Auto re-evaluate repaired pages so we know if the repair improved things
      const repairedPageNumbers = pagesRepaired.map((r: any) => typeof r === 'number' ? r : r.pageNumber).filter(Boolean);
      if (repairedPageNumbers.length > 0) {
        try {
          await reEvaluatePages(repairedPageNumbers);
        } catch (evalErr) {
          console.warn('[RepairWorkflow] Post-repair re-evaluation failed:', evalErr);
        }
      }
    } catch (error) {
      console.error('Character repair failed:', error);
      failStep('character-repair', error instanceof Error ? error.message : 'Unknown error');
    }
  }, [storyId, startStep, failStep, onImageUpdate]);

  // Step 7: Repair artifacts on pages
  const repairArtifacts = useCallback(async (pageNumbers: number[]) => {
    if (!storyId || pageNumbers.length === 0) return;

    startStep('artifact-repair');

    try {
      const result = await storyService.repairArtifacts(storyId, pageNumbers);

      setWorkflowState(prev => ({
        ...prev,
        artifactRepairResults: {
          pagesProcessed: result.pagesProcessed || pageNumbers,
          issuesFixed: result.issuesFixed || 0,
        },
        stepStatus: {
          ...prev.stepStatus,
          'artifact-repair': 'completed',
        },
      }));
    } catch (error) {
      console.error('Artifact repair failed:', error);
      failStep('artifact-repair', error instanceof Error ? error.message : 'Unknown error');
    }
  }, [storyId, startStep, failStep]);

  // Step 8: Regenerate covers
  const [coverRepairProgress, setCoverRepairProgress] = useState({ current: 0, total: 0, currentCover: undefined as string | undefined });

  const regenerateCovers = useCallback(async (coverTypes: ('front' | 'back' | 'initial')[]) => {
    if (!storyId || coverTypes.length === 0) return;

    startStep('cover-repair');
    setCoverRepairProgress({ current: 0, total: coverTypes.length, currentCover: undefined });

    const coversCompleted: string[] = [];

    try {
      for (let i = 0; i < coverTypes.length; i++) {
        const coverType = coverTypes[i];
        setCoverRepairProgress({ current: i, total: coverTypes.length, currentCover: coverType });

        try {
          await storyService.regenerateCover(storyId, coverType);
          coversCompleted.push(coverType);
        } catch (coverError) {
          console.error(`Failed to regenerate ${coverType} cover:`, coverError);
        }
      }

      setWorkflowState(prev => ({
        ...prev,
        stepStatus: {
          ...prev.stepStatus,
          'cover-repair': coversCompleted.length > 0 ? 'completed' : 'failed',
        },
      }));

      setCoverRepairProgress({ current: coverTypes.length, total: coverTypes.length, currentCover: undefined });
    } catch (error) {
      console.error('Cover repair failed:', error);
      failStep('cover-repair', error instanceof Error ? error.message : 'Unknown error');
    }
  }, [storyId, startStep, failStep]);

  // Get step number (1-8, 0 for idle)
  const getStepNumber = useCallback((step: RepairWorkflowStep): number => {
    const index = STEP_ORDER.indexOf(step);
    return index >= 0 ? index : 0;
  }, []);

  // Get characters with issues from consistency results
  // Supports new per-clothing structure (overallConsistent, totalIssues, byClothing)
  const getCharactersWithIssues = useCallback((): string[] => {
    const report = workflowState.consistencyResults.report;
    if (!report?.characters) return [];

    return Object.entries(report.characters)
      .filter(([_, result]) => {
        // New structure uses overallConsistent and totalIssues
        if ('overallConsistent' in result) {
          return !result.overallConsistent || (result.totalIssues ?? 0) > 0;
        }
        // Legacy fallback
        return !result.consistent || (result.issues?.length ?? 0) > 0;
      })
      .map(([name]) => name);
  }, [workflowState.consistencyResults.report]);

  // Get pages with severe issues for a character (for automated character repair)
  const getPagesWithSevereIssuesForCharacter = useCallback((characterName: string): number[] => {
    const report = workflowState.consistencyResults.report;
    if (!report?.characters?.[characterName]) return [];

    const charResult = report.characters[characterName];
    const severePages = new Set<number>();

    // Check byClothing structure (new format)
    if (charResult.byClothing) {
      for (const clothingResult of Object.values(charResult.byClothing)) {
        for (const issue of clothingResult.issues || []) {
          if (issue.severity === 'major' || issue.severity === 'critical') {
            for (const page of issue.pagesToFix || []) {
              severePages.add(page);
            }
            if (issue.pageNumber) {
              severePages.add(issue.pageNumber);
            }
          }
        }
      }
    }

    // Check legacy flat structure
    if (charResult.issues) {
      for (const issue of charResult.issues) {
        if (issue.severity === 'major' || issue.severity === 'critical') {
          for (const page of issue.pagesToFix || []) {
            severePages.add(page);
          }
          if (issue.pageNumber) {
            severePages.add(issue.pageNumber);
          }
        }
      }
    }

    return Array.from(severePages).sort((a, b) => a - b);
  }, [workflowState.consistencyResults.report]);

  // Full automated workflow - global passes instead of per-page retries
  // Each pass: evaluate ALL → redo ALL bad → re-evaluate ALL
  const runFullWorkflow = useCallback(async (options: {
    maxPasses?: number;
    onProgress?: (step: string, detail: string) => void;
  } = {}) => {
    if (!storyId) return;

    const { maxPasses = REPAIR_DEFAULTS.maxPasses, onProgress } = options;

    // Create abort controller for this workflow run
    abortControllerRef.current = new AbortController();
    setIsAborted(false);
    const signal = abortControllerRef.current.signal;

    // Helper to check if workflow should stop
    const checkAborted = () => {
      if (signal.aborted) {
        console.log('[useRepairWorkflow] Workflow aborted');
        throw new Error('Workflow aborted');
      }
    };

    const allPageNumbers = sceneImages.map(s => s.pageNumber);

    // Add cover pages if covers exist
    const coverPageNumbers: number[] = [];
    if (coverImages) {
      if (coverImages.frontCover) coverPageNumbers.push(COVER_PAGES.frontCover);
      if (coverImages.initialPage) coverPageNumbers.push(COVER_PAGES.initialPage);
      if (coverImages.backCover) coverPageNumbers.push(COVER_PAGES.backCover);
    }
    const allEvalNumbers = [...allPageNumbers, ...coverPageNumbers];

    try {
      // Step 1: Collect feedback (populates UI state; pass logic uses fresh API data)
      checkAborted();
      onProgress?.('collect-feedback', 'Collecting existing issues...');
      await collectFeedback();

      const allRedonePagesAcrossPasses: Set<number> = new Set();

      // === Global passes ===
      for (let pass = 1; pass <= maxPasses; pass++) {
        // On pass 2+, run entity consistency first (images changed in previous pass)
        if (pass >= 2) {
          checkAborted();
          onProgress?.('consistency-check', `Pass ${pass}: Running entity consistency...`);
          startStep('consistency-check');
          const consistencyResult = await storyService.runEntityConsistency(storyId);
          const consistencyReport = consistencyResult.report as EntityConsistencyReport | undefined;
          setWorkflowState(prev => ({
            ...prev,
            consistencyResults: { report: consistencyReport },
            stepStatus: { ...prev.stepStatus, 'consistency-check': 'completed' },
          }));
        }

        // Re-evaluate ALL pages (quality + semantic + entity penalties)
        // Pass 1: entity data from generation. Pass 2+: freshly updated entity data.
        checkAborted();
        onProgress?.('re-evaluate', `Pass ${pass}/${maxPasses}: Evaluating all pages...`);
        const evalResult = await reEvaluatePages(allEvalNumbers);

        // 3. Identify bad pages (server computes these using shared findBadPages)
        checkAborted();
        onProgress?.('identify-redo-pages', `Pass ${pass}: Identifying pages needing redo...`);
        const pagesToRedo = evalResult?.badPages ?? [];

        setWorkflowState(prev => ({
          ...prev,
          redoPages: { pageNumbers: pagesToRedo, reasons: {} },
          stepStatus: { ...prev.stepStatus, 'identify-redo-pages': 'completed' },
        }));

        // 4. If no bad pages, we're done with passes
        if (pagesToRedo.length === 0) {
          console.log(`[RepairWorkflow] Pass ${pass}: No bad pages, stopping early`);
          break;
        }

        // 5. Redo ALL bad pages (batched with concurrency limit)
        checkAborted();
        onProgress?.('redo-pages', `Pass ${pass}: Redoing ${pagesToRedo.length} pages (${IMAGE_CONCURRENCY} at a time)...`);
        startStep('redo-pages');

        let redoCompleted = 0;
        const redoLimit = pLimit(IMAGE_CONCURRENCY);

        await Promise.all(pagesToRedo.map((pageNumber) => redoLimit(async () => {
          checkAborted();
          onProgress?.('redo-pages', `Pass ${pass}: ${pageNumber < 0 ? 'Cover' : 'Page ' + pageNumber} (${redoCompleted + 1}/${pagesToRedo.length})`);
          setRedoProgress({ current: redoCompleted, total: pagesToRedo.length, currentPage: pageNumber });

          try {
            // Build evaluation feedback so the iterate endpoint knows what to fix
            const pageEval = evalResult?.evalPages?.[pageNumber];
            const evalFeedback = pageEval ? {
              score: pageEval.score ?? pageEval.qualityScore,
              reasoning: pageEval.reasoning,
              fixableIssues: pageEval.fixableIssues as Array<{ description?: string; issue?: string }>,
            } : undefined;
            const result: any = await redoCoverOrPage(pageNumber, evalFeedback);
            if (result?.success) {
              allRedonePagesAcrossPasses.add(pageNumber);
              if (!signal.aborted) {
                const scene = sceneImages.find(s => s.pageNumber === pageNumber);
                const newVersionIndex = (scene?.imageVersions?.length ?? 0);
                onImageUpdate?.(pageNumber, result.imageData, newVersionIndex, {
                  description: result.sceneDescription,
                  prompt: result.imagePrompt,
                  qualityScore: result.qualityScore,
                  qualityReasoning: result.qualityReasoning,
                  modelId: result.modelId,
                  totalAttempts: result.totalAttempts,
                  type: 'repair',
                });
              }
            }
          } catch (err) {
            console.error(`[RepairWorkflow] Pass ${pass}: Failed to redo ${pageNumber < 0 ? 'cover' : 'page'} ${pageNumber}:`, err);
          }

          redoCompleted++;
        })));

        setWorkflowState(prev => ({
          ...prev,
          redoResults: {
            pagesCompleted: Array.from(allRedonePagesAcrossPasses).sort((a, b) => a - b),
            newVersions: {},
            pageDetails: {},
          },
          stepStatus: { ...prev.stepStatus, 'redo-pages': 'completed' },
        }));
      }

      // === Final steps: consistency → evaluate → character repair → pick best ===

      // Final entity consistency check (against latest images)
      checkAborted();
      onProgress?.('consistency-check', 'Final consistency check...');
      startStep('consistency-check');
      const consistencyResult = await storyService.runEntityConsistency(storyId);
      const consistencyReport = consistencyResult.report as EntityConsistencyReport | undefined;
      setWorkflowState(prev => ({
        ...prev,
        consistencyResults: { report: consistencyReport },
        stepStatus: { ...prev.stepStatus, 'consistency-check': 'completed' },
      }));

      // Final re-evaluate ALL (with fresh entity data)
      checkAborted();
      onProgress?.('re-evaluate', 'Final evaluation of all pages...');
      await reEvaluatePages(allEvalNumbers);

      // Character repair (before pick-best so repair versions are also considered)
      // Server handles task selection via autoSelect (shared selectCharRepairTasks logic)
      checkAborted();
      onProgress?.('character-repair', 'Auto-selecting and repairing characters...');
      startStep('character-repair');
      try {
        const repairResult = await storyService.repairCharacters(storyId, [], { autoSelect: true });

        // Process results for UI state and image updates
        for (const charResult of (repairResult.results || [])) {
          const charName = charResult.character;
          const pagesRepaired = charResult.pagesRepaired || [];
          const pagesFailed = charResult.pagesFailed || [];

          // Notify parent of image updates (skip if aborted)
          if (!signal.aborted) {
            for (const repair of pagesRepaired) {
              if (repair.imageData && onImageUpdate) {
                try {
                  onImageUpdate(repair.pageNumber, repair.imageData, repair.versionIndex, {
                    type: 'character-repair',
                  });
                } catch (err) {
                  console.error(`[RepairWorkflow] Failed to notify image update for page ${repair.pageNumber}:`, err);
                }
              }
            }
          }

          if (pagesFailed.length > 0) {
            console.warn(`[RepairWorkflow] ${pagesFailed.length} pages failed repair for ${charName}:`,
              pagesFailed.map(f => `page ${f.pageNumber}: ${f.reason}`).join(', '));
          }

          const repairedDetails = pagesRepaired.map((r: any) => ({
            pageNumber: typeof r === 'number' ? r : r.pageNumber,
            comparison: r.comparison || null,
            verification: r.verification || null,
            method: r.method || 'gemini',
            debug: r.debug || null,
          }));
          const failedPages = pagesFailed.map(f => ({
            pageNumber: f.pageNumber,
            reason: f.reason,
            rejected: f.rejected,
            comparison: f.comparison || null,
          }));

          setWorkflowState(prev => ({
            ...prev,
            characterRepairResults: {
              charactersProcessed: [...prev.characterRepairResults.charactersProcessed, charName],
              pagesRepaired: { ...prev.characterRepairResults.pagesRepaired, [charName]: repairedDetails },
              pagesFailed: { ...prev.characterRepairResults.pagesFailed, [charName]: failedPages },
            },
          }));
        }

        // Add character-repaired pages to allRedonePagesAcrossPasses so pick-best considers them
        for (const charResult of (repairResult.results || [])) {
          for (const repair of (charResult.pagesRepaired || [])) {
            const pn = typeof repair === 'number' ? repair : repair.pageNumber;
            if (pn != null) allRedonePagesAcrossPasses.add(pn);
          }
        }

        setWorkflowState(prev => ({
          ...prev,
          stepStatus: { ...prev.stepStatus, 'character-repair': 'completed' },
        }));
      } catch (err) {
        console.error('[RepairWorkflow] Auto character repair failed:', err);
        setWorkflowState(prev => ({
          ...prev,
          stepStatus: { ...prev.stepStatus, 'character-repair': 'failed' },
        }));
      }

      // Re-evaluate character-repaired pages so pick-best has scores to compare
      const charRepairedPages = Array.from(allRedonePagesAcrossPasses);
      if (charRepairedPages.length > 0) {
        checkAborted();
        onProgress?.('re-evaluate', 'Re-evaluating repaired pages...');
        try {
          await reEvaluatePages(charRepairedPages);
          console.log(`[RepairWorkflow] Post-repair re-evaluation complete for ${charRepairedPages.length} pages`);
        } catch (err) {
          console.warn('[RepairWorkflow] Post-repair re-evaluation failed:', err);
        }
      }

      // Pick best versions last (considers all versions including character repairs)
      const redonePagesArray = Array.from(allRedonePagesAcrossPasses).sort((a, b) => a - b);
      const pickBestPages = redonePagesArray;
      if (pickBestPages.length > 0) {
        checkAborted();
        onProgress?.('redo-pages', 'Picking best versions...');
        try {
          const pickResult = await storyService.pickBestVersions(storyId, pickBestPages);
          const switched = Object.values(pickResult.results).filter(r => r.switched).length;
          console.log(`[RepairWorkflow] Pick-best: ${switched}/${pickBestPages.length} pages switched to better version`);
        } catch (err) {
          console.error('[RepairWorkflow] Pick-best failed:', err);
        }
      }

      onProgress?.('complete', 'Workflow complete!');
    } catch (error) {
      // Don't log abort as an error
      if (error instanceof Error && error.message === 'Workflow aborted') {
        console.log('[useRepairWorkflow] Workflow was aborted by user');
        return;
      }
      console.error('Full workflow failed:', error);
      throw error;
    } finally {
      abortControllerRef.current = null;
    }
  }, [
    storyId, sceneImages, coverImages, imageModel, onImageUpdate,
    collectFeedback, reEvaluatePages, startStep, setRedoProgress, redoCoverOrPage,
  ]);

  return {
    workflowState,
    isRunning,
    runningSteps,
    resetWorkflow,

    collectFeedback,

    toggleRedoPage,
    autoIdentifyRedoPages,

    redoMarkedPages,
    redoProgress,

    reEvaluatePages,

    runConsistencyCheck,

    repairCharacter,

    repairArtifacts,

    regenerateCovers,
    coverRepairProgress,

    runFullWorkflow,
    abortWorkflow,
    isAborted,

    getStepNumber,
    getCharactersWithIssues,
    getPagesWithSevereIssuesForCharacter,
  };
}

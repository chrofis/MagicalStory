import { useState, useCallback, useMemo, useRef } from 'react';
import type {
  RepairWorkflowStep,
  RepairWorkflowState,
  PageFeedback,
  SceneImage,
  EntityConsistencyReport,
  EntityCheckResult,
  EvaluationData,
  FinalChecksImageCheck,
} from '../types/story';
import type { Character } from '../types/character';
import { storyService } from '../services/storyService';

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
  characters: Character[];
  finalChecksReport?: {
    entity?: EntityConsistencyReport;
    imageChecks?: FinalChecksImageCheck[];
  } | null;
  imageModel?: string;
  onImageUpdate?: (pageNumber: number, imageData: string, versionIndex: number) => void;
}

export interface UseRepairWorkflowReturn {
  // State
  workflowState: RepairWorkflowState;
  isRunning: boolean;
  currentStepIndex: number;

  // Step control
  startStep: (step: RepairWorkflowStep) => void;
  completeStep: (step: RepairWorkflowStep, result?: unknown) => void;
  failStep: (step: RepairWorkflowStep, error?: string) => void;
  skipStep: (step: RepairWorkflowStep) => void;
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
  reEvaluatePages: (pageNumbers?: number[]) => Promise<void>;

  // Step 5: Consistency check
  runConsistencyCheck: () => Promise<void>;

  // Step 6: Character repair
  repairCharacter: (characterName: string, pages: number[], options?: { useMagicApiRepair?: boolean }) => Promise<void>;

  // Step 7: Artifact repair
  repairArtifacts: (pageNumbers: number[]) => Promise<void>;

  // Step 8: Cover repair
  regenerateCovers: (coverTypes: ('front' | 'back' | 'initial')[]) => Promise<void>;
  coverRepairProgress: { current: number; total: number; currentCover?: string };

  // Full automated workflow
  runFullWorkflow: (options?: {
    scoreThreshold?: number;
    issueThreshold?: number;
    maxRetries?: number;
    onProgress?: (step: string, detail: string) => void;
  }) => Promise<void>;

  // Abort running workflow
  abortWorkflow: () => void;
  isAborted: boolean;

  // Computed helpers
  canProceedToStep: (step: RepairWorkflowStep) => boolean;
  getStepNumber: (step: RepairWorkflowStep) => number;
  getPagesNeedingAttention: () => number[];
  getCharactersWithIssues: () => string[];
  getPagesWithSevereIssuesForCharacter: (characterName: string) => number[];
}

export function useRepairWorkflow({
  storyId,
  sceneImages,
  characters: _characters,
  finalChecksReport: _finalChecksReport,
  imageModel,
  onImageUpdate,
}: UseRepairWorkflowProps): UseRepairWorkflowReturn {
  const [workflowState, setWorkflowState] = useState<RepairWorkflowState>(createInitialState);
  const [redoProgress, setRedoProgress] = useState({ current: 0, total: 0, currentPage: undefined as number | undefined });

  // Abort mechanism for stopping runaway workflows
  const abortControllerRef = useRef<AbortController | null>(null);
  const [isAborted, setIsAborted] = useState(false);

  // Computed: is any step running
  const isRunning = useMemo(() => {
    return Object.values(workflowState.stepStatus).some(s => s === 'in-progress');
  }, [workflowState.stepStatus]);

  // Computed: current step index
  const currentStepIndex = useMemo(() => {
    return STEP_ORDER.indexOf(workflowState.currentStep);
  }, [workflowState.currentStep]);

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

        totalIssues += feedback.fixableIssues.length + feedback.entityIssues.length +
                       feedback.objectIssues.length + feedback.semanticIssues.length;
        pages[scene.pageNumber] = feedback;
      }

      completeStep('collect-feedback', { pages, totalIssues });
    } catch (error) {
      console.error('Failed to collect feedback:', error);
      failStep('collect-feedback', error instanceof Error ? error.message : 'Unknown error');
    }
  }, [storyId, sceneImages, startStep, completeStep, failStep]);

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
  const autoIdentifyRedoPages = useCallback((scoreThreshold = 60, issueThreshold = 5) => {
    startStep('identify-redo-pages');

    const pagesToRedo: number[] = [];
    const reasons: Record<number, string> = {};

    for (const [pageNum, feedback] of Object.entries(workflowState.collectedFeedback.pages)) {
      const page = parseInt(pageNum);
      const totalIssues = feedback.fixableIssues.length + feedback.entityIssues.length;
      const score = feedback.qualityScore ?? 100;

      // Mark for redo if score is low or too many issues
      if (score < scoreThreshold) {
        pagesToRedo.push(page);
        reasons[page] = `Low quality score: ${score}`;
      } else if (totalIssues >= issueThreshold) {
        pagesToRedo.push(page);
        reasons[page] = `Too many issues: ${totalIssues}`;
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
  }, [workflowState.collectedFeedback.pages, startStep]);

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
      for (let i = 0; i < pageNumbers.length; i++) {
        const pageNumber = pageNumbers[i];
        setRedoProgress({ current: i, total: pageNumbers.length, currentPage: pageNumber });

        try {
          // Use existing iteratePage function
          const result = await storyService.iteratePage(storyId, pageNumber, imageModel, {
            useOriginalAsReference: options?.useOriginalAsReference,
            blackoutIssues: options?.blackoutIssues,
          });

          if (result.success) {
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

            // Notify parent of image update
            if (onImageUpdate) {
              onImageUpdate(pageNumber, result.imageData, versionIndex);
            }
          }
        } catch (pageError) {
          console.error(`Failed to redo page ${pageNumber}:`, pageError);
          // Continue with other pages
        }
      }

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
  }, [storyId, workflowState.redoPages.pageNumbers, imageModel, sceneImages, onImageUpdate, startStep, failStep]);

  // Step 4: Re-evaluate pages
  const reEvaluatePages = useCallback(async (pageNumbers?: number[]) => {
    if (!storyId) return;

    startStep('re-evaluate');

    // Default to pages that were just redone, or all pages
    const pagesToEvaluate = pageNumbers ?? workflowState.redoResults.pagesCompleted;

    if (pagesToEvaluate.length === 0) {
      skipStep('re-evaluate');
      return;
    }

    try {
      const result = await storyService.reEvaluatePages(storyId, pagesToEvaluate);

      const evalResults: Record<number, {
        qualityScore: number;
        rawScore?: number;
        verdict?: string;
        issuesSummary?: string;
        reasoning?: string;
        fixableIssues: EvaluationData['fixableIssues'];
      }> = {};

      for (const [pageNum, pageResult] of Object.entries(result.pages || {})) {
        const pr = pageResult as {
          qualityScore: number;
          rawScore?: number;
          verdict?: string;
          issuesSummary?: string;
          reasoning?: string;
          fixableIssues: EvaluationData['fixableIssues'];
        };
        evalResults[parseInt(pageNum)] = {
          qualityScore: pr.qualityScore,
          rawScore: pr.rawScore,
          verdict: pr.verdict,
          issuesSummary: pr.issuesSummary,
          reasoning: pr.reasoning,
          fixableIssues: pr.fixableIssues,
        };
      }

      completeStep('re-evaluate', { pages: evalResults });
    } catch (error) {
      console.error('Re-evaluation failed:', error);
      failStep('re-evaluate', error instanceof Error ? error.message : 'Unknown error');
    }
  }, [storyId, workflowState.redoResults.pagesCompleted, startStep, completeStep, failStep, skipStep]);

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
  const repairCharacter = useCallback(async (characterName: string, pages: number[], options?: { useMagicApiRepair?: boolean }) => {
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
            onImageUpdate(repair.pageNumber, repair.imageData, repair.versionIndex);
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
      const repairedDetails = pagesRepaired.map(r => ({
        pageNumber: typeof r === 'number' ? r : r.pageNumber,
        comparison: r.comparison || null,
        verification: r.verification || null,
        method: r.method || 'gemini',
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

  // Can proceed to a step?
  const canProceedToStep = useCallback((step: RepairWorkflowStep): boolean => {
    const stepIndex = STEP_ORDER.indexOf(step);

    // Can always go to idle
    if (step === 'idle') return true;

    // Can't proceed if currently running
    if (isRunning) return false;

    // Check prerequisites based on step
    switch (step) {
      case 'collect-feedback':
        return true; // Can always start here

      case 'identify-redo-pages':
        return workflowState.stepStatus['collect-feedback'] === 'completed';

      case 'redo-pages':
        return workflowState.redoPages.pageNumbers.length > 0;

      case 're-evaluate':
        return workflowState.stepStatus['redo-pages'] === 'completed' ||
               workflowState.stepStatus['redo-pages'] === 'skipped';

      case 'consistency-check':
        // Can run after any earlier step
        return stepIndex > STEP_ORDER.indexOf('collect-feedback');

      case 'character-repair':
        return workflowState.stepStatus['consistency-check'] === 'completed';

      case 'artifact-repair':
        // Can run if there are artifact issues identified
        return workflowState.stepStatus['collect-feedback'] === 'completed';

      case 'cover-repair':
        // Can always run independently — no prerequisite steps
        return true;

      default:
        return false;
    }
  }, [workflowState, isRunning]);

  // Get step number (1-7)
  const getStepNumber = useCallback((step: RepairWorkflowStep): number => {
    const index = STEP_ORDER.indexOf(step);
    return index > 0 ? index : 0;
  }, []);

  // Get pages needing attention (low score or many issues)
  const getPagesNeedingAttention = useCallback((): number[] => {
    return Object.entries(workflowState.collectedFeedback.pages)
      .filter(([_, feedback]) => {
        const score = feedback.qualityScore ?? 100;
        const issues = feedback.fixableIssues.length + feedback.entityIssues.length;
        return score < 70 || issues > 0 || feedback.needsFullRedo;
      })
      .map(([pageNum]) => parseInt(pageNum))
      .sort((a, b) => a - b);
  }, [workflowState.collectedFeedback.pages]);

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

  // Full automated workflow - runs all steps in sequence
  // Note: We use local tracking instead of relying on React state updates (stale closure issue)
  const runFullWorkflow = useCallback(async (options: {
    scoreThreshold?: number;
    issueThreshold?: number;
    maxRetries?: number;
    onProgress?: (step: string, detail: string) => void;
  } = {}) => {
    if (!storyId) return;

    // Default thresholds for repair decisions
    const DEFAULT_SCORE_THRESHOLD = 6;      // Out of 10 - pages below this need redo
    const DEFAULT_ISSUE_THRESHOLD = 5;      // Number of fixable issues triggering redo
    const DEFAULT_MAX_RETRIES = 4;          // Max iterations per page

    const { scoreThreshold = DEFAULT_SCORE_THRESHOLD, issueThreshold = DEFAULT_ISSUE_THRESHOLD, maxRetries = DEFAULT_MAX_RETRIES, onProgress } = options;

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

    try {
      // Step 1: Collect feedback
      checkAborted();
      onProgress?.('collect-feedback', 'Collecting existing issues...');
      await collectFeedback();

      // Step 4 first: Re-evaluate ALL pages to get current state
      checkAborted();
      onProgress?.('re-evaluate', 'Evaluating all pages...');
      const evalResult = await storyService.reEvaluatePages(storyId, sceneImages.map(s => s.pageNumber));

      // Build local evaluation results map
      const evalPages: Record<number, { qualityScore: number; rawScore?: number; fixableIssues?: Array<{ type: string }> }> = {};
      for (const [pageNum, pageResult] of Object.entries(evalResult.pages || {})) {
        const pr = pageResult as { qualityScore: number; rawScore?: number; fixableIssues?: Array<{ type: string }> };
        evalPages[parseInt(pageNum)] = pr;
      }

      // Step 2: Auto-identify redo pages based on evaluation results (compute locally)
      checkAborted();
      onProgress?.('identify-redo-pages', 'Identifying pages needing redo...');
      const pagesToRedo: number[] = [];
      for (const [pageNumStr, result] of Object.entries(evalPages)) {
        const pageNum = parseInt(pageNumStr);
        const rawScore = result.rawScore ?? Math.round(result.qualityScore / 10);
        // Validate rawScore is on 0-10 scale (not 0-100)
        if (rawScore > 10) {
          console.error(`[RepairWorkflow] Invalid rawScore scale for page ${pageNum}: ${rawScore} (expected 0-10)`);
        }
        const issueCount = result.fixableIssues?.length ?? 0;
        if (rawScore < scoreThreshold || issueCount >= issueThreshold) {
          pagesToRedo.push(pageNum);
        }
      }
      pagesToRedo.sort((a, b) => a - b);

      // Update state for UI
      setWorkflowState(prev => ({
        ...prev,
        redoPages: { pageNumbers: pagesToRedo, reasons: {} },
        stepStatus: { ...prev.stepStatus, 'identify-redo-pages': 'completed' },
      }));

      // Step 3: Redo pages with retry logic (up to maxRetries, keep best)
      checkAborted();
      const pagesCompleted: number[] = [];
      if (pagesToRedo.length > 0) {
        onProgress?.('redo-pages', `Redoing ${pagesToRedo.length} pages...`);
        startStep('redo-pages');

        const bestResults: Record<number, { score: number; imageData: string; versionIndex: number }> = {};

        for (let i = 0; i < pagesToRedo.length; i++) {
          // Check abort before each page
          checkAborted();

          const pageNumber = pagesToRedo[i];
          let bestScore = 0;
          let bestImageData = '';
          let bestVersionIndex = 0;

          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            // Check abort before each attempt
            checkAborted();

            onProgress?.('redo-pages', `Page ${pageNumber}: attempt ${attempt}/${maxRetries}`);
            setRedoProgress({ current: i, total: pagesToRedo.length, currentPage: pageNumber });

            try {
              const result = await storyService.iteratePage(storyId, pageNumber, imageModel);

              if (result.success) {
                const score = result.qualityScore ?? 0;
                if (score > bestScore) {
                  bestScore = score;
                  bestImageData = result.imageData;
                  const scene = sceneImages.find(s => s.pageNumber === pageNumber);
                  bestVersionIndex = (scene?.imageVersions?.length ?? 0) + attempt - 1;
                }

                // If score is good enough, stop retrying
                if (score >= scoreThreshold * 10) {
                  break;
                }
              }
            } catch (err) {
              console.error(`Failed to redo page ${pageNumber} attempt ${attempt}:`, err);
            }
          }

          if (bestImageData) {
            bestResults[pageNumber] = { score: bestScore, imageData: bestImageData, versionIndex: bestVersionIndex };
            pagesCompleted.push(pageNumber);
            onImageUpdate?.(pageNumber, bestImageData, bestVersionIndex);
          }
        }

        setWorkflowState(prev => ({
          ...prev,
          redoResults: {
            pagesCompleted,
            newVersions: Object.fromEntries(Object.entries(bestResults).map(([p, r]) => [p, r.versionIndex])),
            pageDetails: {},  // Auto-repair doesn't capture per-page details
          },
          stepStatus: { ...prev.stepStatus, 'redo-pages': 'completed' },
        }));
      }

      // Step 4 again: Re-evaluate redone pages
      if (pagesCompleted.length > 0) {
        checkAborted();
        onProgress?.('re-evaluate', 'Re-evaluating redone pages...');
        await reEvaluatePages(pagesCompleted);
      }

      // Step 5: Consistency check
      checkAborted();
      onProgress?.('consistency-check', 'Running consistency check...');
      const consistencyResult = await storyService.runEntityConsistency(storyId);
      const consistencyReport = consistencyResult.report as EntityConsistencyReport | undefined;

      // Update state with consistency results
      setWorkflowState(prev => ({
        ...prev,
        consistencyResults: { report: consistencyReport },
        stepStatus: { ...prev.stepStatus, 'consistency-check': 'completed' },
      }));

      // Step 6: Auto-repair characters with severe issues (use local consistency result)
      checkAborted();
      if (consistencyReport?.characters) {
        const charsWithIssues = Object.entries(consistencyReport.characters)
          .filter(([_, result]) => {
            if ('overallConsistent' in result) {
              return !result.overallConsistent || (result.totalIssues ?? 0) > 0;
            }
            return !result.consistent || (result.issues?.length ?? 0) > 0;
          })
          .map(([name]) => name);

        if (charsWithIssues.length > 0) {
          onProgress?.('character-repair', `Repairing ${charsWithIssues.length} characters...`);
          for (const charName of charsWithIssues) {
            checkAborted();
            // Compute severe pages locally from consistency report
            const charResult = consistencyReport.characters[charName] as EntityCheckResult;
            const severePages = new Set<number>();
            if (charResult.byClothing) {
              for (const clothingResult of Object.values(charResult.byClothing)) {
                for (const issue of clothingResult.issues || []) {
                  if (issue.severity === 'major' || issue.severity === 'critical') {
                    for (const page of issue.pagesToFix || []) severePages.add(page);
                    if (issue.pageNumber) severePages.add(issue.pageNumber);
                  }
                }
              }
            }
            if (charResult.issues) {
              for (const issue of charResult.issues) {
                if (issue.severity === 'major' || issue.severity === 'critical') {
                  for (const page of issue.pagesToFix || []) severePages.add(page);
                  if (issue.pageNumber) severePages.add(issue.pageNumber);
                }
              }
            }
            const pages = Array.from(severePages).sort((a, b) => a - b);
            if (pages.length > 0) {
              onProgress?.('character-repair', `Repairing ${charName} on ${pages.length} pages...`);
              await repairCharacter(charName, pages);
            }
          }
        }
      }

      // Step 7: Auto-repair artifacts
      checkAborted();
      // Get pages with artifact/distortion issues from evaluation results
      const artifactPages: number[] = [];
      for (const [pageStr, result] of Object.entries(evalPages)) {
        if (result.fixableIssues?.some(i => i.type === 'artifact' || i.type === 'distortion')) {
          artifactPages.push(parseInt(pageStr));
        }
      }
      if (artifactPages.length > 0) {
        onProgress?.('artifact-repair', `Repairing artifacts on ${artifactPages.length} pages...`);
        await repairArtifacts(artifactPages);
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
    storyId, sceneImages, imageModel, onImageUpdate,
    collectFeedback, reEvaluatePages, startStep, setRedoProgress,
    runConsistencyCheck, repairCharacter, repairArtifacts
  ]);

  return {
    workflowState,
    isRunning,
    currentStepIndex,

    startStep,
    completeStep,
    failStep,
    skipStep,
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

    canProceedToStep,
    getStepNumber,
    getPagesNeedingAttention,
    getCharactersWithIssues,
    getPagesWithSevereIssuesForCharacter,
  };
}

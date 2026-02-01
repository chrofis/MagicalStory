import { useState, useCallback, useMemo } from 'react';
import type {
  RepairWorkflowStep,
  RepairWorkflowState,
  PageFeedback,
  SceneImage,
  EntityConsistencyReport,
  EvaluationData,
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
    },
    reEvaluationResults: {
      pages: {},
    },
    consistencyResults: {},
    characterRepairResults: {
      charactersProcessed: [],
      pagesRepaired: {},
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
];

export interface UseRepairWorkflowProps {
  storyId: string | null;
  sceneImages: SceneImage[];
  characters: Character[];
  finalChecksReport?: {
    entity?: EntityConsistencyReport;
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
  updatePageFeedback: (pageNumber: number, feedback: Partial<PageFeedback>) => void;

  // Step 2: Identify redo pages
  toggleRedoPage: (pageNumber: number, reason?: string) => void;
  autoIdentifyRedoPages: (scoreThreshold?: number, issueThreshold?: number) => void;

  // Step 3: Redo pages (uses existing iterate function)
  redoMarkedPages: () => Promise<void>;
  redoProgress: { current: number; total: number; currentPage?: number };

  // Step 4: Re-evaluate
  reEvaluatePages: (pageNumbers?: number[]) => Promise<void>;

  // Step 5: Consistency check
  runConsistencyCheck: () => Promise<void>;

  // Step 6: Character repair
  repairCharacter: (characterName: string, pages: number[]) => Promise<void>;

  // Step 7: Artifact repair
  repairArtifacts: (pageNumbers: number[]) => Promise<void>;

  // Computed helpers
  canProceedToStep: (step: RepairWorkflowStep) => boolean;
  getStepNumber: (step: RepairWorkflowStep) => number;
  getPagesNeedingAttention: () => number[];
  getCharactersWithIssues: () => string[];
}

export function useRepairWorkflow({
  storyId,
  sceneImages,
  characters: _characters,
  finalChecksReport,
  imageModel,
  onImageUpdate,
}: UseRepairWorkflowProps): UseRepairWorkflowReturn {
  const [workflowState, setWorkflowState] = useState<RepairWorkflowState>(createInitialState);
  const [redoProgress, setRedoProgress] = useState({ current: 0, total: 0, currentPage: undefined as number | undefined });

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
  }, []);

  // Step 1: Collect feedback from existing evaluation data
  const collectFeedback = useCallback(async () => {
    if (!storyId) return;

    startStep('collect-feedback');

    try {
      // Collect from existing data (sceneImages and finalChecksReport)
      const pages: Record<number, PageFeedback> = {};
      let totalIssues = 0;

      // Process each scene image
      for (const scene of sceneImages) {
        const feedback: PageFeedback = {
          pageNumber: scene.pageNumber,
          qualityScore: scene.qualityScore,
          fixableIssues: [],
          entityIssues: [],
          manualNotes: '',
          needsFullRedo: false,
        };

        // Get fixable issues from retry history or current evaluation
        const latestRetry = scene.retryHistory?.slice(-1)[0];
        if (latestRetry?.postRepairEval?.fixableIssues) {
          feedback.fixableIssues = latestRetry.postRepairEval.fixableIssues;
        } else if (latestRetry?.preRepairEval?.fixableIssues) {
          feedback.fixableIssues = latestRetry.preRepairEval.fixableIssues;
        }

        // Get entity issues from finalChecksReport
        if (finalChecksReport?.entity) {
          for (const [charName, charResult] of Object.entries(finalChecksReport.entity.characters || {})) {
            const charIssues = charResult.issues?.filter(i =>
              i.pagesToFix?.includes(scene.pageNumber) || i.pageNumber === scene.pageNumber
            ) || [];

            for (const issue of charIssues) {
              feedback.entityIssues.push({
                character: charName,
                issue: issue.description,
                severity: issue.severity,
              });
            }
          }
        }

        totalIssues += feedback.fixableIssues.length + feedback.entityIssues.length;
        pages[scene.pageNumber] = feedback;
      }

      completeStep('collect-feedback', { pages, totalIssues });
    } catch (error) {
      console.error('Failed to collect feedback:', error);
      failStep('collect-feedback', error instanceof Error ? error.message : 'Unknown error');
    }
  }, [storyId, sceneImages, finalChecksReport, startStep, completeStep, failStep]);

  // Update feedback for a specific page
  const updatePageFeedback = useCallback((pageNumber: number, feedback: Partial<PageFeedback>) => {
    setWorkflowState(prev => ({
      ...prev,
      collectedFeedback: {
        ...prev.collectedFeedback,
        pages: {
          ...prev.collectedFeedback.pages,
          [pageNumber]: {
            ...prev.collectedFeedback.pages[pageNumber],
            ...feedback,
          },
        },
      },
    }));
  }, []);

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
  const autoIdentifyRedoPages = useCallback((scoreThreshold = 6, issueThreshold = 3) => {
    startStep('identify-redo-pages');

    const pagesToRedo: number[] = [];
    const reasons: Record<number, string> = {};

    for (const [pageNum, feedback] of Object.entries(workflowState.collectedFeedback.pages)) {
      const page = parseInt(pageNum);
      const totalIssues = feedback.fixableIssues.length + feedback.entityIssues.length;
      const score = feedback.qualityScore ?? 10;

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
  const redoMarkedPages = useCallback(async () => {
    if (!storyId || workflowState.redoPages.pageNumbers.length === 0) return;

    startStep('redo-pages');
    const pageNumbers = workflowState.redoPages.pageNumbers;
    setRedoProgress({ current: 0, total: pageNumbers.length, currentPage: undefined });

    const pagesCompleted: number[] = [];
    const newVersions: Record<number, number> = {};

    try {
      for (let i = 0; i < pageNumbers.length; i++) {
        const pageNumber = pageNumbers[i];
        setRedoProgress({ current: i, total: pageNumbers.length, currentPage: pageNumber });

        try {
          // Use existing iteratePage function
          const result = await storyService.iteratePage(storyId, pageNumber, imageModel);

          if (result.success) {
            pagesCompleted.push(pageNumber);

            // Find version index (imageVersions length after update)
            const scene = sceneImages.find(s => s.pageNumber === pageNumber);
            const versionIndex = (scene?.imageVersions?.length ?? 0);
            newVersions[pageNumber] = versionIndex;

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

      const evalResults: Record<number, { qualityScore: number; fixableIssues: EvaluationData['fixableIssues'] }> = {};

      for (const [pageNum, pageResult] of Object.entries(result.pages || {})) {
        evalResults[parseInt(pageNum)] = {
          qualityScore: pageResult.qualityScore,
          fixableIssues: pageResult.fixableIssues,
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
  const repairCharacter = useCallback(async (characterName: string, pages: number[]) => {
    if (!storyId || pages.length === 0) return;

    startStep('character-repair');

    try {
      const result = await storyService.repairCharacters(storyId, [{ character: characterName, pages }]);

      // Get pages repaired from the result
      const pagesRepaired = result.results?.[0]?.pagesRepaired || pages;

      setWorkflowState(prev => ({
        ...prev,
        characterRepairResults: {
          charactersProcessed: [...prev.characterRepairResults.charactersProcessed, characterName],
          pagesRepaired: {
            ...prev.characterRepairResults.pagesRepaired,
            [characterName]: pagesRepaired,
          },
        },
        stepStatus: {
          ...prev.stepStatus,
          'character-repair': 'completed',
        },
      }));
    } catch (error) {
      console.error('Character repair failed:', error);
      failStep('character-repair', error instanceof Error ? error.message : 'Unknown error');
    }
  }, [storyId, startStep, failStep]);

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
        const score = feedback.qualityScore ?? 10;
        const issues = feedback.fixableIssues.length + feedback.entityIssues.length;
        return score < 7 || issues > 0 || feedback.needsFullRedo;
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
    updatePageFeedback,

    toggleRedoPage,
    autoIdentifyRedoPages,

    redoMarkedPages,
    redoProgress,

    reEvaluatePages,

    runConsistencyCheck,

    repairCharacter,

    repairArtifacts,

    canProceedToStep,
    getStepNumber,
    getPagesNeedingAttention,
    getCharactersWithIssues,
  };
}

import { useState, useCallback, useMemo } from 'react';
import type {
  RepairWorkflowStep,
  RepairWorkflowState,
  PageFeedback,
  SceneImage,
  EntityConsistencyReport,
  EntityCheckResult,
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

  // Full automated workflow
  runFullWorkflow: (options?: {
    scoreThreshold?: number;
    issueThreshold?: number;
    maxRetries?: number;
    onProgress?: (step: string, detail: string) => void;
  }) => Promise<void>;

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
            // Collect issues from both new byClothing structure and legacy flat structure
            const allIssues: typeof charResult.issues = [];

            // New structure: byClothing[category].issues
            if (charResult.byClothing) {
              for (const clothingResult of Object.values(charResult.byClothing)) {
                if (clothingResult.issues) {
                  allIssues.push(...clothingResult.issues);
                }
              }
            }

            // Legacy structure: issues at root level
            if (charResult.issues) {
              allIssues.push(...charResult.issues);
            }

            // Filter to issues affecting this page
            const charIssues = allIssues.filter(i =>
              i.pagesToFix?.includes(scene.pageNumber) || i.pageNumber === scene.pageNumber
            );

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

    const { scoreThreshold = 6, issueThreshold = 3, maxRetries = 4, onProgress } = options;

    try {
      // Step 1: Collect feedback
      onProgress?.('collect-feedback', 'Collecting existing issues...');
      await collectFeedback();

      // Step 4 first: Re-evaluate ALL pages to get current state
      onProgress?.('re-evaluate', 'Evaluating all pages...');
      const evalResult = await storyService.reEvaluatePages(storyId, sceneImages.map(s => s.pageNumber));

      // Build local evaluation results map
      const evalPages: Record<number, { qualityScore: number; rawScore?: number; fixableIssues?: Array<{ type: string }> }> = {};
      for (const [pageNum, pageResult] of Object.entries(evalResult.pages || {})) {
        const pr = pageResult as { qualityScore: number; rawScore?: number; fixableIssues?: Array<{ type: string }> };
        evalPages[parseInt(pageNum)] = pr;
      }

      // Step 2: Auto-identify redo pages based on evaluation results (compute locally)
      onProgress?.('identify-redo-pages', 'Identifying pages needing redo...');
      const pagesToRedo: number[] = [];
      for (const [pageNumStr, result] of Object.entries(evalPages)) {
        const pageNum = parseInt(pageNumStr);
        const rawScore = result.rawScore ?? Math.round(result.qualityScore / 10);
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
      const pagesCompleted: number[] = [];
      if (pagesToRedo.length > 0) {
        onProgress?.('redo-pages', `Redoing ${pagesToRedo.length} pages...`);
        startStep('redo-pages');

        const bestResults: Record<number, { score: number; imageData: string; versionIndex: number }> = {};

        for (let i = 0; i < pagesToRedo.length; i++) {
          const pageNumber = pagesToRedo[i];
          let bestScore = 0;
          let bestImageData = '';
          let bestVersionIndex = 0;

          for (let attempt = 1; attempt <= maxRetries; attempt++) {
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
          },
          stepStatus: { ...prev.stepStatus, 'redo-pages': 'completed' },
        }));
      }

      // Step 4 again: Re-evaluate redone pages
      if (pagesCompleted.length > 0) {
        onProgress?.('re-evaluate', 'Re-evaluating redone pages...');
        await reEvaluatePages(pagesCompleted);
      }

      // Step 5: Consistency check
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
      console.error('Full workflow failed:', error);
      throw error;
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
    updatePageFeedback,

    toggleRedoPage,
    autoIdentifyRedoPages,

    redoMarkedPages,
    redoProgress,

    reEvaluatePages,

    runConsistencyCheck,

    repairCharacter,

    repairArtifacts,

    runFullWorkflow,

    canProceedToStep,
    getStepNumber,
    getPagesNeedingAttention,
    getCharactersWithIssues,
    getPagesWithSevereIssuesForCharacter,
  };
}

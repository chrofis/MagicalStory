import { useState, useMemo, useEffect, useRef } from 'react';
import {
  Wrench,
  RotateCcw,
  CheckCircle,
  Circle,
  Loader2,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Search,
  Zap,
  Users,
  Grid,
  XCircle,
  Play,
  SkipForward,
  Square,
  Image,
} from 'lucide-react';
import { useRepairWorkflow } from '@/hooks/useRepairWorkflow';
import { ImageLightbox } from '@/components/common/ImageLightbox';
import type { SceneImage, FinalChecksReport, RepairWorkflowStep, StepStatus, PageFeedback, RepairPageResult } from '@/types/story';
import type { Character } from '@/types/character';

interface RepairWorkflowPanelProps {
  storyId: string | null;
  sceneImages: SceneImage[];
  characters: Character[];
  finalChecksReport?: FinalChecksReport | null;
  imageModel?: string;
  onImageUpdate?: (pageNumber: number, imageData: string, versionIndex: number) => void;
  onRefreshStory?: () => Promise<void>;
  // Auto-trigger full workflow on mount (for post-generation repair)
  autoRunFullWorkflow?: boolean;
  // Callback when auto-run completes (to clear the trigger state in parent)
  onAutoRunComplete?: () => void;
  // Developer mode settings
  developerMode?: boolean;
  useMagicApiRepair?: boolean;
  setUseMagicApiRepair?: (use: boolean) => void;
}

// Step configuration
const STEP_CONFIG: Record<RepairWorkflowStep, { label: string; icon: React.ComponentType<{ className?: string }>; description: string }> = {
  'idle': { label: 'Ready', icon: Circle, description: '' },
  'collect-feedback': { label: '1. Collect Feedback', icon: Search, description: 'Gather all issues from evaluation data' },
  'identify-redo-pages': { label: '2. Identify Redo Pages', icon: AlertTriangle, description: 'Mark pages needing complete regeneration' },
  'redo-pages': { label: '3. Redo Pages', icon: RefreshCw, description: 'Regenerate marked pages via iteration' },
  're-evaluate': { label: '4. Re-evaluate', icon: CheckCircle, description: 'Run quality evaluation on new images' },
  'consistency-check': { label: '5. Consistency Check', icon: Users, description: 'Run entity consistency on all pages' },
  'character-repair': { label: '6. Character Repair', icon: Users, description: 'Fix character appearance issues' },
  'artifact-repair': { label: '7. Artifact Repair', icon: Grid, description: 'Fix remaining artifacts via grid repair' },
  'cover-repair': { label: '8. Cover Repair', icon: Image, description: 'Regenerate front, back, or dedication covers' },
};

// Status badge component
function StepStatusBadge({ status }: { status: StepStatus }) {
  const config = {
    'pending': { color: 'bg-gray-100 text-gray-600', icon: Circle },
    'in-progress': { color: 'bg-blue-100 text-blue-600', icon: Loader2 },
    'completed': { color: 'bg-green-100 text-green-600', icon: CheckCircle },
    'skipped': { color: 'bg-yellow-100 text-yellow-600', icon: SkipForward },
    'failed': { color: 'bg-red-100 text-red-600', icon: XCircle },
  };

  const { color, icon: Icon } = config[status];
  const isSpinning = status === 'in-progress';

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${color}`}>
      <Icon className={`w-3 h-3 ${isSpinning ? 'animate-spin' : ''}`} />
      {status}
    </span>
  );
}

// Page feedback card component
function PageFeedbackCard({
  feedback,
  isMarkedForRedo,
  onToggleRedo,
  onUpdateNotes,
}: {
  feedback: PageFeedback;
  isMarkedForRedo: boolean;
  onToggleRedo: () => void;
  onUpdateNotes: (notes: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const totalIssues = feedback.fixableIssues.length + feedback.entityIssues.length +
                      (feedback.objectIssues?.length || 0) + (feedback.semanticIssues?.length || 0);
  const hasIssues = totalIssues > 0 || (feedback.qualityScore !== undefined && feedback.qualityScore < 70);

  return (
    <div className={`border rounded-lg p-3 ${isMarkedForRedo ? 'border-red-300 bg-red-50' : hasIssues ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-white'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1 hover:bg-gray-100 rounded"
          >
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
          <span className="font-medium">Page {feedback.pageNumber}</span>
          {feedback.qualityScore !== undefined && (
            <span className={`text-xs px-1.5 py-0.5 rounded ${
              feedback.qualityScore >= 80 ? 'bg-green-100 text-green-700' :
              feedback.qualityScore >= 60 ? 'bg-yellow-100 text-yellow-700' :
              'bg-red-100 text-red-700'
            }`}>
              {feedback.semanticScore != null ? 'Quality' : 'Score'}: {Math.max(0, feedback.qualityScore)}
            </span>
          )}
          {feedback.semanticScore != null && (
            <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
              Semantic: {feedback.semanticScore}%
            </span>
          )}
          {feedback.qualityScore !== undefined && feedback.semanticScore != null && (
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
              feedback.qualityScore >= 70 ? 'bg-green-100 text-green-700' :
              feedback.qualityScore >= 50 ? 'bg-yellow-100 text-yellow-700' :
              'bg-red-100 text-red-700'
            }`}>
              Final: {feedback.qualityScore}%
            </span>
          )}
          {feedback.verdict && (
            <span className={`text-xs px-1.5 py-0.5 rounded ${
              feedback.verdict === 'PASS' ? 'bg-green-100 text-green-700' :
              feedback.verdict === 'SOFT_FAIL' ? 'bg-yellow-100 text-yellow-700' :
              'bg-red-100 text-red-700'
            }`}>
              {feedback.verdict}
            </span>
          )}
          {totalIssues > 0 && (
            <span className="text-xs text-gray-500">{totalIssues} issues</span>
          )}
        </div>
        <button
          onClick={onToggleRedo}
          className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
            isMarkedForRedo
              ? 'bg-red-600 text-white hover:bg-red-700'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          {isMarkedForRedo ? 'Marked for Redo' : 'Mark for Redo'}
        </button>
      </div>

      {expanded && (
        <div className="mt-3 space-y-2 pl-7">
          {feedback.issuesSummary && feedback.issuesSummary !== 'none' && (
            <p className={`text-xs pl-2 border-l-2 ${
              feedback.issuesSummary.includes('SEMANTIC:')
                ? 'text-purple-700 border-purple-400 bg-purple-50 p-1 rounded-r'
                : 'text-gray-600 border-gray-300'
            }`}>
              {feedback.issuesSummary}
            </p>
          )}
          {feedback.semanticResult && (
            <div className="text-xs text-purple-700 pl-2 border-l-2 border-purple-400 bg-purple-50 p-1 rounded-r mt-1">
              <span className="font-medium">Semantic Analysis (Score: {feedback.semanticResult.score ?? 'N/A'}):</span>
              {feedback.semanticResult.visible && (
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                  <div className="bg-white p-2 rounded border border-purple-200">
                    <div className="font-medium text-purple-800 mb-1">Visible:</div>
                    {feedback.semanticResult.visible.characters && feedback.semanticResult.visible.characters.length > 0 && (
                      <div><span className="text-gray-500">Characters:</span> {feedback.semanticResult.visible.characters.join(', ')}</div>
                    )}
                    {feedback.semanticResult.visible.objects && feedback.semanticResult.visible.objects.length > 0 && (
                      <div><span className="text-gray-500">Objects:</span> {feedback.semanticResult.visible.objects.join(', ')}</div>
                    )}
                    {feedback.semanticResult.visible.setting && (
                      <div><span className="text-gray-500">Setting:</span> {feedback.semanticResult.visible.setting}</div>
                    )}
                    {feedback.semanticResult.visible.action && (
                      <div><span className="text-gray-500">Action:</span> {feedback.semanticResult.visible.action}</div>
                    )}
                  </div>
                  <div className="bg-white p-2 rounded border border-purple-200">
                    <div className="font-medium text-purple-800 mb-1">Expected:</div>
                    {feedback.semanticResult.expected?.characters && feedback.semanticResult.expected.characters.length > 0 && (
                      <div><span className="text-gray-500">Characters:</span> {feedback.semanticResult.expected.characters.join(', ')}</div>
                    )}
                    {feedback.semanticResult.expected?.objects && feedback.semanticResult.expected.objects.length > 0 && (
                      <div><span className="text-gray-500">Objects:</span> {feedback.semanticResult.expected.objects.join(', ')}</div>
                    )}
                    {feedback.semanticResult.expected?.setting && (
                      <div><span className="text-gray-500">Setting:</span> {feedback.semanticResult.expected.setting}</div>
                    )}
                    {feedback.semanticResult.expected?.action && (
                      <div><span className="text-gray-500">Action:</span> {feedback.semanticResult.expected.action}</div>
                    )}
                  </div>
                </div>
              )}
              {feedback.semanticResult.semanticIssues && feedback.semanticResult.semanticIssues.length > 0 && (
                <ul className="list-disc list-inside mt-2">
                  {feedback.semanticResult.semanticIssues.map((issue, idx) => (
                    <li key={idx}>
                      <span className={`font-medium ${
                        issue.severity === 'CRITICAL' ? 'text-red-600' :
                        issue.severity === 'MAJOR' ? 'text-orange-600' : 'text-yellow-600'
                      }`}>[{issue.severity}]</span> {issue.problem}
                    </li>
                  ))}
                </ul>
              )}
              {feedback.semanticResult.semanticIssues?.length === 0 && !feedback.semanticResult.visible && (
                <span className="text-green-600 ml-2">No issues</span>
              )}
            </div>
          )}
          {feedback.fixableIssues.length > 0 && (
            <div>
              <h5 className="text-xs font-medium text-gray-600 mb-1">Quality Issues ({feedback.fixableIssues.length}):</h5>
              <ul className="text-xs text-gray-600 space-y-1">
                {feedback.fixableIssues.map((issue, i) => (
                  <li key={i} className="flex items-start gap-1">
                    {issue.source && (
                      <span className="text-[10px] px-1 rounded bg-gray-100 text-gray-500">{issue.source}</span>
                    )}
                    <span className={`px-1 rounded ${
                      issue.severity === 'critical' ? 'bg-red-100 text-red-700' :
                      issue.severity === 'major' ? 'bg-orange-100 text-orange-700' :
                      'bg-yellow-100 text-yellow-700'
                    }`}>{issue.severity}</span>
                    <span>[{issue.type}] {issue.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {feedback.entityIssues.length > 0 && (
            <div>
              <h5 className="text-xs font-medium text-gray-600 mb-1">Character Consistency ({feedback.entityIssues.length}):</h5>
              <ul className="text-xs text-gray-600 space-y-1">
                {feedback.entityIssues.map((issue, i) => (
                  <li key={i} className="flex items-start gap-1">
                    {issue.source && (
                      <span className="text-[10px] px-1 rounded bg-gray-100 text-gray-500">{issue.source}</span>
                    )}
                    <span className="px-1 rounded bg-purple-100 text-purple-700">{issue.character}</span>
                    <span className={`px-1 rounded ${
                      issue.severity === 'critical' ? 'bg-red-100 text-red-700' :
                      issue.severity === 'major' ? 'bg-orange-100 text-orange-700' :
                      'bg-yellow-100 text-yellow-700'
                    }`}>{issue.severity}</span>
                    <span>{issue.issue}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {feedback.objectIssues && feedback.objectIssues.length > 0 && (
            <div>
              <h5 className="text-xs font-medium text-gray-600 mb-1">Object Consistency ({feedback.objectIssues.length}):</h5>
              <ul className="text-xs text-gray-600 space-y-1">
                {feedback.objectIssues.map((issue, i) => (
                  <li key={i} className="flex items-start gap-1">
                    {issue.source && (
                      <span className="text-[10px] px-1 rounded bg-gray-100 text-gray-500">{issue.source}</span>
                    )}
                    <span className="px-1 rounded bg-blue-100 text-blue-700">{issue.object}</span>
                    <span className={`px-1 rounded ${
                      issue.severity === 'critical' ? 'bg-red-100 text-red-700' :
                      issue.severity === 'major' ? 'bg-orange-100 text-orange-700' :
                      'bg-yellow-100 text-yellow-700'
                    }`}>{issue.severity}</span>
                    <span>{issue.issue}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {feedback.semanticIssues && feedback.semanticIssues.length > 0 && (
            <div>
              <h5 className="text-xs font-medium text-gray-600 mb-1">Semantic Issues ({feedback.semanticIssues.length}):</h5>
              <ul className="text-xs text-gray-600 space-y-1">
                {feedback.semanticIssues.map((issue, i) => (
                  <li key={i} className="flex items-start gap-1">
                    {issue.source && (
                      <span className="text-[10px] px-1 rounded bg-gray-100 text-gray-500">{issue.source}</span>
                    )}
                    <span className="px-1 rounded bg-indigo-100 text-indigo-700">{issue.type.replace(/_/g, ' ')}</span>
                    {issue.characterInvolved && (
                      <span className="px-1 rounded bg-purple-100 text-purple-700">{issue.characterInvolved}</span>
                    )}
                    <span className={`px-1 rounded ${
                      issue.severity === 'high' ? 'bg-red-100 text-red-700' :
                      issue.severity === 'medium' ? 'bg-orange-100 text-orange-700' :
                      'bg-yellow-100 text-yellow-700'
                    }`}>{issue.severity}</span>
                    <span>{issue.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h5 className="text-xs font-medium text-gray-600 mb-1">Manual Notes:</h5>
            <textarea
              value={feedback.manualNotes}
              onChange={(e) => onUpdateNotes(e.target.value)}
              placeholder="Add notes about issues not captured automatically..."
              className="w-full text-xs p-2 border rounded resize-none"
              rows={2}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// localStorage key for tracking completed auto-runs (persists across remounts/refreshes)
const AUTORUN_COMPLETED_KEY = 'repair-workflow-autorun-completed';

export function RepairWorkflowPanel({
  storyId,
  sceneImages,
  characters,
  finalChecksReport,
  imageModel,
  onImageUpdate,
  onRefreshStory,
  autoRunFullWorkflow = false,
  onAutoRunComplete,
  developerMode = false,
  useMagicApiRepair = false,
  setUseMagicApiRepair,
}: RepairWorkflowPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [expandedSteps, setExpandedSteps] = useState<Set<RepairWorkflowStep>>(new Set(['collect-feedback']));
  const [gridLightbox, setGridLightbox] = useState<string | null>(null);

  const {
    workflowState,
    isRunning,
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
    regenerateCovers,
    coverRepairProgress,
    runFullWorkflow,
    abortWorkflow,
    isAborted,
    getStepNumber,
    getCharactersWithIssues,
    getPagesWithSevereIssuesForCharacter,
  } = useRepairWorkflow({
    storyId,
    sceneImages,
    characters,
    finalChecksReport,
    imageModel,
    onImageUpdate,
  });

  // Full workflow progress state
  const [fullWorkflowProgress, setFullWorkflowProgress] = useState<{ step: string; detail: string } | null>(null);
  const [isRunningFullWorkflow, setIsRunningFullWorkflow] = useState(false);

  // Track if we've already auto-run for this story (ref for current session)
  const autoRunTriggeredRef = useRef<string | null>(null);

  // Check if auto-run has already completed for this story (persisted in localStorage)
  const hasCompletedAutoRun = (checkStoryId: string): boolean => {
    try {
      const completedStories = JSON.parse(localStorage.getItem(AUTORUN_COMPLETED_KEY) || '[]');
      return completedStories.includes(checkStoryId);
    } catch {
      return false;
    }
  };

  // Mark auto-run as completed for this story (persist to localStorage)
  const markAutoRunCompleted = (completedStoryId: string) => {
    try {
      const completedStories = JSON.parse(localStorage.getItem(AUTORUN_COMPLETED_KEY) || '[]');
      if (!completedStories.includes(completedStoryId)) {
        completedStories.push(completedStoryId);
        // Keep only last 10 to prevent unbounded growth
        const trimmed = completedStories.slice(-10);
        localStorage.setItem(AUTORUN_COMPLETED_KEY, JSON.stringify(trimmed));
      }
    } catch (e) {
      console.error('[RepairWorkflowPanel] Failed to save auto-run completion:', e);
    }
  };

  // Auto-run full workflow when triggered by parent (e.g., after story generation)
  useEffect(() => {
    if (autoRunFullWorkflow && storyId && sceneImages.length > 0 && !isRunning && !isRunningFullWorkflow) {
      // Check both ref (current session) and localStorage (persisted)
      const alreadyRunThisSession = autoRunTriggeredRef.current === storyId;
      const alreadyCompletedPreviously = hasCompletedAutoRun(storyId);

      if (!alreadyRunThisSession && !alreadyCompletedPreviously) {
        autoRunTriggeredRef.current = storyId;
        console.log('[RepairWorkflowPanel] Auto-triggering full repair workflow for story:', storyId);
        // Delay slightly to ensure component is fully mounted
        setTimeout(async () => {
          await handleRunFullWorkflow();
          // After completion, mark as completed and notify parent
          markAutoRunCompleted(storyId);
          onAutoRunComplete?.();
        }, 500);
      } else {
        console.log('[RepairWorkflowPanel] Skipping auto-run - already completed for story:', storyId, { alreadyRunThisSession, alreadyCompletedPreviously });
      }
    }
  }, [autoRunFullWorkflow, storyId, sceneImages.length, isRunning, isRunningFullWorkflow]);

  const handleRunFullWorkflow = async () => {
    setIsRunningFullWorkflow(true);
    try {
      await runFullWorkflow({
        scoreThreshold: 6,
        issueThreshold: 3,
        maxRetries: 4,
        onProgress: (step, detail) => {
          setFullWorkflowProgress({ step, detail });
        },
      });
      if (onRefreshStory) {
        await onRefreshStory();
      }
    } catch (error) {
      console.error('Full workflow failed:', error);
    } finally {
      setIsRunningFullWorkflow(false);
      setFullWorkflowProgress(null);
    }
  };

  // Selected character for repair
  const [selectedCharacter, setSelectedCharacter] = useState<string>('');
  const [selectedCharacterPages, setSelectedCharacterPages] = useState<number[]>([]);

  // Selected pages for artifact repair
  const [selectedArtifactPages, setSelectedArtifactPages] = useState<number[]>([]);

  // Redo mode option for step 3
  const [redoMode, setRedoMode] = useState<'fresh' | 'reference' | 'blackout'>('fresh');

  // Selected covers for step 8
  const [selectedCovers, setSelectedCovers] = useState<('front' | 'back' | 'initial')[]>([]);

  // Toggle step expansion
  const toggleStepExpanded = (step: RepairWorkflowStep) => {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(step)) {
        next.delete(step);
      } else {
        next.add(step);
      }
      return next;
    });
  };

  // Get characters with issues from consistency results
  const charactersWithIssues = useMemo(() => {
    return getCharactersWithIssues();
  }, [getCharactersWithIssues]);

  // Get pages with artifact issues (from both collected feedback AND re-evaluation results)
  const pagesWithArtifacts = useMemo(() => {
    const artifactPages = new Set<number>();

    // Check collected feedback (from retryHistory)
    for (const [page, fb] of Object.entries(workflowState.collectedFeedback.pages)) {
      if (fb.fixableIssues.some(i => i.type === 'artifact' || i.type === 'distortion')) {
        artifactPages.add(parseInt(page));
      }
    }

    // Also check re-evaluation results (from Step 4)
    for (const [page, result] of Object.entries(workflowState.reEvaluationResults.pages)) {
      if (result.fixableIssues?.some(i => i.type === 'artifact' || i.type === 'distortion')) {
        artifactPages.add(parseInt(page));
      }
    }

    return Array.from(artifactPages).sort((a, b) => a - b);
  }, [workflowState.collectedFeedback.pages, workflowState.reEvaluationResults.pages]);

  // Render step header
  const renderStepHeader = (step: RepairWorkflowStep) => {
    const config = STEP_CONFIG[step];
    const Icon = config.icon;
    const status = workflowState.stepStatus[step];
    const isExpandedStep = expandedSteps.has(step);
    const stepNum = getStepNumber(step);

    return (
      <button
        onClick={() => toggleStepExpanded(step)}
        className={`w-full flex items-center justify-between p-3 rounded-lg transition-colors ${
          status === 'in-progress' ? 'bg-blue-50' :
          status === 'completed' ? 'bg-green-50' :
          status === 'failed' ? 'bg-red-50' :
          'bg-gray-50 hover:bg-gray-100'
        }`}
      >
        <div className="flex items-center gap-3">
          <span className="w-6 h-6 flex items-center justify-center rounded-full bg-amber-100 text-amber-700 text-sm font-bold">
            {stepNum}
          </span>
          <Icon className={`w-4 h-4 ${status === 'in-progress' ? 'animate-spin text-blue-600' : 'text-gray-600'}`} />
          <span className="font-medium text-sm">{config.label}</span>
        </div>
        <div className="flex items-center gap-2">
          <StepStatusBadge status={status} />
          {isExpandedStep ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </div>
      </button>
    );
  };

  if (!storyId) return null;

  return (
    <>
    <div className="mb-6 border-2 border-amber-300 rounded-lg bg-amber-50/50 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-4 bg-amber-100 hover:bg-amber-200 transition-colors"
      >
        <div className="flex items-center gap-3">
          <Wrench className="w-5 h-5 text-amber-700" />
          <span className="font-bold text-amber-800">Manual Repair Workflow</span>
          {workflowState.collectedFeedback.totalIssues > 0 && (
            <span className="px-2 py-0.5 bg-amber-200 text-amber-800 text-xs rounded-full">
              {workflowState.collectedFeedback.totalIssues} issues
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isRunning && (
            <span className="flex items-center gap-1 text-xs text-blue-600">
              <Loader2 className="w-3 h-3 animate-spin" />
              Running...
            </span>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              resetWorkflow();
            }}
            className="p-1 hover:bg-amber-300 rounded"
            title="Reset workflow"
          >
            <RotateCcw className="w-4 h-4 text-amber-700" />
          </button>
          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </div>
      </button>

      {isExpanded && (
        <div className="p-4 space-y-3">
          {/* Full Automated Workflow Button */}
          <div className="p-4 bg-gradient-to-r from-purple-50 to-amber-50 border border-purple-200 rounded-lg">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="font-bold text-purple-800">Automated Full Repair</h4>
                <p className="text-sm text-purple-600">
                  Runs all steps automatically. Pages retry up to 4 times, keeping the best result.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {isRunningFullWorkflow && (
                  <button
                    onClick={() => {
                      abortWorkflow();
                      setIsRunningFullWorkflow(false);
                      setFullWorkflowProgress(null);
                    }}
                    className="flex items-center gap-2 px-4 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 font-medium"
                    title="Stop the workflow"
                  >
                    <Square className="w-5 h-5" />
                    Stop
                  </button>
                )}
                <button
                  onClick={handleRunFullWorkflow}
                  disabled={isRunning || isRunningFullWorkflow}
                  className="flex items-center gap-2 px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 font-medium"
                >
                  {isRunningFullWorkflow ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Running...
                    </>
                  ) : (
                    <>
                      <Zap className="w-5 h-5" />
                      Run Full Workflow
                    </>
                  )}
                </button>
              </div>
            </div>
            {fullWorkflowProgress && (
              <div className="mt-3 p-2 bg-white/50 rounded border border-purple-100">
                <div className="flex items-center gap-2 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin text-purple-600" />
                  <span className="font-medium text-purple-700">{fullWorkflowProgress.step}:</span>
                  <span className="text-purple-600">{fullWorkflowProgress.detail}</span>
                </div>
              </div>
            )}
            {isAborted && !isRunningFullWorkflow && (
              <div className="mt-3 p-2 bg-red-50 rounded border border-red-200">
                <div className="flex items-center gap-2 text-sm text-red-700">
                  <Square className="w-4 h-4" />
                  <span className="font-medium">Workflow stopped</span>
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-gray-200 pt-3">
            <h4 className="text-sm font-medium text-gray-500 mb-3">Or run steps manually:</h4>
          </div>

          {/* Step 1: Collect Feedback */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            {renderStepHeader('collect-feedback')}
            {expandedSteps.has('collect-feedback') && (
              <div className="p-4 space-y-3 bg-white">
                <p className="text-sm text-gray-600">{STEP_CONFIG['collect-feedback'].description}</p>

                <button
                  onClick={collectFeedback}
                  disabled={isRunning}
                  className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
                >
                  <Search className="w-4 h-4" />
                  Collect Feedback
                </button>

                {Object.keys(workflowState.collectedFeedback.pages).length > 0 && (() => {
                  // Calculate summary statistics from collected feedback
                  const pages = Object.values(workflowState.collectedFeedback.pages);
                  const qualityIssues = pages.reduce((sum, p) => sum + p.fixableIssues.length, 0);
                  const characterIssues = pages.reduce((sum, p) => sum + p.entityIssues.length, 0);
                  const objectIssues = pages.reduce((sum, p) => sum + (p.objectIssues?.length || 0), 0);
                  const semanticIssues = pages.reduce((sum, p) => sum + (p.semanticIssues?.length || 0), 0);
                  const collectedTotal = qualityIssues + characterIssues + objectIssues + semanticIssues;

                  // Also count issues from re-evaluation if available
                  const reEvalPages = Object.values(workflowState.reEvaluationResults.pages);
                  const reEvalIssues = reEvalPages.reduce((sum, p) => sum + (p.fixableIssues?.length || 0), 0);
                  const hasReEvalData = reEvalPages.length > 0;

                  return (
                    <div className="space-y-3">
                      {/* Summary Statistics */}
                      <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg">
                        <h5 className="text-sm font-medium text-gray-800 mb-2">
                          Feedback Summary: {collectedTotal} issues from generation + {hasReEvalData ? `${reEvalIssues} from re-evaluation` : 're-evaluate for fresh data'}
                        </h5>
                        <div className="flex flex-wrap gap-3 text-xs">
                          {qualityIssues > 0 && (
                            <span className="px-2 py-1 bg-orange-100 text-orange-700 rounded">
                              Quality: {qualityIssues}
                            </span>
                          )}
                          {characterIssues > 0 && (
                            <span className="px-2 py-1 bg-purple-100 text-purple-700 rounded">
                              Character Consistency: {characterIssues}
                            </span>
                          )}
                          {objectIssues > 0 && (
                            <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded">
                              Object Consistency: {objectIssues}
                            </span>
                          )}
                          {semanticIssues > 0 && (
                            <span className="px-2 py-1 bg-indigo-100 text-indigo-700 rounded">
                              Semantic: {semanticIssues}
                            </span>
                          )}
                          {hasReEvalData && reEvalIssues > 0 && (
                            <span className="px-2 py-1 bg-cyan-100 text-cyan-700 rounded">
                              Re-eval Issues: {reEvalIssues}
                            </span>
                          )}
                          {collectedTotal === 0 && !hasReEvalData && (
                            <span className="px-2 py-1 bg-green-100 text-green-700 rounded">
                              No issues detected (run re-evaluate for fresh assessment)
                            </span>
                          )}
                          {collectedTotal === 0 && hasReEvalData && reEvalIssues === 0 && (
                            <span className="px-2 py-1 bg-green-100 text-green-700 rounded">
                              All pages pass quality checks
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Page Cards */}
                      <div className="space-y-2 max-h-96 overflow-y-auto">
                        {pages
                          .sort((a, b) => a.pageNumber - b.pageNumber)
                          .map(feedback => (
                            <PageFeedbackCard
                              key={feedback.pageNumber}
                              feedback={feedback}
                              isMarkedForRedo={workflowState.redoPages.pageNumbers.includes(feedback.pageNumber)}
                              onToggleRedo={() => toggleRedoPage(feedback.pageNumber)}
                              onUpdateNotes={(notes) => updatePageFeedback(feedback.pageNumber, { manualNotes: notes })}
                            />
                          ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          {/* Step 2: Identify Redo Pages */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            {renderStepHeader('identify-redo-pages')}
            {expandedSteps.has('identify-redo-pages') && (
              <div className="p-4 space-y-3 bg-white">
                <p className="text-sm text-gray-600">{STEP_CONFIG['identify-redo-pages'].description}</p>

                <div className="flex gap-2">
                  <button
                    onClick={() => autoIdentifyRedoPages(6, 3)}
                    disabled={isRunning || workflowState.stepStatus['collect-feedback'] !== 'completed'}
                    className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
                  >
                    <Zap className="w-4 h-4" />
                    Auto-Identify (score &lt; 6 or 3+ issues)
                  </button>
                </div>

                {workflowState.redoPages.pageNumbers.length > 0 && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                    <h5 className="text-sm font-medium text-red-800 mb-2">
                      Pages marked for redo: {workflowState.redoPages.pageNumbers.length}
                    </h5>
                    <div className="flex flex-wrap gap-2">
                      {workflowState.redoPages.pageNumbers.map(page => (
                        <span
                          key={page}
                          className="inline-flex items-center gap-1 px-2 py-1 bg-red-100 text-red-700 text-xs rounded"
                          title={workflowState.redoPages.reasons[page]}
                        >
                          Page {page}
                          <button
                            onClick={() => toggleRedoPage(page)}
                            className="hover:text-red-900"
                          >
                            <XCircle className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Step 3: Redo Pages */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            {renderStepHeader('redo-pages')}
            {expandedSteps.has('redo-pages') && (
              <div className="p-4 space-y-3 bg-white">
                <p className="text-sm text-gray-600">{STEP_CONFIG['redo-pages'].description}</p>

                <div className="space-y-1.5">
                  <label className={`flex items-start gap-2 p-2 rounded-lg cursor-pointer transition-colors ${redoMode === 'fresh' ? 'bg-amber-50 border border-amber-300' : 'bg-gray-50 border border-gray-200 hover:bg-gray-100'}`}>
                    <input type="radio" name="redoMode" checked={redoMode === 'fresh'} onChange={() => setRedoMode('fresh')} disabled={isRunning} className="mt-0.5" />
                    <div>
                      <span className="text-sm font-medium">Fresh generation</span>
                      <p className="text-xs text-gray-500">New generation from AI-corrected scene description</p>
                    </div>
                  </label>
                  <label className={`flex items-start gap-2 p-2 rounded-lg cursor-pointer transition-colors ${redoMode === 'reference' ? 'bg-blue-50 border border-blue-300' : 'bg-gray-50 border border-gray-200 hover:bg-gray-100'}`}>
                    <input type="radio" name="redoMode" checked={redoMode === 'reference'} onChange={() => setRedoMode('reference')} disabled={isRunning} className="mt-0.5" />
                    <div>
                      <span className="text-sm font-medium">Use original as reference</span>
                      <p className="text-xs text-gray-500">Passes current image to Gemini — preserves composition, fixes details</p>
                    </div>
                  </label>
                  <label className={`flex items-start gap-2 p-2 rounded-lg cursor-pointer transition-colors ${redoMode === 'blackout' ? 'bg-purple-50 border border-purple-300' : 'bg-gray-50 border border-gray-200 hover:bg-gray-100'}`}>
                    <input type="radio" name="redoMode" checked={redoMode === 'blackout'} onChange={() => setRedoMode('blackout')} disabled={isRunning} className="mt-0.5" />
                    <div>
                      <span className="text-sm font-medium">Blackout issues</span>
                      <p className="text-xs text-gray-500">Blacks out broken areas in the image, forces AI to regenerate those regions</p>
                    </div>
                  </label>
                </div>

                <button
                  onClick={() => redoMarkedPages({
                    useOriginalAsReference: redoMode === 'reference',
                    blackoutIssues: redoMode === 'blackout',
                  })}
                  disabled={isRunning || workflowState.redoPages.pageNumbers.length === 0}
                  className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
                >
                  <Play className="w-4 h-4" />
                  Redo {workflowState.redoPages.pageNumbers.length} Pages
                  {redoMode !== 'fresh' && <span className="text-xs opacity-75">({redoMode === 'reference' ? 'with reference' : 'blackout issues'})</span>}
                </button>

                {redoProgress.total > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span>Progress: {redoProgress.current} / {redoProgress.total}</span>
                      {redoProgress.currentPage && (
                        <span className="text-gray-500">Currently: Page {redoProgress.currentPage}</span>
                      )}
                    </div>
                    <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-amber-500 transition-all"
                        style={{ width: `${(redoProgress.current / redoProgress.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}

                {workflowState.redoResults.pagesCompleted.length > 0 && (
                  <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                    <h5 className="text-sm font-medium text-green-800 mb-2">
                      Completed: {workflowState.redoResults.pagesCompleted.length} pages
                    </h5>
                    <div className="flex flex-wrap gap-3">
                      {workflowState.redoResults.pagesCompleted.map(page => {
                        const detail = workflowState.redoResults.pageDetails?.[page];
                        return (
                          <div key={page} className="p-2 bg-green-50 border border-green-200 rounded-lg">
                            <div className="text-xs font-medium text-green-800 mb-1">
                              Page {page} (v{workflowState.redoResults.newVersions[page] ?? '?'})
                            </div>
                            {detail && (detail.previousImage || detail.newImage) ? (
                              <div className="flex gap-2 items-end">
                                {detail.previousImage && (
                                  <div className="text-center">
                                    <img src={detail.previousImage.startsWith('data:') ? detail.previousImage : `data:image/jpeg;base64,${detail.previousImage}`}
                                         className="w-16 h-16 object-cover rounded cursor-pointer hover:ring-2 hover:ring-gray-400"
                                         onClick={() => setGridLightbox(detail.previousImage!.startsWith('data:') ? detail.previousImage! : `data:image/jpeg;base64,${detail.previousImage}`)} />
                                    <span className="text-[10px] text-gray-500">Before{detail.previousScore != null ? ` (${detail.previousScore})` : ''}</span>
                                  </div>
                                )}
                                {detail.blackoutImage && (
                                  <div className="text-center">
                                    <img src={detail.blackoutImage.startsWith('data:') ? detail.blackoutImage : `data:image/jpeg;base64,${detail.blackoutImage}`}
                                         className="w-16 h-16 object-cover rounded cursor-pointer border-2 border-purple-300 hover:ring-2 hover:ring-purple-400"
                                         onClick={() => setGridLightbox(detail.blackoutImage!.startsWith('data:') ? detail.blackoutImage! : `data:image/jpeg;base64,${detail.blackoutImage}`)} />
                                    <span className="text-[10px] text-purple-500">Blackout</span>
                                  </div>
                                )}
                                <span className="text-gray-400 self-center">&rarr;</span>
                                {detail.newImage && (
                                  <div className="text-center">
                                    <img src={detail.newImage.startsWith('data:') ? detail.newImage : `data:image/jpeg;base64,${detail.newImage}`}
                                         className="w-16 h-16 object-cover rounded cursor-pointer hover:ring-2 hover:ring-green-400"
                                         onClick={() => setGridLightbox(detail.newImage!.startsWith('data:') ? detail.newImage! : `data:image/jpeg;base64,${detail.newImage}`)} />
                                    <span className="text-[10px] text-green-600">After{detail.newScore != null ? ` (${detail.newScore})` : ''}</span>
                                  </div>
                                )}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Step 4: Re-evaluate */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            {renderStepHeader('re-evaluate')}
            {expandedSteps.has('re-evaluate') && (
              <div className="p-4 space-y-3 bg-white">
                <p className="text-sm text-gray-600">{STEP_CONFIG['re-evaluate'].description}</p>

                <div className="flex gap-2">
                  {workflowState.redoResults.pagesCompleted.length > 0 ? (
                    <button
                      onClick={() => reEvaluatePages()}
                      disabled={isRunning}
                      className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
                    >
                      <CheckCircle className="w-4 h-4" />
                      Re-evaluate {workflowState.redoResults.pagesCompleted.length} Redone Pages
                    </button>
                  ) : null}
                  <button
                    onClick={() => reEvaluatePages(sceneImages.map(s => s.pageNumber))}
                    disabled={isRunning}
                    className="flex items-center gap-2 px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50"
                  >
                    <CheckCircle className="w-4 h-4" />
                    Re-evaluate All {sceneImages.length} Pages
                  </button>
                </div>

                {Object.keys(workflowState.reEvaluationResults.pages).length > 0 && (
                  <div className="space-y-2">
                    <h5 className="text-sm font-medium">Evaluation Results:</h5>
                    <div className="space-y-2">
                      {Object.entries(workflowState.reEvaluationResults.pages).map(([page, result]) => {
                        const finalScore = result.score ?? result.qualityScore;
                        const qualityScore = result.qualityScore;
                        const semanticScore = result.semanticScore;
                        // Warn if using fallback (indicates potential bug in evaluation)
                        if (result.score === null && result.qualityScore !== null) {
                          console.warn(`[RepairWorkflow] Page ${page}: Missing combined score, using qualityScore fallback`);
                        }
                        return (
                          <div key={page} className="p-2 bg-gray-50 rounded border text-sm space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium">Page {page}:</span>
                              <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                                Quality: {qualityScore}%
                              </span>
                              {semanticScore !== null && semanticScore !== undefined && (
                                <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
                                  Semantic: {semanticScore}%
                                </span>
                              )}
                              <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                                finalScore >= 70 ? 'bg-green-100 text-green-700' :
                                finalScore >= 50 ? 'bg-yellow-100 text-yellow-700' :
                                'bg-red-100 text-red-700'
                              }`}>
                                Final: {finalScore}%
                              </span>
                              {result.verdict && (
                                <span className={`text-xs px-1.5 py-0.5 rounded ${
                                  result.verdict === 'PASS' ? 'bg-green-100 text-green-700' :
                                  result.verdict === 'SOFT_FAIL' ? 'bg-yellow-100 text-yellow-700' :
                                  'bg-red-100 text-red-700'
                                }`}>
                                  {result.verdict}
                                </span>
                              )}
                              {result.fixableIssues && result.fixableIssues.length > 0 && (
                                <span className="text-gray-500 text-xs">
                                  ({result.fixableIssues.length} fixable issues)
                                </span>
                              )}
                            </div>
                            {result.issuesSummary && result.issuesSummary !== 'none' && (
                              <p className={`text-xs pl-2 border-l-2 ${
                                result.issuesSummary.includes('SEMANTIC:')
                                  ? 'text-purple-700 border-purple-400 bg-purple-50 p-1 rounded-r'
                                  : 'text-gray-600 border-gray-300'
                              }`}>
                                {result.issuesSummary}
                              </p>
                            )}
                            {result.semanticResult && (
                              <div className="text-xs text-purple-700 pl-2 border-l-2 border-purple-400 bg-purple-50 p-1 rounded-r mt-1">
                                <span className="font-medium">🔍 Semantic Analysis (Score: {result.semanticResult.score ?? 'N/A'}):</span>

                                {/* Show visible vs expected */}
                                {result.semanticResult.visible && (
                                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                                    <div className="bg-white p-2 rounded border border-purple-200">
                                      <div className="font-medium text-purple-800 mb-1">👁️ Visible:</div>
                                      {result.semanticResult.visible.characters && result.semanticResult.visible.characters.length > 0 && (
                                        <div><span className="text-gray-500">Characters:</span> {result.semanticResult.visible.characters.join(', ')}</div>
                                      )}
                                      {result.semanticResult.visible.objects && result.semanticResult.visible.objects.length > 0 && (
                                        <div><span className="text-gray-500">Objects:</span> {result.semanticResult.visible.objects.join(', ')}</div>
                                      )}
                                      {result.semanticResult.visible.setting && (
                                        <div><span className="text-gray-500">Setting:</span> {result.semanticResult.visible.setting}</div>
                                      )}
                                      {result.semanticResult.visible.action && (
                                        <div><span className="text-gray-500">Action:</span> {result.semanticResult.visible.action}</div>
                                      )}
                                    </div>
                                    <div className="bg-white p-2 rounded border border-purple-200">
                                      <div className="font-medium text-purple-800 mb-1">🎯 Expected:</div>
                                      {result.semanticResult.expected?.characters && result.semanticResult.expected.characters.length > 0 && (
                                        <div><span className="text-gray-500">Characters:</span> {result.semanticResult.expected.characters.join(', ')}</div>
                                      )}
                                      {result.semanticResult.expected?.objects && result.semanticResult.expected.objects.length > 0 && (
                                        <div><span className="text-gray-500">Objects:</span> {result.semanticResult.expected.objects.join(', ')}</div>
                                      )}
                                      {result.semanticResult.expected?.setting && (
                                        <div><span className="text-gray-500">Setting:</span> {result.semanticResult.expected.setting}</div>
                                      )}
                                      {result.semanticResult.expected?.action && (
                                        <div><span className="text-gray-500">Action:</span> {result.semanticResult.expected.action}</div>
                                      )}
                                    </div>
                                  </div>
                                )}

                                {/* Show issues */}
                                {result.semanticResult.semanticIssues && result.semanticResult.semanticIssues.length > 0 && (
                                  <ul className="list-disc list-inside mt-2">
                                    {result.semanticResult.semanticIssues.map((issue, idx) => (
                                      <li key={idx}>
                                        <span className={`font-medium ${
                                          issue.severity === 'CRITICAL' ? 'text-red-600' :
                                          issue.severity === 'MAJOR' ? 'text-orange-600' : 'text-yellow-600'
                                        }`}>[{issue.severity}]</span> {issue.problem}
                                      </li>
                                    ))}
                                  </ul>
                                )}

                                {result.semanticResult.semanticIssues?.length === 0 && !result.semanticResult.visible && (
                                  <span className="text-green-600 ml-2">✓ No issues</span>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Step 5: Consistency Check */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            {renderStepHeader('consistency-check')}
            {expandedSteps.has('consistency-check') && (
              <div className="p-4 space-y-3 bg-white">
                <p className="text-sm text-gray-600">{STEP_CONFIG['consistency-check'].description}</p>

                <button
                  onClick={() => runConsistencyCheck()}
                  disabled={isRunning}
                  className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
                >
                  <Users className="w-4 h-4" />
                  Run Consistency Check
                </button>

                {workflowState.consistencyResults.report && (
                  <div className="space-y-3">
                    <div className={`p-3 rounded-lg border ${
                      workflowState.consistencyResults.report.overallConsistent
                        ? 'bg-green-50 border-green-200'
                        : 'bg-amber-50 border-amber-200'
                    }`}>
                      <h5 className="text-sm font-medium mb-1">
                        {workflowState.consistencyResults.report.overallConsistent
                          ? 'All characters consistent!'
                          : `${workflowState.consistencyResults.report.totalIssues} consistency issues found`}
                      </h5>
                      <p className="text-xs text-gray-600">{workflowState.consistencyResults.report.summary}</p>
                    </div>

                    {/* Detailed per-character breakdown */}
                    {Object.entries(workflowState.consistencyResults.report.characters || {}).map(([charName, charResult]) => (
                      <details key={charName} className="border rounded-lg overflow-hidden">
                        <summary className={`px-3 py-2 cursor-pointer text-sm font-medium flex items-center justify-between ${
                          charResult.overallConsistent ? 'bg-green-50' : 'bg-amber-50'
                        }`}>
                          <span>{charName}</span>
                          <span className={`text-xs px-2 py-0.5 rounded ${
                            charResult.overallConsistent
                              ? 'bg-green-200 text-green-800'
                              : 'bg-amber-200 text-amber-800'
                          }`}>
                            Score: {charResult.overallScore ?? charResult.score ?? '?'}/10
                            {(charResult.totalIssues ?? charResult.issues?.length ?? 0) > 0 &&
                              ` • ${charResult.totalIssues ?? charResult.issues?.length} issues`}
                          </span>
                        </summary>
                        <div className="p-3 bg-white space-y-2 text-sm">
                          {/* Per-clothing breakdown (new structure) */}
                          {charResult.byClothing && Object.entries(charResult.byClothing).map(([clothing, clothingResult]) => (
                            <div key={clothing} className="border-l-2 border-gray-200 pl-3">
                              <div className="flex items-center justify-between">
                                <span className="font-medium text-gray-700">{clothing}</span>
                                <span className={`text-xs ${clothingResult.score >= 7 ? 'text-green-600' : 'text-amber-600'}`}>
                                  {clothingResult.score}/10
                                </span>
                              </div>
                              {clothingResult.gridImage && (
                                <div className="mt-2 mb-2">
                                  <img
                                    src={clothingResult.gridImage}
                                    alt={`${charName} - ${clothing} consistency grid`}
                                    className="w-full max-h-48 object-contain rounded border border-gray-200 bg-gray-50 cursor-pointer hover:opacity-80 transition-opacity"
                                    onClick={() => setGridLightbox(clothingResult.gridImage!)}
                                    title="Click to enlarge"
                                  />
                                </div>
                              )}
                              {clothingResult.issues && clothingResult.issues.length > 0 && (
                                <ul className="mt-1 space-y-1">
                                  {clothingResult.issues.map((issue, i) => (
                                    <li key={i} className="text-xs text-gray-600 flex items-start gap-1">
                                      <span className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${
                                        issue.severity === 'critical' ? 'bg-red-400' :
                                        issue.severity === 'major' ? 'bg-amber-400' : 'bg-gray-400'
                                      }`} />
                                      <span>
                                        {issue.description}
                                        {issue.pagesToFix && issue.pagesToFix.length > 0 && (
                                          <span className="text-gray-400 ml-1">(pages {issue.pagesToFix.join(', ')})</span>
                                        )}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          ))}
                          {/* Legacy flat issues (backward compat) */}
                          {!charResult.byClothing && (
                            <>
                              {charResult.gridImage && (
                                <div className="mb-2">
                                  <img
                                    src={charResult.gridImage}
                                    alt={`${charName} consistency grid`}
                                    className="w-full max-h-48 object-contain rounded border border-gray-200 bg-gray-50 cursor-pointer hover:opacity-80 transition-opacity"
                                    onClick={() => setGridLightbox(charResult.gridImage!)}
                                    title="Click to enlarge"
                                  />
                                </div>
                              )}
                              {charResult.issues && charResult.issues.length > 0 && (
                                <ul className="space-y-1">
                                  {charResult.issues.map((issue, i) => (
                                    <li key={i} className="text-xs text-gray-600 flex items-start gap-1">
                                      <span className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${
                                        issue.severity === 'critical' ? 'bg-red-400' :
                                        issue.severity === 'major' ? 'bg-amber-400' : 'bg-gray-400'
                                      }`} />
                                      <span>{issue.description}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </>
                          )}
                          {/* No issues */}
                          {(!charResult.byClothing || Object.values(charResult.byClothing).every(c => !c.issues?.length)) &&
                           (!charResult.issues || charResult.issues.length === 0) && (
                            <p className="text-xs text-green-600">No issues found</p>
                          )}
                        </div>
                      </details>
                    ))}

                    {charactersWithIssues.length > 0 && (
                      <div className="text-sm pt-2 border-t">
                        <span className="font-medium">Characters needing repair:</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {charactersWithIssues.map(name => (
                            <span key={name} className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs">
                              {name}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Step 6: Character Repair */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            {renderStepHeader('character-repair')}
            {expandedSteps.has('character-repair') && (
              <div className="p-4 space-y-3 bg-white">
                <p className="text-sm text-gray-600">{STEP_CONFIG['character-repair'].description}</p>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Select Character:</label>
                  <select
                    value={selectedCharacter}
                    onChange={(e) => {
                      setSelectedCharacter(e.target.value);
                      setSelectedCharacterPages([]);
                    }}
                    className="w-full p-2 border rounded text-sm"
                    disabled={isRunning}
                  >
                    <option value="">Choose a character...</option>
                    {charactersWithIssues.map(name => (
                      <option key={name} value={name}>{name} (has issues)</option>
                    ))}
                    {characters.filter(c => !charactersWithIssues.includes(c.name)).map(c => (
                      <option key={c.name} value={c.name}>{c.name}</option>
                    ))}
                  </select>
                </div>

                {selectedCharacter && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium">Select Pages to Repair:</label>
                      <button
                        onClick={() => {
                          const severePages = getPagesWithSevereIssuesForCharacter(selectedCharacter);
                          setSelectedCharacterPages(severePages);
                        }}
                        disabled={isRunning || workflowState.stepStatus['consistency-check'] !== 'completed'}
                        className="flex items-center gap-1 px-2 py-1 text-xs bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50"
                        title="Auto-select pages with major/critical issues"
                      >
                        <Zap className="w-3 h-3" />
                        Auto-Identify Severe
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {sceneImages.map(scene => (
                        <button
                          key={scene.pageNumber}
                          onClick={() => {
                            setSelectedCharacterPages(prev =>
                              prev.includes(scene.pageNumber)
                                ? prev.filter(p => p !== scene.pageNumber)
                                : [...prev, scene.pageNumber]
                            );
                          }}
                          className={`px-2 py-1 text-xs rounded border transition-colors ${
                            selectedCharacterPages.includes(scene.pageNumber)
                              ? 'bg-purple-100 border-purple-300 text-purple-700'
                              : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
                          }`}
                          disabled={isRunning}
                        >
                          Page {scene.pageNumber}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Repair method selector - only in developer mode */}
                {developerMode && setUseMagicApiRepair && (
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    <label className="text-sm font-medium text-blue-800 mb-2 block">Repair Method:</label>
                    <div className="flex items-center gap-4">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="repairMethod"
                          checked={!useMagicApiRepair}
                          onChange={() => setUseMagicApiRepair(false)}
                          className="text-blue-600"
                          disabled={isRunning}
                        />
                        <span className="text-sm">Gemini (default)</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="repairMethod"
                          checked={useMagicApiRepair}
                          onChange={() => setUseMagicApiRepair(true)}
                          className="text-blue-600"
                          disabled={isRunning}
                        />
                        <span className="text-sm">MagicAPI Face+Hair</span>
                        <span className="text-xs text-blue-600">(~$0.006/repair)</span>
                      </label>
                    </div>
                    {useMagicApiRepair && (
                      <p className="text-xs text-blue-600 mt-2">
                        Uses face swap + hair fix pipeline with iterative crop checking
                      </p>
                    )}
                  </div>
                )}

                <button
                  onClick={async () => {
                    await repairCharacter(selectedCharacter, selectedCharacterPages, { useMagicApiRepair });
                    if (onRefreshStory) {
                      await onRefreshStory();
                    }
                  }}
                  disabled={isRunning || !selectedCharacter || selectedCharacterPages.length === 0}
                  className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
                >
                  <Wrench className="w-4 h-4" />
                  Repair {selectedCharacter || 'Character'} on {selectedCharacterPages.length} pages
                  {useMagicApiRepair && <span className="text-xs opacity-75">(MagicAPI)</span>}
                </button>

                {/* Repaired pages with debug images */}
                {Object.keys(workflowState.characterRepairResults.pagesRepaired).length > 0 && (
                  <div className="space-y-3">
                    <h5 className="text-sm font-medium text-green-800">Repair Results:</h5>
                    {Object.entries(workflowState.characterRepairResults.pagesRepaired).map(([char, pages]) => (
                      <div key={char} className="space-y-2">
                        <span className="text-sm font-medium">{char}</span>
                        {(pages as RepairPageResult[]).map((page) => (
                          <div key={page.pageNumber} className="p-3 bg-green-50 border border-green-200 rounded-lg">
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-sm font-medium text-green-800">Page {page.pageNumber}</span>
                              {page.method && (
                                <span className={`px-1.5 py-0.5 text-xs rounded font-medium ${
                                  page.method === 'magicapi' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
                                }`}>
                                  {page.method === 'magicapi' ? 'MagicAPI' : 'Gemini'}
                                </span>
                              )}
                              {page.verification && (
                                <span className={`px-1.5 py-0.5 text-xs rounded ${
                                  page.verification.confidence === 'high' ? 'bg-green-100 text-green-700' :
                                  page.verification.confidence === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                                  'bg-gray-100 text-gray-600'
                                }`}>
                                  {page.verification.confidence} confidence
                                </span>
                              )}
                            </div>
                            {page.comparison && (
                              <div className="grid grid-cols-3 gap-2 mb-2">
                                <div className="text-center">
                                  <img
                                    src={page.comparison.reference}
                                    alt="Reference avatar"
                                    className="w-full h-24 object-contain rounded border border-gray-200 bg-gray-50 cursor-pointer hover:opacity-80 transition-opacity"
                                    onClick={() => setGridLightbox(page.comparison!.reference)}
                                  />
                                  <span className="text-xs text-gray-500 mt-1 block">Reference</span>
                                </div>
                                <div className="text-center">
                                  {page.comparison.before ? (
                                    <img
                                      src={page.comparison.before}
                                      alt="Before repair"
                                      className="w-full h-24 object-contain rounded border border-gray-200 bg-gray-50 cursor-pointer hover:opacity-80 transition-opacity"
                                      onClick={() => setGridLightbox(page.comparison!.before!)}
                                    />
                                  ) : (
                                    <div className="w-full h-24 flex items-center justify-center rounded border border-gray-200 bg-gray-50 text-xs text-gray-400">N/A</div>
                                  )}
                                  <span className="text-xs text-gray-500 mt-1 block">Before</span>
                                </div>
                                <div className="text-center">
                                  <img
                                    src={page.comparison.after}
                                    alt="After repair"
                                    className="w-full h-24 object-contain rounded border border-gray-200 bg-gray-50 cursor-pointer hover:opacity-80 transition-opacity"
                                    onClick={() => setGridLightbox(page.comparison!.after)}
                                  />
                                  <span className="text-xs text-gray-500 mt-1 block">After</span>
                                </div>
                              </div>
                            )}
                            {page.verification?.explanation && (
                              <p className="text-xs text-gray-600 italic">{page.verification.explanation}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}

                {/* Failed pages with debug images */}
                {Object.keys(workflowState.characterRepairResults.pagesFailed).length > 0 && (
                  <div className="space-y-3">
                    <h5 className="text-sm font-medium text-red-800">Failed/Rejected:</h5>
                    {Object.entries(workflowState.characterRepairResults.pagesFailed).map(([char, pages]) =>
                      pages.length > 0 && (
                        <div key={char} className="space-y-2">
                          <span className="text-sm font-medium">{char}</span>
                          {pages.map((page) => (
                            <div key={page.pageNumber} className="p-3 bg-red-50 border border-red-200 rounded-lg">
                              <div className="flex items-center gap-2 mb-2">
                                <span className="text-sm font-medium text-red-800">Page {page.pageNumber}</span>
                                {page.rejected && (
                                  <span className="px-1.5 py-0.5 text-xs rounded bg-red-100 text-red-700 font-medium">Rejected</span>
                                )}
                              </div>
                              <p className="text-xs text-red-700 mb-2">{page.reason}</p>
                              {page.comparison && (
                                <div className="grid grid-cols-3 gap-2">
                                  <div className="text-center">
                                    <img
                                      src={page.comparison.reference}
                                      alt="Reference avatar"
                                      className="w-full h-24 object-contain rounded border border-red-200 bg-gray-50 cursor-pointer hover:opacity-80 transition-opacity"
                                      onClick={() => setGridLightbox(page.comparison!.reference)}
                                    />
                                    <span className="text-xs text-gray-500 mt-1 block">Reference</span>
                                  </div>
                                  <div className="text-center">
                                    {page.comparison.before ? (
                                      <img
                                        src={page.comparison.before}
                                        alt="Before repair"
                                        className="w-full h-24 object-contain rounded border border-red-200 bg-gray-50 cursor-pointer hover:opacity-80 transition-opacity"
                                        onClick={() => setGridLightbox(page.comparison!.before!)}
                                      />
                                    ) : (
                                      <div className="w-full h-24 flex items-center justify-center rounded border border-red-200 bg-gray-50 text-xs text-gray-400">N/A</div>
                                    )}
                                    <span className="text-xs text-gray-500 mt-1 block">Before</span>
                                  </div>
                                  <div className="text-center">
                                    <img
                                      src={page.comparison.after}
                                      alt="After (rejected)"
                                      className="w-full h-24 object-contain rounded border border-red-200 bg-gray-50 cursor-pointer hover:opacity-80 transition-opacity"
                                      onClick={() => setGridLightbox(page.comparison!.after)}
                                    />
                                    <span className="text-xs text-gray-500 mt-1 block">After (rejected)</span>
                                  </div>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Step 7: Artifact Repair */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            {renderStepHeader('artifact-repair')}
            {expandedSteps.has('artifact-repair') && (
              <div className="p-4 space-y-3 bg-white">
                <p className="text-sm text-gray-600">{STEP_CONFIG['artifact-repair'].description}</p>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">Select Pages for Grid Repair:</label>
                    <button
                      onClick={() => setSelectedArtifactPages(pagesWithArtifacts)}
                      disabled={isRunning || pagesWithArtifacts.length === 0}
                      className="flex items-center gap-1 px-2 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
                      title="Auto-select all pages with artifact issues"
                    >
                      <Zap className="w-3 h-3" />
                      Auto-Identify ({pagesWithArtifacts.length})
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {pagesWithArtifacts.length > 0 ? (
                      pagesWithArtifacts.map(page => (
                        <button
                          key={page}
                          onClick={() => {
                            setSelectedArtifactPages(prev =>
                              prev.includes(page)
                                ? prev.filter(p => p !== page)
                                : [...prev, page]
                            );
                          }}
                          className={`px-2 py-1 text-xs rounded border transition-colors ${
                            selectedArtifactPages.includes(page)
                              ? 'bg-amber-100 border-amber-300 text-amber-700'
                              : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
                          }`}
                          disabled={isRunning}
                        >
                          Page {page}
                        </button>
                      ))
                    ) : (
                      <span className="text-sm text-gray-500">No pages with artifact issues detected</span>
                    )}
                  </div>
                  {pagesWithArtifacts.length === 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      <span className="text-xs text-gray-500">Or select manually:</span>
                      {sceneImages.map(scene => (
                        <button
                          key={scene.pageNumber}
                          onClick={() => {
                            setSelectedArtifactPages(prev =>
                              prev.includes(scene.pageNumber)
                                ? prev.filter(p => p !== scene.pageNumber)
                                : [...prev, scene.pageNumber]
                            );
                          }}
                          className={`px-2 py-1 text-xs rounded border transition-colors ${
                            selectedArtifactPages.includes(scene.pageNumber)
                              ? 'bg-amber-100 border-amber-300 text-amber-700'
                              : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
                          }`}
                          disabled={isRunning}
                        >
                          Page {scene.pageNumber}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <button
                  onClick={async () => {
                    await repairArtifacts(selectedArtifactPages);
                    if (onRefreshStory) {
                      await onRefreshStory();
                    }
                  }}
                  disabled={isRunning || selectedArtifactPages.length === 0}
                  className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
                >
                  <Grid className="w-4 h-4" />
                  Run Grid Repair on {selectedArtifactPages.length} pages
                </button>

                {workflowState.artifactRepairResults.pagesProcessed.length > 0 && (
                  <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                    <h5 className="text-sm font-medium text-green-800">
                      Processed {workflowState.artifactRepairResults.pagesProcessed.length} pages,
                      fixed {workflowState.artifactRepairResults.issuesFixed} issues
                    </h5>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Step 8: Cover Repair */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            {renderStepHeader('cover-repair')}
            {expandedSteps.has('cover-repair') && (
              <div className="p-4 space-y-3 bg-white">
                <p className="text-sm text-gray-600">{STEP_CONFIG['cover-repair'].description}</p>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Select Covers to Regenerate:</label>
                  <div className="flex flex-wrap gap-3">
                    {(['front', 'initial', 'back'] as const).map(coverType => {
                      const labels = { front: 'Front Cover', initial: 'Dedication Page', back: 'Back Cover' };
                      return (
                        <label key={coverType} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedCovers.includes(coverType)}
                            onChange={(e) => {
                              setSelectedCovers(prev =>
                                e.target.checked
                                  ? [...prev, coverType]
                                  : prev.filter(c => c !== coverType)
                              );
                            }}
                            disabled={isRunning}
                            className="rounded text-amber-600"
                          />
                          <span className="text-sm">{labels[coverType]}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <button
                  onClick={async () => {
                    await regenerateCovers(selectedCovers);
                    if (onRefreshStory) {
                      await onRefreshStory();
                    }
                  }}
                  disabled={isRunning || selectedCovers.length === 0}
                  className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
                >
                  <Image className="w-4 h-4" />
                  Regenerate {selectedCovers.length} Cover{selectedCovers.length !== 1 ? 's' : ''}
                </button>

                {coverRepairProgress.total > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span>Progress: {coverRepairProgress.current} / {coverRepairProgress.total}</span>
                      {coverRepairProgress.currentCover && (
                        <span className="text-gray-500">Currently: {coverRepairProgress.currentCover} cover</span>
                      )}
                    </div>
                    <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-amber-500 transition-all"
                        style={{ width: `${(coverRepairProgress.current / coverRepairProgress.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}

                {workflowState.stepStatus['cover-repair'] === 'completed' && (
                  <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                    <h5 className="text-sm font-medium text-green-800">
                      Covers regenerated successfully
                    </h5>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
    {gridLightbox && (
      <ImageLightbox
        src={gridLightbox}
        alt="Consistency Grid"
        onClose={() => setGridLightbox(null)}
      />
    )}
    </>
  );
}

export default RepairWorkflowPanel;

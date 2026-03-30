import { useState, useMemo } from 'react';
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
  XCircle,
  Play,
  SkipForward,
  Square,
  Trophy,
  Paintbrush,
} from 'lucide-react';
import { useRepairWorkflow } from '@/hooks/useRepairWorkflow';
import { REPAIR_DEFAULTS } from '@/config/repairDefaults';
import { ImageLightbox } from '@/components/common/ImageLightbox';
import storyService from '@/services/storyService';
import type { SceneImage, CoverImages, FinalChecksReport, RepairWorkflowStep, StepStatus, PageFeedback, RepairPageResult } from '@/types/story';
import type { Character } from '@/types/character';

/** Map negative page numbers to cover display names */
const COVER_PAGE_NAMES: Record<number, string> = { [-1]: 'Front Cover', [-2]: 'Initial Page', [-3]: 'Back Cover' };
function getPageName(pageNumber: number): string {
  return pageNumber < 0 ? (COVER_PAGE_NAMES[pageNumber] || `Cover ${pageNumber}`) : `Page ${pageNumber}`;
}

interface RepairWorkflowPanelProps {
  storyId: string | null;
  sceneImages: SceneImage[];
  coverImages?: CoverImages | null;
  characters: Character[];
  finalChecksReport?: FinalChecksReport | null;
  imageModel?: string;
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
  onRefreshStory?: () => Promise<void>;
  // Developer mode settings
  developerMode?: boolean;
  useMagicApiRepair?: boolean;
  setUseMagicApiRepair?: (use: boolean) => void;
}

// Step configuration
const STEP_CONFIG: Record<RepairWorkflowStep, { label: string; icon: React.ComponentType<{ className?: string }>; description: string }> = {
  'idle': { label: 'Ready', icon: Circle, description: '' },
  'collect-feedback': { label: 'Collect Feedback', icon: Search, description: 'Gather all issues from evaluation data' },
  'identify-redo-pages': { label: 'Identify Redo Pages', icon: AlertTriangle, description: 'Mark pages needing complete regeneration' },
  'redo-pages': { label: 'Redo Pages', icon: RefreshCw, description: 'Regenerate marked pages via iteration' },
  're-evaluate': { label: 'Re-evaluate', icon: CheckCircle, description: 'Run quality evaluation on new images' },
  'consistency-check': { label: 'Consistency Check', icon: Users, description: 'Run entity consistency on all pages' },
  'character-repair': { label: 'Character Repair', icon: Users, description: 'Fix character appearance issues' },
  'inpaint-repair': { label: 'Inpaint Repair', icon: Paintbrush, description: 'Fix specific image regions using Grok edit' },
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

// Re-evaluation result shape (from workflowState.reEvaluationResults.pages)
interface ReEvalResult {
  score?: number;
  qualityScore: number;
  semanticScore?: number | null;
  entityPenalty?: number;
  verdict?: string;
  fixableIssues?: Array<{ description?: string; issue?: string; severity: string; type?: string; fix?: string; source?: string }>;
  semanticResult?: PageFeedback['semanticResult'];
}

// Severity to numeric penalty mapping
const severityPenalty = (s: string) =>
  s === 'critical' || s === 'CRITICAL' ? 30 :
  s === 'major' || s === 'MAJOR' ? 20 : 10;

// Page feedback card component
function PageFeedbackCard({
  feedback,
  reEvalResult,
  isMarkedForRedo,
  onToggleRedo,
}: {
  feedback: PageFeedback;
  reEvalResult?: ReEvalResult;
  isMarkedForRedo?: boolean;
  onToggleRedo?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // When reEvalResult is provided, prefer its scores (more recent)
  const qualityScore = reEvalResult?.qualityScore ?? feedback.qualityScore;
  const semanticScore = reEvalResult?.semanticScore ?? feedback.semanticScore;
  const entityPenalty = reEvalResult?.entityPenalty ?? feedback.entityPenalty ?? 0;
  const finalScore = reEvalResult?.score ?? feedback.score ?? qualityScore;
  const verdict = reEvalResult?.verdict ?? feedback.verdict;
  const semanticResult = reEvalResult?.semanticResult ?? feedback.semanticResult;
  const issuesSummary = feedback.issuesSummary;

  // Warn if using fallback (indicates potential bug in evaluation)
  if (reEvalResult && reEvalResult.score === null && reEvalResult.qualityScore !== null) {
    console.warn(`[RepairWorkflow] Page ${feedback.pageNumber}: Missing combined score, using qualityScore fallback`);
  }

  // Build a unified fixableIssues list: prefer reEvalResult's if available (already source-tagged),
  // otherwise fall back to feedback arrays
  const allIssues: Array<{ description: string; severity: string; type?: string; source?: string }> = [];
  if (reEvalResult?.fixableIssues && reEvalResult.fixableIssues.length > 0) {
    for (const issue of reEvalResult.fixableIssues) {
      allIssues.push({
        description: issue.description || issue.issue || JSON.stringify(issue),
        severity: issue.severity,
        type: issue.type,
        source: issue.source,
      });
    }
  } else {
    // Use feedback's separated arrays
    for (const issue of feedback.fixableIssues) {
      allIssues.push({ description: issue.description, severity: issue.severity, type: issue.type, source: issue.source });
    }
    for (const issue of feedback.entityIssues) {
      allIssues.push({ description: `[${issue.character}] ${issue.issue}`, severity: issue.severity, source: issue.source || 'entity check' });
    }
    if (feedback.objectIssues) {
      for (const issue of feedback.objectIssues) {
        allIssues.push({ description: `[${issue.object}] ${issue.issue}`, severity: issue.severity, source: issue.source || 'entity check' });
      }
    }
    if (feedback.semanticIssues) {
      for (const issue of feedback.semanticIssues) {
        allIssues.push({
          description: issue.description,
          severity: issue.severity,
          type: issue.type.replace(/_/g, ' '),
          source: issue.source || 'semantic',
        });
      }
    }
  }

  // Group issues by source
  const qualityIssues = allIssues.filter(i => !i.source?.includes('semantic') && !i.source?.includes('entity') && !i.source?.includes('image checks'));
  const semanticIssues = allIssues.filter(i => i.source?.includes('semantic'));
  const entityIssues = allIssues.filter(i => i.source?.includes('entity') || i.source?.includes('image checks'));

  const totalIssues = allIssues.length;
  const hasIssues = totalIssues > 0 || (qualityScore !== undefined && qualityScore < 70);

  const pageName = getPageName(feedback.pageNumber);

  const renderIssueList = (issues: typeof allIssues, color: string) => (
    <div className="space-y-0.5">
      {issues.map((issue, idx) => (
        <div key={idx} className="flex gap-1 items-start">
          <span className={`text-[10px] font-bold ${color} shrink-0`}>-{severityPenalty(issue.severity)}</span>
          <span className="text-xs text-gray-700">{issue.description}</span>
        </div>
      ))}
    </div>
  );

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
          <span className="font-medium">{pageName}</span>
          {qualityScore != null ? (
            <span className={`text-xs px-1.5 py-0.5 rounded ${
              qualityScore >= 80 ? 'bg-green-100 text-green-700' :
              qualityScore >= 60 ? 'bg-yellow-100 text-yellow-700' :
              'bg-red-100 text-red-700'
            }`}>
              {semanticScore != null ? 'Quality' : 'Score'}: {Math.max(0, qualityScore)}
            </span>
          ) : (
            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">Not evaluated</span>
          )}
          {(() => {
            const qScore = qualityScore ?? 0;
            const fScore = finalScore ?? qScore;
            const semanticPen = Math.max(0, qScore - fScore - entityPenalty);
            return (
              <>
                {semanticPen > 0 && (
                  <span className="text-xs bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded">
                    Semantic: -{semanticPen}
                  </span>
                )}
                {entityPenalty > 0 && (
                  <span className="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded">
                    Entity: -{entityPenalty}
                  </span>
                )}
                {semanticPen === 0 && entityPenalty === 0 && semanticScore != null && (
                  <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">
                    No penalties
                  </span>
                )}
                {(semanticPen > 0 || entityPenalty > 0) && (
                  <span className="text-xs text-gray-400">=</span>
                )}
              </>
            );
          })()}
          {finalScore !== undefined && (
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
              finalScore >= 70 ? 'bg-green-100 text-green-700' :
              finalScore >= 50 ? 'bg-yellow-100 text-yellow-700' :
              'bg-red-100 text-red-700'
            }`}>
              Final: {finalScore}%
            </span>
          )}
          {verdict && (
            <span className={`text-xs px-1.5 py-0.5 rounded ${
              verdict === 'PASS' ? 'bg-green-100 text-green-700' :
              verdict === 'SOFT_FAIL' ? 'bg-yellow-100 text-yellow-700' :
              'bg-red-100 text-red-700'
            }`}>
              {verdict}
            </span>
          )}
          {totalIssues > 0 && (
            <span className="text-xs text-gray-500">{totalIssues} issues</span>
          )}
        </div>
        {onToggleRedo && (
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
        )}
      </div>

      {expanded && (
        <div className="mt-3 space-y-2 pl-7">
          {issuesSummary && issuesSummary !== 'none' && (
            <p className={`text-xs pl-2 border-l-2 ${
              issuesSummary.includes('SEMANTIC:')
                ? 'text-indigo-700 border-indigo-400 bg-indigo-50 p-1 rounded-r'
                : 'text-gray-600 border-gray-300'
            }`}>
              {issuesSummary}
            </p>
          )}

          {/* Source-grouped issues with per-issue penalty values */}
          {totalIssues > 0 && (
            <div className="space-y-2">
              {qualityIssues.length > 0 && (
                <div className="text-xs pl-2 border-l-2 border-blue-300 bg-blue-50 p-1.5 rounded-r">
                  <div className="font-semibold text-blue-800 mb-1">Quality Issues ({qualityIssues.length}):</div>
                  {renderIssueList(qualityIssues, 'text-blue-600')}
                </div>
              )}
              {semanticIssues.length > 0 && (
                <div className="text-xs pl-2 border-l-2 border-indigo-400 bg-indigo-50 p-1.5 rounded-r">
                  <div className="font-semibold text-indigo-800 mb-1">Semantic Issues ({semanticIssues.length}):</div>
                  {renderIssueList(semanticIssues, 'text-indigo-600')}
                </div>
              )}
              {entityIssues.length > 0 && (
                <div className="text-xs pl-2 border-l-2 border-orange-400 bg-orange-50 p-1.5 rounded-r">
                  <div className="font-semibold text-orange-800 mb-1">Entity / Consistency Issues ({entityIssues.length}):</div>
                  {renderIssueList(entityIssues, 'text-orange-600')}
                </div>
              )}
            </div>
          )}

          {/* Semantic analysis detail (visible vs expected) */}
          {semanticResult && (
            <div className="text-xs text-indigo-700 pl-2 border-l-2 border-indigo-400 bg-indigo-50 p-1 rounded-r mt-1">
              <span className="font-medium">Semantic Analysis (Score: {semanticResult.score ?? 'N/A'}):</span>
              {semanticResult.visible && (
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                  <div className="bg-white p-2 rounded border border-indigo-200">
                    <div className="font-medium text-indigo-800 mb-1">Visible:</div>
                    {semanticResult.visible.characters && semanticResult.visible.characters.length > 0 && (
                      <div><span className="text-gray-500">Characters:</span> {semanticResult.visible.characters.join(', ')}</div>
                    )}
                    {semanticResult.visible.objects && semanticResult.visible.objects.length > 0 && (
                      <div><span className="text-gray-500">Objects:</span> {semanticResult.visible.objects.join(', ')}</div>
                    )}
                    {semanticResult.visible.setting && (
                      <div><span className="text-gray-500">Setting:</span> {semanticResult.visible.setting}</div>
                    )}
                    {semanticResult.visible.action && (
                      <div><span className="text-gray-500">Action:</span> {semanticResult.visible.action}</div>
                    )}
                  </div>
                  <div className="bg-white p-2 rounded border border-indigo-200">
                    <div className="font-medium text-indigo-800 mb-1">Expected:</div>
                    {semanticResult.expected?.characters && semanticResult.expected.characters.length > 0 && (
                      <div><span className="text-gray-500">Characters:</span> {semanticResult.expected.characters.join(', ')}</div>
                    )}
                    {semanticResult.expected?.objects && semanticResult.expected.objects.length > 0 && (
                      <div><span className="text-gray-500">Objects:</span> {semanticResult.expected.objects.join(', ')}</div>
                    )}
                    {semanticResult.expected?.setting && (
                      <div><span className="text-gray-500">Setting:</span> {semanticResult.expected.setting}</div>
                    )}
                    {semanticResult.expected?.action && (
                      <div><span className="text-gray-500">Action:</span> {semanticResult.expected.action}</div>
                    )}
                  </div>
                </div>
              )}
              {semanticResult.semanticIssues && semanticResult.semanticIssues.length > 0 && (
                <ul className="list-disc list-inside mt-2">
                  {semanticResult.semanticIssues.map((issue, idx) => (
                    <li key={idx}>
                      <span className={`font-medium ${
                        issue.severity === 'CRITICAL' ? 'text-red-600' :
                        issue.severity === 'MAJOR' ? 'text-orange-600' : 'text-yellow-600'
                      }`}>[{issue.severity}]</span> {issue.problem}
                    </li>
                  ))}
                </ul>
              )}
              {semanticResult.semanticIssues?.length === 0 && !semanticResult.visible && (
                <span className="text-green-600 ml-2">No issues</span>
              )}
            </div>
          )}

        </div>
      )}
    </div>
  );
}

export function RepairWorkflowPanel({
  storyId,
  sceneImages,
  coverImages,
  characters,
  finalChecksReport,
  imageModel,
  onImageUpdate,
  onRefreshStory,
  developerMode = false,
  useMagicApiRepair = false,
  setUseMagicApiRepair,
}: RepairWorkflowPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [expandedSteps, setExpandedSteps] = useState<Set<RepairWorkflowStep>>(new Set(['collect-feedback']));
  const [gridLightbox, setGridLightbox] = useState<string | null>(null);
  const [overrideImageModel, setOverrideImageModel] = useState<string | null>(null);
  const [overrideQualityModel, setOverrideQualityModel] = useState<string | null>(null);
  const [grokRepairMode, setGrokRepairMode] = useState<'blended' | 'cutout' | 'blackout' | null>(null);
  const [whiteoutTarget, setWhiteoutTarget] = useState<'auto' | 'face' | 'body'>('auto');
  const [retryingPages, setRetryingPages] = useState<Set<string>>(new Set()); // "char:pageNum" keys
  const effectiveImageModel = overrideImageModel || imageModel;

  const {
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
    rejectRepair,
    repairInpaint,
    runFullWorkflow,
    abortWorkflow,
    isAborted,
    getStepNumber,
    getCharactersWithIssues,
    getPagesWithSevereIssuesForCharacter,
  } = useRepairWorkflow({
    storyId,
    sceneImages,
    coverImages,
    characters,
    finalChecksReport,
    imageModel: effectiveImageModel,
    qualityModel: overrideQualityModel,
    onImageUpdate,
    onRefreshStory,
  });

  // Full workflow progress state
  const [fullWorkflowProgress, setFullWorkflowProgress] = useState<{ step: string; detail: string } | null>(null);
  const [isRunningFullWorkflow, setIsRunningFullWorkflow] = useState(false);

  // Per-step disable logic: full workflow locks everything, otherwise only block conflicting ops
  // Re-evaluate, consistency check, and redo can all run in parallel (independent API calls)
  // Character repair and pick-best need redo to be finished
  const isStepBusy = (step: string) => runningSteps.has(step);
  const isFullWorkflowBusy = isRunningFullWorkflow;
  // Disable a button if full workflow is running OR this specific step is already running
  const disableFor = (step: string) => isFullWorkflowBusy || isStepBusy(step);
  // Disable if full workflow OR any step that conflicts with pick-best/character-repair
  const disableForFinalSteps = isFullWorkflowBusy || runningSteps.has('redo-pages');



  const handleRunFullWorkflow = async () => {
    setIsRunningFullWorkflow(true);
    try {
      await runFullWorkflow({
        maxPasses: devMaxPasses,
        maxCharRepairPages: devMaxCharRepairPages,
        scoreThreshold: devScoreThreshold,
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

  // Dev overrides for repair workflow settings
  const [devMaxPasses, setDevMaxPasses] = useState<number>(REPAIR_DEFAULTS.maxPasses);
  const [devMaxCharRepairPages, setDevMaxCharRepairPages] = useState<number>(REPAIR_DEFAULTS.maxCharRepairPages);
  const [devScoreThreshold, setDevScoreThreshold] = useState<number>(REPAIR_DEFAULTS.scoreThreshold);

  // Selected character for repair
  const [selectedCharacter, setSelectedCharacter] = useState<string>('');
  const [selectedCharacterPages, setSelectedCharacterPages] = useState<number[]>([]);
  const [selectedInpaintPage, setSelectedInpaintPage] = useState<number | null>(null);

  // Redo mode option for step 3
  const [redoMode, setRedoMode] = useState<'fresh' | 'reference' | 'blackout'>('fresh');

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

  // Render step header
  const renderStepHeader = (step: RepairWorkflowStep) => {
    const config = STEP_CONFIG[step];
    const Icon = config.icon;
    const status = workflowState.stepStatus[step];
    const errorMsg = workflowState.stepErrors?.[step];
    const isExpandedStep = expandedSteps.has(step);
    const stepNum = getStepNumber(step);

    return (
      <>
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
        {status === 'failed' && errorMsg && (
          <div className="mx-3 mt-1 mb-2 px-3 py-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
            {errorMsg}
          </div>
        )}
      </>
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
              {runningSteps.size > 1 ? `${runningSteps.size} steps running...` : 'Running...'}
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
          {/* Evaluation model selector - dev mode only, affects re-evaluate step */}
          {developerMode && (
            <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg flex items-center gap-3">
              <label className="text-sm font-medium text-yellow-800 whitespace-nowrap">Evaluation Model:</label>
              <select
                value={overrideQualityModel || ''}
                onChange={(e) => setOverrideQualityModel(e.target.value || null)}
                className="flex-1 appearance-none bg-white border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500"
                disabled={isFullWorkflowBusy}
              >
                <option value="">Server Default (gemini-2.5-flash)</option>
                <option value="gemini-2.0-flash">Gemini 2.0 Flash — fast, no bbox ($0.005/eval)</option>
                <option value="gemini-2.5-flash">Gemini 2.5 Flash — thorough, bbox ($0.026/eval)</option>
                <option value="grok-4-fast">Grok 4 Fast — vision ($0.01/eval)</option>
              </select>
            </div>
          )}

          {/* Full Automated Workflow Button */}
          <div className="p-4 bg-gradient-to-r from-indigo-50 to-amber-50 border border-indigo-200 rounded-lg">
            {/* Dev settings row */}
            <div className="flex flex-wrap items-center gap-3 mb-3 text-xs">
              <label className="flex items-center gap-1 text-gray-600">
                Score &lt;
                <input type="number" value={devScoreThreshold} onChange={e => setDevScoreThreshold(Number(e.target.value))}
                  className="w-12 px-1 py-0.5 border rounded text-center" min={0} max={100} />
              </label>
              <label className="flex items-center gap-1 text-gray-600">
                Max passes
                <input type="number" value={devMaxPasses} onChange={e => setDevMaxPasses(Number(e.target.value))}
                  className="w-10 px-1 py-0.5 border rounded text-center" min={1} max={10} />
              </label>
              <label className="flex items-center gap-1 text-gray-600">
                Char repair pages
                <input type="number" value={devMaxCharRepairPages} onChange={e => setDevMaxCharRepairPages(Number(e.target.value))}
                  className="w-10 px-1 py-0.5 border rounded text-center" min={0} max={50} />
              </label>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <h4 className="font-bold text-indigo-800">Automated Full Repair</h4>
                <p className="text-sm text-indigo-600">
                  Runs all steps automatically. Pages retry up to {devMaxPasses} times, keeping the best result. Char repair: max {devMaxCharRepairPages} pages.
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
                  className="flex items-center gap-2 px-6 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 font-medium"
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
              <div className="mt-3 p-2 bg-white/50 rounded border border-indigo-100">
                <div className="flex items-center gap-2 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin text-indigo-600" />
                  <span className="font-medium text-indigo-700">{fullWorkflowProgress.step}:</span>
                  <span className="text-indigo-600">{fullWorkflowProgress.detail}</span>
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
                  disabled={disableFor('collect-feedback')}
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
                          Feedback Summary: {collectedTotal} issue{collectedTotal !== 1 ? 's' : ''}{hasReEvalData ? ` + ${reEvalIssues} from re-evaluation` : ''}
                        </h5>
                        <div className="flex flex-wrap gap-3 text-xs">
                          {qualityIssues > 0 && (
                            <span className="px-2 py-1 bg-orange-100 text-orange-700 rounded">
                              Quality: {qualityIssues}
                            </span>
                          )}
                          {characterIssues > 0 && (
                            <span className="px-2 py-1 bg-indigo-100 text-indigo-700 rounded">
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
                          {collectedTotal === 0 && (
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
                    onClick={() => autoIdentifyRedoPages(REPAIR_DEFAULTS.scoreThreshold, REPAIR_DEFAULTS.issueThreshold)}
                    disabled={disableFor('re-evaluate') || workflowState.stepStatus['collect-feedback'] !== 'completed'}
                    className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
                  >
                    <Zap className="w-4 h-4" />
                    Auto-Identify (score &lt; {REPAIR_DEFAULTS.scoreThreshold} or {REPAIR_DEFAULTS.issueThreshold}+ issues)
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
                          {getPageName(page)}
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
                    <input type="radio" name="redoMode" checked={redoMode === 'fresh'} onChange={() => setRedoMode('fresh')} disabled={isFullWorkflowBusy} className="mt-0.5" />
                    <div>
                      <span className="text-sm font-medium">Fresh generation</span>
                      <p className="text-xs text-gray-500">New generation from AI-corrected scene description</p>
                    </div>
                  </label>
                  <label className={`flex items-start gap-2 p-2 rounded-lg cursor-pointer transition-colors ${redoMode === 'reference' ? 'bg-blue-50 border border-blue-300' : 'bg-gray-50 border border-gray-200 hover:bg-gray-100'}`}>
                    <input type="radio" name="redoMode" checked={redoMode === 'reference'} onChange={() => setRedoMode('reference')} disabled={isFullWorkflowBusy} className="mt-0.5" />
                    <div>
                      <span className="text-sm font-medium">Use original as reference</span>
                      <p className="text-xs text-gray-500">Passes current image to Gemini — preserves composition, fixes details</p>
                    </div>
                  </label>
                  <label className={`flex items-start gap-2 p-2 rounded-lg cursor-pointer transition-colors ${redoMode === 'blackout' ? 'bg-indigo-50 border border-indigo-300' : 'bg-gray-50 border border-gray-200 hover:bg-gray-100'}`}>
                    <input type="radio" name="redoMode" checked={redoMode === 'blackout'} onChange={() => setRedoMode('blackout')} disabled={isFullWorkflowBusy} className="mt-0.5" />
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
                  disabled={disableFor('redo-pages') || workflowState.redoPages.pageNumbers.length === 0}
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
                        <span className="text-gray-500">Currently: {getPageName(redoProgress.currentPage)}</span>
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
                              {getPageName(page)} (v{workflowState.redoResults.newVersions[page] ?? '?'})
                            </div>
                            {detail && (detail.previousImage || detail.newImage) ? (() => {
                              const beforeSrc = detail.previousImage ? (detail.previousImage.startsWith('data:') ? detail.previousImage : `data:image/jpeg;base64,${detail.previousImage}`) : null;
                              const afterSrc = detail.newImage ? (detail.newImage.startsWith('data:') ? detail.newImage : `data:image/jpeg;base64,${detail.newImage}`) : null;
                              const blackoutSrc = detail.blackoutImage ? (detail.blackoutImage.startsWith('data:') ? detail.blackoutImage : `data:image/jpeg;base64,${detail.blackoutImage}`) : null;
                              const canCompare = beforeSrc && afterSrc;
                              return (
                                <div className="space-y-1">
                                  <div
                                    className={`grid ${beforeSrc && afterSrc ? 'grid-cols-2' : 'grid-cols-1'} gap-1 ${canCompare ? 'cursor-pointer hover:opacity-90' : ''} rounded border border-gray-200 overflow-hidden`}
                                    onClick={canCompare ? () => setGridLightbox(`COMPARE:${beforeSrc}|||${afterSrc}`) : undefined}
                                  >
                                    {beforeSrc && (
                                      <div className="relative">
                                        <img src={beforeSrc} alt="Before" className="w-full h-20 object-cover" />
                                        <span className="absolute top-0.5 left-0.5 text-[9px] bg-red-600 text-white px-1 py-0.5 rounded font-medium">Before{detail.previousScore != null ? ` ${detail.previousScore}` : ''}</span>
                                      </div>
                                    )}
                                    {afterSrc && (
                                      <div className="relative">
                                        <img src={afterSrc} alt="After" className="w-full h-20 object-cover" />
                                        <span className="absolute top-0.5 left-0.5 text-[9px] bg-green-600 text-white px-1 py-0.5 rounded font-medium">After{detail.newScore != null ? ` ${detail.newScore}` : ''}</span>
                                      </div>
                                    )}
                                  </div>
                                  {blackoutSrc && (
                                    <img src={blackoutSrc} alt="Blackout" className="w-10 h-10 object-cover rounded cursor-pointer border border-indigo-300 hover:ring-2 hover:ring-indigo-400"
                                         onClick={() => setGridLightbox(blackoutSrc)} />
                                  )}
                                </div>
                              );
                            })() : null}
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
                      disabled={disableFor('re-evaluate')}
                      className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
                    >
                      <CheckCircle className="w-4 h-4" />
                      Re-evaluate {workflowState.redoResults.pagesCompleted.length} Redone Pages
                    </button>
                  ) : null}
                  <button
                    onClick={() => {
                      const pageNums = sceneImages.map(s => s.pageNumber);
                      // Include covers
                      if (coverImages?.frontCover) pageNums.push(-1);
                      if (coverImages?.initialPage) pageNums.push(-2);
                      if (coverImages?.backCover) pageNums.push(-3);
                      reEvaluatePages(pageNums);
                    }}
                    disabled={disableFor('re-evaluate')}
                    className="flex items-center gap-2 px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50"
                  >
                    <CheckCircle className="w-4 h-4" />
                    Re-evaluate All Pages + Covers
                  </button>
                </div>

                {Object.keys(workflowState.reEvaluationResults.pages).length > 0 && (
                  <div className="space-y-2">
                    <h5 className="text-sm font-medium">Evaluation Results:</h5>
                    <div className="space-y-2">
                      {Object.entries(workflowState.reEvaluationResults.pages)
                        .sort(([a], [b]) => Number(a) - Number(b))
                        .map(([page, result]) => {
                          const pageNum = Number(page);
                          const feedbackData = workflowState.collectedFeedback.pages[pageNum] || {
                            pageNumber: pageNum,
                            fixableIssues: [],
                            entityIssues: [],
                            objectIssues: [],
                            semanticIssues: [],
                            needsFullRedo: false,
                          };
                          return (
                            <PageFeedbackCard
                              key={page}
                              feedback={feedbackData}
                              reEvalResult={result}
                            />
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
                  disabled={disableFor('consistency-check')}
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

                    {/* Per-character grids — always visible */}
                    {Object.entries(workflowState.consistencyResults.report.characters || {}).map(([charName, charResult]) => (
                      <div key={charName} className="border rounded-lg overflow-hidden">
                        <div className={`px-3 py-2 text-sm font-medium flex items-center justify-between ${
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
                        </div>
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
                              {(clothingResult.gridImages || (clothingResult.gridImage ? [clothingResult.gridImage] : [])).map((img: string, gridIdx: number) => (
                                <div key={gridIdx} className="mt-2 mb-2">
                                  <img
                                    src={img}
                                    alt={`${charName} - ${clothing} consistency grid${(clothingResult.gridImages?.length || 0) > 1 ? ` ${gridIdx + 1}` : ''}`}
                                    className="w-full max-h-48 object-contain rounded border border-gray-200 bg-gray-50 cursor-pointer hover:opacity-80 transition-opacity"
                                    onClick={() => setGridLightbox(img)}
                                    title="Click to enlarge"
                                  />
                                </div>
                              ))}
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
                      </div>
                    ))}

                    {charactersWithIssues.length > 0 && (
                      <div className="text-sm pt-2 border-t">
                        <span className="font-medium">Characters needing repair:</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {charactersWithIssues.map(name => (
                            <span key={name} className="px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded text-xs">
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
                    disabled={isFullWorkflowBusy}
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
                        disabled={disableForFinalSteps || workflowState.stepStatus['consistency-check'] !== 'completed'}
                        className="flex items-center gap-1 px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
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
                              ? 'bg-indigo-100 border-indigo-300 text-indigo-700'
                              : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
                          }`}
                          disabled={isFullWorkflowBusy}
                        >
                          {getPageName(scene.pageNumber)}
                        </button>
                      ))}
                      {coverImages?.frontCover && (
                        <button
                          key={-1}
                          onClick={() => {
                            setSelectedCharacterPages(prev =>
                              prev.includes(-1) ? prev.filter(p => p !== -1) : [...prev, -1]
                            );
                          }}
                          className={`px-2 py-1 text-xs rounded border transition-colors ${
                            selectedCharacterPages.includes(-1)
                              ? 'bg-indigo-100 border-indigo-300 text-indigo-700'
                              : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
                          }`}
                          disabled={isFullWorkflowBusy}
                        >
                          Front Cover
                        </button>
                      )}
                      {coverImages?.initialPage && (
                        <button
                          key={-2}
                          onClick={() => {
                            setSelectedCharacterPages(prev =>
                              prev.includes(-2) ? prev.filter(p => p !== -2) : [...prev, -2]
                            );
                          }}
                          className={`px-2 py-1 text-xs rounded border transition-colors ${
                            selectedCharacterPages.includes(-2)
                              ? 'bg-indigo-100 border-indigo-300 text-indigo-700'
                              : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
                          }`}
                          disabled={isFullWorkflowBusy}
                        >
                          Initial Page
                        </button>
                      )}
                      {coverImages?.backCover && (
                        <button
                          key={-3}
                          onClick={() => {
                            setSelectedCharacterPages(prev =>
                              prev.includes(-3) ? prev.filter(p => p !== -3) : [...prev, -3]
                            );
                          }}
                          className={`px-2 py-1 text-xs rounded border transition-colors ${
                            selectedCharacterPages.includes(-3)
                              ? 'bg-indigo-100 border-indigo-300 text-indigo-700'
                              : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
                          }`}
                          disabled={isFullWorkflowBusy}
                        >
                          Back Cover
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Image & repair model selector - only in developer mode */}
                {developerMode && (
                  <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                    <label className="text-sm font-medium text-yellow-800 mb-2 block">Image Model:</label>
                    <select
                      value={
                        grokRepairMode === 'cutout' ? 'grok-cutout' :
                        grokRepairMode === 'blackout' ? 'grok-blackout' :
                        grokRepairMode === 'blended' ? 'grok-blended' :
                        useMagicApiRepair ? 'magicapi' :
                        overrideImageModel === 'gemini-repair' ? 'gemini-repair' :
                        (overrideImageModel || imageModel || '')
                      }
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === 'grok-blended') {
                          setGrokRepairMode('blended');
                          setUseMagicApiRepair?.(false);
                          setOverrideImageModel(null);
                        } else if (val === 'grok-cutout') {
                          setGrokRepairMode('cutout');
                          setUseMagicApiRepair?.(false);
                          setOverrideImageModel(null);
                        } else if (val === 'grok-blackout') {
                          setGrokRepairMode('blackout');
                          setUseMagicApiRepair?.(false);
                          setOverrideImageModel(null);
                        } else if (val === 'gemini-repair') {
                          setGrokRepairMode(null);
                          setUseMagicApiRepair?.(false);
                          setOverrideImageModel('gemini-repair');
                        } else if (val === 'magicapi') {
                          setGrokRepairMode(null);
                          setUseMagicApiRepair?.(true);
                          setOverrideImageModel(null);
                        } else {
                          setGrokRepairMode(null);
                          setUseMagicApiRepair?.(false);
                          setOverrideImageModel(val || null);
                        }
                      }}
                      className="w-full appearance-none bg-white border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500"
                      disabled={isFullWorkflowBusy}
                    >
                      <optgroup label="Image Generation">
                        <option value="">Server Default</option>
                        <option value="gemini-2.5-flash-image">Gemini 2.5 Flash Image</option>
                        <option value="gemini-3-pro-image-preview">Gemini 3 Pro Image</option>
                        <option value="grok-imagine">Grok Imagine ($0.02/image)</option>
                        <option value="grok-imagine-pro">Grok Imagine Pro ($0.07/image)</option>
                        <option value="flux-schnell">FLUX Schnell ($0.0006/image)</option>
                      </optgroup>
                      <optgroup label="Character Repair">
                        <option value="grok-blended">Grok Blended — default ($0.02, feathered)</option>
                        <option value="grok-cutout">Grok Cut-Out ($0.02/repair)</option>
                        <option value="grok-blackout">Grok Blackout ($0.02/repair)</option>
                        <option value="gemini-repair">Gemini Repair (~$0.04/repair)</option>
                        <option value="magicapi">MagicAPI Face+Hair (~$0.006/repair)</option>
                      </optgroup>
                    </select>
                    {(!grokRepairMode || grokRepairMode === 'blended') && !useMagicApiRepair && (
                      <div className="mt-2 space-y-2">
                        <label className="text-xs font-medium text-yellow-800 block">Whiteout target:</label>
                        <div className="flex gap-2">
                          {(['auto', 'face', 'body'] as const).map(target => (
                            <button
                              key={target}
                              onClick={() => setWhiteoutTarget(target)}
                              className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
                                whiteoutTarget === target
                                  ? 'bg-yellow-600 text-white'
                                  : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-50'
                              }`}
                            >
                              {target === 'auto' ? 'Auto (by issue type)' : target === 'face' ? 'Face only (+50% pad)' : 'Full body (+20% pad)'}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {useMagicApiRepair && (
                      <p className="text-xs text-yellow-600 mt-2">
                        Uses face swap + hair fix pipeline with iterative crop checking
                      </p>
                    )}
                    {grokRepairMode === 'cutout' && (
                      <p className="text-xs text-yellow-600 mt-2">
                        Extracts character region, sends to Grok with reference, composites back
                      </p>
                    )}
                    {grokRepairMode === 'blackout' && (
                      <p className="text-xs text-yellow-600 mt-2">
                        Sends full scene + reference to Grok for character face replacement
                      </p>
                    )}
                  </div>
                )}

                <button
                  onClick={async () => {
                    await repairCharacter(selectedCharacter, selectedCharacterPages, {
                      useMagicApiRepair,
                      ...(grokRepairMode && { grokRepairMode }),
                      ...(whiteoutTarget !== 'auto' && { whiteoutTarget }),
                      ...(overrideImageModel === 'gemini-repair' && { useGeminiRepair: true }),
                    });
                    if (onRefreshStory) {
                      await onRefreshStory();
                    }
                  }}
                  disabled={disableForFinalSteps || !selectedCharacter || selectedCharacterPages.length === 0}
                  className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                >
                  <Wrench className="w-4 h-4" />
                  Repair {selectedCharacter || 'Character'} on {selectedCharacterPages.length} pages
                  {useMagicApiRepair && <span className="text-xs opacity-75">(MagicAPI)</span>}
                  {grokRepairMode && <span className="text-xs opacity-75">(Grok {grokRepairMode})</span>}
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
                              <span className="text-sm font-medium text-green-800">{getPageName(page.pageNumber)}</span>
                              {page.method && (
                                <span className={`px-1.5 py-0.5 text-xs rounded font-medium ${
                                  page.method === 'magicapi' ? 'bg-blue-100 text-blue-700' :
                                  page.method?.startsWith('grok_') ? 'bg-orange-100 text-orange-700' :
                                  'bg-indigo-100 text-indigo-700'
                                }`}>
                                  {page.method === 'magicapi' ? 'MagicAPI' :
                                   page.method === 'grok_blended' ? 'Grok Blended' :
                                   page.method === 'grok_cutout' ? 'Grok Cut-Out' :
                                   page.method === 'grok_blackout' ? 'Grok Blackout' :
                                   page.method?.startsWith('grok_') ? `Grok ${page.method.replace('grok_', '')}` : 'Gemini'}
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
                              <div className="space-y-2 mb-2">
                                {/* Side-by-side before/after — click to see full size comparison */}
                                {page.comparison.before && (
                                  <div
                                    className="grid grid-cols-2 gap-1 cursor-pointer hover:opacity-90 transition-opacity rounded border border-gray-200 overflow-hidden"
                                    onClick={() => setGridLightbox(`COMPARE:${page.comparison!.before}|||${page.comparison!.after}`)}
                                  >
                                    <div className="relative">
                                      <img src={page.comparison.before} alt="Before" className="w-full h-32 object-contain bg-gray-50" />
                                      <span className="absolute top-1 left-1 text-[10px] bg-red-600 text-white px-1.5 py-0.5 rounded font-medium">Before</span>
                                      {page.beforeScore != null && (
                                        <span className={`absolute top-1 right-1 text-[10px] font-bold text-white px-1.5 py-0.5 rounded ${
                                          page.beforeScore >= 80 ? 'bg-green-600' : page.beforeScore >= 60 ? 'bg-yellow-600' : 'bg-red-600'
                                        }`}>{page.beforeScore}%</span>
                                      )}
                                    </div>
                                    <div className="relative">
                                      <img src={page.comparison.after} alt="After" className="w-full h-32 object-contain bg-gray-50" />
                                      <span className="absolute top-1 left-1 text-[10px] bg-green-600 text-white px-1.5 py-0.5 rounded font-medium">After</span>
                                      {page.afterScore != null && (
                                        <span className={`absolute top-1 right-1 text-[10px] font-bold text-white px-1.5 py-0.5 rounded ${
                                          page.afterScore >= 80 ? 'bg-green-600' : page.afterScore >= 60 ? 'bg-yellow-600' : 'bg-red-600'
                                        }`}>
                                          {page.afterScore}%
                                          {page.beforeScore != null && (
                                            <span className="ml-0.5 text-[9px] opacity-80">
                                              ({page.afterScore - page.beforeScore >= 0 ? '+' : ''}{page.afterScore - page.beforeScore})
                                            </span>
                                          )}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                )}
                                {/* Reference avatar + Grok repair debug images */}
                                <div className="flex items-center gap-2 flex-wrap">
                                  <div className="flex flex-col items-center">
                                    <img
                                      src={page.comparison.croppedAvatar || page.comparison.reference}
                                      alt="Avatar sent to Grok"
                                      className="w-12 h-12 object-contain rounded border border-gray-200 bg-gray-50 cursor-pointer hover:opacity-80"
                                      onClick={() => setGridLightbox(page.comparison!.croppedAvatar || page.comparison!.reference)}
                                    />
                                    <span className="text-[10px] text-gray-500">{page.comparison.croppedAvatar ? 'Sent to Grok' : 'Avatar'}</span>
                                  </div>
                                  {page.comparison.blackoutImage && (
                                    <div className="flex flex-col items-center">
                                      <img
                                        src={page.comparison.blackoutImage}
                                        alt="Whiteout sent to Grok"
                                        className="w-12 h-12 object-contain rounded border border-purple-300 bg-gray-50 cursor-pointer hover:opacity-80"
                                        onClick={() => setGridLightbox(page.comparison!.blackoutImage!)}
                                      />
                                      <span className="text-[10px] text-gray-500">Whiteout</span>
                                    </div>
                                  )}
                                  {page.comparison.grokRawResult && (
                                    <div className="flex flex-col items-center">
                                      <img
                                        src={page.comparison.grokRawResult}
                                        alt="Raw Grok output"
                                        className="w-12 h-12 object-contain rounded border border-orange-300 bg-gray-50 cursor-pointer hover:opacity-80"
                                        onClick={() => setGridLightbox(page.comparison!.grokRawResult!)}
                                      />
                                      <span className="text-[10px] text-gray-500">Grok raw</span>
                                    </div>
                                  )}
                                  {page.comparison.blendMask && (
                                    <div className="flex flex-col items-center">
                                      <img
                                        src={page.comparison.blendMask}
                                        alt="Feather blend mask"
                                        className="w-12 h-12 object-contain rounded border border-gray-400 bg-black cursor-pointer hover:opacity-80"
                                        onClick={() => setGridLightbox(page.comparison!.blendMask!)}
                                      />
                                      <span className="text-[10px] text-gray-500">Blend mask</span>
                                    </div>
                                  )}
                                </div>
                                {!page.comparison.before && (
                                  <img
                                    src={page.comparison.after}
                                    alt="After repair"
                                    className="w-full h-32 object-contain rounded border border-gray-200 bg-gray-50 cursor-pointer hover:opacity-80"
                                    onClick={() => setGridLightbox(page.comparison!.after)}
                                  />
                                )}
                              </div>
                            )}
                            {page.verification?.explanation && (
                              <p className="text-xs text-gray-600 italic">{page.verification.explanation}</p>
                            )}
                            {/* Grok repair details (dev mode) */}
                            {developerMode && (page as any).debug && (
                              <div className="mt-2 p-3 bg-gray-50 border border-gray-200 rounded text-xs space-y-2">
                                <h6 className="font-semibold text-gray-700">Grok Repair Details</h6>
                                <p className="text-gray-600"><strong>Bbox:</strong> [{(page as any).debug.bbox?.map((v: number) => Math.round(v * 100) + '%').join(', ')}] | <strong>Face:</strong> {(page as any).debug.faceBbox ? `[${(page as any).debug.faceBbox.map((v: number) => Math.round(v * 100) + '%').join(', ')}]` : 'none'} | <strong>Blend:</strong> {(page as any).debug.blendRegion?.width}x{(page as any).debug.blendRegion?.height}</p>
                                <div className="grid grid-cols-3 gap-2">
                                  <div className="text-center">
                                    <img src={(page as any).debug.avatarSent} alt="Avatar ref" className="w-full h-32 object-contain rounded border bg-white cursor-pointer hover:opacity-80" onClick={() => setGridLightbox((page as any).debug.avatarSent)} />
                                    <span className="text-gray-500 block mt-1">Avatar ref sent</span>
                                  </div>
                                  <div className="text-center">
                                    <img src={(page as any).debug.sceneSent} alt="Scene sent to Grok" className="w-full h-32 object-contain rounded border bg-white cursor-pointer hover:opacity-80" onClick={() => setGridLightbox((page as any).debug.sceneSent)} />
                                    <span className="text-gray-500 block mt-1">Scene sent (head whited out)</span>
                                  </div>
                                  <div className="text-center">
                                    <img src={(page as any).debug.grokRawResult} alt="Grok raw output" className="w-full h-32 object-contain rounded border bg-white cursor-pointer hover:opacity-80" onClick={() => setGridLightbox((page as any).debug.grokRawResult)} />
                                    <span className="text-gray-500 block mt-1">Grok raw output (before blend)</span>
                                  </div>
                                </div>
                                <details className="mt-1">
                                  <summary className="cursor-pointer text-gray-500 hover:text-gray-700">Prompt sent to Grok</summary>
                                  <p className="mt-1 text-gray-600 break-all bg-white p-2 rounded border">{(page as any).debug.prompt}</p>
                                </details>
                              </div>
                            )}
                            {/* Reject / Retry buttons */}
                            {!page.rejected && (
                              <div className="flex items-center gap-2 mt-2">
                                <button
                                  onClick={async () => {
                                    const prevIdx = (page.versionIndex ?? 1) - 1;
                                    await rejectRepair(char, page.pageNumber, Math.max(0, prevIdx));
                                  }}
                                  disabled={retryingPages.has(`${char}:${page.pageNumber}`)}
                                  className="px-3 py-1.5 text-xs font-medium bg-red-100 text-red-700 rounded hover:bg-red-200 disabled:opacity-50"
                                >
                                  Reject
                                </button>
                                <button
                                  onClick={async () => {
                                    const key = `${char}:${page.pageNumber}`;
                                    setRetryingPages(prev => new Set([...prev, key]));
                                    try {
                                      await repairCharacter(char, [page.pageNumber], {
                                        ...(grokRepairMode && { grokRepairMode }),
                                        ...(whiteoutTarget !== 'auto' && { whiteoutTarget }),
                                        ...(useMagicApiRepair && { useMagicApiRepair }),
                                      });
                                      if (onRefreshStory) await onRefreshStory();
                                    } finally {
                                      setRetryingPages(prev => { const next = new Set(prev); next.delete(key); return next; });
                                    }
                                  }}
                                  disabled={retryingPages.has(`${char}:${page.pageNumber}`)}
                                  className="px-3 py-1.5 text-xs font-medium bg-amber-100 text-amber-700 rounded hover:bg-amber-200 disabled:opacity-50 flex items-center gap-1"
                                >
                                  {retryingPages.has(`${char}:${page.pageNumber}`) ? (
                                    <><RefreshCw className="w-3 h-3 animate-spin" /> Retrying...</>
                                  ) : (
                                    <><RefreshCw className="w-3 h-3" /> Retry</>
                                  )}
                                </button>
                                {page.afterScore != null && page.beforeScore != null && page.afterScore < page.beforeScore && (
                                  <span className="text-xs text-red-600 font-medium">Score dropped {page.afterScore - page.beforeScore}</span>
                                )}
                              </div>
                            )}
                            {page.rejected && (
                              <div className="flex items-center gap-2 mt-2">
                                <span className="text-xs text-red-600 font-medium">Rejected — reverted to previous version</span>
                                <button
                                  onClick={async () => {
                                    const key = `${char}:${page.pageNumber}`;
                                    setRetryingPages(prev => new Set([...prev, key]));
                                    try {
                                      await repairCharacter(char, [page.pageNumber], {
                                        ...(grokRepairMode && { grokRepairMode }),
                                        ...(whiteoutTarget !== 'auto' && { whiteoutTarget }),
                                        ...(useMagicApiRepair && { useMagicApiRepair }),
                                      });
                                      if (onRefreshStory) await onRefreshStory();
                                    } finally {
                                      setRetryingPages(prev => { const next = new Set(prev); next.delete(key); return next; });
                                    }
                                  }}
                                  disabled={retryingPages.has(`${char}:${page.pageNumber}`)}
                                  className="px-3 py-1.5 text-xs font-medium bg-amber-100 text-amber-700 rounded hover:bg-amber-200 disabled:opacity-50 flex items-center gap-1"
                                >
                                  {retryingPages.has(`${char}:${page.pageNumber}`) ? (
                                    <><RefreshCw className="w-3 h-3 animate-spin" /> Retrying...</>
                                  ) : (
                                    <><RefreshCw className="w-3 h-3" /> Retry</>
                                  )}
                                </button>
                              </div>
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
                                <span className="text-sm font-medium text-red-800">{getPageName(page.pageNumber)}</span>
                                {page.rejected && (
                                  <span className="px-1.5 py-0.5 text-xs rounded bg-red-100 text-red-700 font-medium">Rejected</span>
                                )}
                              </div>
                              <p className="text-xs text-red-700 mb-2">{page.reason}</p>
                              {page.comparison && (
                                <div className="grid grid-cols-3 gap-2">
                                  <div className="text-center">
                                    <img
                                      src={page.comparison.croppedAvatar || page.comparison.reference}
                                      alt="Avatar sent to Grok"
                                      className="w-full h-24 object-contain rounded border border-red-200 bg-gray-50 cursor-pointer hover:opacity-80 transition-opacity"
                                      onClick={() => setGridLightbox(page.comparison!.croppedAvatar || page.comparison!.reference)}
                                    />
                                    <span className="text-xs text-gray-500 mt-1 block">{page.comparison.croppedAvatar ? 'Sent to Grok' : 'Reference'}</span>
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
                              <button
                                onClick={async () => {
                                  const key = `${char}:${page.pageNumber}`;
                                  setRetryingPages(prev => new Set([...prev, key]));
                                  try {
                                    await repairCharacter(char, [page.pageNumber], {
                                      ...(grokRepairMode && { grokRepairMode }),
                                      ...(whiteoutTarget !== 'auto' && { whiteoutTarget }),
                                      ...(useMagicApiRepair && { useMagicApiRepair }),
                                    });
                                    if (onRefreshStory) await onRefreshStory();
                                  } finally {
                                    setRetryingPages(prev => { const next = new Set(prev); next.delete(key); return next; });
                                  }
                                }}
                                disabled={retryingPages.has(`${char}:${page.pageNumber}`)}
                                className="mt-2 px-3 py-1.5 text-xs font-medium bg-amber-100 text-amber-700 rounded hover:bg-amber-200 disabled:opacity-50 flex items-center gap-1"
                              >
                                {retryingPages.has(`${char}:${page.pageNumber}`) ? (
                                  <><RefreshCw className="w-3 h-3 animate-spin" /> Retrying...</>
                                ) : (
                                  <><RefreshCw className="w-3 h-3" /> Retry</>
                                )}
                              </button>
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

          {/* Step 7: Inpaint Repair */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            {renderStepHeader('inpaint-repair')}
            {expandedSteps.has('inpaint-repair') && (
              <div className="p-4 space-y-3 bg-white">
                <p className="text-sm text-gray-600">{STEP_CONFIG['inpaint-repair'].description}</p>

                {/* Page selector — show pages + covers that have fix targets */}
                <div className="space-y-2">
                  <div className="text-xs font-medium text-gray-700">Select page to repair:</div>
                  <div className="flex flex-wrap gap-1">
                    {/* Cover entries */}
                    {([
                      { key: 'frontCover', pageNumber: -1 },
                      { key: 'initialPage', pageNumber: -2 },
                      { key: 'backCover', pageNumber: -3 },
                    ] as const).map(({ key, pageNumber }) => {
                      const cover = coverImages?.[key];
                      if (!cover?.hasImage && !cover?.imageData) return null;
                      const fixTargetCount = cover?.fixTargets?.length || 0;
                      return (
                        <button
                          key={pageNumber}
                          onClick={() => setSelectedInpaintPage(pageNumber)}
                          className={`px-2 py-1 text-xs rounded border transition-colors ${
                            selectedInpaintPage === pageNumber
                              ? 'bg-orange-100 border-orange-400 text-orange-800'
                              : fixTargetCount > 0
                                ? 'bg-yellow-50 border-yellow-300 text-yellow-800 hover:bg-yellow-100'
                                : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100'
                          }`}
                          disabled={isFullWorkflowBusy}
                        >
                          {getPageName(pageNumber)} {fixTargetCount > 0 && <span className="font-semibold">({fixTargetCount})</span>}
                        </button>
                      );
                    })}
                    {/* Scene entries */}
                    {sceneImages.map(scene => {
                      const evalTargets = workflowState.reEvaluationResults.pages[scene.pageNumber]?.fixTargets;
                      const fixTargetCount = evalTargets?.length || scene.fixTargets?.length || 0;
                      return (
                        <button
                          key={scene.pageNumber}
                          onClick={() => setSelectedInpaintPage(scene.pageNumber)}
                          className={`px-2 py-1 text-xs rounded border transition-colors ${
                            selectedInpaintPage === scene.pageNumber
                              ? 'bg-orange-100 border-orange-400 text-orange-800'
                              : fixTargetCount > 0
                                ? 'bg-yellow-50 border-yellow-300 text-yellow-800 hover:bg-yellow-100'
                                : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100'
                          }`}
                          disabled={isFullWorkflowBusy}
                        >
                          {getPageName(scene.pageNumber)} {fixTargetCount > 0 && <span className="font-semibold">({fixTargetCount})</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Show fix targets for selected page */}
                {selectedInpaintPage !== null && (() => {
                  const COVER_KEY_MAP: Record<number, keyof CoverImages> = { [-1]: 'frontCover', [-2]: 'initialPage', [-3]: 'backCover' };
                  const isCover = selectedInpaintPage < 0;
                  const scene = isCover ? null : sceneImages.find(s => s.pageNumber === selectedInpaintPage);
                  const cover = isCover ? coverImages?.[COVER_KEY_MAP[selectedInpaintPage]] : null;
                  // Fix targets: prefer workflow re-evaluation results (most recent), then scene data
                  const evalFixTargets = workflowState.reEvaluationResults.pages[selectedInpaintPage]?.fixTargets;
                  const fixTargets = evalFixTargets?.length ? evalFixTargets : (isCover ? cover?.fixTargets : scene?.fixTargets) || [];
                  return (
                    <div className="space-y-2">
                      {fixTargets.length > 0 ? (
                        <>
                          <div className="text-xs text-gray-600">
                            {fixTargets.length} fixable issue{fixTargets.length !== 1 ? 's' : ''} on {getPageName(selectedInpaintPage)}:
                          </div>
                          <ul className="text-xs text-gray-500 list-disc pl-4 space-y-0.5">
                            {fixTargets.map((t, i) => (
                              <li key={i}>{t.issue}</li>
                            ))}
                          </ul>
                        </>
                      ) : (
                        <div className="text-xs text-gray-400">No fix targets available for this page. Run evaluation first.</div>
                      )}

                      <button
                        onClick={async () => {
                          const result = await repairInpaint(selectedInpaintPage!, fixTargets.length > 0 ? fixTargets : undefined);
                          if (result?.repaired && onRefreshStory) {
                            await onRefreshStory();
                          }
                        }}
                        disabled={disableForFinalSteps || selectedInpaintPage === null || workflowState.stepStatus['inpaint-repair'] === 'in-progress'}
                        className="flex items-center gap-2 px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50"
                      >
                        <Paintbrush className="w-4 h-4" />
                        Inpaint {getPageName(selectedInpaintPage)}
                        {workflowState.stepStatus['inpaint-repair'] === 'in-progress' && (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        )}
                      </button>

                      {/* Inpaint result display */}
                      {workflowState.inpaintResults[selectedInpaintPage] && (() => {
                        const ir = workflowState.inpaintResults[selectedInpaintPage];
                        // Get before image from current scene/cover
                        const beforeImg = isCover
                          ? (cover as { imageData?: string })?.imageData
                          : scene?.imageData;
                        return (
                          <div className={`mt-2 p-3 rounded-lg border ${ir.repaired ? 'bg-green-50 border-green-300' : 'bg-red-50 border-red-300'}`}>
                            <div className="flex items-center justify-between mb-1">
                              <span className={`text-sm font-semibold ${ir.repaired ? 'text-green-800' : 'text-red-800'}`}>
                                {ir.repaired ? 'Repair applied' : ir.noErrorsFound ? 'No errors detected' : 'Repair rejected'}
                              </span>
                              {ir.preScore != null && ir.postScore != null && (
                                <span className="text-sm font-bold">
                                  <span className={ir.preScore >= 60 ? 'text-green-600' : 'text-red-600'}>{ir.preScore}%</span>
                                  <span className="text-gray-400 mx-1">→</span>
                                  <span className={ir.postScore >= 60 ? 'text-green-600' : 'text-red-600'}>{ir.postScore}%</span>
                                </span>
                              )}
                            </div>
                            {/* Before / After images */}
                            {(beforeImg || ir.afterImage) && (
                              <div className="mt-2 grid grid-cols-2 gap-2">
                                {beforeImg && (
                                  <div>
                                    <div className="text-[10px] text-gray-500 mb-0.5 font-medium">Before</div>
                                    <img src={beforeImg} alt="Before" className="w-full rounded border-2 border-red-300" />
                                  </div>
                                )}
                                {ir.afterImage && (
                                  <div>
                                    <div className="text-[10px] text-gray-500 mb-0.5 font-medium">After</div>
                                    <img src={ir.afterImage} alt="After" className="w-full rounded border-2 border-green-300" />
                                  </div>
                                )}
                              </div>
                            )}
                            <div className="text-xs text-gray-600 mt-1">
                              {ir.fixTargetsCount} fix target{ir.fixTargetsCount !== 1 ? 's' : ''} processed
                              {!ir.repaired && !ir.noErrorsFound && (
                                <span className="ml-1">— inpainting could not fix these issues. Try regenerating the page instead.</span>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          {/* Pick Best Versions (LAST — after character repair so repaired versions are considered) */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Trophy className="w-4 h-4 text-amber-600" />
                <span className="text-sm font-semibold text-gray-700">Pick Best Versions</span>
              </div>
              <button
                onClick={async () => {
                  const pageNumbers = sceneImages
                    .filter(img => img.imageVersions && img.imageVersions.length > 1)
                    .map(img => img.pageNumber);
                  if (coverImages) {
                    const coverMap: Array<[string, number]> = [['frontCover', -1], ['initialPage', -2], ['backCover', -3]];
                    for (const [ct, pn] of coverMap) {
                      const cover = (coverImages as any)[ct];
                      if (cover?.imageVersions?.length > 1) pageNumbers.push(pn);
                    }
                  }
                  if (pageNumbers.length === 0) return;
                  try {
                    const result = await storyService.pickBestVersions(storyId!, pageNumbers);
                    const switched = Object.values(result.results).filter((r: any) => r.switched).length;
                    if (onRefreshStory) await onRefreshStory();
                    alert(`${switched}/${pageNumbers.length} pages switched to better version`);
                  } catch (err) {
                    console.error('Pick-best failed:', err);
                  }
                }}
                disabled={disableForFinalSteps || sceneImages.filter(img => img.imageVersions && img.imageVersions.length > 1).length === 0}
                className="flex items-center gap-2 px-3 py-1.5 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
              >
                <Trophy className="w-3.5 h-3.5" />
                Pick Best ({sceneImages.filter(img => img.imageVersions && img.imageVersions.length > 1).length} pages)
              </button>
            </div>
          </div>

        </div>
      )}
    </div>
    {gridLightbox && (
      gridLightbox.startsWith('COMPARE:') ? (
        // Side-by-side comparison lightbox
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setGridLightbox(null)}>
          <div className="max-w-[95vw] max-h-[95vh] grid grid-cols-2 gap-2" onClick={e => e.stopPropagation()}>
            {(() => {
              const [before, after] = gridLightbox.replace('COMPARE:', '').split('|||');
              return (
                <>
                  <div className="relative">
                    <img src={before} alt="Before" className="max-h-[90vh] w-auto object-contain rounded" />
                    <span className="absolute top-2 left-2 text-sm bg-red-600 text-white px-3 py-1 rounded font-semibold shadow">Before</span>
                  </div>
                  <div className="relative">
                    <img src={after} alt="After" className="max-h-[90vh] w-auto object-contain rounded" />
                    <span className="absolute top-2 left-2 text-sm bg-green-600 text-white px-3 py-1 rounded font-semibold shadow">After</span>
                  </div>
                </>
              );
            })()}
          </div>
          <button onClick={() => setGridLightbox(null)} className="absolute top-4 right-4 text-white text-3xl hover:text-gray-300">&times;</button>
        </div>
      ) : (
        <ImageLightbox
          src={gridLightbox}
          alt="Consistency Grid"
          onClose={() => setGridLightbox(null)}
        />
      )
    )}
    </>
  );
}

export default RepairWorkflowPanel;

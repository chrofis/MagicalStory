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
  Grid,
  XCircle,
  Play,
  SkipForward,
} from 'lucide-react';
import { useRepairWorkflow } from '@/hooks/useRepairWorkflow';
import type { SceneImage, FinalChecksReport, RepairWorkflowStep, StepStatus, PageFeedback } from '@/types/story';
import type { Character } from '@/types/character';

interface RepairWorkflowPanelProps {
  storyId: string | null;
  sceneImages: SceneImage[];
  characters: Character[];
  finalChecksReport?: FinalChecksReport | null;
  imageModel?: string;
  onImageUpdate?: (pageNumber: number, imageData: string, versionIndex: number) => void;
  onRefreshStory?: () => Promise<void>;
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
  const totalIssues = feedback.fixableIssues.length + feedback.entityIssues.length;
  const hasIssues = totalIssues > 0 || (feedback.qualityScore !== undefined && feedback.qualityScore < 7);

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
              feedback.qualityScore >= 8 ? 'bg-green-100 text-green-700' :
              feedback.qualityScore >= 6 ? 'bg-yellow-100 text-yellow-700' :
              'bg-red-100 text-red-700'
            }`}>
              Score: {feedback.qualityScore}
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
          {feedback.fixableIssues.length > 0 && (
            <div>
              <h5 className="text-xs font-medium text-gray-600 mb-1">Quality Issues:</h5>
              <ul className="text-xs text-gray-600 space-y-1">
                {feedback.fixableIssues.map((issue, i) => (
                  <li key={i} className="flex items-start gap-1">
                    <span className={`px-1 rounded ${
                      issue.severity === 'critical' ? 'bg-red-100 text-red-700' :
                      issue.severity === 'major' ? 'bg-orange-100 text-orange-700' :
                      'bg-yellow-100 text-yellow-700'
                    }`}>{issue.severity}</span>
                    <span>{issue.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {feedback.entityIssues.length > 0 && (
            <div>
              <h5 className="text-xs font-medium text-gray-600 mb-1">Entity Issues:</h5>
              <ul className="text-xs text-gray-600 space-y-1">
                {feedback.entityIssues.map((issue, i) => (
                  <li key={i} className="flex items-start gap-1">
                    <span className="px-1 rounded bg-purple-100 text-purple-700">{issue.character}</span>
                    <span>{issue.issue}</span>
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

export function RepairWorkflowPanel({
  storyId,
  sceneImages,
  characters,
  finalChecksReport,
  imageModel,
  onImageUpdate,
  onRefreshStory,
}: RepairWorkflowPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [expandedSteps, setExpandedSteps] = useState<Set<RepairWorkflowStep>>(new Set(['collect-feedback']));

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
    getStepNumber,
    getCharactersWithIssues,
  } = useRepairWorkflow({
    storyId,
    sceneImages,
    characters,
    finalChecksReport,
    imageModel,
    onImageUpdate,
  });

  // Selected character for repair
  const [selectedCharacter, setSelectedCharacter] = useState<string>('');
  const [selectedCharacterPages, setSelectedCharacterPages] = useState<number[]>([]);

  // Selected pages for artifact repair
  const [selectedArtifactPages, setSelectedArtifactPages] = useState<number[]>([]);

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

  // Get pages with artifact issues
  const pagesWithArtifacts = useMemo(() => {
    return Object.entries(workflowState.collectedFeedback.pages)
      .filter(([_, fb]) => fb.fixableIssues.some(i => i.type === 'artifact' || i.type === 'distortion'))
      .map(([page]) => parseInt(page));
  }, [workflowState.collectedFeedback.pages]);

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

                {Object.keys(workflowState.collectedFeedback.pages).length > 0 && (
                  <div className="space-y-2 max-h-96 overflow-y-auto">
                    {Object.values(workflowState.collectedFeedback.pages)
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
                )}
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

                <button
                  onClick={redoMarkedPages}
                  disabled={isRunning || workflowState.redoPages.pageNumbers.length === 0}
                  className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
                >
                  <Play className="w-4 h-4" />
                  Redo {workflowState.redoPages.pageNumbers.length} Pages
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
                    <div className="flex flex-wrap gap-2">
                      {workflowState.redoResults.pagesCompleted.map(page => (
                        <span key={page} className="px-2 py-1 bg-green-100 text-green-700 text-xs rounded">
                          Page {page} (v{workflowState.redoResults.newVersions[page] ?? '?'})
                        </span>
                      ))}
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
                        const displayScore = result.rawScore ?? Math.round(result.qualityScore / 10);
                        const scoreClass = displayScore >= 7 ? 'text-green-600' : displayScore >= 5 ? 'text-amber-600' : 'text-red-600';
                        return (
                          <div key={page} className="p-2 bg-gray-50 rounded border text-sm space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">Page {page}:</span>
                              <span className={scoreClass}>
                                {displayScore}/10
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
                              <p className="text-xs text-gray-600 pl-2 border-l-2 border-gray-300">
                                {result.issuesSummary}
                              </p>
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
                          {!charResult.byClothing && charResult.issues && charResult.issues.length > 0 && (
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
                    <label className="text-sm font-medium">Select Pages to Repair:</label>
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

                <button
                  onClick={async () => {
                    await repairCharacter(selectedCharacter, selectedCharacterPages);
                    if (onRefreshStory) {
                      await onRefreshStory();
                    }
                  }}
                  disabled={isRunning || !selectedCharacter || selectedCharacterPages.length === 0}
                  className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
                >
                  <Wrench className="w-4 h-4" />
                  Repair {selectedCharacter || 'Character'} on {selectedCharacterPages.length} pages
                </button>

                {Object.keys(workflowState.characterRepairResults.pagesRepaired).length > 0 && (
                  <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                    <h5 className="text-sm font-medium text-green-800 mb-2">Repair Results:</h5>
                    {Object.entries(workflowState.characterRepairResults.pagesRepaired).map(([char, pages]) => (
                      <div key={char} className="text-sm">
                        <span className="font-medium">{char}:</span>{' '}
                        <span className="text-gray-600">Pages {pages.join(', ')}</span>
                      </div>
                    ))}
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
                  <label className="text-sm font-medium">Select Pages for Grid Repair:</label>
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
        </div>
      )}
    </div>
  );
}

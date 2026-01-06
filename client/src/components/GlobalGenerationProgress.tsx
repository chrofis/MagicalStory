import { useNavigate } from 'react-router-dom';
import { useGenerationOptional } from '@/context/GenerationContext';

/**
 * Global progress bar for story generation
 * Shows at top of screen when a story is being generated
 * Allows users to navigate away and still see progress
 */
export function GlobalGenerationProgress() {
  const generation = useGenerationOptional();
  const navigate = useNavigate();

  // Don't render if no context or no active job
  if (!generation || !generation.activeJob) {
    return null;
  }

  const { progress, activeJob, isComplete, error } = generation;
  const percentage = Math.round((progress.current / progress.total) * 100);

  const handleClick = () => {
    // Navigate to wizard to see full progress
    navigate('/wizard');
  };

  // Don't show if complete (badge will show instead)
  if (isComplete) {
    return null;
  }

  // Error state
  if (error) {
    return (
      <div
        className="fixed top-0 left-0 right-0 z-50 cursor-pointer"
        onClick={handleClick}
        title={`Error: ${error}. Click to view details.`}
      >
        <div className="h-1 bg-red-500 w-full" />
        <div className="absolute top-1 left-1/2 -translate-x-1/2 bg-red-600 text-white text-xs px-3 py-1 rounded-b shadow-lg">
          Generation failed - click to view
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 cursor-pointer group"
      onClick={handleClick}
      title={`${activeJob.storyTitle} - ${percentage}% complete. Click to view.`}
    >
      {/* Progress bar background */}
      <div className="h-1 bg-gray-200 dark:bg-gray-700">
        {/* Animated progress fill */}
        <div
          className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 transition-all duration-500 ease-out relative overflow-hidden"
          style={{ width: `${percentage}%` }}
        >
          {/* Shimmer effect */}
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
        </div>
      </div>

      {/* Tooltip on hover */}
      <div className="absolute top-1 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-xs px-3 py-1.5 rounded shadow-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
        <span className="font-medium">{activeJob.storyTitle}</span>
        <span className="mx-2 text-gray-400">•</span>
        <span>{percentage}%</span>
        {progress.message && (
          <>
            <span className="mx-2 text-gray-400">•</span>
            <span className="text-gray-300">{progress.message}</span>
          </>
        )}
      </div>
    </div>
  );
}

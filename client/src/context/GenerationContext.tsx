import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { storyService } from '@/services';
import storage from '@/services/storage';
import logger from '@/services/logger';
import { useAuth } from '@/context/AuthContext';

// Storage key for persisting active job
const ACTIVE_JOB_KEY = 'active_story_job';

interface ActiveJob {
  jobId: string;
  startedAt: number;
  storyTitle: string;
}

interface GenerationProgress {
  current: number;
  total: number;
  message: string;
}

interface GenerationState {
  activeJob: ActiveJob | null;
  progress: GenerationProgress;
  isComplete: boolean;
  completedStoryId: string | null;
  hasUnviewedCompletion: boolean;
  error: string | null;
}

interface GenerationContextType extends GenerationState {
  startTracking: (jobId: string, storyTitle: string) => void;
  stopTracking: () => void;
  markCompletionViewed: () => void;
  clearError: () => void;
}

const GenerationContext = createContext<GenerationContextType | null>(null);

// Poll interval in milliseconds
const POLL_INTERVAL = 3000;

export function GenerationProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null);
  const [progress, setProgress] = useState<GenerationProgress>({ current: 0, total: 100, message: '' });
  const [isComplete, setIsComplete] = useState(false);
  const [completedStoryId, setCompletedStoryId] = useState<string | null>(null);
  const [hasUnviewedCompletion, setHasUnviewedCompletion] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const isPollingRef = useRef(false);
  const lastUserIdRef = useRef<string | null>(null);

  // Load active job from localStorage on mount
  useEffect(() => {
    const stored = storage.getItem(ACTIVE_JOB_KEY);
    if (stored) {
      try {
        const job = JSON.parse(stored) as ActiveJob;
        // Check if job is not too old (max 30 minutes)
        const maxAge = 30 * 60 * 1000;
        if (Date.now() - job.startedAt < maxAge) {
          logger.info('[GenerationContext] Restoring active job from storage:', job.jobId);
          setActiveJob(job);
        } else {
          logger.info('[GenerationContext] Stored job too old, clearing');
          storage.removeItem(ACTIVE_JOB_KEY);
        }
      } catch {
        storage.removeItem(ACTIVE_JOB_KEY);
      }
    }
  }, []);

  // Fetch active jobs from server when user changes (e.g., impersonation)
  useEffect(() => {
    const currentUserId = user?.id || null;

    // Skip if user hasn't changed
    if (currentUserId === lastUserIdRef.current) {
      return;
    }

    // User changed - clear any existing job from localStorage (it belongs to old user)
    if (lastUserIdRef.current !== null) {
      logger.info('[GenerationContext] User changed, clearing local job state');
      setActiveJob(null);
      setIsComplete(false);
      setCompletedStoryId(null);
      setError(null);
      storage.removeItem(ACTIVE_JOB_KEY);
    }

    lastUserIdRef.current = currentUserId;

    // Fetch active jobs from server for new user
    if (currentUserId) {
      logger.info('[GenerationContext] Fetching active jobs for user:', currentUserId);
      storyService.getActiveJobs()
        .then(jobs => {
          if (jobs.length > 0) {
            // Take the most recent active job
            const job = jobs[0];
            logger.info('[GenerationContext] Found active job from server:', job.id);
            const restoredJob: ActiveJob = {
              jobId: job.id,
              startedAt: new Date(job.created_at).getTime(),
              storyTitle: '', // Will be populated when polling
            };
            setActiveJob(restoredJob);
            setProgress({
              current: job.progress || 0,
              total: 100,
              message: job.progress_message || '',
            });
            // Store in localStorage for consistency
            storage.setItem(ACTIVE_JOB_KEY, JSON.stringify(restoredJob));
          } else {
            logger.info('[GenerationContext] No active jobs found for user');
          }
        })
        .catch(err => {
          logger.error('[GenerationContext] Failed to fetch active jobs:', err);
        });
    }
  }, [user?.id]);

  // Poll job status when we have an active job
  const pollJobStatus = useCallback(async (jobId: string) => {
    if (isPollingRef.current) return;
    isPollingRef.current = true;

    try {
      const status = await storyService.getJobStatus(jobId);

      // Update progress (with backwards guard - never show lower progress)
      if (status.progress) {
        setProgress(prev => {
          if (status.progress!.current >= prev.current) {
            return {
              current: status.progress!.current,
              total: status.progress!.total,
              message: status.progress!.message
            };
          }
          // Keep current progress but update message
          return { ...prev, message: status.progress!.message };
        });
      }

      // Check for completion
      if (status.status === 'completed' && status.result) {
        logger.success('[GenerationContext] Job completed:', jobId, 'storyId:', status.result.storyId);
        logger.debug('[GenerationContext] Result object:', JSON.stringify(status.result).substring(0, 200));
        setIsComplete(true);
        setCompletedStoryId(status.result.storyId);
        setHasUnviewedCompletion(true);
        setProgress({ current: 100, total: 100, message: 'Complete!' });

        // Clear from storage
        storage.removeItem(ACTIVE_JOB_KEY);

        // Stop polling
        if (pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      } else if (status.status === 'failed') {
        logger.error('[GenerationContext] Job failed:', status.error);
        setError(status.error || 'Generation failed');
        setActiveJob(null);
        storage.removeItem(ACTIVE_JOB_KEY);

        if (pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      }
    } catch (err) {
      logger.error('[GenerationContext] Polling error:', err);
      // Don't stop polling on transient errors
    } finally {
      isPollingRef.current = false;
    }
  }, []);

  // Start/stop polling based on activeJob
  useEffect(() => {
    if (activeJob && !isComplete) {
      logger.info('[GenerationContext] Starting polling for job:', activeJob.jobId);

      // Poll immediately
      pollJobStatus(activeJob.jobId);

      // Then poll at interval
      pollingRef.current = setInterval(() => {
        pollJobStatus(activeJob.jobId);
      }, POLL_INTERVAL);
    }

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [activeJob, isComplete, pollJobStatus]);

  // Listen for storage changes (cross-tab sync)
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === ACTIVE_JOB_KEY) {
        if (e.newValue) {
          try {
            const job = JSON.parse(e.newValue) as ActiveJob;
            setActiveJob(job);
            setIsComplete(false);
            setCompletedStoryId(null);
            setError(null);
          } catch {
            // Invalid data
          }
        } else {
          // Job cleared in another tab
          setActiveJob(null);
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  const startTracking = useCallback((jobId: string, storyTitle: string) => {
    const job: ActiveJob = {
      jobId,
      startedAt: Date.now(),
      storyTitle
    };

    logger.info('[GenerationContext] Starting to track job:', jobId);

    // Persist to storage
    storage.setItem(ACTIVE_JOB_KEY, JSON.stringify(job));

    // Update state
    setActiveJob(job);
    setIsComplete(false);
    setCompletedStoryId(null);
    setHasUnviewedCompletion(false);
    setError(null);
    setProgress({ current: 0, total: 100, message: 'Starting...' });
  }, []);

  const stopTracking = useCallback(() => {
    logger.info('[GenerationContext] Stopping tracking');

    // Clear polling
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }

    // Clear storage
    storage.removeItem(ACTIVE_JOB_KEY);

    // Reset state (but keep completion info for badge)
    setActiveJob(null);
  }, []);

  const markCompletionViewed = useCallback(() => {
    setHasUnviewedCompletion(false);
    setIsComplete(false);
    // Don't clear completedStoryId - navigation effect needs it
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return (
    <GenerationContext.Provider
      value={{
        activeJob,
        progress,
        isComplete,
        completedStoryId,
        hasUnviewedCompletion,
        error,
        startTracking,
        stopTracking,
        markCompletionViewed,
        clearError,
      }}
    >
      {children}
    </GenerationContext.Provider>
  );
}

export function useGeneration() {
  const context = useContext(GenerationContext);
  if (!context) {
    throw new Error('useGeneration must be used within a GenerationProvider');
  }
  return context;
}

// Optional hook that doesn't throw (for components that might be outside provider)
export function useGenerationOptional() {
  return useContext(GenerationContext);
}

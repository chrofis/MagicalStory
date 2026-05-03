import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { storyService } from '@/services';
import storage from '@/services/storage';
import logger from '@/services/logger';
import { useAuth } from '@/context/AuthContext';
import { isNavigationAbort } from '@/utils/fetchErrors';

// Storage key for persisting active job
const ACTIVE_JOB_KEY = 'active_story_job';

// Sanity cap on how old a stored job can be before we discard it without
// even asking the server. Long stories can take 30+ minutes (Sonnet streaming
// + image generation), so the cap must be generous. The backend is the real
// source of truth — we still call getJobStatus on whatever we restore.
const MAX_RESTORE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// If a job has been "processing" for more than this, treat it as orphaned —
// the server probably restarted while it was running and the row will never
// get marked completed. Silent cleanup, no error toast.
const ORPHANED_JOB_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes

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
  completedShareToken: string | null;
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
  // Load active job synchronously from localStorage so it's available on first render.
  // We restore anything younger than MAX_RESTORE_AGE_MS — the polling effect below will
  // immediately ask the server for the real status and react accordingly:
  //   - completed → set completedStoryId, navigate
  //   - failed    → clear state (silent if abandoned, error toast otherwise)
  //   - processing & age > ORPHANED_JOB_THRESHOLD_MS → silent cleanup (server restart)
  //   - processing & age < ORPHANED_JOB_THRESHOLD_MS → resume polling normally
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(() => {
    const stored = storage.getItem(ACTIVE_JOB_KEY);
    if (stored) {
      try {
        const job = JSON.parse(stored) as ActiveJob;
        if (Date.now() - job.startedAt < MAX_RESTORE_AGE_MS) {
          logger.info('[GenerationContext] Restoring active job from storage:', job.jobId);
          return job;
        }
        logger.info('[GenerationContext] Stored job exceeds 24h age cap, clearing');
        storage.removeItem(ACTIVE_JOB_KEY);
      } catch {
        storage.removeItem(ACTIVE_JOB_KEY);
      }
    }
    return null;
  });
  const [progress, setProgress] = useState<GenerationProgress>({ current: 0, total: 100, message: '' });
  const [isComplete, setIsComplete] = useState(false);
  const [completedStoryId, setCompletedStoryId] = useState<string | null>(null);
  const [completedShareToken, setCompletedShareToken] = useState<string | null>(null);
  const [hasUnviewedCompletion, setHasUnviewedCompletion] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const isPollingRef = useRef(false);
  const lastUserIdRef = useRef<string | null>(null);

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
      setCompletedShareToken(null);
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
          // Navigation-cancelled fetches (e.g. trial → /stories redirect)
          // surface here as AbortError / "Failed to fetch" — expected, not
          // a bug. Real errors still log at error level.
          if (isNavigationAbort(err)) {
            logger.debug('[GenerationContext] Active-jobs fetch aborted (navigation):', err);
          } else {
            logger.error('[GenerationContext] Failed to fetch active jobs:', err);
          }
        });
    }
  }, [user?.id]);

  // Helper: stop polling and clear local state. Used by every terminal-state branch.
  const cleanupAfterTerminalState = useCallback(() => {
    setActiveJob(null);
    storage.removeItem(ACTIVE_JOB_KEY);
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  // Poll job status when we have an active job. Caller passes the job's
  // startedAt timestamp so we can detect orphaned jobs (server restart left
  // a row in 'processing' that will never advance).
  const pollJobStatus = useCallback(async (jobId: string, startedAt: number) => {
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
        // Order matters: set completion fields BEFORE clearing activeJob so StoryWizard's
        // auto-nav effect sees both `generationComplete && completedStoryId` and the
        // `step === 6` it inherited from the active job. After this re-render the
        // polling effect's `!isComplete` guard prevents re-polling, and
        // markCompletionViewed (which clears isComplete) won't restart polling
        // because activeJob is now null.
        setIsComplete(true);
        setCompletedStoryId(status.result.storyId);
        setCompletedShareToken(status.result.shareToken || null);
        setHasUnviewedCompletion(true);
        setProgress({ current: 100, total: 100, message: 'Complete!' });
        cleanupAfterTerminalState();
      } else if (status.status === 'failed') {
        const errorMsg = status.error || 'Generation failed';

        // Server-side cleanup of abandoned jobs is silent (no error toast).
        const isAbandoned = errorMsg.toLowerCase().includes('abandoned')
          || errorMsg.toLowerCase().includes('stopped responding');
        if (isAbandoned) {
          logger.info('[GenerationContext] Job cleaned up by server (abandoned/stale):', errorMsg);
        } else {
          logger.error('[GenerationContext] Job failed:', errorMsg);
          setError(errorMsg);
        }
        cleanupAfterTerminalState();
      } else if (status.status === 'processing' || status.status === 'pending') {
        // Orphan check: if a job has been processing for > ORPHANED_JOB_THRESHOLD_MS
        // and is still not done, the worker probably died (server restart). Server
        // will eventually mark it as failed, but we don't need to wait — silently
        // clean up local state so the user isn't stuck on a stale spinner.
        const jobAge = Date.now() - startedAt;
        if (jobAge > ORPHANED_JOB_THRESHOLD_MS) {
          logger.warn(`[GenerationContext] Job ${jobId} still ${status.status} after ${Math.round(jobAge / 60000)} min — treating as orphaned`);
          cleanupAfterTerminalState();
        }
      }
    } catch (err) {
      // 404 means the row was deleted server-side (e.g. by the cleanup job for
      // very old abandoned jobs). Silent cleanup, no error toast.
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('HTTP 404') || errMsg.toLowerCase().includes('not found')) {
        logger.info('[GenerationContext] Job no longer exists on server, cleaning up:', jobId);
        cleanupAfterTerminalState();
      } else {
        // Transient error (network, 5xx) — keep polling, don't toast.
        logger.warn('[GenerationContext] Transient polling error:', errMsg);
      }
    } finally {
      isPollingRef.current = false;
    }
  }, [cleanupAfterTerminalState]);

  // Start/stop polling based on activeJob
  useEffect(() => {
    if (activeJob && !isComplete) {
      logger.info('[GenerationContext] Starting polling for job:', activeJob.jobId);
      const { jobId, startedAt } = activeJob;

      // Poll immediately
      pollJobStatus(jobId, startedAt);

      // Then poll at interval
      pollingRef.current = setInterval(() => {
        pollJobStatus(jobId, startedAt);
      }, POLL_INTERVAL);
    }

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [activeJob, isComplete, pollJobStatus]);

  // Poll immediately when user returns to app (phone wakes up, tab refocused)
  // Prevents stale "generating 18%" state from showing after a deploy killed the job
  useEffect(() => {
    if (!activeJob || isComplete) return;
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && activeJob) {
        logger.info('[GenerationContext] App visible again, polling job immediately');
        pollJobStatus(activeJob.jobId, activeJob.startedAt);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
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
            setCompletedShareToken(null);
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
    setCompletedShareToken(null);
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
        completedShareToken,
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

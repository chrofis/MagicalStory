// What one job-status poll means for the global generation tracker.
//
// The SERVER decides when a job is dead: its status route marks a job `failed`
// once the heartbeat has been silent for 10 minutes (or past the 180-minute
// runaway backstop), and the cleanup job deletes very old rows (404). The
// client only reacts to that status. It used to also drop any job still
// `processing` after 60 minutes as "orphaned" — but production stories run
// 52-83 minutes, so readers who left the wizard (as the wait screen tells them
// to) silently lost the nav %, the My Stories card and the auto-open on
// completion (tasks/bugs.json generation-tracking-dropped-after-60-min).
//
//   completed            → 'completed'
//   failed / cancelled   → 'ended-silent' (user cancel, server-detected stall
//                          or abandonment) or 'ended-error' (a real failure)
//   anything else        → 'running' (keep polling, whatever the job's age)
export type JobStatusOutcome = 'completed' | 'ended-silent' | 'ended-error' | 'running';

export function jobStatusOutcome(status: { status: string; error?: string | null; hasResult?: boolean }): JobStatusOutcome {
  if (status.status === 'completed' && status.hasResult) return 'completed';
  if (status.status === 'failed' || status.status === 'cancelled') {
    if (status.status === 'cancelled') return 'ended-silent';
    const msg = (status.error || '').toLowerCase();
    return msg.includes('abandoned') || msg.includes('stopped responding') ? 'ended-silent' : 'ended-error';
  }
  return 'running';
}

# Resume Story Generation from Checkpoints

**Status:** Planned
**Priority:** Medium
**Created:** 2026-01-18

## Problem

When the server restarts during story generation:
1. Jobs are left in `processing` status
2. After 30 min timeout, they're marked `failed`
3. User must regenerate entire story from scratch
4. If a story crashes the server, it could cause infinite restart loops

## Solution

Add automatic resume from checkpoints on server startup, with single-retry protection.

## Database Changes

**Add to `story_jobs` table:**
```sql
ALTER TABLE story_jobs ADD COLUMN retry_count INT DEFAULT 0;
```

- `retry_count = 0`: First attempt (normal)
- `retry_count = 1`: Server restarted, resumed once
- `retry_count >= 2`: Do NOT resume (mark as failed)

## Implementation

### 1. Server Startup Hook

**File:** `server.js` (after database init, before routes)

```javascript
async function resumeInterruptedJobs() {
  // Find jobs that were processing when server died
  const staleJobs = await pool.query(`
    SELECT id, retry_count, created_at
    FROM story_jobs
    WHERE status = 'processing'
    AND updated_at < NOW() - INTERVAL '2 minutes'
  `);

  for (const job of staleJobs.rows) {
    if (job.retry_count >= 1) {
      // Already retried once - mark as permanently failed
      await pool.query(`
        UPDATE story_jobs
        SET status = 'failed',
            error_message = 'Job failed after server restart retry. Manual intervention required.',
            updated_at = NOW()
        WHERE id = $1
      `, [job.id]);
      log.warn(`[RESUME] Job ${job.id} exceeded retry limit - marked as failed`);
    } else {
      // Increment retry count and resume
      await pool.query(`
        UPDATE story_jobs
        SET retry_count = retry_count + 1,
            progress_message = 'Resuming after server restart...',
            updated_at = NOW()
        WHERE id = $1
      `, [job.id]);
      log.info(`[RESUME] Resuming interrupted job ${job.id}`);

      // Resume asynchronously
      processStoryJob(job.id).catch(err => {
        log.error(`[RESUME] Failed to resume job ${job.id}:`, err.message);
      });
    }
  }
}

// Call after DB init
resumeInterruptedJobs();
```

### 2. Checkpoint-Aware Job Processing

**File:** `server.js` - Modify `processStoryJob()` and sub-functions

**A) Load existing checkpoints at job start:**
```javascript
async function processStoryJob(jobId) {
  // ... existing setup code ...

  // Check for existing checkpoints (resume scenario)
  const existingCheckpoints = await getAllCheckpoints(jobId);
  const checkpointMap = {};
  for (const cp of existingCheckpoints) {
    checkpointMap[`${cp.step_name}_${cp.step_index}`] = cp.step_data;
  }

  const isResume = existingCheckpoints.length > 0;
  if (isResume) {
    log.info(`[RESUME] Job ${jobId} has ${existingCheckpoints.length} checkpoints - resuming`);
  }

  // Pass checkpointMap to processing functions
  // ...
}
```

**B) Skip completed steps in UNIFIED mode:**
```javascript
// In processUnifiedStoryJob():

// 1. Check for outline checkpoint
const outlineCheckpoint = checkpointMap['outline_0'];
if (outlineCheckpoint) {
  log.info(`[RESUME] Using cached outline`);
  storyOutline = outlineCheckpoint.outline;
  // Skip outline generation
} else {
  // Generate outline normally
  storyOutline = await generateOutline(...);
  await saveCheckpoint(jobId, 'outline', { outline: storyOutline, ... });
}

// 2. Check for story_text checkpoint
const textCheckpoint = checkpointMap['story_text_0'];
if (textCheckpoint) {
  log.info(`[RESUME] Using cached story text`);
  fullStoryText = textCheckpoint.text;
  parsedPages = textCheckpoint.pages;
} else {
  // Generate story text normally
}

// 3. Check for partial_page checkpoints
const completedPages = new Set();
for (const key of Object.keys(checkpointMap)) {
  if (key.startsWith('partial_page_')) {
    const pageNum = parseInt(key.split('_')[2]);
    completedPages.add(pageNum);
  }
}

// Skip image generation for completed pages
for (const page of pages) {
  if (completedPages.has(page.pageNumber)) {
    log.info(`[RESUME] Skipping page ${page.pageNumber} - already generated`);
    continue;
  }
  // Generate image normally
}
```

**C) Skip completed covers:**
```javascript
const completedCovers = new Set();
for (const key of Object.keys(checkpointMap)) {
  if (key.startsWith('partial_cover_')) {
    completedCovers.add(key.split('_')[2]); // 'front', 'back', etc.
  }
}

if (!completedCovers.has('front')) {
  // Generate front cover
}
// ... etc
```

### 3. Update Stale Job Timeout

**File:** `server.js` - Modify stale job check (~line 12171)

```javascript
// When checking for stale jobs, consider retry_count
if (job.status === 'processing' && isStale) {
  if (job.retry_count >= 1) {
    // Already retried - this is a permanent failure
    await markJobFailed(jobId, 'Job timed out after retry attempt');
  } else {
    // First timeout - will be resumed on next server start
    // Don't mark as failed yet
  }
}
```

## Files to Modify

1. **`server.js`**
   - Add `resumeInterruptedJobs()` function after DB init
   - Add `retry_count` column in table creation SQL
   - Modify `processStoryJob()` to accept/use checkpoint map
   - Modify `processUnifiedStoryJob()` to skip checkpointed steps
   - Modify `processStorybookJob()` similarly
   - Update stale job timeout logic

2. **Database migration** (or inline ALTER TABLE)
   - Add `retry_count INT DEFAULT 0` column

## Edge Cases

1. **Job crashes server repeatedly** → retry_count hits 2, marked as permanently failed
2. **Job partially complete** → Resumes from last checkpoint, regenerates remaining
3. **Checkpoints missing** → Falls back to full regeneration (existing behavior)
4. **Multiple server restarts quickly** → 2-minute staleness check prevents immediate re-resume

## Verification

1. Start a story generation
2. Kill the server mid-generation (after some pages complete)
3. Restart server
4. Verify job resumes and completes using existing checkpoints
5. Kill server again mid-generation
6. Restart server
7. Verify job is marked as failed (retry_count exceeded)
8. Check that completed pages are preserved in final result

## Not In Scope

- Resuming in-memory state (token tracking, avatar logs) - will be incomplete for resumed jobs
- Resuming streaming/SSE connections - client must reconnect and poll
- Partial page image regeneration - either page is complete or regenerated

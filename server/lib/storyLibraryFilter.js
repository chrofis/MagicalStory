/**
 * SQL fragment for GET /api/stories: which story rows the customer's library must NOT list.
 * See docs/decisions.md 2026-11-10 "Empty rows of cancelled/failed jobs are hidden by the library query".
 *
 * ensureStoryRow creates a stories row (data = {}, metadata = {}) when a job starts. The job's own
 * status decides visibility (no flag on the row, which would go stale):
 *  - pending/processing: still generating, hide.
 *  - cancelled/failed AND metadata has no id: upsertStory never ran, so the row holds no story
 *    content, hide. (upsertStory always writes metadata.id; a failed job that saved a partial has it
 *    and stays visible on purpose.)
 * A story saved outside the job flow has no job row, so NOT EXISTS is true and it lists normally.
 */
const LIBRARY_HIDDEN_JOB_FILTER = ` AND NOT EXISTS (
        SELECT 1 FROM story_jobs j WHERE j.id = s.id AND (
          j.status IN ('pending', 'processing')
          OR (j.status IN ('cancelled', 'failed') AND s.metadata->>'id' IS NULL)
        )
      )`;

module.exports = { LIBRARY_HIDDEN_JOB_FILTER };

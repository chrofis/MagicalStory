-- Ad attribution that survives to the purchase: utm_term + gclid on trial_events.
--
-- WHY: the question "did this campaign produce buyers, or only trials?" was
-- unanswerable. trial_events already carries user_id (back-filled when the
-- anonymous account is created), so the join trial_events -> users -> orders
-- existed; what was missing was anything identifying the click.
--
-- Two separate faults, both found 2026-08-26:
--
--  1. captureAttribution() in client/src/utils/trialFunnel.ts only ran via
--     trackTrialStep(), which fires solely inside /try. The Search ads land on
--     the HOMEPAGE carrying the tags
--     (magicalstory.ch/?utm_source=google&utm_medium=search&utm_campaign=zurich),
--     so the visitor arrived tagged, navigated client-side to /try, and the
--     query string was gone before anything read it. Measured on production:
--     40 trial_events rows, 7 visits, 24 with user_id, and 0 with a campaign.
--     Fixed by calling captureAttribution() at app mount (client/src/App.tsx).
--
--  2. Even once captured, utm_campaign is campaign-level only. Keyword-level
--     attribution needs utm_term (ValueTrack {keyword} in the ad's final URL),
--     and attributing a purchase that happens DAYS after the click — this
--     funnel's normal shape: trial completes in ~3 min, the paid story is
--     created in a later session, generation takes an hour, the buy decision
--     comes after that — needs the gclid, which is what Google Ads offline
--     conversion import keys on. Account-level auto-tagging is already ON, so
--     every paid click carries a gclid; nothing was reading it.
--
-- Both columns are nullable: organic visits legitimately have neither, and the
-- funnel must keep recording steps for visitors who arrive untagged.
--
-- gclid is generously sized (VARCHAR 200) — the wrapped GCLID/GBRAID/WBRAID
-- forms are long and get longer; truncating one silently breaks the offline
-- import that is the entire point of storing it.

ALTER TABLE trial_events ADD COLUMN IF NOT EXISTS utm_term VARCHAR(120);
ALTER TABLE trial_events ADD COLUMN IF NOT EXISTS gclid    VARCHAR(200);

-- Partial index: the attribution readout always filters to the paid rows, and
-- these are a small minority of the table.
CREATE INDEX IF NOT EXISTS idx_trial_events_gclid
  ON trial_events (gclid) WHERE gclid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trial_events_campaign
  ON trial_events (utm_campaign) WHERE utm_campaign IS NOT NULL;

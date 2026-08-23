-- 026: cover naming unification (2026-08-23). coverHints was keyed by the
-- outline's hint vocabulary — the FRONT cover lived under 'titlePage' while
-- every other subsystem calls it 'frontCover'. The parser now translates at
-- its boundary and writes coverHints.frontCover; this migration renames the
-- key in every stored story so readers need no translator (coverKeys.js
-- COVER_HINT_KEY / coverKeyToHintKey were retired in the same commit).
-- Data-only; idempotent (the WHERE clause skips already-renamed rows).
UPDATE stories
SET data = jsonb_set(
             data #- '{coverHints,titlePage}',
             '{coverHints,frontCover}',
             data->'coverHints'->'titlePage'
           )
WHERE data->'coverHints' ? 'titlePage'
  AND NOT (data->'coverHints' ? 'frontCover');

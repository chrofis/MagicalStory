# Own story box: earlier and deeper checks (owner, 2026-11-01)

## Owner's request (verbatim intent)
1. The Jev check only starts once the two idea cards have finished generating. It should run while the parent types, from the start.
2. The five parts (WHO, WHERE, PROBLEM, WANT, ENDING) stay as the top level, but two thin lines can satisfy all five. Each part needs a depth check:
   - WHERE: a known real place ("London") is enough. An invented place ("Fantasytown") must be described: what kind of world it is, and WHEN it is (past, today, future).
   - PROBLEM ("Was geht schief"): one event is not enough for a 15-page book; ask for a second event / complication.
   - WHO: ask for more detailed traits of the main character.

## Current state (read 2026-11-01)
- prompts/jev-own-story.txt v2: one yes/no proposition per part, plus UNSUITABLE and TOO_MANY_EVENTS.
- client/src/utils/ownStoryCheck.ts: 5 s debounce, min 40 chars; OwnStoryCard is rendered next to the idea cards (WizardStep6Summary.tsx:646). Why the check waits for the idea cards is NOT yet found: no client gate seen; check the browser's request queue (the two idea SSE streams) and the server Jev concurrency before changing anything.

## Plan
- [x] Reproduce the wait: NOT reproduced. Mock spec with a 20 s idea stream fires the check at 5 s (test added); staging answered analyze-own-story in 0.26 s at +2/+6/+12/+20 s of a live idea stream. Ruled out: client gate, remount, server lock, limiter, connection limit (one HTTP/2 SSE stream).
- [x] Depth propositions in jev-own-story.txt (generic wording), each feeding a fixed translated tip; PROBLEM depth scaled to the page count.
- [x] Replay the new propositions on a set of >=20 stored/written premises (thin and rich, real and invented places) and report hit rates.
- [x] Unit tests (parser, tip choice), verify.json entry, decisions.md entry.

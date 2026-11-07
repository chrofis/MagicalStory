# Janna's three books — every issue found, and how the next story avoids it (2026-11-07)

Books (prod user 025579e7…): Einhorn `job_1793893086454_ao77wh9j5`, Rubi `job_1793959308869_fre2mb4d0`,
Laternen `job_1793964466256_1tmyzh1do`. Fix log: `tasks/customer-height-edits-2026-11-06.md`.

Status words: **LIVE** = in production for every story · **BUILT** = committed locally, tested on stored
data, not pushed · **IN WORK** · **OPEN** = nothing prevents it yet.

## A. Story / plot

| # | Issue (book) | Fixed for her? | Prevention for the next story | Status |
|---|---|---|---|---|
| A1 | The obstacle is removed by a friend, not by the hero's climax act. Rubi: Melisa unties her own cord. Laternen: Melodi stops the parade and Melisa's lantern guides Janna in. | Rubi: rewritten + 3 new pictures. Laternen: not yet. | New plot-check rule "an obstacle the hero's climax does not remove is a major fault", one shared rule for writer and critics. First free test on 44 stored plots: catches Rubi (no check caught it before), but flagged 7 of 38 "good" plots, and Laternen and Einhorn are among those 7, so some of the "false" flags are real. The narrowed version is being tested now. | IN WORK (`cc694a080`) |
| A2 | The trap makes no sense. Rubi: tying a cord to catch a "pony" that could jump it; "why not just untie it". | Rubi rewritten (no trap). | Same rule as A1 (an obstacle open to an easy fix is a fault). | IN WORK |
| A3 | Who knows what, and when, is inconsistent. Einhorn: when do they find out it is a unicorn? (my own rewrite made it worse). Laternen: the friends walk beside a unicorn and never react. | Einhorn: fixed and live. Laternen: not yet. | A lesson for manual rewrites (write the who-knows-what-when table first). Nothing in the pipeline checks it. | OPEN (BACKLOG line) |
| A4 | The stakes are never explained. Laternen: why does the ring matter, what happens if it closes without Janna? Why does the unicorn come, and why does she send it away? Einhorn: why must the unicorn get home through the fog? | Einhorn: text added. Laternen: not yet. | The plot logic has a "want / opposition / chain" spec, but no check asks "is the price of failing stated on the page?" | OPEN |
| A5 | A page that only moves people around (Einhorn p9). | Einhorn p9 rewritten and redrawn. | None. | OPEN (BACKLOG line) |
| A6 | Rhyming text is hard for a first reader (Laternen). The customer chose the topic "rhyming words". | Kept the rhymes; made p4/p7/p8 clearer. | Not decided: rhyme as the learning topic plus the first-grade reading level. | OPEN, owner's call |

## B. Pictures

| # | Issue (book) | Fixed for her? | Prevention | Status |
|---|---|---|---|---|
| B1 | The four girls appear in the wrong height order. | Fixed on all pages. | The final book review checks height order (6 of 7 wrong test pictures caught). | LIVE (`9572f01f`) |
| B2 | A customer edit naming a child changed the wrong child. | — | The edit now names the child by her clothes and hair (9 of 9 right in a replay, 3 of 9 before). | LIVE |
| B3 | "Regenerate cover" failed with "no cover image". | Rubi cover redrawn. | Route fixed. | LIVE |
| B4 | The cover title sat on a strip with a hard seam (Rubi). | Redrawn. | None. | OPEN (BACKLOG line) |
| B5 | A redraw used the old scene plan or a different background (Einhorn p9: "iterate" redrew the old gate scene). | Redrawn through the Lab with the right scene. | A redraw now keeps the page's stored background. The book review says "background: keep" or "redo — what changes". Not covered: when the TEXT changes, the scene plan does not follow, so a customer text edit plus a redraw still draws the old scene. | BUILT (`0151f878c`); the text-follows-scene part is OPEN |
| B6 | A hidden feature is drawn too early. The horn shows before the reveal (Rubi p5: 2 of 2 redraws showed the horn; an edit then hid the whole face). | p5 drawn with a leaf-crown reference: horn hidden. | The visual bible gets a "hidden" and a "revealed" state with their own reference pictures. Today's p5 is the proof that the picture needs its own reference, not just words: 0 of 2 without it, 1 of 1 with it. | BUILT (`3ed0f6bae`; text replay 2 of 2 found, 0 false on 18) |
| B7 | The text names a place or thing no picture shows (Rubi: cliff, herd). This came from MY rewrite. | Rubi rewritten around the pictures. | Process rule: a text rewrite of a finished book is checked against its pictures. Not a pipeline check (owner rule: page text is not a checklist). | Lesson |
| B8 | The wrong girl stands at the story moment (Laternen p9: Melodi, in orange, stands where the text says Polina is). | Not yet. | The entity check should catch it; it did not. | OPEN, to investigate |
| B9 | Redrawn pages draw the creature in a slightly different style (Rubi as a rounder foal on new p4/p5/p7). | Accepted by the owner. | — | Noted |

## C. Tools / bugs found while fixing

| # | Issue | Status |
|---|---|---|
| C1 | A page edit saved its result over an existing Lab version (Rubi p5 v3) | Registered in `tasks/bugs.json` (`page-edit-overwrites-existing-version`), blocks the next push until fixed |
| C2 | The visual-bible parser fails when the model writes the code fence before the section marker (1 of 20 in the horn test; the JSON was fine) | OPEN, to add to BACKLOG |
| C3 | The research labels of "good" plots were wrong for Laternen and probably Einhorn, so the plot-rule test set needs relabelling by the owner's reading | IN WORK |

## Pattern

Most story faults (A1–A4) share one root. The plan states a want and an obstacle, but nothing checks
that the hero's own act resolves it, that everyone's knowledge follows the page order, or that the
cost of failing is said. The picture faults are mostly fixed or built. The story faults are where the
next book can still go wrong.

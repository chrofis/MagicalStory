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

## D. Where the plot breaks: idea → arc → beats → text (traced 2026-11-07, stored prod data)

| Stage | Einhorn | Rubi | Laternen |
|---|---|---|---|
| Idea (generated, customer picked) | Friends are the obstacle, each with a job: "Polina knotet ein Seil, Melisa hält es fest, Melodi geht voran" | Same pattern: "Melodi ruft, Polina schwingt ein Seil, Melisa spannt den Strick" (the customer swapped an apple for the rope) | The unicorn is the obstacle (it won't leave her coat), and the friends have jobs (Melodi leads, Melisa carries the lantern, Polina keeps the place) |
| Arc: creator | Keeps every friend's job and lets them finish the story: Melisa lifts the loop, Melodi opens the gate | Melisa ties the cord and unties it at the end, a cliff and brambles close the side ways, "rope too short" is invented | Melodi stops the row and Melisa lifts the lantern; the climax is shared out to the friends |
| Arc: panel (3 models) | 9+ MAJOR, e.g. "a child will ask why Silva does not just step back into the mist" | 7+ MAJOR, e.g. "rope and cord come from nowhere", "how does Janna know there is a herd" | 6+ MAJOR, e.g. "nothing stops Janna from taking off her coat" |
| Arc: rewrite (1 round) | Patches each hole with a new fact or prop and keeps "everything else"; the friends' endings are kept explicitly | Same: adds the herd and leaves hiding the horn; keeps "cord … untied cord" | Same: adds "cannot be shaken off or handed on"; keeps "the roles of Polina, Melodi and Melisa" |
| Arc: final self-critique | MINOR only, so no second round (1 configured) | MINOR only | MINOR only |
| World rules | 5, over the limit | 5, over the limit | 5, over the limit |
| Beats | Faithful to the arc. Adds an empty page (p6) and turns arc s9 into the logistics page p9 | Faithful (empty p2) | Faithful (empty p5). Keeps "the pairs will soon be fixed" |
| Text (~650–710 words / 10 pages) | Lost little | Kept all the machinery (bank, herd, gap) that the pictures don't show | Lost the stakes ("pairs fixed for the song") and the unicorn's reason ("alone in the cold leaves") |

Conclusion: the plot breaks at the ARC, seeded by the IDEA, and not mainly at the beats or the text.
1. The idea gives every friend an action against the hero. The arc keeps those actions and has the
   friends undo them at the end, so the hero's act is never what removes the obstacle.
2. The panel finds the holes, but the one-round rewrite fills each hole with a new rule or prop and
   keeps the structure. That is why all three end with world rules over the limit and a heavier plot,
   not a simpler one.
3. No panel lens asks "who removes the obstacle?" — the new rule (A1) is meant to cover that.
4. The text loses stakes and motives on short first-reader pages (Laternen). The beats lose almost nothing.

## E. Laternen redo with the new rules (2026-11-07, staging text-only rerun job_1794067759328_ud0gsxvn3r, same prod input_data)
Not fixed. The stakes are now said (p3, the MUST SAY works). The unicorn's reason is still not said. The
ending is still made by friends: Melodi calls «Halt!» (p8) and Melisa lifts the lantern (p9). Janna's own
act (shouting «Laterne!») is a bit stronger. The rhyme gimmick is unchanged, as expected: verse mode is
not built yet. Logs show 9 MAJOR panel findings went to the re-telling, but the text-only rerun stores no
arc report, so why the obstacle rule did not hold cannot be read (BACKLOG line).

## F. Laternen full verse run (2026-11-08, staging job_1794128424739_0j933o99i5u, USD 4.10 + about USD 0.30 Lab)
Full rerun from the identical input with verse mode and the tightened verse rule (e8cb78719). Verse 7/10, plot 7/10:
the stakes and the unicorn's reason are said, and Janna's own act (comforting the unicorn, so its horn lights the street) is what makes Polina see her.
The rhyme-word unicorn is gone.
Hand fixes after the logic check (owner: "check logic and consistency first, rewrite texts, then fix images, spend 2.-"):
- p1: Janna can no longer be painting her star while Melisa already carries it.
- p5: clearer why she cannot get through.
- p8: Polina stops at the corner and turns round, because the front had already turned the corner on p6.
- p9: a line with no beat rewritten.
Pictures: the stored scene plans for p6 and p9 had no Janna at all (p6: zero characters on her low point). Redrawn in the Lab:
- p6 v1 (Lab 1812): good on the first try.
- p9 v2 (Lab 1814): the first try, 1813, gave Janna a second star lantern.
Both are active.
Open finding: the scene plan left the main character out of her own key moments (p6, p9) and p1 shows only Melodi.

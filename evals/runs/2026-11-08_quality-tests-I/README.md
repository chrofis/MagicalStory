# Quality tests I: blind A/B of the final book review (instructions for reviewers)

You stand in for the review model. For each book you get one prompt file and the book's pictures. Read
the prompt, look at every picture where the prompt shows its `[PICTURE: pN.jpg]` marker, and answer the
way the review model would.

## Your arm

You are given one arm, A, B, C, D or D2. Use only `prompt-A.txt`, `prompt-B.txt`, `prompt-C.txt`, `prompt-D.txt` or `prompt-D2.txt` in every
book folder. Do not open another arm's prompt file. Arm C answers go to `answers/C/`, arm D answers to `answers/D/`, arm D2 answers to `answers/D2/`. Do not open `key.json`, `scripts/`, `templates/`, or anything
from earlier test runs in `evals/runs/`.

## Per book

1. Open `packets/bookNN/prompt-<ARM>.txt`. It is the full text the model receives, part by part, in order.
   Each `[PICTURE: pN.jpg]` marks the place where that picture is sent. The picture file is in the same folder.
   `index.md` gives the same page-to-file map.
2. Look at every picture (use the Read tool on the .jpg). Never judge a page without looking at its picture.
3. Answer exactly as the prompt asks. Output only what the prompt says to output:
   - the `FAULT[...]` lines, one per line, starting at the left margin, in the prompt's exact format
     (weight, type, route and, for NEW, the background decision);
   - the `FAULTS: <count>` line;
   - for arms B and C only (never D or D2), the two `VERDICT[ENJOY][...]` and `VERDICT[BUY][...]` lines the prompt asks for.
   No reasoning, no headings, no notes.
4. A few books are sent in 2 calls (the prompt says `CALL 1 of 2`). Answer each call on its own, one
   after the other, in the same answer file, each with its own `FAULTS:` line (and, in B and C, its own verdicts).
5. Write the answer to `answers/<ARM>/bookNN.txt` (for example `answers/B/book07.txt`, `answers/C/book07.txt`).
   One file per book.

## Rules

- Judge only what the prompt and the pictures give you. Do not look up the book, the story or earlier
  results. There is no grade file and no known-fault list in the packets, and you must not search for one.
- Do not edit the packets.
- No paid model calls. You are the model.

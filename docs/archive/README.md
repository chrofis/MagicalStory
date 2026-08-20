# Archive — superseded, do not treat as open work

Everything under `docs/archive/` is **historical**. It is kept because it records how the
system got here, not because anything in it is pending.

**Skip this directory when sweeping for open tasks.** These files contain hundreds of
unchecked `- [ ]` boxes, "Pending" headings and "Next Steps" sections that describe work
already done, abandoned, or superseded by a later decision. Counting them as open work is the
single largest source of noise in a task sweep — roughly 240 phantom items.

Open work lives in **`tasks/BACKLOG.md`**. Clear reproduced bugs live in `tasks/bugs.json`.

## What is in here

- `requirements-2025-01/` — the pre-implementation requirements package (2025-01-26). Written
  before the system existed; its 174 checkboxes describe a build plan that was superseded by
  what actually shipped. Moved here 2026-08-20 from the repo root.
- Everything else — earlier architecture notes, deploy guides, code reviews and plans, each
  superseded by a current document under `docs/`.

If you need to know what is true **now**, read `CLAUDE.md`, `docs/codebase-guide.md`,
`docs/decisions.md` and `docs/SETTLED.md`. If something in here contradicts those, they win.

## Adding to the archive

Move a document here when it has been fully superseded, and say in one line at the top of the
moved file what replaced it. Do not delete — the reasoning behind a reversal is often the only
thing that stops the reversal being reversed again.

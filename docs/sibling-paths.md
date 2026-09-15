# Sibling paths — the registry and the gate

## The failure class

A fix lands on one code or prompt path and not its sibling, so the bug is still
live on whichever path production actually runs. This is the repo's #1 historical
defect class. On 2026-09-15 a verification sweep of **173 behaviour commits from a
60-hour window found 27 PARTIAL fixes, and every single one had this shape.**

The worst of them was the root cause of a whole story's collapse: `crowdExpected`
was added to the metadata schema of `prompts/scene-expansion.txt` (the per-page
fallback Art Director template) and not to `prompts/scene-expansion-all.txt` (the
one the live beats pipeline runs). Omission reads as `false`, so the crowd guard
saw `false` on all 16 pages; nine of them then took an `extra_character` CRITICAL
for correctly-drawn harbour crowds, and mean finalScore fell to 43 from 62–69.

A skill describing this exact failure class — `.claude/skills/fixing-sibling-paths`
— had existed for five weeks and prevented **none** of the 27. That is the lesson:
a skill is advisory and is read only by a session that chooses to invoke it.
Prose cannot be a control. So the sibling relationship is now **data**.

## The three pieces

| Piece | What it does |
|---|---|
| `scripts/admin/sibling-registry.json` | Declares sibling SETS: files that must move together, each with an axis and a one-line reason. |
| `scripts/admin/check-sibling-paths.js` | Pre-push gate (gate 9 in `.githooks/pre-push`). Per commit in the push: touched some members of a set but not all → **blocked**. |
| `tests/unit/sibling-parity.test.ts` | Runs in the normal suite. Asserts structural parity of the declared parts (metadata schema keys, rule anchors, within-file invariants) — catches drift that is already in the tree, which no diff will ever flag. |

## Adding a sibling set

One entry in `sets`:

```json
{
  "id": "art-director-templates",
  "axis": "per-page vs all-pages Art Director",
  "reason": "one line: why these move together",
  "members": ["prompts/scene-expansion.txt", "prompts/scene-expansion-all.txt"],
  "severity": "block",
  "parity": { "metadataKeys": true }
}
```

- `severity: "block"` (default) refuses the push. `"warn"` prints and passes — for
  one-to-many axes where most edits legitimately touch one side only. A gate that
  cries wolf gets bypassed, and a bypassed gate is worse than none.
- `parity.metadataKeys` — every member's `---METADATA---` JSON example declares the
  same top-level keys. This alone would have caught `crowdExpected`.
- `parity.anchors` — literal strings every member must contain.
- `withinFile` sets express an intra-file axis (every `call*API` entry point in
  `textModels.js` must guard its prompt string); the parity test enforces them.

The gate refuses to run against a set naming a file that does not exist — a stale
member makes a set silently unenforceable.

## The escape hatch

Two things let a one-sided commit through, both deliberate:

1. **The push's full range covers the missing members.** A fix split across two
   commits of one push is a complete fix; only the push ships.
2. **`Siblings-Checked: <reason>` in the commit message.** It is a statement, not a
   silencer: write why the sibling needs no change. An empty marker is not accepted.

The marker's main honest use is a **catch-up commit** — the sibling was fixed in an
earlier commit that has already been pushed, so the range cannot cover it. Say so.

## Fail-closed

If the registry is missing or malformed, or git cannot be read, the gate exits
non-zero. A gate that waves a push through on its own error is a gate nobody can
rely on. Same contract as the rest of `.githooks/pre-push`.

## Advisory nudge

A PostToolUse hook in `.claude/settings.json` fires after an Edit/Write to any
registry member and lists that file's siblings in context. It never blocks — the
pre-push gate is the blocker; the nudge just moves the reminder to the moment the
fix is being written instead of the moment it is being pushed.

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
| `scripts/admin/check-sibling-paths.js` | Pre-push gate (gate 9 in `.githooks/pre-push`). Per commit in the push: touched some members of a set but not all → **blocked**. Every set blocks; there is no soft tier. |
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

- `severity` accepts only `"block"`, and may be omitted. A `"warn"` tier existed for
  one day; the owner retired it on **2026-09-15** — every set blocks, including the
  one-to-many axes (trial vs full writer, VB authoring sites, repair entry points,
  cover cast builders, Lab vs prod). The gate rejects any other value rather than
  quietly reading it as block. The reasoning: a warn let a partial fix through and
  left nothing written down, where the marker always leaves a reason behind.
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

3. **A later commit in the same push vouches for it by sha:**
   `Siblings-Checked: <sha-prefix ≥ 7> — <reason>`. The gate prints
   `vouched by <sha>` so attribution stays visible.

### When to vouch instead of amending

The **catch-up commit** is the case the plain marker cannot serve: the sibling was
fixed in a commit that has already been pushed, so the range cannot cover it, and
the gate blocks — correctly, on the evidence it can see. Amending that commit means
a rebase, which rewrites every hash after it, and handoff notes cite those hashes.
A vouch ADDS a commit instead of rewriting history. One `--allow-empty` commit can
carry several vouch lines, one per blocked commit.

The vouch fails closed on every way it could become a loophole — all are errors,
never passes:

- a prefix that resolves to no commit **in the push range**
- an ambiguous prefix (use a longer one; the gate never guesses)
- a commit vouching for itself (use the plain marker for your own siblings)
- a missing reason

A message carrying only vouches for OTHER commits does **not** double as an excuse
for its own siblings. Tested in `tests/unit/sibling-vouching.test.ts`.

## Fail-closed

If the registry is missing or malformed, or git cannot be read, the gate exits
non-zero. A gate that waves a push through on its own error is a gate nobody can
rely on. Same contract as the rest of `.githooks/pre-push`.

## Advisory nudge

A PostToolUse hook in `.claude/settings.json` fires after an Edit/Write to any
registry member and lists that file's siblings in context. It never blocks — the
pre-push gate is the blocker; the nudge just moves the reminder to the moment the
fix is being written instead of the moment it is being pushed.

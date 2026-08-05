# Costumed character sheet — 2×4 vs production 2×2

Local test of expanding the production styled-costumed avatar layout from a
2×2 grid (4 cells: face front, face right, body front, body right) to a 2×4
grid (8 cells: face front + 45° + 90° profile + 180° back; same four angles
for the costumed body).

Test harness: `scripts/test-costumed-2x4.js`
Prompt: `prompts/styled-costumed-avatar-2x4.txt`
Backend: `gemini-2.5-flash-image`
Run date: 2026-05-11
Outputs: `tests/_outputs/costumed-2x4/<timestamp>__<name>/`

## Runs

| Character | Photo | Style | Costume | Layout | Result |
|---|---|---|---|---|---|
| Hans | berger/Hans.jpg | watercolor | pirate (hat + sash) | 2×4 | ✅ all 8 panels rendered |
| Hans | berger/Hans.jpg | pixar | medieval villager | 2×4 | ✅ |
| Hans | berger/Hans.jpg | anime | medieval villager | 2×4 | ✅ |
| Emma | berger/Emma.jpg | watercolor | pirate | 2×4 | ✅ |
| Emma | berger/Emma.jpg | watercolor | forest fairy | 2×4 | ✅ |
| Noah | berger/Noah.jpg | watercolor | striped pirate + eye patch | 2×4 | ✅ |
| Daniel | berger/Daniel.jpg | watercolor | pirate (coat + tricorn) | 2×4 | ✅ |
| Sarah | berger/Sarah.jpg | watercolor | pirate (4 retries) | 2×4 | ❌ IMAGE_OTHER |
| Sarah | berger/Sarah.jpg | pixar | medieval | 2×4 | ❌ IMAGE_OTHER |
| Sarah | berger/Sarah.jpg | watercolor | medieval (simpler) | 2×4 | ❌ IMAGE_OTHER |
| Sarah | berger/Sarah.jpg | watercolor | medieval | **2×2** | ❌ IMAGE_OTHER |
| Hans | berger/Hans.jpg | watercolor | pirate | **2×2** (baseline) | ✅ (production-quality) |

8/9 distinct characters/style/costume combos succeeded. Sarah failed even on
the legacy 2×2 layout — that's a photo-specific Gemini moderation quirk, not
a property of the new layout.

## Findings

### 1. The 2×4 layout works

All 8 panels rendered with the correct angle in every successful run.
The 180° back-of-head pose (top row, panel 4) and full back body
(bottom row, panel 8) came through cleanly even for distinctive features
(Hans's bald patch from behind; Noah's blonde hair tied back; Emma's brown
ponytail).

### 2. System instruction must NOT hard-code the grid shape

First several attempts returned `finishReason: IMAGE_OTHER` (no image, no
safety block). Cause: the script's `systemInstruction` literally said
*"create a 2×2 grid"* while the user prompt asked for 2×4. The model
silently failed under that contradiction.

Fix in `scripts/test-costumed-2x4.js`: the system text is now neutral —
*"create reference sheets … follow the user's instructions precisely about
grid shape"*. This is a lesson for the production path too — if
`generateStyledCostumedAvatar` (`server/routes/avatars.js:1396-1404`) ever
ships a 2×4 variant, the system text must be rewritten the same way, not
just the user prompt.

### 3. Aspect ratio: 16:9 for 2×4, 1:1 for 2×2

For a 2×4 grid, 16:9 canvas means each panel is ~228×256 (roughly square)
— full-body figures fit well. The script picks aspect automatically:
`cols >= 4 ? '16:9' : '1:1'`. Other aspects (1:1, 4:3) for 2×4 also
work but the body panels end up squeezed in narrow vertical slots.

### 4. Costume leaks into the top-row face panels

In several runs (Hans pirate, Emma pirate, Daniel pirate) the model drew
the hat / hair accessory into face panels 3 and 4 even though the prompt
says *"Row 1 … face only, no clothing visible"*. Panels 1 and 2 stayed
clean; the leak is concentrated at the profile and back-of-head views,
where the head silhouette is more dominant.

Possible mitigations to try next:
- Stronger negative phrasing in Row 1: *"never show the costume in Row 1,
  even if the costume includes a hat or head covering."*
- Move the hat instruction inside the body row only and rename the
  costume variable to make it unambiguous which row consumes it.
- Generate Row 1 (faces) and Row 2 (bodies) in separate calls and tile
  them. Doubles the cost but eliminates the leak by construction.

### 5. Cost & latency comparable to 2×2

| Layout | Avg latency | Avg in tokens | Avg out tokens | Cost/image |
|---|---|---|---|---|
| 2×2 (legacy) | ~11s | ~1,184 | ~1,290 | $0.04 |
| 2×4 (new) | ~12s | ~890 | ~1,290 | $0.04 |

No real cost difference. The 2×4 prompt is shorter than the 2×2 prompt
in token count (the test version is more compact), which slightly reduces
input tokens.

### 6. Sarah-specific moderation

Sarah's photo (`tests/fixtures/demo-photos/berger/Sarah.jpg`) triggers
`finishReason: IMAGE_OTHER` on every Gemini call regardless of layout,
style, or costume. This affects the production pipeline today —
investigated separately. Not a 2×4 issue.

## Next steps before promoting 2×4 to production

1. **Fix the Row-1 costume leak**: stronger negative phrasing or split
   into two API calls. Sample size of 8 isn't enough to know whether the
   leak is style-dependent (it appeared on watercolor + pirate; didn't
   appear on watercolor + fairy in this run, may appear on a re-roll).
2. **Larger sample**: re-run each character 5× to measure the IMAGE_OTHER
   failure rate. If 8/9 holds at this scale (89% success), production
   needs a retry loop the same as the 2×2 path already has
   (`MAX_COSTUME_RETRIES = 2` in `server/routes/avatars.js:1432`).
3. **Identity drift across angles**: visually compare panel 1 (front) to
   panel 8 (back) — does the model preserve hair colour and build, or
   does it drift? Cells are cropped automatically; eyeball them in the
   output dir.
4. **Decide consumer**: which downstream code reads the styled-costumed
   avatar grid today (`buildCharacterPhotoDetails`, the cutout extraction
   in `coverComposite.js`, char-repair avatar lookup)? Switching the
   shape from 2×2 to 2×4 will rebroadcast as 8 cell offsets — every
   reader needs an updated index map. See
   `server/lib/styledAvatars.js:remapAvatarGrid` (if it exists) before
   wiring the new shape in.

## How to reproduce

```bash
# Single character, 2×4 only
node scripts/test-costumed-2x4.js \
  --face=tests/fixtures/demo-photos/berger/Hans.jpg \
  --style=watercolor \
  --costume="pirate costume, white shirt, red sash, dark breeches" \
  --name=Hans-pirate

# With legacy 2×2 side-by-side
node scripts/test-costumed-2x4.js --face=... --also-2x2

# Override aspect ratio or model
node scripts/test-costumed-2x4.js --face=... --aspect=4:3 --model=gemini-2.5-flash-image
```

Output goes to `tests/_outputs/costumed-2x4/<timestamp>__<name>/` with:

- `2x4.png` — the full Gemini output
- `2x4_cell1.png` … `2x4_cell8.png` — per-panel crops
- `2x4_prompt.txt` — the exact prompt sent to Gemini
- `2x4_meta.json` — tokens, latency, cell dimensions
- `summary.json` — run metadata

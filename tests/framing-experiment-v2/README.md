# Framing Experiment v2 — Tell apple-shot (job_1776554957628_pw7g3k0d5 P6)

Proper production-matching references:
- Costumed medieval avatars (`styledAvatars.realistic.costumed.mittelalterlich`)
- Empty scene from story_images (`input_empty_scene.jpg`)
- VB grid available but not packed into slots (matches new prod: VB rides with char slots, not scene)

## Files
- `input_empty_scene.jpg` — empty scene used as scene background in slot 1
- `input_vb_grid.jpg` — the VB grid cached on the scene (for reference)
- `production_original_p6.jpg` — the image production actually generated for P6
- `characters/<name>.jpeg` — costumed medieval avatars used as reference refs

## Framings (each has its own folder)

### 1. `A_before_manuel_ready`
BEFORE — Manuel at shoulder-mount with crossbow, gaze follows the barrel, side-profile, bowstring relaxed.

**Characters attached as refs:** Manuel

Inside `A_before_manuel_ready/`:
- `slot_1.jpg`, `slot_2.jpg`, … — the exact Grok reference slots
- `prompt.txt` — the full prompt sent to Grok
- `output.jpg` — what Grok generated
- `meta.json` — timing + cost

### 2. `B_before_lukas_tense_scared`
BEFORE — Lukas alone, apple on head, tense and frightened, natural child proportions, medium close-up.

**Characters attached as refs:** Lukas

Inside `B_before_lukas_tense_scared/`:
- `slot_1.jpg`, `slot_2.jpg`, … — the exact Grok reference slots
- `prompt.txt` — the full prompt sent to Grok
- `output.jpg` — what Grok generated
- `meta.json` — timing + cost

### 3. `C_pov_distant_lukas`
POV — tight strip of crossbow at bottom edge only; Lukas very far back with apple on head.

**Characters attached as refs:** Lukas

Inside `C_pov_distant_lukas/`:
- `slot_1.jpg`, `slot_2.jpg`, … — the exact Grok reference slots
- `prompt.txt` — the full prompt sent to Grok
- `output.jpg` — what Grok generated
- `meta.json` — timing + cost

### 4. `D2_over_shoulder_distant_kid`
Over-the-shoulder Manuel foreground, Lukas tiny in distance (generic medieval kid with red apple). THE WINNER PATTERN.

**Characters attached as refs:** Manuel

Inside `D2_over_shoulder_distant_kid/`:
- `slot_1.jpg`, `slot_2.jpg`, … — the exact Grok reference slots
- `prompt.txt` — the full prompt sent to Grok
- `output.jpg` — what Grok generated
- `meta.json` — timing + cost

### 5. `E_aftermath_pierced_apple`
AFTERMATH — Lukas facing camera; bolt went forward-to-backward (into tree away from camera), fletching toward viewer, apple impaled on shaft pressed against bark above his head.

**Characters attached as refs:** Lukas

Inside `E_aftermath_pierced_apple/`:
- `slot_1.jpg`, `slot_2.jpg`, … — the exact Grok reference slots
- `prompt.txt` — the full prompt sent to Grok
- `output.jpg` — what Grok generated
- `meta.json` — timing + cost


## Results
- A_before_manuel_ready: **ok**  (7.4s)
- B_before_lukas_tense_scared: **ok**  (8.4s)
- C_pov_distant_lukas: **ok**  (8.1s)
- D2_over_shoulder_distant_kid: **ok**  (8.7s)
- E_aftermath_pierced_apple: **ok**  (9.0s)

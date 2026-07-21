# Generic AI-Image Failure Modes — Catalogue & Mitigation Playbook

> Status: **reference only — mitigations NOT implemented yet** (decision 2026-07-21:
> documented for later; no prompt/eval changes made).
> Sources: PhyBench (arXiv:2406.11802), forensic spot-AI checklists (CAI, Forensic
> Focus), practitioner taxonomies. Full links at the bottom.

There is no single canonical taxonomy in the literature. The closest is
**PhyBench** (700 prompts, 31 physical scenarios, categories mechanics / optics /
thermodynamics / material properties — mechanics and thermodynamics score worst
across all tested models). Its key finding is the actionable one:

> **Models cannot reason about physics, but they can render explicitly described
> physics.** Rewriting implicit physical relations as explicit visible cues
> "drastically improves" outputs.

That is the same mechanism as our EXACT POSES / EXPRESSIONS tail anchors —
translate implicit constraints into visible, nameable cues.

## Failure classes (observed in Grok + generic across models)

| # | Class | Typical instances | Observed here |
|---|-------|-------------------|---------------|
| 1 | **Force & tension** | Ropes/leashes/chains render slack when strained; pulling poses lack counter-lean; load-bearing arms relaxed | rope without tension |
| 2 | **Z-order / interpenetration** | Bars/fences/railings pass in front of one limb, behind another; held poles merge with hands; straps enter a shoulder and never exit | impossible cage bars |
| 3 | **Canonical-view bias** | Stairs climbed not descended; clocks at 10:10; default smiles; bicycles side-on with impossible frames; books face the reader | ascending-stairs substitution; default smiles |
| 4 | **Articulated extremities** | Finger count, melted knuckles; worst when the hand DOES something (rungs, chopsticks, instrument strings, pencil grip); teeth overcrowded/pointed; ears without lobes | |
| 5 | **Repeating-structure breakdown** | Ladder rungs, fence pickets, stair steps, piano keys, spokes, braids, window grids — pattern starts correct, drifts with count | |
| 6 | **Optics** | Multiple shadow directions; missing contact shadows (floating objects); mirror/water reflections wrong angle or wrong content; glass fails to refract | |
| 7 | **Liquids & materials** | Pouring doesn't connect vessel to cup; cloth ignores gravity; hair merges with clothing | |
| 8 | **Contact & support** | Sitting figures hover above the chair; feet not touching ground; held objects without grip contact | (feet-flat rule already in cover prompt) |
| 9 | **Counting / negation / binding** | N objects → N±1; "no X" ATTRACTS X (naming the forbidden thing makes it appear); attribute bleed between adjacent nouns; prompt words painted as text | VB-id leak; "no backpack" class |
| 10 | **Crowd degradation** | Background figures get fused faces, cloned outfits, fewer fingers — quality budget concentrates on the focal figure | |

## Mitigation playbook (deferred — apply when we pick this up)

Principle: **name the visible cue, not the physical intent.**

- **Tension**: never "pulls the rope" → "the rope is taut and straight, both
  hands gripping, body leaning back against the strain".
- **Z-order**: never rely on "behind the bars" → "both hands wrap around the
  bars in front of her; the bars pass in front of her whole body".
- **Anti-canonical poses**: name the giveaway cue — descending stairs: "seen
  from below, front foot on a lower step, body facing downhill".
- **Negation**: don't name forbidden objects in generation prompts; omit them
  (aligns with prompt-genericity + avatar garments-only rules).

Planned implementation shape (when we do it):
1. **Hazard list in scene-expansion prompt**: if an interaction involves
   rope/chain/leash, ladder/stairs, bars/fence, mirror, pouring, carrying-heavy
   → emit the explicit physics phrasing for that hazard.
2. **Matching eval checks** (same pattern as `character_marking`): taut-rope,
   contact-shadow, z-order consistency on bar/fence scenes.
3. Validate via Test Lab `scene_variant` (one hazard rule per experiment) on
   benchmark pages with rope/stairs/bars interactions.

## Sources

- PhyBench: A Physical Commonsense Benchmark for T2I — https://arxiv.org/abs/2406.11802
- Conceptual Blindspots in Generative Image Models — https://arxiv.org/pdf/2506.19708
- How to Distinguish AI-Generated Images from Photographs — https://arxiv.org/pdf/2406.08651
- 12 AI Image Failure Modes (practitioner taxonomy) — https://lifehackedai.com/articles/ai-image-failure-modes/
- CAI photo forensics (shadows/reflections) — https://contentauthenticity.org/blog/photo-forensics-from-lighting-shadows-and-reflections
- Forensic Focus: shadows & reflections — https://www.forensicfocus.com/articles/how-to-reveal-ai-generated-images-by-checking-shadows-and-reflections-in-amped-authenticate/
- HandCraft (malformed-hand restoration) — https://arxiv.org/pdf/2411.04332
- Britannica: why AI fails at hands — https://www.britannica.com/topic/Why-does-AI-art-screw-up-hands-and-fingers-2230501

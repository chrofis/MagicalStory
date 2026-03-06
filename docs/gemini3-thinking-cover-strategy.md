# Gemini 3 Pro Image: Thinking Mode & Multi-Character Cover Strategy

## The Problem

Cover/title images need up to 10 consistent characters. Every approach tested has failed (see `docs/MULTI-CHARACTER-COVER-TESTS.md`):

| Approach | Result |
|----------|--------|
| Single-shot 10 chars | Characters blend together |
| Iterative add (3->6->10) | Identity drift |
| Ghost + inpaint | Style mismatch |
| Gemini edit its own image | Re-interprets whole scene |
| Multi-turn conversation | No better than single-shot |
| Stitching separate parts | Scene elements change |

**Root cause:** Diffusion models average/blend when given too many competing reference images. Beyond 4-5 characters, faces merge.

---

## What Gemini 3 Pro Image Changes

### Model: `gemini-3-pro-image-preview` (codename "Nano Banana Pro")

| Feature | Gemini 2.5 Flash Image | Gemini 3 Pro Image |
|---------|------------------------|--------------------|
| Reference images | Up to 3 | **Up to 14** (5 human, 6 object) |
| Resolution | 1024px max | **1K / 2K / 4K** |
| Thinking mode | No | **Yes** - plans composition before rendering |
| Text rendering | Mediocre | State-of-the-art |
| Price per image | ~$0.02 | **$0.134** (2K), $0.067 batch |

### The Thinking Process

The model generates **up to 2 interim "thought images"** before the final output. These are composition tests - the model plans spatial layout visually before committing. Thought images are **not charged**.

The process:
1. **Analyze** - deeply parses prompt for spatial relationships, character placement
2. **Design** - generates interim images to test composition layout
3. **Evaluate** - checks if characters are distinct and well-positioned
4. **Render** - produces the optimized final image

**Benchmark:** 89% prompt adherence (vs Midjourney V7's 72% on identical prompts).

---

## How To Guide The Thinking (It's Not Just On/Off)

### What DOESN'T Work

- `thinkingBudget` parameter (Gemini 2.5 only, deprecated)
- Meta-instructions like "think carefully about composition" (model already does this)
- Chain-of-thought prompting (Google says to stop doing this for Gemini 3)
- Telling it to "plan first" in the prompt

### What DOES Work

#### 1. System Instructions (biggest opportunity)

System instructions anchor the model's reasoning **before** it sees the prompt. We currently don't use them.

```javascript
system_instruction: {
  parts: [{
    text: "You are an expert children's book illustrator specializing in group scenes. " +
          "When drawing multiple characters, give each character DISTINCT features: " +
          "different heights, different hair styles, different clothing colors. " +
          "Never blend or average character faces. Each character must be individually " +
          "recognizable. Use warm, vibrant colors appropriate for children's books."
  }]
}
```

This tells the thinking process **how** to approach composition before it sees any specific scene.

#### 2. Structured Scene Layering (guides composition planning)

Instead of one paragraph, layer the scene so the model's thinking follows a spatial blueprint:

**Current approach (single paragraph):**
```
All ten family members sit around a long wooden dinner table. Sophie (8) is at the head...
```

**Better approach (layered):**
```
BACKGROUND: A warm dining room with golden evening light from windows on the left wall.

SETTING: A long wooden dinner table with 10 place settings, viewed from a slight elevation.

LEFT SIDE OF TABLE (from viewer's perspective):
- Sophie (8, brown hair, blue dress) at the head of the table
- Manuel (9, dark hair, red shirt) next to Sophie
- Grandmother (elderly, white hair, green cardigan) next to Manuel

RIGHT SIDE OF TABLE:
- Father (tall, brown hair, white shirt) opposite Sophie
- Mother (blonde, floral dress) next to Father
- Baby Max (2, blonde curls, yellow bib) in a high chair next to Mother

BACKGROUND CHARACTERS (smaller, less detail needed):
- Uncle Hans, Aunt Marie, Cousin Lena, Cousin Tim sitting in remaining seats

Style: Pixar-style 3D illustration with soft lighting.
```

This gives the thinking process a spatial map. The model doesn't have to figure out where 10 people go - you've done the layout work.

#### 3. Two-Turn "Plan Then Generate" (for covers specifically)

**Turn 1** - text only, ask model to plan:
```
I need to create a children's book cover illustration showing 10 family members
around a dinner table. Here are their reference photos: [photos]

Before generating the image, describe in detail:
1. How would you arrange all 10 characters around the table?
2. Which characters should be in the foreground (larger, more detail)?
3. Which characters can be in the background (smaller, less detail needed)?
4. What camera angle would work best to show everyone?
5. How will you ensure each character remains distinct?
```

**Turn 2** - generate based on the plan:
```
Generate the illustration based on your plan above.
```

The thought signatures carry between turns, so Turn 1's reasoning directly informs Turn 2's generation. This doubles API cost (~$0.27 for a cover) but could be worth it for the most important images.

#### 4. Constraints at the END

Google's guidance: critical restrictions go **last** because the model drops late-prompt constraints less during complex reasoning.

```
[scene description...]
[character placement...]
[style...]

CRITICAL CONSTRAINTS:
- Every character must have a DIFFERENT face - no blending or averaging
- Characters in the background can be smaller but must still be recognizable
- Do NOT show reference photos or grids in the output
- Title text "{STORY_TITLE}" must appear at the top, clearly legible
```

#### 5. Temperature 1.0

Google "strongly recommends" 1.0 for Gemini 3. We currently use 0.8. Higher temperature gives the thinking process more creative room for composition solutions.

#### 6. Reading Back the Thoughts (debugging)

```javascript
// After generation, inspect what the model reasoned about
for (const part of response.candidates[0].content.parts) {
  if (part.thought && part.text) {
    console.log('Model reasoning:', part.text);
  }
  if (part.thought && part.inlineData) {
    console.log('Interim composition test image found');
  }
}
```

Use this to understand **why** a composition failed. If the thought text reveals the model struggled with character placement, retry with clearer spatial instructions instead of the same prompt.

---

## Can We Skip Our Complicated Scene Creation?

### What We Currently Do

1. Claude generates a scene description from the story outline
2. `OutlineParser.extractCoverScenes()` extracts it (simple string)
3. `buildCharacterReferenceList()` creates detailed character descriptions
4. `buildFullVisualBiblePrompt()` adds secondary elements
5. Template fills `front-cover.txt` with all these pieces
6. Send to Gemini with all reference photos

The scene creation for covers is actually **already simple** - it's just a text description plus character reference photos. The complexity is in the prompts and the character reference system, not in scene construction.

### What We Could Simplify With Gemini 3

**YES - we can lean more on internal reasoning:**

| Current Approach | Gemini 3 Approach | Why |
|------------------|-------------------|-----|
| Detailed CHARACTER_REFERENCE_LIST with physical descriptions | Pass reference photos + names only | Model's thinking can extract features from photos directly |
| VISUAL_BIBLE with secondary elements | Skip for covers | Thinking mode handles scene coherence |
| Explicit composition instructions | Spatial layout hints only | Model plans composition internally |
| Complex prompt template (36 lines) | Simpler conversational prompt | "Think like a creative director, not keyword tags" |

**NO - we still need:**

| Still Needed | Why |
|--------------|-----|
| Reference photos | Model needs to know what characters look like |
| Character names | Need to label who is who |
| Scene description | Model needs to know what to draw |
| Art style | Needs to match the book's style |
| Text requirements | Title/URL placement |

### Proposed Simplified Cover Prompt (Gemini 3)

```
system_instruction: "You are an expert children's book illustrator. Create warm,
vibrant illustrations where every character is individually recognizable.
When drawing group scenes with many characters, use depth (foreground/background)
and varied positioning to keep each character distinct."

prompt: """
Create a front cover for the children's book "{STORY_TITLE}".

Scene: {TITLE_PAGE_SCENE}
Art style: {STYLE_DESCRIPTION}

The following reference photos show each character. Transform them into the art style
while keeping each face recognizable:

{photos with name labels}

Arrange all characters in a balanced group composition.
Use foreground/background depth - main characters (first 2-3) larger in front,
others visible but smaller behind.

The title "{STORY_TITLE}" must appear prominently at the top in an attractive font.
Do NOT include reference photos or grids in the output image.
"""
```

This is ~15 lines vs our current 36-line template, and leans on the model's thinking to handle composition rather than over-specifying.

---

## The Real Question: Does 5 Human References Fix 10 Characters?

### Honest Assessment

Gemini 3 Pro supports up to **5 human reference images** and **6 object images** (14 total). For 10 characters, this means:

- **5 characters get direct face references** (the 5 most important)
- **5 characters must rely on text descriptions only**

This is better than Gemini 2.5's 3-image limit, but still doesn't solve the fundamental problem of 10 distinct identities.

### Realistic Strategy for 10-Character Covers

**Tier the characters by visual importance:**

```
FOREGROUND (3 characters, large, full face references):
- Main character 1: full reference photo
- Main character 2: full reference photo
- Main character 3: full reference photo

MIDGROUND (2-3 characters, medium, reference photos):
- Supporting character 4: reference photo
- Supporting character 5: reference photo

BACKGROUND (4-5 characters, small, text-described):
- Background characters: described by text only
- Shown smaller, partial views, or from behind
- Distinct through clothing color, height, hair color
```

**This plays to the model's strengths:**
- 5 face references for the 5 most prominent characters
- Background characters don't need face-level consistency
- The thinking mode can plan this depth layering itself if we tell it the tier structure

### What To Test

1. **Gemini 3 single-shot with 5 refs + 5 text-described** - does thinking mode handle the tiering?
2. **Two-turn approach** - ask model to plan the group layout first, then generate
3. **Simplified prompt** vs current detailed template - does less instruction + better thinking = better results?
4. **System instruction impact** - same prompt with/without system instruction
5. **Temperature 1.0 vs 0.8** - does it help or hurt consistency?

---

## Implementation Checklist

### Phase 1: Quick Tests (no code changes)

- [ ] Test `gemini-3-pro-image-preview` with current prompts (baseline)
- [ ] Test with system instruction added
- [ ] Test simplified prompt (this doc's version) vs current template
- [ ] Test two-turn plan-then-generate for a cover
- [ ] Test 5 refs + 5 text-described characters
- [ ] Log thought text to understand model reasoning
- [ ] Compare temperature 0.8 vs 1.0

### Phase 2: Integration (if tests show improvement)

- [ ] Add system instruction support to image generation calls
- [ ] Create Gemini 3-specific cover prompt templates
- [ ] Add thought text logging to cover generation
- [ ] Implement two-turn generation option for covers
- [ ] Update character tiering logic (foreground/midground/background)
- [ ] Bump temperature to 1.0 for Gemini 3 calls

### Phase 3: Pipeline Simplification (if Phase 2 works)

- [ ] Simplify cover prompts to lean on internal reasoning
- [ ] Reduce CHARACTER_REFERENCE_LIST to names + photos only
- [ ] Remove VISUAL_BIBLE from cover prompts
- [ ] Use thought text for quality pre-screening (before full eval)
- [ ] Evaluate cost: $0.134/image vs current cost + repair loops

---

## Cost Analysis

| Approach | Cost per Cover | Notes |
|----------|---------------|-------|
| Current (Gemini 2.5 + retries) | ~$0.05-0.20 | Depends on retry count |
| Gemini 3 single-shot | $0.134 | Higher base, possibly fewer retries |
| Gemini 3 two-turn | ~$0.27 | Plan + generate |
| Gemini 3 batch API | $0.067 | 50% discount, but async |
| Current + quality eval + repair | $0.15-0.40 | Eval costs add up |

If Gemini 3's thinking reduces retries from ~3 to ~1, the total cost could be **lower** despite the higher per-image price.

---

## Alternative: FLUX.2 for Covers

FLUX.2 supports **up to 10 reference images** at $0.03-0.05/image. This could handle the 10-character problem differently:

- All 10 characters get direct reference photos
- No thinking mode, but multi-reference is the core feature
- Available via fal.ai, Replicate, and already via Runware (which we use)

Worth testing in parallel with Gemini 3.

---

## Sources

- [Gemini 3 Pro Image API Docs](https://ai.google.dev/gemini-api/docs/image-generation)
- [Gemini 3 Thinking Documentation](https://ai.google.dev/gemini-api/docs/thinking)
- [Gemini 3 Prompting Guide](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/gemini-3-prompting-guide)
- [Nano Banana Pro - Google DeepMind](https://deepmind.google/models/gemini-image/pro/)
- [Generating Consistent Imagery with Gemini - Google Codelabs](https://codelabs.developers.google.com/gemini-consistent-imagery-notebook)
- [FLUX.2 on fal.ai](https://fal.ai/flux-2)
- Internal: `docs/MULTI-CHARACTER-COVER-TESTS.md`

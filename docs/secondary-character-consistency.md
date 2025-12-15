# Secondary Character Consistency Problem

## The Problem

Main characters have good visual consistency because we pass their photos to every image generation call. However, secondary characters introduced during the story (fireman, teacher, policeman, pets, etc.) have no reference images and can look completely different between scenes.

**Example:** A white cat in scene 3 becomes a brown cat in scene 8.

## Why This Happens

1. **No reference images** - Secondary characters don't have uploaded photos
2. **No memory between calls** - Each Gemini image generation is independent
3. **Vague descriptions** - Scene descriptions may not specify exact appearance
4. **Long gaps** - Character may appear in scene 3, disappear, then return in scene 15

## Current Flow

```
Scene 3: "A friendly fireman helps Lukas"
  → Gemini generates: tall fireman with mustache, blue eyes

Scene 8: "The fireman returns with his fire truck"
  → Gemini generates: short fireman, no mustache, brown eyes (INCONSISTENT!)
```

---

# Proposed Solutions

## Option A: Extract & Describe (Prompt Enhancement)

**Approach:** After generating each image, use Gemini Vision to analyze it and extract detailed descriptions of any new characters. Store these descriptions and include them in all future prompts.

**Flow:**
```
1. Generate Scene 3 image (fireman first appears)
2. Analyze image with Gemini Vision:
   "Describe any characters in this image who are NOT in the main cast"
   → "Fireman: tall, middle-aged man with gray mustache, blue eyes,
      wearing standard red firefighter uniform with yellow reflective stripes"
3. Store this description linked to "fireman" character
4. For Scene 8+, include in prompt:
   "RECURRING CHARACTER - Fireman: tall, middle-aged man with gray mustache..."
```

**Pros:**
- Uses actual generated appearance (self-consistent)
- No extra image generation costs
- Works with any character type (humans, animals, objects)

**Cons:**
- Adds API call per scene (vision analysis)
- Description might not capture everything
- Still relies on Gemini following text descriptions

**Complexity:** Medium
**Cost Impact:** +1 vision API call per scene with new characters

---

## Option B: Generate Reference Images

**Approach:** When the outline mentions a new character, generate a dedicated reference image for them BEFORE generating story scenes. Pass this reference image to all scenes where they appear.

**Flow:**
```
1. Parse outline for secondary characters:
   - "Fireman Fred" appears in scenes 3, 8, 15
   - "Whiskers the cat" appears in scenes 5, 7, 12

2. Generate reference images:
   "Create a character reference sheet for a friendly fireman named Fred
    in [ART STYLE]. Show front view, clear details."

3. Store reference images for secondary characters

4. For each scene, pass relevant reference images:
   Scene 3: main character photos + fireman reference
   Scene 8: main character photos + fireman reference
```

**Pros:**
- Visual reference (strongest consistency)
- Same approach as main characters (proven to work)
- Reference image can be shown to user for approval

**Cons:**
- Extra image generation cost per secondary character
- Increases total generation time
- Need to identify secondary characters from outline (parsing challenge)

**Complexity:** High
**Cost Impact:** +1 image generation per secondary character

---

## Option C: Detailed Scene Descriptions (Prompt Only)

**Approach:** Enhance the outline/scene description generation to include detailed, consistent appearance descriptions for ALL characters (including secondary ones) that persist throughout the story.

**Flow:**
```
1. During outline generation, ask Claude to create a "Character Bible":

   MAIN CHARACTERS:
   - Lukas: [from photo analysis]

   SECONDARY CHARACTERS:
   - Fireman Fred: tall man (185cm), gray mustache, blue eyes,
     weathered face, standard red firefighter uniform
   - Whiskers: small white cat with orange patches on ears, green eyes,
     pink collar with bell

2. Include full character bible in EVERY image generation prompt

3. Scene descriptions explicitly reference the bible:
   "Fireman Fred (see character bible) helps Lukas down from the tree"
```

**Pros:**
- No extra API calls
- No extra images to generate
- Descriptions created once, used everywhere
- Works within current architecture

**Cons:**
- Text descriptions less reliable than images
- Longer prompts (more tokens)
- Gemini may still deviate from descriptions

**Complexity:** Low
**Cost Impact:** Minimal (slightly longer prompts)

---

# Recommendation

**Start with Option C (Prompt Enhancement)**, then add **Option A (Extract & Describe)** if needed.

### Why?

1. **Option C is low-risk and low-cost** - We can implement it by modifying the outline prompt to generate a character bible. No architectural changes.

2. **Option A can be added incrementally** - If text descriptions aren't enough, we can add image analysis for the first appearance of each secondary character.

3. **Option B is expensive** - Generating reference images for every secondary character significantly increases cost and time. Reserve this for a "premium quality" mode.

### Implementation Steps for Option C:

1. Modify `outline.txt` to request a "Secondary Characters" section with detailed physical descriptions
2. Store secondary character descriptions with the story
3. Include character bible in image generation prompts
4. Add to scene description prompt: "Maintain exact appearance as defined in character bible"

### Implementation Steps to Add Option A:

1. After generating first scene with a new secondary character, call Gemini Vision
2. Extract appearance description
3. Update stored character bible with extracted details
4. Use extracted description for all future scenes

---

# Cost Comparison (30-page story with 3 secondary characters)

| Option | Extra API Calls | Extra Images | Est. Extra Cost |
|--------|-----------------|--------------|-----------------|
| C: Prompt Only | 0 | 0 | ~$0 |
| A: Extract & Describe | 3-5 vision calls | 0 | ~$0.05 |
| B: Reference Images | 0 | 3 | ~$0.15 |
| A + C Combined | 3-5 vision calls | 0 | ~$0.05 |

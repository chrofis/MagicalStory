# Visual Consistency Implementation Plan

## Scope: Characters AND Artifacts

This applies to anything that appears multiple times and needs consistent appearance:

**Characters:**
- Secondary humans (fireman, teacher, policeman, shopkeeper)
- Animals (pets, wildlife)
- Fantasy creatures (dragons, fairies, monsters)

**Artifacts:**
- Important objects (magic book, treasure map, golden key)
- Toys/companions (stuffed elephant, favorite teddy bear)
- Vehicles (fire truck, spaceship, pirate ship)
- Locations with distinctive features (the old lighthouse, the magic tree)

---

## Combined Approach: C + A

### Phase 1: Outline Generation (Option C)

Modify the outline prompt to generate a **Visual Bible** that lists all recurring elements.

**Add to `outline.txt`:**

```markdown
# Part 5: Visual Bible

List ALL recurring visual elements that appear in more than one scene. This is critical for illustration consistency.

## Secondary Characters
For each non-main character who appears in multiple scenes, provide:
- Name/Role: [e.g., "Fireman Fred" or "The friendly fireman"]
- Appears in scenes: [list page numbers]
- Physical description: [detailed: age, height, build, hair, eye color, distinguishing features]
- Clothing/Uniform: [what they typically wear]

## Recurring Animals/Creatures
- Name: [e.g., "Whiskers the cat"]
- Appears in scenes: [list page numbers]
- Species & breed: [e.g., "domestic shorthair cat"]
- Coloring: [detailed color pattern]
- Size: [relative size]
- Distinguishing features: [collar, markings, etc.]

## Important Artifacts
- Name: [e.g., "The Magic Map"]
- Appears in scenes: [list page numbers]
- Type: [book, key, toy, etc.]
- Physical description: [size, color, material, condition]
- Distinguishing features: [symbols, wear marks, unique details]

## Recurring Locations (if visually important)
- Name: [e.g., "The Old Lighthouse"]
- Appears in scenes: [list page numbers]
- Key visual features: [color, shape, condition, surroundings]

Format:
## Visual Bible

### Secondary Characters
**Fireman Fred** (scenes 3, 8, 15)
- Middle-aged man, approximately 50 years old
- Tall (185cm), stocky build
- Gray hair, thick gray mustache, blue eyes
- Weathered, kind face with laugh lines
- Standard red firefighter uniform with yellow reflective stripes, black boots

### Animals
**Whiskers** (scenes 5, 7, 12, 20)
- Small domestic cat, adult female
- White fur with distinctive orange patches on both ears
- Bright green eyes
- Pink collar with small silver bell
- Fluffy tail with white tip

### Artifacts
**The Ancient Map** (scenes 4, 9, 14, 22)
- Old parchment scroll, approximately 30cm x 40cm
- Yellowed/aged paper with torn edges
- Hand-drawn in brown ink with red X marking treasure
- Rolled and tied with frayed brown leather cord
- Coffee stain in bottom left corner
```

### Phase 2: Parse and Store Visual Bible

After outline generation, parse the Visual Bible section and store it:

```javascript
// New data structure
story.visualBible = {
  secondaryCharacters: [
    {
      id: 'fireman-fred',
      name: 'Fireman Fred',
      appearsInScenes: [3, 8, 15],
      description: 'Middle-aged man, approximately 50 years old...',
      extractedDescription: null, // Filled after first image analysis
      referenceImageData: null    // Optional: store first generated appearance
    }
  ],
  animals: [...],
  artifacts: [...],
  locations: [...]
};
```

### Phase 3: Image Analysis After First Appearance (Option A)

When generating an image for a scene that contains a Visual Bible element FOR THE FIRST TIME:

```javascript
async function analyzeAndUpdateVisualBible(imageData, sceneNumber, visualBible) {
  // Find which visual bible elements appear in this scene for the first time
  const firstAppearances = findFirstAppearances(sceneNumber, visualBible);

  if (firstAppearances.length === 0) return;

  // Call Gemini Vision to extract actual appearance
  const analysisPrompt = `
    Analyze this children's book illustration and describe the following elements in EXACT detail.
    These descriptions will be used to maintain consistency in future illustrations.

    Elements to describe:
    ${firstAppearances.map(e => `- ${e.name} (${e.type})`).join('\n')}

    For each element, provide:
    - Exact colors (be specific: "bright red" not just "red")
    - Size relative to other elements
    - Distinctive features, markings, patterns
    - Clothing/accessories details
    - Art style characteristics (how is it rendered in this style?)

    Format as JSON:
    {
      "elements": [
        {
          "name": "Fireman Fred",
          "extractedDescription": "Tall man with round belly, bright red uniform with 3 yellow stripes on sleeves, black helmet with gold badge, thick gray handlebar mustache, rosy cheeks, small blue eyes, black boots with silver buckles"
        }
      ]
    }
  `;

  const analysis = await callGeminiVision(imageData, analysisPrompt);

  // Update visual bible with extracted descriptions
  for (const element of analysis.elements) {
    updateVisualBibleElement(visualBible, element.name, element.extractedDescription);
  }
}
```

### Phase 4: Include in Image Generation Prompts

Modify image generation to include relevant Visual Bible entries:

```javascript
function buildImagePrompt(scene, visualBible, mainCharacters) {
  let prompt = `...existing prompt...`;

  // Find which visual bible elements appear in this scene
  const relevantElements = findElementsInScene(scene.pageNumber, visualBible);

  if (relevantElements.length > 0) {
    prompt += `\n\n**RECURRING ELEMENTS - MUST MATCH EXACTLY:**\n`;

    for (const element of relevantElements) {
      // Prefer extracted description (from actual image) over outline description
      const description = element.extractedDescription || element.description;
      prompt += `\n**${element.name}** (${element.type}):\n${description}\n`;
    }

    prompt += `\nCRITICAL: These elements have appeared before. They MUST look IDENTICAL to their descriptions above. Do not change colors, features, or any visual details.\n`;
  }

  return prompt;
}
```

---

## Implementation Checklist

### 1. Modify Outline Prompt (`prompts/outline.txt`)
- [ ] Add "Part 5: Visual Bible" section
- [ ] Define format for secondary characters, animals, artifacts, locations
- [ ] Add examples

### 2. Parse Visual Bible from Outline (`server.js`)
- [ ] Create `parseVisualBible(outline)` function
- [ ] Extract structured data for each element type
- [ ] Store in story data structure

### 3. Track First Appearances (`server.js`)
- [ ] Add `hasBeenGenerated` flag to each visual bible element
- [ ] Track which scene first generated each element

### 4. Analyze First Appearance Images (`server.js`)
- [ ] Create `analyzeVisualBibleElements(imageData, elements)` function
- [ ] Call Gemini Vision with analysis prompt
- [ ] Parse response and update visual bible with extracted descriptions

### 5. Modify Image Generation Prompt (`server.js`)
- [ ] Modify `buildSceneDescriptionPrompt()` or image prompt building
- [ ] Include relevant visual bible entries
- [ ] Use extracted descriptions when available

### 6. Store Visual Bible with Story (`server.js`)
- [ ] Add `visual_bible` column to stories table (JSONB)
- [ ] Save after outline parsing
- [ ] Update after each image analysis

---

## Example Flow

```
1. OUTLINE GENERATION
   Claude creates outline with Visual Bible:
   - Fireman Fred (scenes 3, 8, 15): "tall, gray mustache, red uniform"
   - Magic Map (scenes 4, 9, 14): "old parchment, brown ink, red X"

2. SCENE 3 GENERATION (Fireman's first appearance)
   Prompt includes: "Fireman Fred: tall, gray mustache, red uniform"
   → Gemini generates image
   → Image analysis extracts: "Fireman Fred: stocky man with big gray handlebar
      mustache, bright red uniform with 3 yellow stripes, black helmet with
      gold shield badge, ruddy complexion, small friendly eyes"
   → Visual Bible updated with extracted description

3. SCENE 8 GENERATION (Fireman's second appearance)
   Prompt includes extracted description: "stocky man with big gray handlebar
   mustache, bright red uniform with 3 yellow stripes, black helmet with
   gold shield badge..."
   → Gemini generates CONSISTENT fireman

4. SCENE 4 GENERATION (Map's first appearance)
   Same process for the map...
```

---

## Cost Analysis

| Step | API Call | Cost per Story |
|------|----------|----------------|
| Outline (already exists) | Claude | +0 (just longer prompt) |
| Image Analysis (first appearances) | Gemini Vision | ~$0.01 per element |
| Image Generation | Gemini | +0 (just longer prompt) |

**Estimated extra cost:** $0.03-0.10 per story (3-10 unique recurring elements)

---

## Decisions Made

1. **Store reference image?** → **NO, text only**
   - Just store extracted text descriptions
   - Simpler, less storage

2. **User editing?** → **Developer mode only**
   - Show Visual Bible on final story page in developer mode
   - Regular users don't see it
   - Developers can inspect/debug consistency issues

3. **Regeneration handling?** → **Context-dependent**
   - **During initial generation** (auto-retry for quality): Update bible from new image
   - **Manual regenerate after story complete**: Pass existing bible along, don't update
   - This prevents breaking consistency of already-generated scenes

4. **Main character clothing changes?**
   - Story text describes this naturally
   - Visual Bible is for RECURRING elements that need consistency
   - Intentional changes (pajamas → adventure clothes) are handled by scene descriptions

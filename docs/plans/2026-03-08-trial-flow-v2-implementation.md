# Trial Flow v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Simplify and speed up trial story generation — pre-defined costumes, parallel avatar generation, title page, no scene expansion, progressive image retry on Gemini blocks.

**Architecture:** Keep trial in the unified pipeline (`processUnifiedStoryJob` in server.js) with flag-based behavior. New costume config file replaces outline-generated clothing. Image retry wrapper added to `generateImageOnly` in images.js.

**Tech Stack:** Node.js/Express backend, Gemini image API, Claude text API

**Design spec:** `docs/plans/2026-03-08-trial-flow-v2-design.md`

---

### Task 1: Create Trial Costume Config

**Files:**
- Create: `server/config/trialCostumes.js`

**Step 1: Create the costume config file**

Create `server/config/trialCostumes.js` with costume descriptions for all adventure themes and historical events. Each entry has `male` and `female` costume descriptions. Historical costumes should be pulled from `prompts/historical-guides.txt` (search for "PERIOD COSTUMES" sections).

```javascript
// server/config/trialCostumes.js
// Pre-defined costumes per story topic for trial stories
// Each entry: { male: "description", female: "description" }
// NO face coverings (helmets, masks, face-covering hats) — faces must stay visible

const TRIAL_COSTUMES = {
  // ══════════════════════════════════════════════════════════════
  // ADVENTURE THEMES
  // ══════════════════════════════════════════════════════════════
  adventure: {
    pirate: {
      male: "Striped sailor shirt, brown leather vest, loose canvas trousers tucked into tall boots, wide leather belt with brass buckle",
      female: "Striped sailor blouse, brown leather corset vest, flowing skirt over trousers, tall boots, wide leather belt"
    },
    knight: {
      male: "Silver chain mail tunic over padded gambeson, leather bracers, brown leather boots, simple sword belt",
      female: "Silver chain mail tunic over padded gambeson, leather bracers, brown leather boots, simple sword belt"
    },
    cowboy: {
      male: "Denim jeans, plaid flannel shirt, brown leather vest, cowboy boots with spurs, bandana around neck",
      female: "Denim jeans, plaid flannel shirt, brown leather vest, cowboy boots, bandana around neck"
    },
    ninja: {
      male: "Dark blue traditional ninja outfit (shinobi shozoku), cloth wraps on forearms, soft tabi boots",
      female: "Dark blue traditional ninja outfit (shinobi shozoku), cloth wraps on forearms, soft tabi boots"
    },
    viking: {
      male: "Brown fur-trimmed tunic, leather bracers, thick leather belt with round buckle, fur-lined boots, woolen cloak",
      female: "Long woolen dress with embroidered trim, leather belt with pouch, fur-lined cloak, leather boots"
    },
    roman: {
      male: "White tunic (tunica) with red trim, leather sandals (caligae), leather wrist guards, simple belt",
      female: "White stola dress with golden trim, leather sandals, simple belt with decorative clasp"
    },
    egyptian: {
      male: "White linen kilt (shendyt), gold collar necklace, leather sandals, gold arm bands",
      female: "White linen dress with gold belt, beaded collar necklace, leather sandals, gold arm bands"
    },
    greek: {
      male: "White chiton tunic with blue border, leather sandals, rope belt, simple shoulder clasp",
      female: "White flowing peplos dress with golden trim, leather sandals, golden waist belt"
    },
    caveman: {
      male: "Animal fur tunic, leather cord belt, bare feet or simple leather wraps, bone necklace",
      female: "Animal fur dress, leather cord belt, bare feet or simple leather wraps, shell necklace"
    },
    samurai: {
      male: "Traditional hakama pants, kimono top with family crest, obi sash belt, wooden sandals (geta)",
      female: "Traditional hakama pants, kimono top with floral pattern, obi sash belt, wooden sandals (geta)"
    },
    wizard: {
      male: "Long flowing robe in deep blue with silver star patterns, leather belt with pouch, pointed cloth shoes",
      female: "Long flowing robe in deep purple with golden moon patterns, leather belt with pouch, pointed cloth shoes"
    },
    dragon: {
      male: "Leather armor vest with scale pattern, sturdy boots, arm guards, adventurer's belt with pouches",
      female: "Leather armor vest with scale pattern, sturdy boots, arm guards, adventurer's belt with pouches"
    },
    superhero: {
      male: "Bright colored bodysuit with cape, boots, utility belt, emblem on chest",
      female: "Bright colored bodysuit with cape, boots, utility belt, emblem on chest"
    },
    detective: {
      male: "Tweed jacket, white shirt, brown trousers, polished shoes, magnifying glass on a chain",
      female: "Tweed blazer, white blouse, plaid skirt, polished shoes, magnifying glass on a chain"
    },
    unicorn: {
      male: "Shimmering white tunic with rainbow trim, silver boots, crystal pendant, star-dusted cape",
      female: "Shimmering white dress with rainbow ribbons, silver shoes, crystal tiara, star-dusted cape"
    },
    mermaid: {
      male: "Shimmering scale-pattern vest in sea green, loose trousers, shell necklace, coral arm band",
      female: "Shimmering scale-pattern top in sea green, flowing skirt with fin-like hem, shell necklace, coral tiara"
    },
    dinosaur: {
      male: "Khaki explorer shorts, safari vest with many pockets, hiking boots, adventurer's belt",
      female: "Khaki explorer shorts, safari vest with many pockets, hiking boots, adventurer's belt"
    },
    space: {
      male: "Silver-white space suit with blue patches, utility belt, space boots, mission patch on shoulder",
      female: "Silver-white space suit with blue patches, utility belt, space boots, mission patch on shoulder"
    },
    ocean: {
      male: "Wetsuit in blue and black, diving flippers, waterproof utility belt",
      female: "Wetsuit in blue and black, diving flippers, waterproof utility belt"
    },
    jungle: {
      male: "Khaki shorts, green explorer shirt with rolled sleeves, hiking boots, canvas backpack",
      female: "Khaki shorts, green explorer shirt with rolled sleeves, hiking boots, canvas backpack"
    },
    farm: {
      male: "Denim overalls over plaid shirt, rubber boots, straw in pocket",
      female: "Denim overalls over plaid shirt, rubber boots, gardening gloves tucked in pocket"
    },
    forest: {
      male: "Green tunic, brown leather boots, hooded cloak, leather belt with pouch",
      female: "Green tunic dress, brown leather boots, hooded cloak, leather belt with pouch"
    },
    fireman: {
      male: "Yellow firefighter turnout coat with reflective stripes, dark trousers, rubber boots",
      female: "Yellow firefighter turnout coat with reflective stripes, dark trousers, rubber boots"
    },
    doctor: {
      male: "White lab coat over blue scrubs, comfortable shoes, stethoscope around neck",
      female: "White lab coat over blue scrubs, comfortable shoes, stethoscope around neck"
    },
    police: {
      male: "Dark blue police uniform shirt with badge, dark trousers, black shoes, utility belt",
      female: "Dark blue police uniform shirt with badge, dark trousers, black shoes, utility belt"
    },
    christmas: {
      male: "Red velvet suit with white fur trim, black boots, wide black belt with gold buckle",
      female: "Red velvet dress with white fur trim, black boots, candy cane striped stockings"
    },
    newyear: {
      male: "Sparkly formal suit in midnight blue, bow tie, shiny shoes, party hat",
      female: "Sparkly formal dress in midnight blue, shiny shoes, glittery tiara"
    },
    easter: {
      male: "Pastel colored vest over white shirt, light trousers, bow tie, basket",
      female: "Pastel colored dress with flower pattern, white shoes, flower crown"
    },
    halloween: {
      male: "Black cape over dark clothes, spiderweb-patterned vest, dark boots",
      female: "Black cape over dark dress, spiderweb-patterned bodice, dark boots"
    }
  },

  // ══════════════════════════════════════════════════════════════
  // HISTORICAL EVENTS
  // Period costumes extracted from prompts/historical-guides.txt
  // ══════════════════════════════════════════════════════════════
  historical: {
    // Swiss History
    'swiss-founding': {
      male: "Simple woolen tunic, leather belt, fur-lined cloak, leather boots, woolen leggings",
      female: "Long woolen dress with linen apron, leather belt, woolen shawl, leather shoes"
    },
    'wilhelm-tell': {
      male: "Simple farmer's tunic, leather breeches, sturdy boots, woolen cloak, leather belt",
      female: "Long woolen dress with embroidered bodice, white linen apron, leather shoes"
    },
    'battle-morgarten': {
      male: "Padded linen gambeson, leather bracers, simple chain mail vest, leather boots, woolen cloak",
      female: "Long woolen dress with linen apron, leather belt, woolen shawl"
    },
    'battle-sempach': {
      male: "Padded gambeson, leather bracers, chain mail vest, leather boots, cloth surcoat with Swiss cross",
      female: "Long woolen dress with embroidered trim, leather belt, linen head covering"
    },
    'swiss-reformation': {
      male: "Dark scholar's robe, white collar, simple leather shoes, leather belt with book pouch",
      female: "Plain dark dress with white collar and cuffs, linen cap, leather shoes"
    },
    'red-cross-founding': {
      male: "Dark formal suit with white shirt, cravat, leather shoes, top hat (carried)",
      female: "Dark dress with white collar, nurse's apron with red cross, leather shoes"
    },
    'general-dufour': {
      male: "Swiss military uniform with brass buttons, dark blue jacket, white trousers, leather boots",
      female: "Simple dress with white apron, bonnet, leather shoes"
    },
    'sonderbund-war': {
      male: "Swiss military coat with brass buttons, dark trousers, leather boots, peaked cap (carried)",
      female: "Simple dress with shawl, leather shoes, bonnet"
    },
    'swiss-constitution': {
      male: "Formal dark suit, white shirt with high collar, leather shoes, pocket watch chain",
      female: "Elegant dress with lace collar, leather shoes, small brooch"
    },
    'gotthard-tunnel': {
      male: "Work shirt, sturdy trousers, heavy leather boots, suspenders, cloth cap",
      female: "Simple work dress with apron, sturdy boots, kerchief"
    },
    'swiss-ww1-neutrality': {
      male: "Swiss military uniform (grey-green), puttees, leather boots, kepi cap (carried)",
      female: "White blouse with dark skirt, Red Cross armband, sensible shoes"
    },
    'general-guisan': {
      male: "Swiss WWII military uniform, leather boots, officer's belt, peaked cap (carried)",
      female: "Practical dress with cardigan, sensible shoes, civil defense armband"
    },
    'swiss-ww2-neutrality': {
      male: "Swiss military uniform (grey-green), leather boots, ammunition belt, field cap (carried)",
      female: "Practical dress with apron, cardigan, sensible shoes"
    },
    'swiss-womens-vote': {
      male: "1970s suit with wide lapels, patterned tie, leather shoes",
      female: "1970s dress or blouse with A-line skirt, sensible shoes, protest sash"
    },

    // Exploration & Discovery
    'moon-landing': {
      male: "White NASA spacesuit with American flag patch, life support chest panel, white boots",
      female: "White NASA spacesuit with American flag patch, life support chest panel, white boots"
    },
    'columbus-voyage': {
      male: "Renaissance sailor tunic, loose trousers, leather shoes, cloth cap, rope belt",
      female: "Renaissance blouse with laced bodice, long skirt, leather shoes, cloth cap"
    },
    'wright-brothers': {
      male: "Early 1900s suit with waistcoat, white shirt, bow tie, leather shoes, newsboy cap",
      female: "Early 1900s blouse with long skirt, leather boots, simple jacket"
    },
    'lindbergh-flight': {
      male: "Leather flight jacket, white scarf, flight goggles (on forehead), leather boots",
      female: "Leather flight jacket, white scarf, flight goggles (on forehead), leather boots"
    },
    'everest-summit': {
      male: "Thick down climbing jacket, insulated trousers, heavy climbing boots, goggles (on forehead)",
      female: "Thick down climbing jacket, insulated trousers, heavy climbing boots, goggles (on forehead)"
    },
    'south-pole': {
      male: "Heavy wool sweater, fur-lined anorak, thick trousers, mukluks, mittens",
      female: "Heavy wool sweater, fur-lined anorak, thick trousers, mukluks, mittens"
    },
    'magellan-circumnavigation': {
      male: "Renaissance sailor outfit, loose shirt, knee breeches, leather shoes, cloth sash belt",
      female: "Renaissance blouse, long skirt, leather shoes, cloth sash belt"
    },
    'mariana-trench': {
      male: "Deep-sea research jumpsuit, utility belt, waterproof boots",
      female: "Deep-sea research jumpsuit, utility belt, waterproof boots"
    },

    // Science & Medicine
    'electricity-discovery': {
      male: "18th century waistcoat over white shirt, knee breeches, white stockings, buckle shoes",
      female: "18th century dress with lace trim, leather shoes, simple bonnet"
    },
    'penicillin': {
      male: "White lab coat, shirt and tie underneath, leather shoes, round spectacles",
      female: "White lab coat, blouse underneath, leather shoes, hair pinned up"
    },
    'vaccine-discovery': {
      male: "18th century doctor's coat, white shirt, waistcoat, knee breeches, leather shoes",
      female: "18th century dress with linen apron, leather shoes, bonnet"
    },
    'dna-discovery': {
      male: "1950s lab coat over shirt and tie, leather shoes, reading glasses",
      female: "1950s lab coat over blouse, leather shoes, hair pinned neatly"
    },
    'dinosaur-discovery': {
      male: "Victorian field outfit: tweed jacket, sturdy trousers, leather boots, canvas satchel",
      female: "Victorian field outfit: practical dress with apron, leather boots, canvas satchel"
    },
    'einstein-relativity': {
      male: "Rumpled tweed suit, white shirt (no tie), wild hair, leather shoes, chalk-dusted sleeves",
      female: "Early 1900s blouse with long skirt, leather shoes, hair in bun"
    },
    'galapagos-darwin': {
      male: "Victorian naturalist outfit: linen shirt, waistcoat, sturdy trousers, leather boots, specimen bag",
      female: "Victorian explorer dress with practical apron, leather boots, specimen bag"
    },
    'first-heart-transplant': {
      male: "Surgical scrubs, white coat, surgical cap, comfortable shoes",
      female: "Surgical scrubs, white coat, surgical cap, comfortable shoes"
    },
    'human-genome': {
      male: "Modern lab coat over casual shirt, safety glasses, comfortable shoes",
      female: "Modern lab coat over casual blouse, safety glasses, comfortable shoes"
    },
    'hubble-launch': {
      male: "NASA flight suit with mission patches, boots, crew badge",
      female: "NASA flight suit with mission patches, boots, crew badge"
    },

    // Inventions
    'telephone-invention': {
      male: "Victorian suit with waistcoat, white shirt, cravat, leather shoes",
      female: "Victorian dress with bustle, lace collar, leather boots"
    },
    'light-bulb': {
      male: "Dark waistcoat over white shirt, dark trousers, leather shoes, bow tie",
      female: "Victorian blouse with long skirt, leather shoes, simple brooch"
    },
    'printing-press': {
      male: "Medieval craftsman's tunic, leather apron, simple leather shoes, cloth cap",
      female: "Medieval dress with linen apron, leather shoes, linen head covering"
    },
    'internet-creation': {
      male: "1990s casual: polo shirt, khaki trousers, sneakers",
      female: "1990s casual: blouse, khaki trousers, sneakers"
    },

    // Human Rights & Freedom
    'emancipation': {
      male: "Simple cotton shirt, suspenders, worn trousers, bare feet or simple shoes",
      female: "Simple cotton dress, head wrap, bare feet or simple shoes"
    },
    'womens-suffrage': {
      male: "Early 1900s suit, white shirt, tie, leather shoes",
      female: "Early 1900s white blouse with long skirt, sash reading 'Votes for Women', leather boots"
    },
    'rosa-parks': {
      male: "1950s suit, white shirt, tie, fedora hat (carried), leather shoes",
      female: "1950s modest dress with coat, small hat, gloves, sensible shoes"
    },
    'berlin-wall-fall': {
      male: "1989 casual: jeans, denim jacket, sneakers, scarf",
      female: "1989 casual: jeans, warm jacket, sneakers, scarf"
    },
    'mandela-freedom': {
      male: "Colorful African-print shirt (Madiba shirt), dark trousers, leather shoes",
      female: "Colorful African-print dress, headwrap, leather shoes"
    },

    // Great Constructions
    'pyramids': {
      male: "White linen kilt (shendyt), leather sandals, beaded collar, gold arm bands",
      female: "White linen dress, leather sandals, beaded collar, gold arm bands"
    },
    'eiffel-tower': {
      male: "1880s work shirt, sturdy trousers, leather boots, suspenders, cloth cap",
      female: "1880s dress with bustle and lace trim, leather boots, parasol"
    },
    'panama-canal': {
      male: "Work shirt, khaki trousers, leather boots, wide-brimmed hat (carried), bandana",
      female: "Practical blouse, khaki skirt, leather boots, sun bonnet"
    },
    'golden-gate': {
      male: "1930s work overalls, flannel shirt, leather boots, cloth cap",
      female: "1930s dress with cardigan, sensible shoes, cloche hat"
    },
    'channel-tunnel': {
      male: "Modern construction jumpsuit, safety vest, steel-toe boots",
      female: "Modern construction jumpsuit, safety vest, steel-toe boots"
    },

    // Culture & Arts
    'first-olympics': {
      male: "Ancient Greek athletic tunic (chiton), leather sandals, olive wreath crown",
      female: "Ancient Greek dress (peplos), leather sandals, olive wreath crown"
    },
    'disneyland-opening': {
      male: "1950s casual: polo shirt, slacks, saddle shoes, crew cut",
      female: "1950s dress with petticoat, bobby socks, saddle shoes, hair ribbon"
    },
    'first-movie': {
      male: "1890s suit with bowler hat (carried), waistcoat, pocket watch chain, leather shoes",
      female: "1890s dress with high collar, cameo brooch, leather boots"
    },
    'first-zoo': {
      male: "Regency-era tailcoat, white cravat, knee breeches, leather boots",
      female: "Regency-era dress with high waist, bonnet, leather shoes, parasol"
    },
    'natural-history-museum': {
      male: "Victorian suit, top hat (carried), walking cane, leather shoes",
      female: "Victorian dress with bustle, lace gloves, leather boots, small hat"
    },

    // Archaeological Discoveries
    'king-tut': {
      male: "1920s khaki safari suit, leather boots, pith helmet (carried), field notebook",
      female: "1920s khaki field outfit, leather boots, wide-brimmed sun hat, field notebook"
    },
    'pompeii-discovery': {
      male: "18th century scholar's outfit: coat, waistcoat, breeches, leather shoes, sketch pad",
      female: "18th century dress with practical apron, leather shoes, sketch pad"
    },
    'terracotta-army': {
      male: "1970s archaeologist outfit: khaki shirt, sturdy trousers, leather boots, sun hat (carried)",
      female: "1970s archaeologist outfit: khaki shirt, sturdy trousers, leather boots, sun hat (carried)"
    }
  }
};

/**
 * Get trial costume for a character based on story topic and category.
 * @param {string} storyTopic - The story topic ID (e.g., 'pirate', 'moon-landing')
 * @param {string} storyCategory - The story category ('adventure', 'historical')
 * @param {string} gender - Character gender ('male', 'female', or empty)
 * @returns {{ costumeType: string, description: string } | null}
 */
function getTrialCostume(storyTopic, storyCategory, gender) {
  const category = storyCategory === 'historical' ? 'historical' : 'adventure';
  const costumes = TRIAL_COSTUMES[category]?.[storyTopic];
  if (!costumes) return null;

  // Default to male if gender not specified or unrecognized
  const genderKey = gender?.toLowerCase() === 'female' ? 'female' : 'male';
  return {
    costumeType: storyTopic,
    description: costumes[genderKey]
  };
}

module.exports = { TRIAL_COSTUMES, getTrialCostume };
```

**Step 2: Commit**

```bash
git add server/config/trialCostumes.js
git commit -m "Add pre-defined costume config for trial stories"
```

---

### Task 2: Rewrite Trial Prompt

**Files:**
- Modify: `prompts/story-trial.txt`

**Step 1: Replace the trial prompt**

Replace the entire content of `prompts/story-trial.txt` with the new simplified version. Key changes:
- Remove `---CLOTHING REQUIREMENTS---` section entirely
- Remove `{COSTUME_INSTRUCTION}` placeholder
- Remove `---COVER SCENE HINTS---` section
- Simplify visual bible to locations + keyObjects only
- Make scene hints richer (they'll be used directly, no expansion)
- Add avatar selection section with `{COSTUME_TYPE}` and `{COSTUME_DESCRIPTION}` placeholders
- Add `{AVATAR_SELECTION}` placeholder (entire section, so it can be omitted if no costume)

New content:
```
# Trial Story Generation

You write children's stories. Create a {PAGES}-scene story.
SHORT story — {PAGES} scenes. Keep it focused:
- One clear conflict, one resolution. No subplots.
- Introduce quickly (scene 1), build tension (2-3), resolve (4-5).

**Rules:**
- Write EVERYTHING in {LANGUAGE}. All text, title, scene hints — 100% in {LANGUAGE}. {LANGUAGE_NOTE}
- NO questions, just produce the output
- Keep it simple, warm, and age-appropriate
- 150-200 words per page, flowing paragraphs
- Start with action, not weather or waking up
- Show character personality through actions

# Story Parameters

- **Scenes**: {PAGES}
- **Language**: {LANGUAGE}
- **Characters**: {CHARACTERS}
- **Story Idea**: {STORY_DETAILS}

{AVATAR_SELECTION}

# Scene Hint Format

Each scene hint must be detailed enough for direct image generation (no further expansion).
Include: setting details, mood, lighting, colors, textures, atmosphere, character positions, key actions.

```
SCENE HINT:
[2-3 detailed sentences describing the visual scene. Include specific colors, lighting, atmosphere, character expressions and poses.]
Characters:
- [Name] (left/right/center): [standard | costumed:{type}]
Setting: [indoor/outdoor] | Time: [morning/afternoon/evening/night] | Weather: [sunny/cloudy/rainy/snowy/n/a]
Key objects: [list any visual bible objects visible in scene]
```

MAX 2 characters per scene hint. Every character needs a position (left/right/center). Use n/a for indoor weather.

# OUTPUT FORMAT

Output ALL sections in this EXACT order. Do not skip any.

---TITLE---
TITLE: [A creative, specific title in {LANGUAGE}]

---VISUAL BIBLE---
```json
{
  "locations": [
    { "id": "LOC001", "name": "[Main location name]", "pages": [1, 2, 3], "type": "location", "description": "[key visual features: colors, architectural style, lighting, atmosphere]" }
  ],
  "keyObjects": [
    { "id": "OBJ001", "name": "[Important object]", "pages": [2, 3, 4], "type": "artifact", "description": "[appearance: shape, color, material, size, distinctive features]" }
  ]
}
```
Keep it minimal: max 2-3 locations, 1-2 key objects. Only include elements that appear on 2+ pages.

---STORY PAGES---

--- Page 1 ---
TEXT:
[Story text, 150-200 words]

SCENE HINT:
[2-3 detailed sentences for image generation]
Characters:
- [Name] (position): [standard or costumed:{type}]
Setting: [indoor/outdoor] | Time: [time] | Weather: [weather]
Key objects: [objects from visual bible, if any]

--- Page 2 ---
TEXT:
[Story continues...]

SCENE HINT:
[2-3 detailed sentences for image generation]
Characters:
- [Name] (position): [standard or costumed:{type}]
Setting: [indoor/outdoor] | Time: [time] | Weather: [weather]
Key objects: [objects from visual bible, if any]

... continue for ALL {PAGES} pages ...
```

**Step 2: Commit**

```bash
git add prompts/story-trial.txt
git commit -m "Simplify trial prompt: remove clothing section, richer scene hints"
```

---

### Task 3: Update buildTrialStoryPrompt()

**Files:**
- Modify: `server/lib/storyHelpers.js:3318-3360`

**Step 1: Update the function to use costume config**

Replace the `buildTrialStoryPrompt` function. Changes:
- Import `getTrialCostume` from `server/config/trialCostumes.js`
- Remove `costumedThemes` hardcoded map
- Look up costume from config file
- Build `AVATAR_SELECTION` section conditionally (empty if no costume for topic)
- New placeholders: `{AVATAR_SELECTION}`

```javascript
function buildTrialStoryPrompt(inputData, sceneCount = null) {
  const pageCount = sceneCount || inputData.pages || 5;
  const language = inputData.language || 'en';

  const characterDesc = (inputData.characters || []).map(char => {
    const parts = [char.name];
    if (char.age) parts.push(`age ${char.age}`);
    if (char.gender) parts.push(char.gender);
    if (char.traits?.length) parts.push(`traits: ${char.traits.join(', ')}`);
    return parts.join(', ');
  }).join('\n');

  if (PROMPT_TEMPLATES.storyTrial) {
    // Look up costume from config
    const { getTrialCostume } = require('../config/trialCostumes');
    const mainChar = (inputData.characters || [])[0];
    const costume = getTrialCostume(
      inputData.storyTopic || inputData.storyTheme || '',
      inputData.storyCategory || 'adventure',
      mainChar?.gender || ''
    );

    // Build avatar selection section (only if costume available)
    let avatarSelection = '';
    if (costume) {
      avatarSelection = `# Avatar Selection
The main character has two avatar styles available:
- \`standard\` — everyday modern clothes
- \`costumed:${costume.costumeType}\` — ${costume.description}

Use \`standard\` for the opening scene (before the adventure begins).
Use \`costumed:${costume.costumeType}\` for all other scenes.
NO face coverings — faces must stay visible at all times.`;
    }

    return fillTemplate(PROMPT_TEMPLATES.storyTrial, {
      LANGUAGE_INSTRUCTION: getLanguageInstruction(language),
      PAGES: pageCount,
      LANGUAGE: getLanguageNameEnglish(language),
      LANGUAGE_NOTE: getLanguageNote(language),
      CHARACTERS: characterDesc || 'A child',
      STORY_DETAILS: inputData.storyDetails || inputData.storyTheme || 'A fun adventure',
      AVATAR_SELECTION: avatarSelection,
    });
  }

  // Fallback
  return `Create a ${pageCount}-page children's story in ${getLanguageNameEnglish(language)}.
Character: ${characterDesc}
Story: ${inputData.storyDetails || 'A fun adventure'}
Output: Title, then each page with story text and a scene hint for illustration.`;
}
```

**Step 2: Commit**

```bash
git add server/lib/storyHelpers.js
git commit -m "Update buildTrialStoryPrompt to use costume config instead of outline-generated clothing"
```

---

### Task 4: Add Progressive Image Retry to generateImageOnly

**Files:**
- Modify: `server/lib/images.js:2574-2931` (generateImageOnly function)

**Step 1: Add sanitization helpers at top of the function section (before generateImageOnly)**

Add these near the top of images.js (after imports, before functions), around line 45:

```javascript
// Problematic words that may trigger Gemini content filtering
const PROBLEMATIC_WORDS = [
  // Violence
  'weapon', 'sword', 'knife', 'dagger', 'spear', 'axe', 'bow and arrow',
  'blood', 'bleeding', 'wound', 'injured', 'injury',
  'kill', 'killing', 'death', 'dead', 'dying', 'corpse',
  'attack', 'attacking', 'fight', 'fighting', 'combat', 'battle', 'war',
  'explosion', 'exploding', 'bomb', 'gun', 'pistol', 'rifle', 'shoot', 'shooting',
  'violent', 'violence', 'aggressive',
  // Horror
  'scary', 'horror', 'terrifying', 'nightmare', 'monster',
  'torture', 'torment', 'suffering', 'agony',
  'poison', 'poisonous', 'toxic', 'venom',
  // Fire/destruction
  'fire', 'burning', 'flames', 'ablaze', 'inferno',
  'destroy', 'destruction', 'devastation', 'ruins',
  // Other
  'slave', 'slavery', 'chains', 'shackles', 'prisoner',
  'drunk', 'alcohol', 'wine', 'beer',
  'naked', 'nude', 'undressed',
  'evil', 'demonic', 'devil', 'satan', 'hell',
  'skull', 'skeleton', 'bones'
];

/**
 * Remove problematic words from a prompt (Level 1 sanitization)
 */
function sanitizePromptLevel1(prompt) {
  let sanitized = prompt;
  for (const word of PROBLEMATIC_WORDS) {
    // Replace whole words only (case-insensitive)
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    sanitized = sanitized.replace(regex, '');
  }
  // Clean up double spaces and empty lines
  sanitized = sanitized.replace(/  +/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n');
  return sanitized;
}

/**
 * Simplify prompt to core scene elements only (Level 2 sanitization)
 * Keeps: art style, character names/positions, setting, time, weather
 * Removes: detailed descriptions, mood, atmosphere
 */
function sanitizePromptLevel2(prompt) {
  // Try to extract key elements from the prompt
  const settingMatch = prompt.match(/Setting:\s*([^\n|]+)/i);
  const timeMatch = prompt.match(/Time:\s*([^\n|]+)/i);
  const styleMatch = prompt.match(/(?:art\s*style|style):\s*([^\n,]+)/i);
  const charMatches = prompt.match(/(?:Characters?|Character Reference).*?(?:\n|:)([\s\S]*?)(?=Setting:|Key objects:|$)/i);

  const setting = settingMatch ? settingMatch[1].trim() : 'a scenic location';
  const time = timeMatch ? timeMatch[1].trim() : 'daytime';
  const style = styleMatch ? styleMatch[1].trim() : 'watercolor';

  // Extract just character names
  let characters = 'a child';
  if (charMatches) {
    const names = charMatches[1].match(/[\w]+(?:\s+[\w]+)?(?=\s*\()/g);
    if (names) characters = names.join(' and ');
  }

  return `A ${style} illustration of ${characters} in ${setting} during ${time}. Warm, friendly, child-appropriate scene. Bright colors, soft lighting.`;
}

/**
 * Build minimal fallback prompt (Level 3 sanitization)
 */
function sanitizePromptLevel3(artStyle) {
  const style = artStyle || 'watercolor';
  return `A beautiful ${style} illustration of a happy child on an adventure in a colorful, magical setting. Bright, warm colors. Friendly atmosphere. Child-appropriate.`;
}
```

**Step 2: Modify generateImageOnly to wrap the Gemini call with retry logic**

In `generateImageOnly`, replace the section from line ~2853 (the `withRetry` Gemini API call) through line ~2931 (end of function). The key change: catch block errors, detect safety blocks, retry with sanitized prompt.

Replace the Gemini API call section (from line 2853 `const data = await withRetry(...)` through end of function at line 2931) with:

```javascript
  // Progressive retry with sanitization on safety blocks
  const sanitizationLevels = [
    null,                                                    // Level 0: original prompt
    () => sanitizePromptLevel1(prompt),                      // Level 1: remove problematic words
    () => sanitizePromptLevel2(prompt),                      // Level 2: simplify to core scene
    () => sanitizePromptLevel3(inputData?.artStyle || 'watercolor')  // Level 3: minimal fallback
  ];

  for (let sanitizationLevel = 0; sanitizationLevel < sanitizationLevels.length; sanitizationLevel++) {
    // Apply sanitization if needed
    let currentPrompt = prompt;
    if (sanitizationLevel > 0) {
      currentPrompt = sanitizationLevels[sanitizationLevel]();
      parts[0] = { text: currentPrompt };
      log.info(`🔄 [IMAGE GEN-ONLY] Retry with sanitization level ${sanitizationLevel}, prompt: ${currentPrompt.substring(0, 100)}...`);
    }

    try {
      const data = await withRetry(async () => {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
          }
        );

        if (!response.ok) {
          const error = await response.text();
          log.error('❌ [IMAGE GEN-ONLY] Gemini API error response:', error);
          const err = new Error(`Gemini API error (${response.status}): ${error}`);
          err.status = response.status;
          throw err;
        }

        return response.json();
      }, { maxRetries: 2, baseDelay: 2000 });

      // Extract token usage
      const usage = {
        input_tokens: data.usageMetadata?.promptTokenCount || 0,
        output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
        thinking_tokens: data.usageMetadata?.thoughtsTokenCount || 0
      };

      if (!data.candidates || data.candidates.length === 0) {
        // No candidates = likely safety block
        log.warn(`⚠️ [IMAGE GEN-ONLY] No candidates (safety block?) at level ${sanitizationLevel}`);
        if (sanitizationLevel < sanitizationLevels.length - 1) continue;
        throw new Error('No image generated - no candidates in response');
      }

      const candidate = data.candidates[0];
      const thinkingText = extractThinkingFromParts(candidate.content?.parts, 'IMAGE GEN-ONLY');

      // Check for safety block at candidate level
      const finishReason = candidate.finishReason;
      if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') {
        log.warn(`⚠️ [IMAGE GEN-ONLY] Content blocked (${finishReason}) at level ${sanitizationLevel}`);
        if (sanitizationLevel < sanitizationLevels.length - 1) continue;
        throw new Error(`Image blocked by API: reason=${finishReason}`);
      }

      if (candidate.content && candidate.content.parts) {
        for (const part of candidate.content.parts) {
          const inlineData = part.inlineData || part.inline_data;
          if (inlineData && inlineData.data) {
            const pngImageData = `data:image/png;base64,${inlineData.data}`;
            const compressedImageData = await compressImageToJPEG(pngImageData);

            if (onImageReady) {
              try {
                await onImageReady(compressedImageData, modelId);
              } catch (callbackError) {
                log.error('⚠️ [IMAGE GEN-ONLY] onImageReady callback error:', callbackError.message);
              }
            }

            const result = {
              imageData: compressedImageData,
              modelId,
              thinkingText,
              usage,
              sanitizationLevel // Track which level succeeded
            };

            if (!skipCache) imageCache.set(genOnlyCacheKey, result);
            if (sanitizationLevel > 0) {
              log.info(`✅ [IMAGE GEN-ONLY] Image generated with sanitization level ${sanitizationLevel}`);
            } else {
              log.info(`✅ [IMAGE GEN-ONLY] Image generated successfully`);
            }
            return result;
          }
        }
      }

      // No image data in response but also not explicitly blocked
      const reason = candidate.finishReason || 'unknown';
      log.warn(`⚠️ [IMAGE GEN-ONLY] No image data, reason=${reason} at level ${sanitizationLevel}`);
      if (sanitizationLevel < sanitizationLevels.length - 1) continue;
      throw new Error(`Image blocked by API: reason=${reason}`);

    } catch (error) {
      const errorMsg = error.message?.toLowerCase() || '';
      const isSafetyBlock = errorMsg.includes('blocked') || errorMsg.includes('safety') ||
                            errorMsg.includes('prohibited') || errorMsg.includes('filtered') ||
                            errorMsg.includes('no candidates') || errorMsg.includes('no image generated');

      if (isSafetyBlock && sanitizationLevel < sanitizationLevels.length - 1) {
        log.warn(`⚠️ [IMAGE GEN-ONLY] Safety block at level ${sanitizationLevel}, trying level ${sanitizationLevel + 1}...`);
        continue;
      }
      throw error;
    }
  }

  // Should not reach here, but just in case
  throw new Error('Image generation failed after all sanitization levels');
```

Note: The `inputData` parameter doesn't exist in `generateImageOnly`. We need to pass `artStyle` through options. Add `artStyle = 'watercolor'` to the destructured options at line 2575.

**Step 3: Commit**

```bash
git add server/lib/images.js
git commit -m "Add progressive prompt sanitization retry on Gemini safety blocks"
```

---

### Task 5: Update Reference Sheet to Support maxElements

**Files:**
- Modify: `server/lib/images.js:8726-8779` (generateReferenceSheet function)

**Step 1: Add maxElements parameter**

In `generateReferenceSheet`, add `maxElements` to destructured options (line 8730) and apply it after getting elements:

```javascript
async function generateReferenceSheet(visualBible, styleDescription, options = {}) {
  const {
    minAppearances = 2,
    maxPerBatch = 4,
    imageModel = null,
    maxElements = null  // NEW: limit total elements (for trial mode)
  } = options;
```

After line 8759 (`const needsReference = getElementsNeedingReferenceImages(visualBible, minAppearances);`), add:

```javascript
  // Limit elements if maxElements specified (trial mode)
  if (maxElements && needsReference.length > maxElements) {
    // Sort by page count descending, then alphabetically
    needsReference.sort((a, b) => b.pageCount - a.pageCount || a.name.localeCompare(b.name));
    needsReference.length = maxElements;
    log.info(`[REF-SHEET] Limited to top ${maxElements} elements (trial mode)`);
  }
```

Note: `needsReference` is declared with `const` — need to change to `let` at line 8759.

**Step 2: Commit**

```bash
git add server/lib/images.js
git commit -m "Add maxElements param to generateReferenceSheet for trial mode"
```

---

### Task 6: Update Unified Pipeline for Trial Mode

**Files:**
- Modify: `server.js:2148-3350` (processUnifiedStoryJob)
- Modify: `server/routes/trial.js:413-460` (createTrialStoryJob)

This is the biggest task. Changes to `processUnifiedStoryJob`:

**Step 1: Update trial.js — change skipCovers to titlePageOnly**

In `createTrialStoryJob` (line 413-460), change:
```javascript
// OLD:
skipCovers: true,
// NEW:
skipCovers: false,
titlePageOnly: true,  // Only generate title page, skip initialPage and backCover
```

**Step 2: Add early avatar styling for trial mode (before story generation)**

In `processUnifiedStoryJob`, after the `addUsage` helper (around line 2236) and before the scene count calculation (line 2246), add trial-specific early avatar styling:

```javascript
  // TRIAL MODE: Start avatar styling immediately using pre-defined costumes
  // This runs in parallel with story generation (no need to wait for outline clothing)
  if (inputData.trialMode && !skipImages && artStyle !== 'realistic') {
    const { getTrialCostume } = require('./server/config/trialCostumes');
    const mainChar = (inputData.characters || [])[0];
    const costume = getTrialCostume(
      inputData.storyTopic || inputData.storyTheme || '',
      inputData.storyCategory || 'adventure',
      mainChar?.gender || ''
    );

    // Build clothing requirements from config (not from outline)
    const trialClothingRequirements = {};
    for (const char of (inputData.characters || [])) {
      trialClothingRequirements[char.name] = {
        standard: { used: true, signature: 'none' },
        costumed: costume
          ? { used: true, costume: costume.costumeType, description: costume.description }
          : { used: false }
      };
    }

    // Store for later use (skip outline-generated clothing)
    inputData._trialClothingRequirements = trialClothingRequirements;
    inputData._trialCostumeType = costume?.costumeType || null;

    const trialAvatarRequirements = (inputData.characters || []).flatMap(char => {
      const cats = ['standard'];
      if (costume) cats.push(`costumed:${costume.costumeType}`);
      return cats.map(cat => ({
        pageNumber: 'pre-cover',
        clothingCategory: cat,
        characterNames: [char.name]
      }));
    });

    log.info(`🎨 [TRIAL] Starting immediate avatar styling (${trialAvatarRequirements.length} variants)...`);
    streamingAvatarStylingPromise = (async () => {
      try {
        await prepareStyledAvatars(inputData.characters || [], artStyle, trialAvatarRequirements, trialClothingRequirements, addUsage);
        log.info(`✅ [TRIAL] Early avatar styling complete: ${getStyledAvatarCacheStats().size} cached`);
      } catch (error) {
        log.warn(`⚠️ [TRIAL] Early avatar styling failed: ${error.message}`);
      }
    })();
  }
```

**Step 3: Skip scene expansion for trial, skip onClothingRequirements for trial**

In the `onClothingRequirements` callback (line 2684), wrap the avatar styling block:

```javascript
onClothingRequirements: (requirements) => {
  streamingClothingRequirements = requirements;
  // ... existing logging ...

  // START AVATAR STYLING EARLY (only for non-trial — trial starts avatars before streaming)
  if (!inputData.trialMode && !skipImages && artStyle !== 'realistic' && !streamingAvatarStylingPromise) {
    // ... existing avatar styling code ...
  }
},
```

In the `onTitle` callback (line 2681), add trial title page trigger:

```javascript
onTitle: (title) => {
  streamingTitle = title;

  // TRIAL MODE: Start title page generation as soon as title is known
  if (inputData.trialMode && inputData.titlePageOnly && !skipImages) {
    const mainCharNames = (inputData.characters || [])
      .filter(c => c.isMainCharacter)
      .map(c => c.name)
      .join(', ') || 'the main character';
    const theme = inputData.storyTopic || inputData.storyTheme || 'adventure';
    const titlePageHint = {
      hint: `A magical, eye-catching front cover scene featuring ${mainCharNames} in a ${theme}-themed setting. The main characters are prominently displayed, looking excited and ready for adventure. The composition leaves space at the top for the title.`,
      characterClothing: {}
    };
    // Use trial costume for title page character clothing
    if (inputData._trialCostumeType) {
      for (const char of (inputData.characters || [])) {
        titlePageHint.characterClothing[char.name] = `costumed:${inputData._trialCostumeType}`;
      }
    }
    startCoverGeneration('titlePage', titlePageHint);
    log.info(`🎨 [TRIAL] Started title page generation (title: "${title}")`);
  }
},
```

In the `onPageComplete` callback (line 2757), skip scene expansion for trial:

```javascript
onPageComplete: (page) => {
  streamingPagesDetected = Math.max(streamingPagesDetected, page.pageNumber);
  genLog.info('page_streamed', `Page ${page.pageNumber} parsed from stream`, null, { pageNumber: page.pageNumber, textLength: page.text?.length || 0 });
  streamingExpandedPages.set(page.pageNumber, page);
  // Only start scene expansion for non-trial (trial uses rich hints directly)
  if (!inputData.trialMode) {
    startSceneExpansion(page);
  }
},
```

**Step 4: Override clothing requirements and skip expansion in later phases**

After final parse (around line 2825), for trial mode use config-based clothing:

```javascript
const clothingRequirements = inputData.trialMode
  ? inputData._trialClothingRequirements
  : (parser.extractClothingRequirements() || streamingClothingRequirements);
```

For `skipCovers` logic (line 2427), update to handle `titlePageOnly`:

```javascript
const startCoverGeneration = (coverType, hint) => {
  if (streamingCoverPromises.has(coverType) || skipImages) return;
  // titlePageOnly: only allow titlePage covers
  if (inputData.titlePageOnly && coverType !== 'titlePage') return;
  if (skipCovers) return;
  // ... rest of function
```

For reference sheet generation (line 2902-2912), pass maxElements for trial:

```javascript
referenceSheetPromise = generateReferenceSheet(visualBible, styleDescription, {
  minAppearances: 2,
  maxPerBatch: 4,
  maxElements: inputData.trialMode ? 3 : null  // Trial: top 3 only
}).catch(err => {
```

For PHASE 3 scene expansion (lines 3066-3134), skip for trial:

```javascript
// PHASE 3: Wait for scene expansion to complete (most should be done by now)
if (inputData.trialMode) {
  // Trial mode: use enriched scene hints directly as scene descriptions
  log.info(`⏭️ [TRIAL] Skipping scene expansion — using rich scene hints directly`);
  // Build expandedScenes from storyPages directly
  const expandedScenes = storyPages.map(page => ({
    pageNumber: page.pageNumber,
    text: page.text,
    sceneHint: page.sceneHint,
    sceneDescription: page.sceneHint, // Use hint directly as scene description
    characterClothing: page.characterClothing || {},
    characters: page.characters
  }));
  // ... continue to PHASE 4 with these expandedScenes
} else {
  // Normal flow: existing scene expansion code
  genLog.setStage('scenes');
  // ... existing code ...
}
```

This requires restructuring the code so `expandedScenes` is declared before the if/else and assigned in both branches.

For the covers section (lines 3054-3064), skip non-title covers for trial:

```javascript
if (!skipImages && !skipCovers && coverHints) {
  const coverTypes = inputData.titlePageOnly
    ? ['titlePage']  // Trial: only title page
    : ['titlePage', 'initialPage', 'backCover'];
  for (const coverType of coverTypes) {
    const hint = coverHints[coverType];
    if (hint && !streamingCoverPromises.has(coverType)) {
      startCoverGeneration(coverType, hint);
    }
  }
}
```

**Step 5: Commit**

```bash
git add server.js server/routes/trial.js
git commit -m "Wire up trial flow v2: parallel avatars, title page, skip scene expansion, top 3 landmarks"
```

---

### Task 7: Test and Verify

**Step 1: Check for syntax errors**

```bash
node -e "require('./server.js')" 2>&1 | head -5
```

Or simpler — just check individual modules:

```bash
node -e "require('./server/config/trialCostumes.js')"
node -e "require('./server/lib/storyHelpers.js')"
```

**Step 2: Verify costume lookup works**

```bash
node -e "
  const { getTrialCostume } = require('./server/config/trialCostumes');
  console.log('pirate male:', getTrialCostume('pirate', 'adventure', 'male'));
  console.log('moon-landing female:', getTrialCostume('moon-landing', 'historical', 'female'));
  console.log('unknown:', getTrialCostume('nonexistent', 'adventure', 'male'));
"
```

Expected:
- pirate male: `{ costumeType: 'pirate', description: 'Striped sailor shirt...' }`
- moon-landing female: `{ costumeType: 'moon-landing', description: 'White NASA spacesuit...' }`
- unknown: `null`

**Step 3: Verify sanitization functions work**

```bash
node -e "
  // Quick test of the sanitization helpers (they're module-level in images.js)
  // Would need to test via a require or inline test
  console.log('Sanitization tests need manual verification via trial story generation');
"
```

**Step 4: Build frontend** (shouldn't need changes but verify)

```bash
cd client && npm run build
```

**Step 5: Final commit**

```bash
git add -A
git commit -m "Trial flow v2: complete implementation with costume config, parallel avatars, title page"
```

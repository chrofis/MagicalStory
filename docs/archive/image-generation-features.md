# Physical Features & Clothing in Image Generation

> Last updated: January 2025

## Summary

All image types (covers AND normal pages) use **identical character description building**. The only differences are in scene composition requirements, not in physical features or clothing.

---

## Physical Features Passed to Image Generation

| Feature | Source Field | Example | Notes |
|---------|--------------|---------|-------|
| **Build** | `physical.build` | "athletic", "slim" | Always included |
| **Eye Color** | `physical.eyeColor` | "brown", "blue" | Always included |
| **Hair Color** | `physical.hairColor` | "dark blonde" | Part of hair description |
| **Hair Style** | `physical.hairStyle` | "ponytail", "braids" | User-edited takes priority |
| **Hair Length** | `physical.hairLength` | "shoulder-length" | Part of hair description |
| **Hair Type** | `detailedHairAnalysis.type` | "wavy", "curly" | Fallback if no user hairStyle |
| **Bangs** | `detailedHairAnalysis.bangsEndAt` | "to eyebrows" | Only if not "no bangs" |
| **Hair Direction** | `detailedHairAnalysis.direction` | "part left" | Only if specific |
| **Facial Hair** | `physical.facialHair` | "beard", "stubble" | **Males only**, skip if "none" |
| **Other** | `physical.other` | "glasses", "birthmark" | Skip if "none" |
| **Height** | `physical.height` | "145 cm" | Converted to relative descriptions |

### Hair Description Logic (`buildHairDescription`)

```
Output: "dark blonde, ponytail, shoulder-length, bangs to eyebrows"

Priority order:
1. hairColor (always first)
2. User-edited hairStyle > detailedHairAnalysis.type > extracted hairStyle
3. hairLength (or "short sides, longer on top" from detailed analysis)
4. Bangs from detailed analysis
5. Direction from detailed analysis (if specific)
```

---

## Clothing Parameters Passed to Image Generation

| Parameter | Source | Example | Priority |
|-----------|--------|---------|----------|
| **Avatar Clothing** | `photo.clothingDescription` | "red winter parka, blue jeans" | **Primary** |
| **Costumed Clothing** | `avatars.costumed[type].clothing` | "pirate vest, striped pants, bandana" | **For costumes** |
| **Clothing Style** | `char.clothingStyle` | "blue and white striped" | **Fallback** |
| **Clothing Category** | `photo.clothingCategory` | "winter", "standard", "costumed:pirate" | Selects avatar |

### Clothing Categories

| Category | Source | Example |
|----------|--------|---------|
| `standard` | `avatars.standard` + `avatars.clothing.standard` | Everyday clothes |
| `winter` | `avatars.winter` + `avatars.clothing.winter` | Winter jacket, boots |
| `summer` | `avatars.summer` + `avatars.clothing.summer` | T-shirt, shorts |
| `costumed:pirate` | `avatars.costumed.pirate` + clothing | Full pirate outfit |
| `costumed:knight` | `avatars.costumed.knight` + clothing | Knight armor |
| `costumed:superhero` | `avatars.costumed.superhero` + clothing | Superhero costume |

### Clothing Flow

```
Standard/Winter/Summer:
1. Avatar selected based on scene requirements
2. clothingDescription from avatars.clothing[category]
3. Passed as: "Wearing: ${clothingDescription}"

Costumed (e.g., costumed:pirate):
1. Costume type extracted from scene (e.g., "pirate")
2. Avatar from: avatars.costumed[costumeKey] or avatars.styledAvatars[style].costumed[costumeKey]
3. Clothing from: avatars.costumed[costumeKey].clothing OR avatars.clothing.costumed[costumeKey]
4. Passed as: "Wearing: ${costumeClothingDescription}"

Fallback:
- If no avatar clothing: "CLOTHING STYLE (MUST MATCH): ${clothingStyle}"
```

### Costumed Avatar Data Structure

```typescript
avatars: {
  // Regular seasonal avatars
  standard: "base64...",
  winter: "base64...",
  summer: "base64...",

  // Costumed avatars (per costume type)
  costumed: {
    pirate: {
      imageData: "base64...",
      clothing: "striped vest, brown pants, red bandana, black boots"
    },
    knight: {
      imageData: "base64...",
      clothing: "silver armor, blue cape, leather boots"
    }
  },

  // Clothing descriptions per category
  clothing: {
    standard: "blue t-shirt, jeans",
    winter: "red parka, dark jeans, snow boots",
    summer: "yellow sundress, sandals",
    costumed: {
      pirate: "striped vest, brown pants, red bandana",
      knight: "silver armor, blue cape"
    }
  }
}
```

### Visual Bible Clothing Items (Accessories & Special Items)

Visual Bible clothing entries (CLO001, CLO002, etc.) are **accessories and special items** like capes, masks, hats - NOT the main character outfit.

**How VB Clothing Works:**

| Aspect | Behavior |
|--------|----------|
| Storage | `visualBible.clothing[]` with `wornBy` field |
| In prompts | Listed as "REQUIRED OBJECTS" when mentioned in scene |
| Character "Wearing:" | NOT merged (intentional - see below) |

**Why VB Clothing is NOT Merged into Character Descriptions:**

1. **Avatars cannot have masks/helmets** - faces must stay visible for consistency
2. **Scene context matters** - the item might be:
   - Held in hands
   - Found/discovered
   - Being removed
   - Being put on
   - Lying on a surface

**Example - Superhero Mask:**
```
VB Entry: { name: "Superhero Mask", id: "CLO001", wornBy: "Max", description: "red mask with gold trim" }
```

| Scene Context | How AI Should Render |
|---------------|---------------------|
| "Max finds the mask in the attic" | Mask on shelf/in box, Max looking at it |
| "Max holds up his mask proudly" | Mask in Max's hands |
| "Max puts on his mask" | Mask being worn (one scene only) |
| "Max removes his mask dramatically" | Mask being taken off |

The `wornBy` field indicates **ownership/association**, not "always wearing". The scene description determines how the item appears.

**Prompt Output:**
```
REQUIRED OBJECTS IN THIS SCENE:
* Superhero Mask [CLO001] (worn by Max): red mask with gold trim

CHARACTER REFERENCE PHOTOS:
1. Max, ... Wearing: blue t-shirt, jeans  ← Base outfit from avatar, no mask
```

---

### Per-Character Clothing (Different Characters, Different Outfits)

Each character in a scene can have a **different clothing category**. This is fully supported.

**Scene Hint Format:**
```
Characters:
- Roger: summer
- Sophie: costumed:pirate
```

**How Per-Character Clothing Works:**

1. **Scene parsing** extracts per-character clothing map:
   ```javascript
   scene.characterClothing = { "Roger": "summer", "Sophie": "costumed:pirate" }
   ```

2. **`sceneClothingRequirements`** is built with `_currentClothing` per character (server.js:7429-7440):
   ```javascript
   sceneClothingRequirements["Roger"]._currentClothing = "summer";
   sceneClothingRequirements["Sophie"]._currentClothing = "costumed:pirate";
   ```

3. **`getCharacterPhotoDetails`** checks `_currentClothing` for each character (storyHelpers.js:720-731):
   ```javascript
   if (clothingRequirements[char.name]?._currentClothing) {
     const charCurrentClothing = clothingRequirements[char.name]._currentClothing;
     if (charCurrentClothing.startsWith('costumed:')) {
       effectiveClothingCategory = 'costumed';
       effectiveCostumeType = charCurrentClothing.split(':')[1];
     } else {
       effectiveClothingCategory = charCurrentClothing;
     }
   }
   ```

4. **Result:** Each character gets their own avatar and clothing description:
   - Roger: summer avatar + "yellow t-shirt, khaki shorts"
   - Sophie: pirate costume avatar + "striped shirt, brown pants, red bandana"

**Example Mixed Clothing Output:**
```
**CHARACTER REFERENCE PHOTOS (in order):**
1. Roger, Looks: adult, 45 years old, man, Build: athletic. Eyes: brown.
   Hair: dark blonde, ponytail, shoulder-length. Facial hair: clean-shaven.
   Wearing: yellow t-shirt, khaki shorts, sandals
2. Sophie, Looks: young-school-age, 7 years old, girl, Build: slim.
   Eyes: blue. Hair: blonde, wavy, long.
   Wearing: striped blue/white pirate shirt, brown pants, red bandana, black boots

HEIGHT ORDER: Sophie (shortest) -> Roger (much taller)
```

---

## Cover Images vs Normal Pages

### What's IDENTICAL:
- `buildCharacterReferenceList()` function
- `buildHairDescription()` function
- All physical features included
- Clothing handling approach
- Visual Bible integration

### What's DIFFERENT (composition only):

| Image Type | Scene Placeholder | Composition |
|------------|------------------|-------------|
| Front Cover | `{TITLE_PAGE_SCENE}` | Main character centered, prominent |
| Back Cover | `{BACK_COVER_SCENE}` | Group scene, all together |
| Initial Page | `{INITIAL_PAGE_SCENE}` | Group intro, main in center |
| Story Pages | `{SCENE_DESCRIPTION}` | Scene-dependent |

---

## Code Locations

| Function | File | Line |
|----------|------|------|
| `buildHairDescription()` | server/lib/storyHelpers.js | ~50 |
| `buildCharacterPhysicalDescription()` | server/lib/storyHelpers.js | ~942 |
| `buildCharacterReferenceList()` | server/lib/storyHelpers.js | ~1060 |
| `buildImagePrompt()` | server/lib/storyHelpers.js | ~1643 |

### Prompt Templates
- `prompts/front-cover.txt` - Front cover
- `prompts/back-cover.txt` - Back cover
- `prompts/initial-page-with-dedication.txt` - Initial page
- `prompts/image-generation-storybook.txt` - Normal pages

---

## Example Character Reference Output

### Standard Clothing Example
```
**CHARACTER REFERENCE PHOTOS (in order):**
1. Roger, Looks: adult, 45 years old, man, Build: athletic. Eyes: brown.
   Hair: dark blonde, ponytail, shoulder-length. Facial hair: clean-shaven.
   Wearing: blue winter jacket, dark jeans
2. Sophie, Looks: young-school-age, 7 years old, girl, Build: slim.
   Eyes: blue. Hair: blonde, wavy, long.
   Wearing: pink sweater, purple leggings

HEIGHT ORDER: Sophie (shortest) -> Roger (much taller)
```

### Costumed Example (Pirate Adventure)
```
**CHARACTER REFERENCE PHOTOS (in order):**
1. Roger, Looks: adult, 45 years old, man, Build: athletic. Eyes: brown.
   Hair: dark blonde, ponytail, shoulder-length. Facial hair: clean-shaven.
   Wearing: brown leather vest, white puffy shirt, black pants, red sash, boots
2. Sophie, Looks: young-school-age, 7 years old, girl, Build: slim.
   Eyes: blue. Hair: blonde, wavy, long.
   Wearing: striped blue/white shirt, brown pants, red bandana, black boots

HEIGHT ORDER: Sophie (shortest) -> Roger (much taller)
```

---

## Filtering Rules

- **"none" values**: Filtered out for `Other` and `Facial hair` fields
- **User edits**: `hairStyle` respects user-edited values over AI-extracted values
- **Males only**: `facialHair` only included for `gender === 'male'`

---

## Data Sources

### Character Object Structure
```typescript
character: {
  physical: {
    build: string,
    eyeColor: string,
    hairColor: string,
    hairStyle: string,
    hairLength: string,
    facialHair: string,      // males only
    other: string,           // glasses, birthmarks
    height: string,
    detailedHairAnalysis: {
      type: string,          // wavy, curly, straight
      bangsEndAt: string,
      direction: string,
      lengthTop: string,
      lengthSides: string
    }
  },
  physicalTraitsSource: {
    hairStyle: 'user' | 'extracted' | 'photo',
    // ... other fields
  }
}
```

### Avatar Clothing
```typescript
photo: {
  clothingDescription: string,  // "red winter parka, blue jeans"
  clothingCategory: string      // "winter", "standard", "costumed:pirate"
}
```

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
| **Clothing Style** | `char.clothingStyle` | "blue and white striped" | **Fallback** |
| **Clothing Category** | `photo.clothingCategory` | "winter", "standard", "costumed:pirate" | Selects avatar |

### Clothing Flow

```
1. Avatar selected based on scene (winter/summer/standard/costumed)
2. clothingDescription extracted from avatar evaluation
3. Passed as: "Wearing: ${clothingDescription}"
4. Fallback: "CLOTHING STYLE (MUST MATCH): ${clothingStyle}"
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

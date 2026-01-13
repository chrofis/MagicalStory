# Character Trait Handling

This document describes how character traits are set, updated, and preserved in MagicalStory.

## Trait Sources

Each physical trait can have a source tracked via `PhysicalTraitsSource`:

| Source | Meaning | When Set |
|--------|---------|----------|
| `'photo'` | From initial photo analysis | Not currently used |
| `'extracted'` | From avatar evaluation | After avatar generation |
| `'user'` | Manually edited by user | When user changes a field |

## Trait Categories

### 1. User-Input Traits (Never Extracted)

These traits are ONLY set by the user and never overwritten by AI:

| Trait | Location | Required | Notes |
|-------|----------|----------|-------|
| `name` | `character.name` | Yes | User input |
| `age` | `character.age` | Yes | User input (numeric string) |
| `gender` | `character.gender` | Yes | User input: 'male', 'female', 'other' |
| `height` | `character.physical.height` | No | User input, optional |
| `ageCategory` | `character.ageCategory` | Auto | Auto-calculated from `age` |

### 2. Always-Overwritten Traits (No Source Tracking)

These traits are ALWAYS overwritten with the latest avatar evaluation:

| Trait | Location | Notes |
|-------|----------|-------|
| `detailedHairAnalysis` | `character.physical.detailedHairAnalysis` | Detailed hair analysis JSON |

**Behavior:** Every avatar regeneration updates these values regardless of previous state.

### 2b. Source-Tracked Character Traits (Not in `physical`)

| Trait | Location | Notes |
|-------|----------|-------|
| `apparentAge` | `character.apparentAge` | How old they LOOK - source tracked, user edits preserved |

### 3. Source-Tracked Physical Traits

These traits follow the source tracking rules - user edits are preserved:

| Trait | Location | Source Tracking |
|-------|----------|-----------------|
| `build` | `character.physical.build` | Full |
| `eyeColor` | `character.physical.eyeColor` | Full |
| `eyeColorHex` | `character.physical.eyeColorHex` | Full (via eyeColor) |
| `hairColor` | `character.physical.hairColor` | Full |
| `hairColorHex` | `character.physical.hairColorHex` | Full (via hairColor) |
| `hairLength` | `character.physical.hairLength` | Full |
| `hairStyle` | `character.physical.hairStyle` | Full |
| `face` | `character.physical.face` | Full |
| `skinTone` | `character.physical.skinTone` | Full |
| `skinToneHex` | `character.physical.skinToneHex` | Full (via skinTone) |
| `facialHair` | `character.physical.facialHair` | Full |
| `other` | `character.physical.other` | Full |

### 4. Clothing Traits

Clothing has its own source tracking via `ClothingSource`:

| Trait | Location | Source Tracked? |
|-------|----------|-----------------|
| `upperBody` | `character.clothing.structured.upperBody` | Yes |
| `lowerBody` | `character.clothing.structured.lowerBody` | Yes |
| `shoes` | `character.clothing.structured.shoes` | Yes |
| `fullBody` | `character.clothing.structured.fullBody` | Yes |

## Update Rules

### On Avatar Generation/Regeneration

1. **User-edited traits (`source === 'user'`)**: PRESERVED
   - Value is NOT overwritten by extraction
   - Source remains 'user'
   - These traits are sent to avatar generation prompt

2. **Non-user traits (`source !== 'user'`)**: OVERWRITTEN
   - Value is updated from extraction
   - Source is set to 'extracted'

3. **Always-overwritten traits**: REPLACED
   - `apparentAge`: Always uses latest from avatar evaluation
   - `detailedHairAnalysis`: Always uses latest

4. **User-only traits**: NEVER TOUCHED
   - `age`, `gender`, `height`: Only user can set these, AI never overwrites

### On User Edit (CharacterForm)

When user edits a physical trait field:
1. Value is updated
2. Source is set to `'user'`
3. This trait will be preserved on future regenerations

## Hex Color Variants

Several traits have both a text value and hex color code:

| Text Trait | Hex Trait | Notes |
|------------|-----------|-------|
| `eyeColor` | `eyeColorHex` | Shared source tracking via `eyeColor` |
| `hairColor` | `hairColorHex` | Shared source tracking via `hairColor` |
| `skinTone` | `skinToneHex` | Shared source tracking via `skinTone` |

Both are updated together based on the text trait's source.

## Code Locations

| File | Purpose |
|------|---------|
| `client/src/types/character.ts` | Type definitions |
| `client/src/services/characterService.ts` | API calls, trait extraction |
| `client/src/pages/StoryWizard.tsx` | Trait merging on avatar generation |
| `client/src/components/character/CharacterForm.tsx` | User edit handling |
| `prompts/avatar-evaluation.txt` | Extraction prompt for Gemini |

## Flow Diagram

```
User Input ──────────────────────────────────────────────────────────────
   │
   ├─→ name, age, gender, height (mandatory/optional, NEVER extracted)
   │
Photo Upload → Photo Analysis → Suggested traits
                                      ↓
                              Avatar Generation
                                      ↓
                              Avatar Evaluation
                                      ↓
                    ┌─────────────────┼─────────────────┐
                    ↓                 ↓                 ↓
            User-edited?       Non-user trait?    Always-overwrite?
            (source='user')                       (detailedHairAnalysis)
                    ↓                 ↓                 ↓
               PRESERVE          OVERWRITE         ALWAYS OVERWRITE
                                with new value
                                      ↓
                              Set source='extracted'
```

## Fixed Bugs (for reference)

### Bug 1: `apparentAge` - No Source Tracking (FIXED)

**Fixed in:** `character.ts`, `StoryWizard.tsx` (3 locations)

**Problem was:** `apparentAge` was always overwritten from avatar evaluation. User edits were lost.

**Fix:** Added `apparentAge` to `PhysicalTraitsSource` and applied same preserve-user-edit logic as other traits.

### Bug 2: `facialHair` and `other` - Inconsistent Source Tracking (FIXED)

**Fixed in:** `StoryWizard.tsx` (3 locations)

**Problem was:** Source was never set to `'extracted'`, only `'user'` or `undefined`.

**Fix:** Now properly sets source to `'extracted'` when extracted, matching other traits.

## Notes

1. **First avatar generation** (line ~2100 in StoryWizard.tsx): Uses simpler logic - always takes extracted value if present, fallback to existing. No source tracking applied on first generation.

2. **Regeneration** (line ~1816, ~1948, ~2683 in StoryWizard.tsx): Full source tracking - preserves user edits, overwrites extracted.

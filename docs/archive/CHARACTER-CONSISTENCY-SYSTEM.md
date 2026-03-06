# Character Consistency System in Roger iOS

## Overview

The Roger iOS app maintains visual consistency of characters across story pages through a **two-tier system**:

1. **Visual Reference Chaining** - The main character's generated cartoon image is passed as input to every page generation
2. **Character Manifest** - Detailed text descriptions of secondary characters are injected into every prompt

This document explains the complete flow from photo upload to consistent story illustration generation.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        STORY GENERATION PIPELINE                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────┐     ┌─────────────────┐     ┌─────────────────────────┐   │
│  │   USER      │     │   GEMINI API    │     │      COREDATA           │   │
│  │   PHOTO     │────>│  Character Gen  │────>│  character.generated    │   │
│  │             │     │                 │     │    ImageData            │   │
│  └─────────────┘     └─────────────────┘     └───────────┬─────────────┘   │
│                                                          │                  │
│                                                          │ Base64 Image     │
│                                                          ▼                  │
│  ┌─────────────┐     ┌─────────────────┐     ┌─────────────────────────┐   │
│  │   STORY     │     │   OPENAI API    │     │    CHARACTER MANIFEST   │   │
│  │   PROMPT    │────>│  GPT-4 Story    │────>│    (Secondary Chars)    │   │
│  │             │     │  Generation     │     └───────────┬─────────────┘   │
│  └─────────────┘     └─────────────────┘                 │                  │
│                                                          │ Text Guide       │
│                                                          ▼                  │
│                      ┌─────────────────────────────────────────────────┐   │
│                      │              PAGE GENERATION LOOP               │   │
│                      │                                                 │   │
│                      │   For each page (1..N):                        │   │
│                      │   ┌─────────────────────────────────────────┐  │   │
│                      │   │          GEMINI API CALL               │  │   │
│                      │   │                                         │  │   │
│                      │   │  INPUT:                                 │  │   │
│                      │   │  ├── Base Character Image (base64) ◄───┼──┼───┤
│                      │   │  ├── Scene Description (text)          │  │   │
│                      │   │  ├── Character Manifest Guide (text)◄──┼──┘   │
│                      │   │  └── Secondary Character Details       │  │   │
│                      │   │                                         │  │   │
│                      │   │  OUTPUT:                                │  │   │
│                      │   │  └── Page Illustration (base64)         │  │   │
│                      │   └─────────────────────────────────────────┘  │   │
│                      │                                                 │   │
│                      └─────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 1: Character Image Generation

### Location
`Roger/Services/GeminiService.swift` - `generateCharacterImage(from:characterName:)`

### Process

```swift
func generateCharacterImage(from photo: UIImage, characterName: String?) async throws -> String
```

1. **Photo Compression**: User photo is compressed to < 2MB JPEG
2. **Base64 Encoding**: Converted to base64 string for API transport
3. **API Call**: Sent to Gemini `gemini-2.5-flash-image` model
4. **Prompt**: Creates a vertical portrait cartoon illustration (3:4 aspect ratio)
5. **Storage**: Result saved to CoreData as `Character.generatedImageData`

### Example Prompt

```
Create a VERTICAL PORTRAIT-ORIENTED colorful cartoon illustration of this child
named Emma for a children's storybook. The illustration should be in 3:4 aspect
ratio (portrait orientation). Make it friendly and cheerful with bright, vibrant
colors and a simple background. No text or words on the image.
```

### Output

The generated cartoon image becomes the **primary visual reference** for all subsequent story pages.

---

## Step 2: Story Generation with Character Manifest

### Location
`Roger/Services/OpenAIService.swift` - `generateStory()`

### The Manifest Structure

When GPT-4 generates the story, it also creates a **Character Manifest** - detailed descriptions of all secondary characters:

```swift
struct CharacterManifest: Codable {
    let characters: [SecondaryCharacter]
}

struct SecondaryCharacter: Codable {
    let name: String
    let role: String  // "supporting", "minor", "creature"
    let appearance: CharacterAppearance
}

struct CharacterAppearance: Codable {
    let ageDescription: String
    let hairDescription: String
    let faceDescription: String
    let buildDescription: String
    let clothingDescription: String
    let accessoriesDescription: String?
    let distinctiveFeatures: String?
}
```

### Example Manifest

```json
{
  "characters": [
    {
      "name": "Farmer Jeremy",
      "role": "supporting",
      "appearance": {
        "ageDescription": "elderly man, approximately 65-70 years old",
        "hairDescription": "short gray hair, slightly balding on top",
        "faceDescription": "kind wrinkled face with warm smile, rosy cheeks",
        "buildDescription": "tall and lean with slightly stooped shoulders",
        "clothingDescription": "red and white checkered flannel shirt, faded blue denim overalls with brass buttons, brown leather work boots",
        "accessoriesDescription": "weathered straw hat with faded red band",
        "distinctiveFeatures": "bushy white eyebrows, deep laugh lines"
      }
    }
  ]
}
```

### Why This Matters

Without a manifest, the AI would:
- Invent new appearances for characters on each page
- Change clothing colors, hairstyles, and physical features randomly
- Break the reader's immersion

---

## Step 3: Building the Consistency Guide

### Location
`Roger/Services/OpenAIService.swift` - `buildCharacterConsistencyGuide(from:)`

The manifest is converted into a human-readable text guide:

```
CHARACTER CONSISTENCY GUIDE - Use these EXACT descriptions for secondary characters:

[FARMER JEREMY]
• Age: elderly man, approximately 65-70 years old
• Hair: short gray hair, slightly balding on top
• Face: kind wrinkled face with warm smile and rosy cheeks
• Build: tall and lean
• Clothing: red and white checkered flannel shirt, faded blue denim overalls
• Accessories: weathered straw hat with faded red band
• Distinctive: bushy white eyebrows, deep laugh lines

CRITICAL: These characters MUST look IDENTICAL on every page. Do not change their appearance.
```

This text is appended to **every single page generation prompt**.

---

## Step 4: Page Illustration Generation

### Location
`Roger/Services/GeminiService.swift` - `generateSceneImage()`

### Function Signature

```swift
func generateSceneImage(
    baseCharacter: String,                    // Base64 of main character cartoon
    sceneDescription: String,                 // Scene text from story
    secondaryCharacters: [SecondaryCharacter],
    characterConsistencyGuide: String?        // The manifest text guide
) async throws -> String
```

### How Consistency Is Maintained

For **every page**, the API receives:

| Input | Purpose |
|-------|---------|
| `baseCharacter` (image) | Main character visual reference - same image every time |
| `sceneDescription` (text) | What happens in this specific scene |
| `characterConsistencyGuide` (text) | Detailed descriptions of secondary characters |
| `secondaryCharacters` (array) | Structured data for secondary character details |

### API Request Structure

```json
{
  "contents": [{
    "parts": [
      {
        "text": "Create a VERTICAL PORTRAIT children's book illustration...\n\nSCENE: Emma walked up to the old farmhouse...\n\nCHARACTER CONSISTENCY GUIDE - Use these EXACT descriptions..."
      },
      {
        "inline_data": {
          "mime_type": "image/jpeg",
          "data": "<BASE64_OF_MAIN_CHARACTER_CARTOON>"
        }
      }
    ]
  }]
}
```

### The Key Insight

The **same base character image** is passed to every page generation call. This means:

1. **Page 1**: Gemini sees the character cartoon → generates scene with that character
2. **Page 2**: Gemini sees the **same** character cartoon → maintains visual consistency
3. **Page 3**: Gemini sees the **same** character cartoon → character looks identical
4. ...and so on for all pages

---

## Step 5: Complete Orchestration

### Location
`Roger/Services/StoryGenerationService.swift` - `generateStoryWithProgress()`

### Full Flow

```swift
// 1. Analyze the user's photo
let photoDescription = try await geminiService.analyzeImage(image)

// 2. Generate story with GPT-4 (includes character manifest)
let storyResponse = try await openAIService.generateStory(
    characterName: characterName,
    characterContext: characterContext,
    storyPrompt: storyPrompt,
    ...
)

// 3. Build consistency guide from manifest
let consistencyGuide = OpenAIService.buildCharacterConsistencyGuide(
    from: storyResponse.characterManifest
)

// 4. Generate main character cartoon
let baseCharacterImageBase64 = try await geminiService.generateCharacterImage(
    from: image,
    characterName: characterName
)

// 5. Generate each page with consistency inputs
for page in storyResponse.pages {
    let pageImage = try await geminiService.generateSceneImage(
        baseCharacter: baseCharacterImageBase64,      // ← SAME every time
        sceneDescription: page.scene,
        secondaryCharacters: manifest.characters,
        characterConsistencyGuide: consistencyGuide   // ← SAME every time
    )
    // Store page...
}
```

---

## Character Reuse Optimization

When generating multiple stories with the same character, the app can skip character regeneration:

```swift
func generateStoryWithProgress(
    image: UIImage,
    existingCharacterImage: UIImage? = nil,  // ← Pass existing cartoon
    ...
) async throws -> GeneratedStory
```

If `existingCharacterImage` is provided:
- The character cartoon is **not regenerated**
- The existing image is used directly
- Saves ~15-20 seconds per story

---

## Data Flow Summary

```
USER PHOTO
    │
    ▼
┌───────────────────────────────────────┐
│  GeminiService.generateCharacterImage │
│  (Photo → Cartoon conversion)         │
└───────────────────────────────────────┘
    │
    ▼
┌───────────────────────────────────────┐
│  CoreData: Character.generatedImageData│
│  (Stored for reuse)                    │
└───────────────────────────────────────┘
    │
    │  ┌─────────────────────────────────────┐
    │  │  OpenAIService.generateStory        │
    │  │  (Creates story + manifest)         │
    │  └─────────────────────────────────────┘
    │                    │
    │                    ▼
    │  ┌─────────────────────────────────────┐
    │  │  Character Manifest                 │
    │  │  (Secondary character descriptions) │
    │  └─────────────────────────────────────┘
    │                    │
    ▼                    ▼
┌───────────────────────────────────────────────────────┐
│              FOR EACH PAGE:                           │
│                                                       │
│  GeminiService.generateSceneImage(                   │
│      baseCharacter: <SAME_CARTOON_EVERY_TIME>,       │
│      sceneDescription: <THIS_PAGE_TEXT>,             │
│      characterConsistencyGuide: <SAME_MANIFEST>      │
│  )                                                    │
└───────────────────────────────────────────────────────┘
    │
    ▼
CONSISTENT STORY PAGES
```

---

## Key Files

| File | Responsibility |
|------|----------------|
| `GeminiService.swift` | Character & scene image generation via Gemini API |
| `OpenAIService.swift` | Story text generation + character manifest creation |
| `StoryGenerationService.swift` | Orchestrates the complete pipeline |
| `Character+Extensions.swift` | CoreData model with `generatedImageData` storage |

---

## Known Limitations

### Current System
- ✅ Main character consistency via visual reference
- ✅ Secondary character consistency via text manifest
- ⚠️ Art style can drift slightly between pages (same character, different rendering)
- ⚠️ Text descriptions alone may not capture all visual details

### Planned Enhancement: Style Reference Chaining (PRP-016)

To achieve even better consistency, a future enhancement will:
1. Generate Page 1 normally
2. Pass Page 1's image as a **style reference** to all subsequent pages
3. This ensures not just character consistency, but **art style consistency**

See `docs/PRPs/PRP-016-PRIMARY-CHARACTER-CONSISTENCY.md` for implementation details.

---

## Summary

The Roger app achieves character consistency through:

1. **One-time character generation**: Photo → Cartoon (stored in CoreData)
2. **Visual reference reuse**: Same cartoon image passed to every page generation
3. **Text-based manifest**: Detailed secondary character descriptions in every prompt
4. **Orchestration layer**: `StoryGenerationService` ensures all inputs are consistently applied

This hybrid approach (visual + text) provides robust character consistency across the entire storybook.

# Landmark Data Flow

How landmark information flows through story generation stages.

## Quick Reference

| Stage | Data Used | Purpose |
|-------|-----------|---------|
| Outline | `wikipediaExtract` | What the landmark IS (historical context) |
| Scene Description | `extractedDescription` + photo variants | Visual context for scene writing |
| Image Generation | `referencePhotoData` | Actual photo for visual reference |

## Stage 1: Outline/Story Ideas

**Function**: `buildAvailableLandmarksSection()` in `storyHelpers.js:3051`

**Data passed to Claude**:
```
- Kurpark Baden [Park]
  DESCRIPTION: A historic spa park established in 1847 with thermal springs...
```

**Fields used**:
- `name` - Landmark name
- `type` - Category (Park, Castle, Church, etc.)
- `wikipediaExtract` - What the landmark IS (from Wikipedia)

**NOT used**: `photoDescription` (what photos look like)

**Why**: Claude needs to understand historical/cultural significance to write a good story, not what specific photos show.

**Claude outputs**:
```json
{
  "name": "The Enchanted Gardens",
  "isRealLandmark": true,
  "landmarkQuery": "Kurpark Baden"
}
```

## Stage 2: Visual Bible Linking

**Function**: `linkPreDiscoveredLandmarks()` in `visualBible.js:1480`

After outline, landmarks are linked to pre-fetched photos:

```javascript
location.referencePhotoData = preDiscovered.photoData;  // Base64 JPEG
location.referencePhotoUrl = preDiscovered.photoUrl;
location.photoAttribution = preDiscovered.attribution;
location.extractedDescription = preDiscovered.photoDescription;  // AI-analyzed
```

**Result**: Visual Bible locations now have actual photos attached.

## Stage 3: Scene Description Generation

**Function**: `buildSceneDescriptionPrompt()` in `storyHelpers.js:2055`

**Data passed to Claude**:
```
**Kurpark Baden** [LOC001] (real landmark): A beautiful public park...
  PHOTO OPTIONS (select ONE via landmarkPhotoVariant field):
    - variant 1: Wide shot of manicured lawns with fountain
    - variant 2: Close-up of historic spa building entrance
```

**Fields used**:
- `name`, `id` - For identification
- `extractedDescription` - What the photo shows (AI-analyzed)
- `photoVariants` - If multiple photos available

**Claude outputs**:
```json
{
  "setting": {
    "location": "Kurpark Baden [LOC001]",
    "landmarkPhotoVariant": 2
  }
}
```

## Stage 4: Image Generation

**Function**: `getLandmarkPhotosForScene()` in `storyHelpers.js:2956`

**Data passed to Gemini**:
- `referencePhotoData` - Actual base64 JPEG photo
- `name` - Landmark name for prompt
- `attribution` - Photo credit

The image model receives the actual landmark photo as visual reference to render the scene accurately.

## Data Field Summary

| Field | Source | Used In | Purpose |
|-------|--------|---------|---------|
| `wikipediaExtract` | Wikipedia API | Outline | Historical/cultural context |
| `photoDescription` | AI analysis of photo | Stored only | What specific photo shows |
| `extractedDescription` | Same as photoDescription | Scene descriptions | Visual reference for writing |
| `referencePhotoData` | Commons/photo fetch | Image generation | Actual photo for rendering |
| `landmarkQuery` | User/Claude output | Photo lookup | Exact name for matching |

## Key Distinction

**wikipediaExtract** = "Ruine Stein is a medieval castle ruin dating from the 12th century, located on a hill overlooking Baden."

**photoDescription** = "A stone castle ruin with weathered gray walls against a blue sky, viewed from the northwest showing the remaining tower."

The outline uses Wikipedia (what it IS), image generation uses the photo (what it LOOKS like).

## Code References

- `storyHelpers.js:3051-3091` - `buildAvailableLandmarksSection()`
- `storyHelpers.js:2055-2274` - `buildSceneDescriptionPrompt()`
- `storyHelpers.js:2956-3040` - `getLandmarkPhotosForScene()`
- `visualBible.js:1480-1558` - `linkPreDiscoveredLandmarks()`
- `landmarkPhotos.js:1909-2083` - `discoverLandmarksForLocation()`

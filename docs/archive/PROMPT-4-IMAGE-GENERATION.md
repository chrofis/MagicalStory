# Prompt 4: Image Generation

**Location:** `server.js:4312-4336` (function `buildImagePrompt()`)
**Called at:** `server.js:4070`
**API:** Gemini API (imagen-3.0-generate-001)
**Process:** Parallel generation with rate limiting (max 5 concurrent)

---

## The Prompt Template

```javascript
function buildImagePrompt(sceneDescription, inputData) {
  const artStyleId = inputData.artStyle || 'pixar';
  const styleDescription = ART_STYLES[artStyleId] || ART_STYLES.pixar;

  // Build character info for consistency
  let characterPrompts = '';
  if (inputData.characters && inputData.characters.length > 0) {
    characterPrompts = '\n\nCHARACTER APPEARANCE GUIDE - Maintain consistency:\n\n';
    inputData.characters.forEach((char, idx) => {
      characterPrompts += `[${char.name}]: ${char.age} years old, ${char.gender}.\n`;
    });
    characterPrompts += '\nCRITICAL: These characters must maintain visual consistency across ALL pages.';
  }

  return `Create a cinematic scene in ${styleDescription}.

Scene Description: ${sceneDescription}${characterPrompts}

Important:
- Show only the emotions visible on faces (happy, sad, surprised, worried, excited)
- Maintain consistent character appearance across ALL pages
- Clean, clear composition
- Age-appropriate for ${inputData.ageFrom || 3}-${inputData.ageTo || 8} years old`;
}
```

---

## Art Styles

The `styleDescription` comes from `ART_STYLES` object defined in server.js (around line 200-300). Common styles include:

- **pixar:** "Pixar-style 3D animation with vibrant colors and expressive characters"
- **watercolor:** "Soft watercolor painting style with gentle colors and flowing brushstrokes"
- **cartoon:** "Classic cartoon style with bold outlines and bright colors"
- **realistic:** "Realistic illustration with detailed textures and natural lighting"

---

## Character Reference Photos

When generating images, character photos are passed as reference images to Gemini:

```javascript
const characterPhotos = [];
if (inputData.characters && inputData.characters.length > 0) {
  inputData.characters.forEach(char => {
    if (char.photoUrl) {
      characterPhotos.push(char.photoUrl);
    }
  });
}
```

These photos are included in the Gemini API request to maintain visual consistency of characters across all pages.

---

## Example Prompt

**Input:**
- Scene: "Max standing at the edge of a dense forest, holding the glowing map"
- Art Style: "pixar"
- Characters: [{ name: "Max", age: 8, gender: "male" }]
- Age Range: 3-8 years

**Generated Prompt:**
```
Create a cinematic scene in Pixar-style 3D animation with vibrant colors and expressive characters.

Scene Description: Max standing at the edge of a dense forest, holding the glowing map in his hand, looking up at the tall trees before him.

CHARACTER APPEARANCE GUIDE - Maintain consistency:

[Max]: 8 years old, male.

CRITICAL: These characters must maintain visual consistency across ALL pages.

Important:
- Show only the emotions visible on faces (happy, sad, surprised, worried, excited)
- Maintain consistent character appearance across ALL pages
- Clean, clear composition
- Age-appropriate for 3-8 years old
```

---

## Image Generation Flow

1. **For each scene description** (from Step 3):
   - Build image prompt using `buildImagePrompt()`
   - Call Gemini API with prompt + character photos
   - Retry up to 2 times on failure with exponential backoff
   - Compress PNG to JPEG (85% quality) to reduce size
   - Store image as base64 data

2. **Parallel Processing:**
   - Max 5 concurrent image generations
   - Uses `p-limit` library for rate limiting
   - Progress tracked: 70% → 100%

3. **Image Quality:**
   - Optional quality evaluation using Claude Vision API
   - Scores from 0-10
   - Quality reasoning stored in database

---

## Gemini API Call

**Location:** `server.js` (around line 4500-4600)

```javascript
await fetch('https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:generate', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${GEMINI_API_KEY}`
  },
  body: JSON.stringify({
    prompt: imagePrompt,
    negativePrompt: "blurry, low quality, distorted, scary, violent",
    numberOfImages: 1,
    aspectRatio: "4:3",
    // Character photos included as reference images
    referenceImages: characterPhotos.map(photo => ({
      imageUrl: photo
    }))
  })
})
```

---

## Image Caching

**Location:** `server.js` (around line 4376-4390)

Images are cached using a hash of:
- Image prompt text
- Character photo hashes (SHA-256 of base64 data)

**Cache Key Generation:**
```javascript
function generateImageCacheKey(prompt, characterPhotos = []) {
  const photoHashes = characterPhotos
    .filter(p => p && p.startsWith('data:image'))
    .map(photoUrl => {
      const base64Data = photoUrl.replace(/^data:image\/\w+;base64,/, '');
      return crypto.createHash('sha256').update(base64Data).digest('hex').substring(0, 16);
    })
    .sort()
    .join('|');

  const combined = `${prompt}|${photoHashes}`;
  return crypto.createHash('sha256').update(combined).digest('hex');
}
```

This prevents regenerating identical images and saves API costs.

---

## Image Compression

**Location:** `server.js:4398-4425`

After generation, images are compressed:
- Input: PNG from Gemini API
- Output: JPEG at 85% quality with progressive encoding
- Uses Sharp library
- Typical compression: 60-80% file size reduction

```javascript
const compressedBuffer = await sharp(imageBuffer)
  .jpeg({ quality: 85, progressive: true })
  .toBuffer();
```

---

## Output Format

Each generated image is stored as:

```javascript
{
  pageNumber: 1,
  imageData: "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
  description: "Max standing at the edge of a dense forest...",
  qualityScore: 8.5,
  qualityReasoning: "Clear composition, good lighting, character is recognizable"
}
```

---

## Notes

- **Character consistency** is emphasized multiple times in the prompt
- **Age-appropriate** content is enforced by age range
- **Emotional clarity** is requested (visible emotions on faces)
- **Clean composition** ensures professional-looking images
- Reference photos help maintain consistent character appearance across pages
- Negative prompts filter out low-quality or inappropriate content

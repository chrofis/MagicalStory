---
name: extract-faces
description: "Extract character faces from a story's scene images using evaluation bounding boxes"
---

# Extract Faces from Story

Extracts character face crops from a story's scene images, using the quality evaluation's bounding boxes for character identification and face location. There is no standing script for this — do it with an inline script using the recipes below.

## Where the data lives

- Evaluation data: `stories.data->sceneImages[].qualityReasoning` — `matches[]` carries `reference` (character name), `confidence`, and `face_bbox`.
- Image bytes: `story_images` table (pageNumber, version_index, image_data).
- Bounding-box format everywhere: `[ymin, xmin, ymax, xmax]`, normalized 0-1.

Prefer `face_bbox` from `qualityReasoning.matches` — the `faceBox` in `retryHistory[].bboxDetection` is unreliable (often points at background); its `bodyBox` is fine.

## Extraction recipe

For each match: convert normalized bbox to pixels, pad ~60% around the face, enforce a minimum crop of ~15% of image width, resize to 256×256, save as `faces/<Character>/<Character>_page<N>.jpg`.

```javascript
const sharp = require('sharp');
const meta = await sharp(imageBuffer).metadata();
const [ymin, xmin, ymax, xmax] = match.face_bbox;
await sharp(imageBuffer).extract({
  left: Math.round(xmin * meta.width),
  top: Math.round(ymin * meta.height),
  width: Math.round((xmax - xmin) * meta.width),
  height: Math.round((ymax - ymin) * meta.height)
}).resize(256, 256).jpeg({ quality: 90 }).toFile(outPath);
```

(Padding/min-size math omitted — expand the box before `extract` and clamp to image bounds.)

## Raw bbox fallback

When `qualityReasoning` is missing, use `sceneImages[].retryHistory[].bboxDetection` (`figures[]` with `label`, `bodyBox`, `faceBox`, `position`; `objects[]`) — body crops only, given the faceBox caveat above.

## Helper scripts that exist

```bash
node scripts/list-stories.js            # list recent stories
node scripts/get-latest-story.js        # latest story ID
node scripts/count-expected-faces.js <storyId>   # expected vs extracted
node scripts/analysis/review-page.js <storyId> <pageNum>  # inspect one page's eval data
```

## Troubleshooting

- **No evaluation matches** — story predates the current eval format or eval failed; fall back to raw bboxes.
- **Multiple faces of the same character on one page** — add an index suffix to filenames or later crops overwrite earlier ones.
- **Crop shows wrong area** — you used `bboxDetection.faceBox`; switch to `qualityReasoning` `face_bbox`.

#!/usr/bin/env node
/**
 * Re-evaluate Historical Location Images
 *
 * Re-runs Gemini evaluation on existing images in the database
 * to update descriptions with more detail.
 *
 * Usage: node server/scripts/reevaluate-historical-images.js [event-id]
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const DATABANK_FILE = path.join(__dirname, '../data/historical-locations.json');

/**
 * Evaluate image with Gemini - detailed description
 */
async function evaluateImage(photoData, locationName, locationType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log('    No Gemini API key');
    return null;
  }

  const matches = photoData.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!matches) {
    return null;
  }

  const [, mimeType, data] = matches;

  const prompt = `Analyze this photo of "${locationName}"${locationType ? ` (a ${locationType})` : ''} for use in children's book illustration.

TASK 1 - SCORE (1-10):
Rate suitability as a children's book background based on:
- Clarity: Sharp and well-lit? (not blurry or dark)
- Composition: Shows the landmark clearly and completely?
- Suitability: Works as background? (not too busy, no distracting people/cars/signs)

TASK 2 - DESCRIPTION:
Write a detailed visual description (4-6 sentences) focusing on:
- The main architectural/natural features visible
- Colors, materials, textures
- Distinctive elements that make it recognizable
- The setting/surroundings visible in the photo
- Lighting and atmosphere

Be specific and visual. Do NOT mention "the photo" or "the image" - describe as if painting the scene.

Return ONLY valid JSON (no markdown):
{"score": N, "reason": "1-sentence scoring explanation", "description": "4-6 sentence detailed visual description"}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inlineData: { mimeType, data } }
            ]
          }],
          generationConfig: {
            maxOutputTokens: 500,
            temperature: 0.3
          }
        }),
        signal: AbortSignal.timeout(30000)
      }
    );

    if (!response.ok) {
      console.log(`    API error: ${response.status}`);
      return null;
    }

    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!text) {
      return null;
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    return null;
  } catch (err) {
    console.log(`    Error: ${err.message}`);
    return null;
  }
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  const filterEventId = args[0];

  console.log('='.repeat(60));
  console.log('Re-evaluate Historical Location Images');
  console.log('='.repeat(60));

  if (!fs.existsSync(DATABANK_FILE)) {
    console.error(`\nError: Databank not found: ${DATABANK_FILE}`);
    process.exit(1);
  }

  const databank = JSON.parse(fs.readFileSync(DATABANK_FILE, 'utf-8'));

  let totalEvaluated = 0;
  let totalUpdated = 0;

  for (const [eventId, eventData] of Object.entries(databank)) {
    // Filter by event ID if specified
    if (filterEventId && eventId !== filterEventId) {
      continue;
    }

    const locations = eventData.locations || [];
    const photosCount = locations.reduce((sum, loc) => sum + (loc.photos?.length || 0), 0);

    if (photosCount === 0) {
      continue;
    }

    console.log(`\n[${eventId}] - ${locations.length} locations, ${photosCount} photos`);

    for (const location of locations) {
      if (!location.photos || location.photos.length === 0) {
        continue;
      }

      console.log(`  ${location.name} (${location.photos.length} photos)`);

      for (let i = 0; i < location.photos.length; i++) {
        const photo = location.photos[i];

        if (!photo.photoData) {
          console.log(`    Photo ${i + 1}: No data (skipped)`);
          continue;
        }

        console.log(`    Photo ${i + 1}: Evaluating...`);
        totalEvaluated++;

        const evaluation = await evaluateImage(photo.photoData, location.name, location.type);

        if (evaluation) {
          const oldDescLen = photo.description?.length || 0;
          const newDescLen = evaluation.description?.length || 0;

          photo.score = evaluation.score;
          photo.reason = evaluation.reason;
          photo.description = evaluation.description;
          totalUpdated++;

          console.log(`      Score: ${evaluation.score}/10`);
          console.log(`      Description: ${oldDescLen} → ${newDescLen} chars`);
          console.log(`      "${evaluation.description.substring(0, 80)}..."`);
        } else {
          console.log(`      Failed to evaluate`);
        }

        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 300));
      }

      // Sort photos by score after re-evaluation
      location.photos.sort((a, b) => b.score - a.score);
    }

    // Update timestamp
    eventData.lastUpdated = new Date().toISOString();

    // Save after each event
    fs.writeFileSync(DATABANK_FILE, JSON.stringify(databank, null, 2));
    console.log(`  Saved.`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('RE-EVALUATION COMPLETE');
  console.log('='.repeat(60));
  console.log(`Evaluated: ${totalEvaluated} photos`);
  console.log(`Updated:   ${totalUpdated} photos`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

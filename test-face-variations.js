/**
 * Test: Generate 4 Face Variations in One API Call
 *
 * This script:
 * 1. Takes a face photo as input
 * 2. Generates 4 forward-facing face variations in ONE Gemini API call (2x2 grid)
 * 3. Splits the grid into 4 separate images
 * 4. Compares all images using LPIPS & ArcFace
 * 5. Has Gemini evaluate which face is best
 * 6. User can then select the best face for avatar generation
 *
 * Usage: node test-face-variations.js [path-to-photo.jpg]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Configuration
const PHOTO_ANALYZER_URL = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
const OUTPUT_DIR = path.join(__dirname, 'test-output', `face-variations-${Date.now()}`);

// Load prompt template
const PROMPT_FILE = path.join(__dirname, 'prompts', 'test-face-variations.txt');

/**
 * Read config.json for API key
 */
function getGeminiApiKey() {
  // Try environment first
  if (process.env.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY;
  }
  // Try config.json
  const configPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config.geminiApiKey;
  }
  throw new Error('GEMINI_API_KEY not found in env or config.json');
}

/**
 * Load image as base64 data URL
 */
function loadImageAsBase64(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

/**
 * Save base64 image to file
 */
function saveImage(base64Data, filename) {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  const base64Clean = base64Data.replace(/^data:image\/\w+;base64,/, '');
  const filepath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(filepath, Buffer.from(base64Clean, 'base64'));
  return filepath;
}

/**
 * Generate 2x2 grid of face variations using Gemini
 */
async function generateFaceVariations(photoBase64, apiKey) {
  const prompt = fs.readFileSync(PROMPT_FILE, 'utf8');

  // Extract just the base64 data
  const photoData = photoBase64.replace(/^data:image\/\w+;base64,/, '');
  const mimeType = photoBase64.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';

  const requestBody = {
    systemInstruction: {
      parts: [{
        text: `You are an expert children's book illustrator specializing in character portraits.
Your task is to create 4 variations of the same child's face in a 2x2 grid layout.
CRITICAL: All 4 faces must be recognizably the SAME child - only expression/lighting varies.`
      }]
    },
    contents: [{
      parts: [
        {
          inline_data: {
            mime_type: mimeType,
            data: photoData
          }
        },
        { text: prompt }
      ]
    }],
    generationConfig: {
      temperature: 1.0,
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: {
        aspectRatio: "1:1"
      }
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
    ]
  };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    }
  );

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errorData}`);
  }

  const data = await response.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

  if (!imagePart) {
    const textPart = parts.find(p => p.text);
    const finishReason = data.candidates?.[0]?.finishReason;
    if (finishReason === 'SAFETY') {
      throw new Error('Image generation blocked by safety filters');
    }
    if (finishReason === 'IMAGE_OTHER') {
      throw new Error('Gemini could not generate image - try rephrasing the prompt');
    }
    throw new Error(`No image generated. Response: ${textPart?.text || JSON.stringify(data).substring(0, 500)}`);
  }

  return `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
}

/**
 * Split 2x2 grid into 4 quadrants using photo_analyzer
 */
async function splitGrid(gridBase64) {
  const response = await fetch(`${PHOTO_ANALYZER_URL}/split-grid`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: gridBase64 })
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(`Split grid failed: ${result.error}`);
  }

  // Return as array for easier iteration
  // Note: quadrant names from split-grid API are legacy names from avatar grid format
  // For our 4-face test, they map to: top-left, top-right, bottom-left, bottom-right
  return [
    { name: 'Face 1 (Neutral)', position: 'top-left', image: result.quadrants.faceFront },
    { name: 'Face 2 (Gentle Smile)', position: 'top-right', image: result.quadrants.faceProfile },
    { name: 'Face 3 (Curious)', position: 'bottom-left', image: result.quadrants.bodyFront },
    { name: 'Face 4 (Happy Smile)', position: 'bottom-right', image: result.quadrants.bodyProfile }
  ];
}

/**
 * Compare two images using ArcFace identity matching
 */
async function compareIdentity(image1, image2) {
  try {
    const response = await fetch(`${PHOTO_ANALYZER_URL}/compare-identity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image1, image2 })
    });

    const result = await response.json();
    if (!result.success) {
      console.error(`      [ArcFace failed: ${result.error}]`);
    }
    return result.success ? result : null;
  } catch (err) {
    console.error('ArcFace error:', err.message);
    return null;
  }
}

/**
 * Compare two images using LPIPS perceptual similarity
 */
async function compareLPIPS(image1, image2) {
  try {
    const response = await fetch(`${PHOTO_ANALYZER_URL}/lpips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image1, image2 })
    });

    const result = await response.json();
    return result.success ? result : null;
  } catch (err) {
    console.error('LPIPS error:', err.message);
    return null;
  }
}

/**
 * Have Gemini evaluate which face variation is best
 */
async function evaluateWithGemini(originalPhoto, variations, apiKey) {
  // Build the content parts with all images
  const parts = [
    { text: 'ORIGINAL PHOTO (reference):' },
    {
      inline_data: {
        mime_type: originalPhoto.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg',
        data: originalPhoto.replace(/^data:image\/\w+;base64,/, '')
      }
    },
    { text: '\n\nGENERATED FACE VARIATIONS:' }
  ];

  // Add each variation
  for (let i = 0; i < variations.length; i++) {
    const v = variations[i];
    parts.push({ text: `\n\n${v.name}:` });
    parts.push({
      inline_data: {
        mime_type: v.image.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg',
        data: v.image.replace(/^data:image\/\w+;base64,/, '')
      }
    });
  }

  parts.push({
    text: `

EVALUATION TASK:
You are evaluating 4 illustrated avatar face variations generated from the original photo.

For each variation, assess:
1. Face identity preservation (does it look like the same child?)
2. Art style quality (is it well-executed children's book illustration?)
3. Expression rendering (is the intended expression clear and appealing?)
4. Overall appeal (would this make a good avatar for a children's book?)

Respond in JSON format:
{
  "rankings": [
    {
      "rank": 1,
      "variation": "Variation X (name)",
      "score": 85,
      "reasoning": "Brief explanation"
    },
    ...
  ],
  "recommendation": "Which variation is best for avatar use and why",
  "concerns": "Any issues noticed across variations"
}
`
  });

  const requestBody = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: "application/json"
    }
  };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    }
  );

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Gemini evaluation error ${response.status}: ${errorData}`);
  }

  const data = await response.json();
  const textPart = data.candidates?.[0]?.content?.parts?.find(p => p.text);

  if (!textPart) {
    return null;
  }

  try {
    return JSON.parse(textPart.text);
  } catch {
    return { raw: textPart.text };
  }
}

/**
 * Main test function
 */
async function main() {
  console.log('🎨 Face Variations Test - Generate 4 in One API Call\n');

  // Get photo path from args or use default
  const photoPath = process.argv[2] || path.join(__dirname, 'images', 'Real person.jpg');

  if (!fs.existsSync(photoPath)) {
    console.error(`❌ Photo not found: ${photoPath}`);
    console.log('\nUsage: node test-face-variations.js [path-to-photo.jpg]');
    process.exit(1);
  }

  console.log(`📷 Input photo: ${photoPath}`);
  console.log(`📁 Output dir:  ${OUTPUT_DIR}\n`);

  // Load API key
  const apiKey = getGeminiApiKey();
  console.log('✅ Gemini API key loaded\n');

  // Load the photo
  console.log('1. Loading input photo...');
  const photoBase64 = loadImageAsBase64(photoPath);
  saveImage(photoBase64, '0-original-photo.jpg');
  console.log('   Saved: 0-original-photo.jpg\n');

  // Generate the 2x2 grid
  console.log('2. Generating 4 face variations (single API call)...');
  const startTime = Date.now();
  const gridImage = await generateFaceVariations(photoBase64, apiKey);
  const genTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`   ✅ Generated in ${genTime}s`);
  saveImage(gridImage, '1-full-grid.png');
  console.log('   Saved: 1-full-grid.png\n');

  // Split the grid
  console.log('3. Splitting grid into 4 quadrants...');
  const variations = await splitGrid(gridImage);
  console.log(`   ✅ Split into ${variations.length} quadrants`);

  // Save each variation
  for (let i = 0; i < variations.length; i++) {
    const v = variations[i];
    const filename = `2-variation-${i + 1}-${v.position}.jpg`;
    saveImage(v.image, filename);
    console.log(`   Saved: ${filename} (${v.name})`);
  }
  console.log();

  // Compare each variation to original
  console.log('4. Comparing variations to original photo...\n');

  const results = [];

  for (let i = 0; i < variations.length; i++) {
    const v = variations[i];
    process.stdout.write(`   ${v.name}: `);

    // ArcFace comparison
    const arcface = await compareIdentity(photoBase64, v.image);
    const arcScore = arcface?.similarity || 0;
    const samePerson = arcface?.same_person || false;

    // LPIPS comparison
    const lpips = await compareLPIPS(photoBase64, v.image);
    const lpipsScore = lpips?.lpips_score ?? -1;

    results.push({
      index: i + 1,
      name: v.name,
      position: v.position,
      image: v.image,
      arcface: arcScore,
      samePerson,
      lpips: lpipsScore,
      confidence: arcface?.confidence || 'unknown'
    });

    console.log(`ArcFace: ${(arcScore * 100).toFixed(1)}% ${samePerson ? '✅' : '❌'} | LPIPS: ${lpipsScore >= 0 ? lpipsScore.toFixed(3) : 'N/A'}`);
  }
  console.log();

  // Pairwise comparisons between variations
  console.log('5. Pairwise comparisons between variations...\n');
  console.log('   Pair        | ArcFace | LPIPS');
  console.log('   ------------|---------|-------');

  const pairs = [];
  for (let i = 0; i < variations.length; i++) {
    for (let j = i + 1; j < variations.length; j++) {
      const arcface = await compareIdentity(variations[i].image, variations[j].image);
      const lpips = await compareLPIPS(variations[i].image, variations[j].image);

      const pairName = `V${i+1} vs V${j+1}`;
      const arcScore = arcface?.similarity || 0;
      const lpipsScore = lpips?.lpips_score ?? -1;

      pairs.push({ pair: pairName, arcface: arcScore, lpips: lpipsScore });
      console.log(`   ${pairName.padEnd(12)} | ${(arcScore * 100).toFixed(1)}%   | ${lpipsScore >= 0 ? lpipsScore.toFixed(3) : 'N/A'}`);
    }
  }
  console.log();

  // Gemini evaluation
  console.log('6. Gemini evaluation of variations...\n');
  const evaluation = await evaluateWithGemini(photoBase64, variations, apiKey);

  if (evaluation?.rankings) {
    console.log('   Gemini Rankings:');
    console.log('   ----------------');
    for (const r of evaluation.rankings) {
      console.log(`   #${r.rank}: ${r.variation} (Score: ${r.score}/100)`);
      console.log(`       ${r.reasoning}`);
    }
    console.log();
    console.log(`   Recommendation: ${evaluation.recommendation}`);
    if (evaluation.concerns) {
      console.log(`   Concerns: ${evaluation.concerns}`);
    }
  } else if (evaluation?.raw) {
    console.log('   Raw response:', evaluation.raw.substring(0, 500));
  } else {
    console.log('   ⚠️ Could not parse Gemini evaluation');
  }
  console.log();

  // Final summary
  console.log('7. Final Summary:\n');

  // Sort by combined score (higher ArcFace, lower LPIPS is better)
  results.sort((a, b) => {
    // Normalize: ArcFace (0-1, higher better) vs LPIPS (0-1, lower better)
    const scoreA = a.arcface - (a.lpips >= 0 ? a.lpips : 0.5);
    const scoreB = b.arcface - (b.lpips >= 0 ? b.lpips : 0.5);
    return scoreB - scoreA;
  });

  console.log('   Rank | Variation                 | ArcFace | LPIPS  | Same Person');
  console.log('   -----|---------------------------|---------|--------|------------');

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const marker = i === 0 ? ' 👑' : '';
    console.log(`   ${(i + 1).toString().padStart(4)} | ${r.name.padEnd(25)} | ${(r.arcface * 100).toFixed(1)}%   | ${r.lpips >= 0 ? r.lpips.toFixed(3) : 'N/A  '}  | ${r.samePerson ? '✅' : '❌'} ${r.confidence}${marker}`);
  }

  // Save results summary
  const summary = {
    timestamp: new Date().toISOString(),
    inputPhoto: photoPath,
    outputDir: OUTPUT_DIR,
    generationTime: `${genTime}s`,
    variations: results.map(r => ({
      name: r.name,
      position: r.position,
      arcface: r.arcface,
      lpips: r.lpips,
      samePerson: r.samePerson,
      confidence: r.confidence
    })),
    pairwiseComparisons: pairs,
    geminiEvaluation: evaluation
  };

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'results.json'),
    JSON.stringify(summary, null, 2)
  );

  console.log(`\n✅ Done! Results saved to ${OUTPUT_DIR}`);
  console.log(`   - 0-original-photo.jpg`);
  console.log(`   - 1-full-grid.png`);
  console.log(`   - 2-variation-*.jpg (4 files)`);
  console.log(`   - results.json`);
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  if (err.message.includes('ECONNREFUSED')) {
    console.error('\n💡 Make sure photo_analyzer.py is running: npm run dev:python');
  }
  process.exit(1);
});

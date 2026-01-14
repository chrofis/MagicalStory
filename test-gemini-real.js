const { Pool } = require('pg');
const https = require('https');

const pool = new Pool({connectionString: 'postgresql://postgres:CkudCnsnCYbUdHxztMaHklimyMZCJAqJ@turntable.proxy.rlwy.net:26087/railway'});

pool.query("SELECT data FROM characters WHERE id LIKE 'characters_%' LIMIT 1").then(r => {
  const chars = r.rows[0]?.data?.characters || [];
  const char = chars.find(c => c.thumbnail_url);
  if (!char || !char.thumbnail_url) {
    console.log('No thumbnail found');
    pool.end();
    return;
  }

  const base64Data = char.thumbnail_url.replace(/^data:image\/\w+;base64,/, '');
  const mimeType = 'image/jpeg';

  console.log('Testing with real face photo (' + base64Data.length + ' chars)...');

  const systemInstruction = `ROLE: Forensic Biometric Replication Expert - PHOTOREALISTIC MODE.

OUTPUT STYLE (CRITICAL - DO NOT DEVIATE):
Generate PHOTOREALISTIC images ONLY. The output must look like a professional photograph.
DO NOT generate:
- Pixar/Disney 3D animation style
- Cartoon or illustrated style
- Anime or manga style
- Watercolor or painted style
- Any non-photographic art style

PRIMARY DIRECTIVE: ZERO DRIFT IDENTITY.
The output MUST preserve the exact age, ethnicity, facial geometry, and unique micro-markers of the person in the provided reference photos.
If the subject is a child, they MUST remain a child with child-like proportions and features. Do not mature the face.
If the subject has specific facial markers (moles, scars, eye shape), these MUST be retained with 100% accuracy.

CRITICAL RULE: NO "BEAUTIFICATION".
Do not apply "Standard Fashion Model" features. The face must be a literal duplicate of the reference.
The goal is a photographic "Documentary" level of facial realism - NOT animated or stylized.`;

  const prompt = `TASK: Create a 2x2 Character Concept Design Sheet / Orthographic Views. Use a GRID IMAGE with 4 views of the EXACT individual from the reference photos.

OUTPUT STYLE: PHOTOREALISTIC - This must look like a professional fashion photograph, NOT a cartoon, NOT animated, NOT Pixar style.

GRID LAYOUT (with clear black dividing lines between quadrants):
- TOP LEFT: Face - Front (looking at camera)
- TOP RIGHT: Face - 3/4 Profile (75 degrees, looking RIGHT)
- BOTTOM LEFT: Full Body - Front View (facing camera)
- BOTTOM RIGHT: Full Body - Profile View (facing RIGHT)

CRITICAL GRID REQUIREMENTS:
- Clean 2x2 collage layout with a thin neutral divider.
- Both profile views (top right and bottom right) the face looks towards the RIGHT
- Each quadrant has solid light grey (off-white) studio background
- All 4 quadrants show the SAME outfit.

VISUAL REQUIREMENTS:
- Face: 100% identical to reference photo. Direct replication, not averaged.
- Expression: Natural, friendly expression.
- Body: Generate age-appropriate body proportions based on the apparent age visible in the reference photo.
- Setting: Solid light grey studio background in each quadrant.
- Lighting: Natural, even, studio-style diffused light.

BODY TRANSFORMATION (CRITICAL):
- Generate the person with an ATHLETIC, FIT body type by default
- Do NOT preserve overweight or heavy body proportions from the reference photo
- Keep the EXACT same face and identity, but transform the body to be slim and athletic

WARDROBE DETAILS:
- Outfit: Long-sleeved T-shirt, casual hoodie, or cozy sweater with the SAME pattern AND colors as the input image clothing. Jeans or casual trousers. Casual shoes.

Output Quality: 4k, Photorealistic.`;

  const data = JSON.stringify({
    systemInstruction: {parts: [{text: systemInstruction}]},
    contents: [{parts: [
      {inline_data: {mime_type: mimeType, data: base64Data}},
      {text: prompt}
    ]}],
    generationConfig: {
      temperature: 0.3,
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: '9:16'
      }
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
    ]
  });

  const req = https.request({
    hostname: 'generativelanguage.googleapis.com',
    path: '/v1beta/models/gemini-2.5-flash-image:generateContent?key=AIzaSyAbUwQyomOeu0CsidqpTD2PZcHMEPGBvC0',
    method: 'POST',
    headers: {'Content-Type': 'application/json'}
  }, (res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
      pool.end();
      const json = JSON.parse(body);
      if (json.candidates?.[0]?.content?.parts) {
        const hasImage = json.candidates[0].content.parts.some(p => p.inlineData || p.inline_data);
        console.log(hasImage ? 'SUCCESS' : 'NO IMAGE - ' + json.candidates[0].finishReason);
      } else {
        console.log('RESULT:', JSON.stringify(json).substring(0, 400));
      }
    });
  });
  req.write(data);
  req.end();
});

const { Pool } = require('pg');
const https = require('https');

const pool = new Pool({connectionString: 'postgresql://postgres:CkudCnsnCYbUdHxztMaHklimyMZCJAqJ@turntable.proxy.rlwy.net:26087/railway'});

pool.query("SELECT data FROM characters WHERE id LIKE 'characters_%' LIMIT 1").then(r => {
  const chars = r.rows[0]?.data?.characters || [];
  const char = chars.find(c => c.thumbnail_url);
  if (!char || !char.thumbnail_url) {
    console.log('No photo found');
    pool.end();
    return;
  }

  const base64Data = char.thumbnail_url.replace(/^data:image\/\w+;base64,/, '');
  console.log('Testing with real face photo (' + base64Data.length + ' chars)...');

  const systemInstruction = 'ROLE: Forensic Biometric Replication Expert - PHOTOREALISTIC MODE. Generate PHOTOREALISTIC images ONLY.';
  const prompt = 'TASK: Create a 2x2 Character Concept Design Sheet of this person. OUTPUT STYLE: PHOTOREALISTIC. WARDROBE: Casual clothing.';

  const data = JSON.stringify({
    systemInstruction: {parts: [{text: systemInstruction}]},
    contents: [{parts: [
      {inline_data: {mime_type: 'image/jpeg', data: base64Data}},
      {text: prompt}
    ]}],
    generationConfig: {
      temperature: 0.3,
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {aspectRatio: '9:16'}
    }
  });

  const req = https.request({
    hostname: 'generativelanguage.googleapis.com',
    path: '/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + process.env.GEMINI_API_KEY,
    method: 'POST',
    headers: {'Content-Type': 'application/json'}
  }, (res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
      pool.end();
      const json = JSON.parse(body);
      if (json.candidates?.[0]?.content?.parts) {
        const hasImage = json.candidates[0].content.parts.some(p => p.inlineData);
        console.log(hasImage ? 'SUCCESS with real face' : 'FAILED: ' + json.candidates[0].finishReason);
      } else {
        console.log('ERROR:', JSON.stringify(json).substring(0, 400));
      }
    });
  });
  req.write(data);
  req.end();
});

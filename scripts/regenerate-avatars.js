require('dotenv').config();

async function regenerateAvatars() {
  const email = process.env.TEST_EMAIL;
  const password = process.env.TEST_PASSWORD;

  console.log('Attempting login with email:', email);

  // First, login to get auth token (API expects 'username' field, not 'email')
  const loginRes = await fetch('https://magicalstory.ch/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: email, password })
  });

  console.log('Login status:', loginRes.status);

  if (!loginRes.ok) {
    console.error('Login failed:', await loginRes.text());
    return;
  }

  const { token } = await loginRes.json();
  console.log('Login successful');

  // Get characters with full data
  const charsRes = await fetch('https://magicalstory.ch/api/characters?mode=full', {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const { characters } = await charsRes.json();
  console.log('Found', characters.length, 'characters');

  // Find Roger and Franziska
  const toRegenerate = characters.filter(c => c.name === 'Roger' || c.name === 'Franziska');

  for (const char of toRegenerate) {
    console.log('\n=== ' + char.name + ' ===');
    console.log('  characterId:', char.characterId);
    console.log('  hasPhoto:', !!char.photo_url);
    console.log('  photo_url type:', char.photo_url ? (char.photo_url.startsWith('data:') ? 'base64' : 'url') : 'none');
    console.log('  avatarStatus:', char.avatars?.status || 'none');
    console.log('  gender:', char.gender);
    console.log('  age:', char.age);
    console.log('  build:', char.build);

    if (!char.photo_url) {
      console.log('  ⚠️ NO PHOTO - cannot regenerate avatar');
      continue;
    }

    // Trigger avatar regeneration
    console.log('\n  Starting avatar regeneration...');

    const regenRes = await fetch('https://magicalstory.ch/api/generate-clothing-avatars?async=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        characterId: char.characterId,
        facePhoto: char.photo_url,
        name: char.name,
        age: char.age,
        gender: char.gender,
        build: char.build,
        physicalTraits: char.physicalTraits || char.physical_traits,
        physicalDescription: char.physicalDescription,
        clothing: char.structured_clothing
      })
    });

    const regenData = await regenRes.json();
    console.log('  Response:', JSON.stringify(regenData, null, 2));

    if (regenData.jobId) {
      console.log('  Job started:', regenData.jobId);

      // Poll for completion
      let attempts = 0;
      const maxAttempts = 60; // 2 minutes max

      while (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 2000));
        attempts++;

        const statusRes = await fetch(`https://magicalstory.ch/api/avatar-jobs/${regenData.jobId}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        const statusData = await statusRes.json();
        console.log(`  [${attempts}] Status: ${statusData.status}, Progress: ${statusData.progress || 0}%`);

        if (statusData.status === 'complete') {
          console.log('  ✅ Avatar generation complete!');
          break;
        } else if (statusData.status === 'failed') {
          console.log('  ❌ Avatar generation failed:', statusData.error);
          break;
        }
      }

      if (attempts >= maxAttempts) {
        console.log('  ⏰ Timeout waiting for avatar generation');
      }
    }
  }
}

regenerateAvatars().catch(console.error);

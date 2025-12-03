const fs = require('fs');

async function testModel(apiKey, modelName) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: modelName,
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Say "API test successful"' }]
    })
  });

  const data = await response.json();
  return { status: response.status, data };
}

async function testAPI() {
  try {
    const config = JSON.parse(fs.readFileSync('./data/config.json', 'utf8'));
    const apiKey = config.anthropicApiKey;

    console.log('Testing API key:', apiKey.substring(0, 20) + '...\n');

    // Test multiple model names
    const modelsToTest = [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-20240620',
      'claude-3-sonnet-20240229',
      'claude-3-opus-20240229',
      'claude-3-haiku-20240307',
      'claude-2.1',
      'claude-2.0'
    ];

    for (const model of modelsToTest) {
      process.stdout.write(`Testing ${model}... `);
      const result = await testModel(apiKey, model);

      if (result.status === 200) {
        console.log('✅ WORKS!');
        console.log('Response:', result.data.content[0].text);
        break;
      } else {
        console.log('❌', result.data.error?.type || 'failed');
      }
    }
  } catch (err) {
    console.error('\n❌ Error:', err.message);
  }
}

testAPI();

// Cloudflare Worker for Anthropic API Proxy
// This bypasses CORS restrictions by forwarding requests from browser to Anthropic API

export default {
  async fetch(request, env) {
    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Only allow POST requests to /api/generate
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      // Parse the incoming request
      const body = await request.json();
      const { apiKey, prompt, model, max_tokens } = body;

      // Validate required fields
      if (!apiKey || !prompt || !model) {
        return new Response(JSON.stringify({
          error: { message: 'Missing required fields: apiKey, prompt, or model' }
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      // Forward request to Anthropic API
      const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: model,
          max_tokens: max_tokens || 4000,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
        }),
      });

      // Get the response
      const responseData = await anthropicResponse.text();

      // Forward the response back to the browser with CORS headers
      return new Response(responseData, {
        status: anthropicResponse.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });

    } catch (error) {
      return new Response(JSON.stringify({
        error: { message: error.message }
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};

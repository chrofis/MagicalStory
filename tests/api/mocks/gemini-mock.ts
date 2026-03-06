/**
 * Mock responses for Gemini API calls
 * Used for testing without incurring API costs
 */

export const mockGeminiResponses = {
  // Photo analysis response (traits extraction)
  photoAnalysis: {
    success: true,
    traits: {
      height: 'average',
      build: 'slim',
      eyeColor: 'blue',
      hairColor: 'brown',
      hairStyle: 'short and curly',
      skinTone: 'fair',
      apparentAge: 'school-age',
      other: 'freckles on cheeks'
    }
  },

  // Avatar evaluation response (quality + clothing extraction)
  avatarEvaluation: {
    success: true,
    score: 8.5,
    faceScore: 9,
    bodyScore: 8,
    clothingScore: 8,
    clothing: {
      upperBody: 'red t-shirt with cartoon print',
      lowerBody: 'blue denim shorts',
      shoes: 'white sneakers'
    },
    issues: []
  },

  // Scene description generation
  sceneDescription: {
    success: true,
    description: 'A cheerful 8-year-old with curly brown hair and bright blue eyes stands in a sunny meadow, wearing a red t-shirt and blue shorts, pointing excitedly at a butterfly.'
  }
};

/**
 * Create a mock fetch function for Gemini API
 */
export function createGeminiMock() {
  return async (url: string, options: RequestInit) => {
    // Parse the request to determine which response to return
    const body = JSON.parse(options.body as string);

    // Check for different prompt types
    const promptText = body.contents?.[0]?.parts?.[0]?.text || '';

    if (promptText.includes('analyze') && promptText.includes('photo')) {
      return createMockResponse(mockGeminiResponses.photoAnalysis);
    }

    if (promptText.includes('evaluate') && promptText.includes('avatar')) {
      return createMockResponse(mockGeminiResponses.avatarEvaluation);
    }

    if (promptText.includes('scene') || promptText.includes('illustration')) {
      return createMockResponse(mockGeminiResponses.sceneDescription);
    }

    // Default response
    return createMockResponse({ success: true, text: 'Mock response' });
  };
}

function createMockResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{ text: JSON.stringify(data) }]
        }
      }]
    })
  };
}

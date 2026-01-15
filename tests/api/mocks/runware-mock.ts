/**
 * Mock responses for Runware API calls
 * Used for testing without incurring API costs
 */

// Small base64 test image (1x1 pixel PNG)
const TEST_IMAGE_BASE64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Slightly larger placeholder (10x10 red square)
const PLACEHOLDER_AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFklEQVR42mP8z8DwnxEPYBxVOPwEAAj5B/tB+Z8WAAAAAElFTkSuQmCC';

export const mockRunwareResponses = {
  // Standard avatar generation (SDXL)
  avatarGeneration: {
    success: true,
    images: [PLACEHOLDER_AVATAR],
    taskUUID: 'mock-task-uuid-12345',
    model: 'sdxl'
  },

  // ACE++ face-consistent avatar
  aceAvatarGeneration: {
    success: true,
    images: [PLACEHOLDER_AVATAR],
    taskUUID: 'mock-ace-uuid-67890',
    model: 'ace++',
    faceConsistency: 0.92
  },

  // Inpainting response
  inpaintingResult: {
    success: true,
    images: [PLACEHOLDER_AVATAR],
    taskUUID: 'mock-inpaint-uuid'
  },

  // Error responses
  rateLimitError: {
    success: false,
    error: 'Rate limit exceeded',
    code: 429
  },

  invalidApiKey: {
    success: false,
    error: 'Invalid API key',
    code: 401
  }
};

/**
 * Create a mock WebSocket for Runware
 * (Runware uses WebSocket for real-time image generation)
 */
export class MockRunwareWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((error: Error) => void) | null = null;
  onclose: (() => void) | null = null;

  private responseQueue: unknown[] = [];

  constructor(_url: string) {
    // Simulate connection delay
    setTimeout(() => {
      this.onopen?.();
    }, 10);
  }

  send(data: string) {
    const request = JSON.parse(data);

    // Determine response based on request type
    let response;
    if (request.taskType === 'imageInference') {
      if (request.acePlusPlus) {
        response = mockRunwareResponses.aceAvatarGeneration;
      } else {
        response = mockRunwareResponses.avatarGeneration;
      }
    } else if (request.taskType === 'imageInpainting') {
      response = mockRunwareResponses.inpaintingResult;
    } else {
      response = mockRunwareResponses.avatarGeneration;
    }

    // Simulate async response
    setTimeout(() => {
      this.onmessage?.({ data: JSON.stringify(response) });
    }, 50);
  }

  close() {
    this.onclose?.();
  }

  queueResponse(response: unknown) {
    this.responseQueue.push(response);
  }
}

/**
 * Helper to create mock avatar images for different clothing types
 */
export function createMockAvatarSet() {
  return {
    winter: PLACEHOLDER_AVATAR,
    standard: PLACEHOLDER_AVATAR,
    summer: PLACEHOLDER_AVATAR,
    formal: PLACEHOLDER_AVATAR,
    faceThumbnails: {
      winter: TEST_IMAGE_BASE64,
      standard: TEST_IMAGE_BASE64,
      summer: TEST_IMAGE_BASE64,
      formal: TEST_IMAGE_BASE64
    },
    clothing: {
      winter: { upperBody: 'warm jacket', lowerBody: 'jeans', shoes: 'boots' },
      standard: { upperBody: 't-shirt', lowerBody: 'shorts', shoes: 'sneakers' },
      summer: { upperBody: 'tank top', lowerBody: 'shorts', shoes: 'sandals' },
      formal: { upperBody: 'dress shirt', lowerBody: 'dress pants', shoes: 'dress shoes' }
    },
    status: 'complete',
    generatedAt: new Date().toISOString()
  };
}

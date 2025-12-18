import { createLogger } from './logger';

const log = createLogger('PhotoService');

export interface PhotoAnalysisResult {
  success: boolean;
  faceBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  bodyBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  faceThumbnail?: string;
  bodyCrop?: string;
  bodyNoBg?: string;
  age?: string;
  gender?: string;
  height?: string;
  build?: string;
  hairColor?: string;
  skinTone?: string;
  eyeColor?: string;
  distinctiveFeatures?: string;
  source?: string;
}

export const photoService = {
  /**
   * Analyze a photo using the Python MediaPipe API
   * Returns face/body bounding boxes and pre-cropped images
   */
  async analyzePhoto(imageData: string): Promise<PhotoAnalysisResult> {
    try {
      log.info('Analyzing photo with Python MediaPipe API...');

      const response = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/analyze-photo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth_token')}`,
        },
        body: JSON.stringify({ imageData }),
      });

      if (!response.ok) {
        log.error('Python API analysis failed:', response.status);
        return { success: false };
      }

      const data = await response.json();
      log.debug('Python API response:', data);

      if (data.error) {
        log.warn('Python API returned error:', data.error);
        return { success: false };
      }

      // Extract attributes from nested object (server returns { attributes: {...} })
      const attrs = data.attributes || {};

      return {
        success: true,
        faceBox: data.faceBox,
        bodyBox: data.bodyBox,
        faceThumbnail: data.faceThumbnail,
        bodyCrop: data.bodyCrop,
        bodyNoBg: data.bodyNoBg,
        age: attrs.age || data.age,
        gender: attrs.gender || data.gender,
        height: attrs.height || data.height,
        build: attrs.build || data.build,
        hairColor: attrs.hair_color || attrs.hairColor || data.hairColor,
        skinTone: attrs.skin_tone || attrs.skinTone || data.skinTone,
        eyeColor: attrs.eye_color || attrs.eyeColor || data.eyeColor,
        distinctiveFeatures: attrs.other_features || attrs.distinctiveFeatures || data.distinctiveFeatures,
        source: 'python-mediapipe',
      };
    } catch (error) {
      log.error('Error with Python API:', error);
      return { success: false };
    }
  },

  /**
   * Convert a File to base64 data URL
   */
  async fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  },

  /**
   * Upload and analyze a character photo
   * Returns the analysis result with cropped images
   */
  async uploadAndAnalyze(file: File): Promise<{
    photoUrl: string;
    bodyPhotoUrl?: string;
    bodyNoBgUrl?: string;
    analysis?: PhotoAnalysisResult;
  }> {
    // Convert file to base64
    const base64 = await this.fileToBase64(file);

    // Analyze with Python API
    const analysis = await this.analyzePhoto(base64);

    // Use the cropped images if available, otherwise use original
    const photoUrl = analysis.faceThumbnail || base64;
    const bodyPhotoUrl = analysis.bodyCrop || base64;
    const bodyNoBgUrl = analysis.bodyNoBg || undefined;

    return {
      photoUrl,
      bodyPhotoUrl,
      bodyNoBgUrl,
      analysis: analysis.success ? analysis : undefined,
    };
  },
};

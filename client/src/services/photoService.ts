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
      console.log('Analyzing photo with Python MediaPipe API...');

      const response = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/analyze-photo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth_token')}`,
        },
        body: JSON.stringify({ imageData }),
      });

      if (!response.ok) {
        console.error('Python API analysis failed:', response.status);
        return { success: false };
      }

      const data = await response.json();
      console.log('Python API response:', data);

      if (data.error) {
        console.warn('Python API returned error:', data.error);
        return { success: false };
      }

      return {
        success: true,
        faceBox: data.faceBox,
        bodyBox: data.bodyBox,
        faceThumbnail: data.faceThumbnail,
        bodyCrop: data.bodyCrop,
        bodyNoBg: data.bodyNoBg,
        age: data.age,
        gender: data.gender,
        height: data.height,
        build: data.build,
        hairColor: data.hairColor,
        skinTone: data.skinTone,
        eyeColor: data.eyeColor,
        distinctiveFeatures: data.distinctiveFeatures,
        source: 'python-mediapipe',
      };
    } catch (error) {
      console.error('Error with Python API:', error);
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

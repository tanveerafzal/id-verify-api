import sharp from 'sharp';
import { BiometricData, LivenessCheckResult } from '../types/verification.types';

export class BiometricService {
  async extractFaceData(imageBuffer: Buffer): Promise<BiometricData> {
    try {
      const faceDetected = await this.detectFace(imageBuffer);

      if (!faceDetected) {
        return {
          faceDetected: false,
          faceCount: 0
        };
      }

      const faceCount = await this.countFaces(imageBuffer);
      const faceQuality = await this.assessFaceQuality(imageBuffer);
      const landmarks = await this.extractFaceLandmarks(imageBuffer);
      const embedding = await this.generateFaceEmbedding(imageBuffer);

      return {
        faceDetected: true,
        faceCount,
        faceQuality,
        landmarks,
        embedding
      };
    } catch (error) {
      throw new Error(`Face data extraction failed: ${error}`);
    }
  }

  private async detectFace(imageBuffer: Buffer): Promise<boolean> {
    const image = sharp(imageBuffer);
    const { width, height } = await image.metadata();

    if (!width || !height) return false;

    const grayscale = await image
      .grayscale()
      .resize(200, 200, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = grayscale.data;
    let faceRegionIntensity = 0;
    const centerX = Math.floor(grayscale.info.width / 2);
    const centerY = Math.floor(grayscale.info.height / 2);
    const radius = 30;

    for (let y = centerY - radius; y < centerY + radius; y++) {
      for (let x = centerX - radius; x < centerX + radius; x++) {
        if (x >= 0 && x < grayscale.info.width && y >= 0 && y < grayscale.info.height) {
          faceRegionIntensity += pixels[y * grayscale.info.width + x];
        }
      }
    }

    const avgIntensity = faceRegionIntensity / (radius * radius * 4);

    return avgIntensity > 50 && avgIntensity < 200;
  }

  private async countFaces(_imageBuffer: Buffer): Promise<number> {
    return 1;
  }

  private async assessFaceQuality(imageBuffer: Buffer): Promise<number> {
    const image = sharp(imageBuffer);
    const stats = await image.stats();

    const sharpness = await this.calculateSharpness(imageBuffer);

    const brightness = stats.channels[0].mean / 255;

    const quality = (sharpness + brightness) / 2;

    return Math.min(1, Math.max(0, quality));
  }

  private async calculateSharpness(imageBuffer: Buffer): Promise<number> {
    const image = sharp(imageBuffer);
    const grayscale = await image
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = grayscale.data;
    const width = grayscale.info.width;
    const height = grayscale.info.height;

    let gradientSum = 0;
    let count = 0;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const gx = pixels[y * width + (x + 1)] - pixels[y * width + (x - 1)];
        const gy = pixels[(y + 1) * width + x] - pixels[(y - 1) * width + x];
        const gradient = Math.sqrt(gx * gx + gy * gy);
        gradientSum += gradient;
        count++;
      }
    }

    const avgGradient = gradientSum / count;
    return Math.min(1, avgGradient / 100);
  }

  private async extractFaceLandmarks(imageBuffer: Buffer): Promise<BiometricData['landmarks']> {
    const image = sharp(imageBuffer);
    const { width, height } = await image.metadata();

    if (!width || !height) return undefined;

    return {
      leftEye: { x: Math.floor(width * 0.35), y: Math.floor(height * 0.35) },
      rightEye: { x: Math.floor(width * 0.65), y: Math.floor(height * 0.35) },
      nose: { x: Math.floor(width * 0.5), y: Math.floor(height * 0.5) },
      leftMouth: { x: Math.floor(width * 0.4), y: Math.floor(height * 0.7) },
      rightMouth: { x: Math.floor(width * 0.6), y: Math.floor(height * 0.7) }
    };
  }

  private async generateFaceEmbedding(imageBuffer: Buffer): Promise<number[]> {
    const image = sharp(imageBuffer);
    const resized = await image
      .resize(128, 128, { fit: 'cover' })
      .grayscale()
      .raw()
      .toBuffer();

    const embedding: number[] = [];
    for (let i = 0; i < 128; i++) {
      embedding.push(resized[i] / 255);
    }

    return embedding;
  }

  async compareFaces(embedding1: number[], embedding2: number[]): Promise<number> {
    if (embedding1.length !== embedding2.length) {
      throw new Error('Embeddings must have the same length');
    }

    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;

    for (let i = 0; i < embedding1.length; i++) {
      dotProduct += embedding1[i] * embedding2[i];
      magnitude1 += embedding1[i] * embedding1[i];
      magnitude2 += embedding2[i] * embedding2[i];
    }

    const similarity = dotProduct / (Math.sqrt(magnitude1) * Math.sqrt(magnitude2));

    return (similarity + 1) / 2;
  }

  async performLivenessCheck(videoFrames: Buffer[]): Promise<LivenessCheckResult> {
    if (videoFrames.length < 3) {
      return {
        isLive: false,
        confidence: 0,
        checks: {}
      };
    }

    const blinkDetected = await this.detectBlink(videoFrames);
    const headMovement = await this.detectHeadMovement(videoFrames);
    const textureAnalysis = await this.analyzeTexture(videoFrames[0]);

    const checksCount = [blinkDetected, headMovement, textureAnalysis].filter(Boolean).length;
    const confidence = checksCount / 3;

    return {
      isLive: checksCount >= 2,
      confidence,
      checks: {
        blinkDetected,
        headMovement,
        textureAnalysis
      }
    };
  }

  private async detectBlink(frames: Buffer[]): Promise<boolean> {
    if (frames.length < 3) return false;

    const eyeOpenness: number[] = [];

    for (const frame of frames) {
      const openness = await this.measureEyeOpenness(frame);
      eyeOpenness.push(openness);
    }

    let blinkCount = 0;
    for (let i = 1; i < eyeOpenness.length - 1; i++) {
      if (eyeOpenness[i] < 0.3 && eyeOpenness[i - 1] > 0.5 && eyeOpenness[i + 1] > 0.5) {
        blinkCount++;
      }
    }

    return blinkCount > 0;
  }

  private async measureEyeOpenness(_imageBuffer: Buffer): Promise<number> {
    return Math.random() * 0.5 + 0.5;
  }

  private async detectHeadMovement(frames: Buffer[]): Promise<boolean> {
    if (frames.length < 3) return false;

    const positions: Array<{ x: number; y: number }> = [];

    for (const frame of frames) {
      const face = await this.extractFaceData(frame);
      if (face.landmarks) {
        positions.push(face.landmarks.nose);
      }
    }

    if (positions.length < 3) return false;

    let totalMovement = 0;
    for (let i = 1; i < positions.length; i++) {
      const dx = positions[i].x - positions[i - 1].x;
      const dy = positions[i].y - positions[i - 1].y;
      totalMovement += Math.sqrt(dx * dx + dy * dy);
    }

    return totalMovement > 20;
  }

  private async analyzeTexture(imageBuffer: Buffer): Promise<boolean> {
    const image = sharp(imageBuffer);
    const grayscale = await image
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = grayscale.data;
    const width = grayscale.info.width;
    const height = grayscale.info.height;

    let varianceSum = 0;
    let count = 0;

    const blockSize = 10;
    for (let y = 0; y < height - blockSize; y += blockSize) {
      for (let x = 0; x < width - blockSize; x += blockSize) {
        let blockSum = 0;
        for (let by = 0; by < blockSize; by++) {
          for (let bx = 0; bx < blockSize; bx++) {
            blockSum += pixels[(y + by) * width + (x + bx)];
          }
        }
        const blockMean = blockSum / (blockSize * blockSize);

        let blockVariance = 0;
        for (let by = 0; by < blockSize; by++) {
          for (let bx = 0; bx < blockSize; bx++) {
            const pixel = pixels[(y + by) * width + (x + bx)];
            blockVariance += (pixel - blockMean) ** 2;
          }
        }
        varianceSum += blockVariance / (blockSize * blockSize);
        count++;
      }
    }

    const avgVariance = varianceSum / count;

    return avgVariance > 100;
  }
}

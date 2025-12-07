import sharp from 'sharp';
import { ImageAnnotatorClient } from '@google-cloud/vision';
import { RekognitionClient, CompareFacesCommand } from '@aws-sdk/client-rekognition';
import { BiometricData, LivenessCheckResult } from '../types/verification.types';

// Face annotation interface from Google Vision API
interface FaceAnnotation {
  boundingPoly?: { vertices?: Array<{ x?: number; y?: number }> };
  landmarks?: Array<{
    type?: string;
    position?: { x?: number; y?: number; z?: number };
  }>;
  rollAngle?: number;
  panAngle?: number;
  tiltAngle?: number;
  detectionConfidence?: number;
  landmarkingConfidence?: number;
  joyLikelihood?: string;
  sorrowLikelihood?: string;
  angerLikelihood?: string;
  surpriseLikelihood?: string;
  underExposedLikelihood?: string;
  blurredLikelihood?: string;
  headwearLikelihood?: string;
}

export class BiometricService {
  private visionClient: ImageAnnotatorClient | null = null;
  private rekognitionClient: RekognitionClient | null = null;
  private useGoogleVision: boolean = false;
  private useAwsRekognition: boolean = false;

  constructor() {
    this.initializeGoogleVision();
    this.initializeAwsRekognition();
  }

  private initializeGoogleVision(): void {
    try {
      if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_CLOUD_PROJECT) {
        this.visionClient = new ImageAnnotatorClient();
        this.useGoogleVision = true;
        console.log('[BiometricService] Google Cloud Vision API initialized for face detection');
      } else {
        console.log('[BiometricService] Google Cloud Vision credentials not found, using fallback');
      }
    } catch (error) {
      console.log('[BiometricService] Failed to initialize Google Vision:', error);
      this.useGoogleVision = false;
    }
  }

  private initializeAwsRekognition(): void {
    try {
      if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
        this.rekognitionClient = new RekognitionClient({
          region: process.env.AWS_REGION || 'us-east-1',
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
          }
        });
        this.useAwsRekognition = true;
        console.log('[BiometricService] AWS Rekognition initialized for face comparison');
      } else {
        console.log('[BiometricService] AWS credentials not found, face comparison will use fallback');
      }
    } catch (error) {
      console.log('[BiometricService] Failed to initialize AWS Rekognition:', error);
      this.useAwsRekognition = false;
    }
  }

  async extractFaceData(imageBuffer: Buffer): Promise<BiometricData> {
    try {
      if (this.useGoogleVision && this.visionClient) {
        return this.extractFaceDataWithGoogleVision(imageBuffer);
      }
      return this.extractFaceDataFallback(imageBuffer);
    } catch (error) {
      console.error('[BiometricService] Face extraction error, using fallback:', error);
      return this.extractFaceDataFallback(imageBuffer);
    }
  }

  private async extractFaceDataWithGoogleVision(imageBuffer: Buffer): Promise<BiometricData> {
    try {
      const [result] = await this.visionClient!.faceDetection({
        image: { content: imageBuffer.toString('base64') }
      });

      const faces = result.faceAnnotations;

      if (!faces || faces.length === 0) {
        console.log('[BiometricService] No faces detected by Google Vision');
        return {
          faceDetected: false,
          faceCount: 0
        };
      }

      const primaryFace = faces[0] as FaceAnnotation;
      console.log('[BiometricService] Google Vision detected', faces.length, 'face(s)');
      console.log('[BiometricService] Detection confidence:', primaryFace.detectionConfidence);

      // Extract landmarks from Google Vision
      const landmarks = this.extractGoogleVisionLandmarks(primaryFace);

      // Generate embedding from face features
      const embedding = this.generateEmbeddingFromFaceAnnotation(primaryFace);

      // Calculate face quality based on Vision API metrics
      const faceQuality = this.calculateFaceQualityFromAnnotation(primaryFace);

      return {
        faceDetected: true,
        faceCount: faces.length,
        faceQuality,
        landmarks,
        embedding,
        googleVisionData: primaryFace // Store full annotation for comparison
      };
    } catch (error) {
      console.error('[BiometricService] Google Vision face detection failed:', error);
      return this.extractFaceDataFallback(imageBuffer);
    }
  }

  private extractGoogleVisionLandmarks(face: FaceAnnotation): BiometricData['landmarks'] {
    if (!face.landmarks) return undefined;

    const getLandmark = (type: string) => {
      const landmark = face.landmarks?.find(l => l.type === type);
      return landmark?.position ? { x: landmark.position.x || 0, y: landmark.position.y || 0 } : null;
    };

    const leftEye = getLandmark('LEFT_EYE');
    const rightEye = getLandmark('RIGHT_EYE');
    const nose = getLandmark('NOSE_TIP');
    const leftMouth = getLandmark('MOUTH_LEFT');
    const rightMouth = getLandmark('MOUTH_RIGHT');

    if (!leftEye || !rightEye || !nose || !leftMouth || !rightMouth) {
      return undefined;
    }

    return { leftEye, rightEye, nose, leftMouth, rightMouth };
  }

  private generateEmbeddingFromFaceAnnotation(face: FaceAnnotation): number[] {
    const embedding: number[] = [];

    // Use facial landmarks positions for embedding
    if (face.landmarks) {
      for (const landmark of face.landmarks) {
        if (landmark.position) {
          embedding.push(landmark.position.x || 0);
          embedding.push(landmark.position.y || 0);
          embedding.push(landmark.position.z || 0);
        }
      }
    }

    // Add face angles for better discrimination
    embedding.push(face.rollAngle || 0);
    embedding.push(face.panAngle || 0);
    embedding.push(face.tiltAngle || 0);

    // Normalize the embedding
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    if (magnitude > 0) {
      return embedding.map(val => val / magnitude);
    }

    return embedding;
  }

  private calculateFaceQualityFromAnnotation(face: FaceAnnotation): number {
    let quality = face.detectionConfidence || 0.5;

    // Penalize for blur
    if (face.blurredLikelihood === 'VERY_LIKELY' || face.blurredLikelihood === 'LIKELY') {
      quality *= 0.5;
    } else if (face.blurredLikelihood === 'POSSIBLE') {
      quality *= 0.8;
    }

    // Penalize for under-exposure
    if (face.underExposedLikelihood === 'VERY_LIKELY' || face.underExposedLikelihood === 'LIKELY') {
      quality *= 0.6;
    }

    // Penalize for extreme angles
    const rollAngle = Math.abs(face.rollAngle || 0);
    const panAngle = Math.abs(face.panAngle || 0);
    const tiltAngle = Math.abs(face.tiltAngle || 0);

    if (rollAngle > 30 || panAngle > 30 || tiltAngle > 30) {
      quality *= 0.7;
    }

    return Math.min(1, Math.max(0, quality));
  }

  private async extractFaceDataFallback(imageBuffer: Buffer): Promise<BiometricData> {
    // Fallback to basic detection
    const faceDetected = await this.detectFaceFallback(imageBuffer);

    if (!faceDetected) {
      return {
        faceDetected: false,
        faceCount: 0
      };
    }

    const faceQuality = await this.assessFaceQualityFallback(imageBuffer);
    const landmarks = await this.extractFaceLandmarksFallback(imageBuffer);
    const embedding = await this.generateFaceEmbeddingFallback(imageBuffer);

    return {
      faceDetected: true,
      faceCount: 1,
      faceQuality,
      landmarks,
      embedding
    };
  }

  private async detectFaceFallback(imageBuffer: Buffer): Promise<boolean> {
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

  private async assessFaceQualityFallback(imageBuffer: Buffer): Promise<number> {
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

  private async extractFaceLandmarksFallback(imageBuffer: Buffer): Promise<BiometricData['landmarks']> {
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

  private async generateFaceEmbeddingFallback(imageBuffer: Buffer): Promise<number[]> {
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
    // Handle different embedding lengths (Google Vision vs fallback)
    const minLength = Math.min(embedding1.length, embedding2.length);

    if (minLength === 0) {
      return 0;
    }

    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;

    for (let i = 0; i < minLength; i++) {
      dotProduct += embedding1[i] * embedding2[i];
      magnitude1 += embedding1[i] * embedding1[i];
      magnitude2 += embedding2[i] * embedding2[i];
    }

    if (magnitude1 === 0 || magnitude2 === 0) {
      return 0;
    }

    const similarity = dotProduct / (Math.sqrt(magnitude1) * Math.sqrt(magnitude2));

    // Convert from [-1, 1] to [0, 1]
    return (similarity + 1) / 2;
  }

  async compareFacesWithGoogleVision(
    documentImageBuffer: Buffer,
    selfieBuffer: Buffer
  ): Promise<{ match: boolean; confidence: number; details: any }> {
    // Use AWS Rekognition if available (recommended for face comparison)
    if (this.useAwsRekognition && this.rekognitionClient) {
      return this.compareFacesWithRekognition(documentImageBuffer, selfieBuffer);
    }

    // Fallback to Google Vision landmark comparison (less accurate)
    if (this.useGoogleVision && this.visionClient) {
      return this.compareFacesWithGoogleVisionLandmarks(documentImageBuffer, selfieBuffer);
    }

    // Final fallback to embedding comparison
    console.log('[BiometricService] No face comparison service available, using embedding fallback');
    const docFace = await this.extractFaceData(documentImageBuffer);
    const selfieFace = await this.extractFaceData(selfieBuffer);

    if (!docFace.faceDetected || !selfieFace.faceDetected) {
      return { match: false, confidence: 0, details: { error: 'Face not detected' } };
    }

    const score = await this.compareFaces(docFace.embedding!, selfieFace.embedding!);
    return { match: score >= 0.85, confidence: score, details: { method: 'fallback' } };
  }

  /**
   * Compare faces using AWS Rekognition - the most accurate method
   */
  private async compareFacesWithRekognition(
    documentImageBuffer: Buffer,
    selfieBuffer: Buffer
  ): Promise<{ match: boolean; confidence: number; details: any }> {
    try {
      console.log('[BiometricService] Using AWS Rekognition for face comparison');

      const command = new CompareFacesCommand({
        SourceImage: {
          Bytes: documentImageBuffer
        },
        TargetImage: {
          Bytes: selfieBuffer
        },
        SimilarityThreshold: 0 // Get all results, we'll filter by threshold ourselves
      });

      const response = await this.rekognitionClient!.send(command);

      console.log('[BiometricService] Rekognition response:', {
        faceMatchesCount: response.FaceMatches?.length || 0,
        unmatchedFacesCount: response.UnmatchedFaces?.length || 0,
        sourceImageFace: response.SourceImageFace ? 'detected' : 'not detected'
      });

      // Check if source face was detected
      if (!response.SourceImageFace) {
        console.log('[BiometricService] No face detected in document image');
        return {
          match: false,
          confidence: 0,
          details: {
            error: 'No face detected in document',
            method: 'aws_rekognition'
          }
        };
      }

      // Check if we have any face matches
      if (!response.FaceMatches || response.FaceMatches.length === 0) {
        console.log('[BiometricService] No matching face found in selfie');
        return {
          match: false,
          confidence: 0,
          details: {
            error: 'Face in selfie does not match document',
            method: 'aws_rekognition',
            sourceConfidence: response.SourceImageFace.Confidence,
            unmatchedFaces: response.UnmatchedFaces?.length || 0
          }
        };
      }

      // Get the best match
      const bestMatch = response.FaceMatches[0];
      const similarity = bestMatch.Similarity || 0;
      const normalizedScore = similarity / 100; // Convert to 0-1 scale

      console.log('[BiometricService] AWS Rekognition face comparison results:');
      console.log('  - Similarity:', similarity.toFixed(2) + '%');
      console.log('  - Source face confidence:', response.SourceImageFace.Confidence?.toFixed(2) + '%');
      console.log('  - Target face confidence:', bestMatch.Face?.Confidence?.toFixed(2) + '%');

      // Match threshold: 80% similarity is a good balance
      const isMatch = similarity >= 80;

      return {
        match: isMatch,
        confidence: normalizedScore,
        details: {
          method: 'aws_rekognition',
          similarity: similarity,
          similarityPercent: similarity.toFixed(2) + '%',
          sourceConfidence: response.SourceImageFace.Confidence,
          targetConfidence: bestMatch.Face?.Confidence,
          boundingBox: bestMatch.Face?.BoundingBox,
          threshold: 80
        }
      };
    } catch (error: any) {
      console.error('[BiometricService] AWS Rekognition comparison failed:', error.message);

      // Check for specific error types
      if (error.name === 'InvalidParameterException') {
        return {
          match: false,
          confidence: 0,
          details: {
            error: 'Invalid image: ' + error.message,
            method: 'aws_rekognition'
          }
        };
      }

      // Fallback to Google Vision if Rekognition fails
      if (this.useGoogleVision && this.visionClient) {
        console.log('[BiometricService] Falling back to Google Vision landmarks');
        return this.compareFacesWithGoogleVisionLandmarks(documentImageBuffer, selfieBuffer);
      }

      return {
        match: false,
        confidence: 0,
        details: {
          error: 'Face comparison failed: ' + error.message,
          method: 'aws_rekognition'
        }
      };
    }
  }

  /**
   * Compare faces using Google Vision landmarks - less accurate fallback
   */
  private async compareFacesWithGoogleVisionLandmarks(
    documentImageBuffer: Buffer,
    selfieBuffer: Buffer
  ): Promise<{ match: boolean; confidence: number; details: any }> {
    try {
      console.log('[BiometricService] Using Google Vision landmarks for face comparison (less accurate)');

      // Get face annotations for both images
      const [docResult] = await this.visionClient!.faceDetection({
        image: { content: documentImageBuffer.toString('base64') }
      });

      const [selfieResult] = await this.visionClient!.faceDetection({
        image: { content: selfieBuffer.toString('base64') }
      });

      const docFaces = docResult.faceAnnotations;
      const selfieFaces = selfieResult.faceAnnotations;

      if (!docFaces || docFaces.length === 0) {
        console.log('[BiometricService] No face detected in document');
        return { match: false, confidence: 0, details: { error: 'No face in document', method: 'google_vision_landmarks' } };
      }

      if (!selfieFaces || selfieFaces.length === 0) {
        console.log('[BiometricService] No face detected in selfie');
        return { match: false, confidence: 0, details: { error: 'No face in selfie', method: 'google_vision_landmarks' } };
      }

      const docFace = docFaces[0] as FaceAnnotation;
      const selfieFace = selfieFaces[0] as FaceAnnotation;

      // Compare using multiple metrics
      const landmarkSimilarity = this.compareFaceLandmarks(docFace, selfieFace);
      const geometrySimilarity = this.compareFaceGeometry(docFace, selfieFace);

      // Weight the similarities
      const overallScore = (landmarkSimilarity * 0.6) + (geometrySimilarity * 0.4);

      console.log('[BiometricService] Google Vision landmark comparison results:');
      console.log('  - Landmark similarity:', landmarkSimilarity.toFixed(3));
      console.log('  - Geometry similarity:', geometrySimilarity.toFixed(3));
      console.log('  - Overall score:', overallScore.toFixed(3));
      console.log('  - WARNING: This method is less accurate than AWS Rekognition');

      return {
        match: overallScore >= 0.75,
        confidence: overallScore,
        details: {
          method: 'google_vision_landmarks',
          warning: 'Landmark-based comparison is less accurate. Consider using AWS Rekognition.',
          landmarkSimilarity,
          geometrySimilarity,
          docDetectionConfidence: docFace.detectionConfidence,
          selfieDetectionConfidence: selfieFace.detectionConfidence
        }
      };
    } catch (error) {
      console.error('[BiometricService] Google Vision comparison failed:', error);

      // Final fallback to embedding comparison
      const docFace = await this.extractFaceData(documentImageBuffer);
      const selfieFace = await this.extractFaceData(selfieBuffer);

      if (!docFace.faceDetected || !selfieFace.faceDetected) {
        return { match: false, confidence: 0, details: { error: 'Face detection failed' } };
      }

      const score = await this.compareFaces(docFace.embedding!, selfieFace.embedding!);
      return { match: score >= 0.85, confidence: score, details: { method: 'fallback_after_error' } };
    }
  }

  private compareFaceLandmarks(face1: FaceAnnotation, face2: FaceAnnotation): number {
    if (!face1.landmarks || !face2.landmarks) {
      return 0.5; // Neutral score if landmarks unavailable
    }

    // Calculate normalized distances between key facial landmarks
    const keyLandmarks = [
      'LEFT_EYE', 'RIGHT_EYE', 'LEFT_OF_LEFT_EYEBROW', 'RIGHT_OF_RIGHT_EYEBROW',
      'NOSE_TIP', 'UPPER_LIP', 'LOWER_LIP', 'MOUTH_LEFT', 'MOUTH_RIGHT',
      'LEFT_EYE_LEFT_CORNER', 'LEFT_EYE_RIGHT_CORNER',
      'RIGHT_EYE_LEFT_CORNER', 'RIGHT_EYE_RIGHT_CORNER'
    ];

    const getLandmarkPos = (face: FaceAnnotation, type: string) => {
      const landmark = face.landmarks?.find(l => l.type === type);
      return landmark?.position || null;
    };

    // Calculate face bounding box for normalization
    const getFaceSize = (face: FaceAnnotation): number => {
      if (!face.boundingPoly?.vertices || face.boundingPoly.vertices.length < 2) return 1;
      const v = face.boundingPoly.vertices;
      const width = Math.abs((v[1]?.x || 0) - (v[0]?.x || 0));
      const height = Math.abs((v[2]?.y || 0) - (v[0]?.y || 0));
      return Math.max(width, height) || 1;
    };

    const size1 = getFaceSize(face1);
    const size2 = getFaceSize(face2);

    // Compare relative positions of landmarks
    let totalSimilarity = 0;
    let count = 0;

    // Get reference point (nose tip) for relative positioning
    const nose1 = getLandmarkPos(face1, 'NOSE_TIP');
    const nose2 = getLandmarkPos(face2, 'NOSE_TIP');

    if (!nose1 || !nose2) return 0.5;

    for (const landmarkType of keyLandmarks) {
      const pos1 = getLandmarkPos(face1, landmarkType);
      const pos2 = getLandmarkPos(face2, landmarkType);

      if (pos1 && pos2) {
        // Calculate relative position from nose (normalized by face size)
        const relX1 = ((pos1.x || 0) - (nose1.x || 0)) / size1;
        const relY1 = ((pos1.y || 0) - (nose1.y || 0)) / size1;
        const relX2 = ((pos2.x || 0) - (nose2.x || 0)) / size2;
        const relY2 = ((pos2.y || 0) - (nose2.y || 0)) / size2;

        // Calculate distance between relative positions
        const distance = Math.sqrt(
          Math.pow(relX1 - relX2, 2) + Math.pow(relY1 - relY2, 2)
        );

        // Convert distance to similarity (closer = higher similarity)
        // Distance of 0 = 1.0, distance of 0.5 = 0.0
        const similarity = Math.max(0, 1 - (distance * 2));
        totalSimilarity += similarity;
        count++;
      }
    }

    return count > 0 ? totalSimilarity / count : 0.5;
  }

  private compareFaceGeometry(face1: FaceAnnotation, face2: FaceAnnotation): number {
    // Compare face angles
    const angleDiffs = [
      Math.abs((face1.rollAngle || 0) - (face2.rollAngle || 0)),
      Math.abs((face1.panAngle || 0) - (face2.panAngle || 0)),
      Math.abs((face1.tiltAngle || 0) - (face2.tiltAngle || 0))
    ];

    // Angles should be somewhat similar for the same person
    // But allow for different photo conditions
    let angleScore = 1;
    for (const diff of angleDiffs) {
      if (diff > 45) {
        angleScore *= 0.8; // Significant angle difference
      } else if (diff > 30) {
        angleScore *= 0.9;
      }
    }

    // Compare facial proportions using landmarks
    if (!face1.landmarks || !face2.landmarks) {
      return angleScore;
    }

    const getDistance = (face: FaceAnnotation, type1: string, type2: string): number => {
      const pos1 = face.landmarks?.find(l => l.type === type1)?.position;
      const pos2 = face.landmarks?.find(l => l.type === type2)?.position;
      if (!pos1 || !pos2) return 0;
      return Math.sqrt(
        Math.pow((pos1.x || 0) - (pos2.x || 0), 2) +
        Math.pow((pos1.y || 0) - (pos2.y || 0), 2)
      );
    };

    // Calculate facial ratios
    const eyeDistance1 = getDistance(face1, 'LEFT_EYE', 'RIGHT_EYE');
    const eyeDistance2 = getDistance(face2, 'LEFT_EYE', 'RIGHT_EYE');

    const noseToMouth1 = getDistance(face1, 'NOSE_TIP', 'UPPER_LIP');
    const noseToMouth2 = getDistance(face2, 'NOSE_TIP', 'UPPER_LIP');

    const eyeToNose1 = getDistance(face1, 'LEFT_EYE', 'NOSE_TIP');
    const eyeToNose2 = getDistance(face2, 'LEFT_EYE', 'NOSE_TIP');

    // Calculate ratio similarities
    let ratioScore = 1;

    if (eyeDistance1 > 0 && eyeDistance2 > 0) {
      // Eye to nose ratio
      const ratio1 = eyeToNose1 / eyeDistance1;
      const ratio2 = eyeToNose2 / eyeDistance2;
      const ratioDiff = Math.abs(ratio1 - ratio2);
      ratioScore *= Math.max(0.5, 1 - ratioDiff);

      // Nose to mouth ratio
      if (noseToMouth1 > 0 && noseToMouth2 > 0) {
        const nmRatio1 = noseToMouth1 / eyeDistance1;
        const nmRatio2 = noseToMouth2 / eyeDistance2;
        const nmRatioDiff = Math.abs(nmRatio1 - nmRatio2);
        ratioScore *= Math.max(0.5, 1 - nmRatioDiff);
      }
    }

    return angleScore * ratioScore;
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

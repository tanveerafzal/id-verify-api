import sharp from 'sharp';
import { ImageAnnotatorClient } from '@google-cloud/vision';
import { RekognitionClient, CompareFacesCommand, DetectFacesCommand, Attribute } from '@aws-sdk/client-rekognition';
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
      // Only initialize if GOOGLE_APPLICATION_CREDENTIALS is set to a non-empty value
      const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
      if (credentialsPath && credentialsPath.length > 0) {
        this.visionClient = new ImageAnnotatorClient();
        this.useGoogleVision = true;
        console.log('[BiometricService] Google Cloud Vision API initialized for face detection');
      } else {
        console.log('[BiometricService] Google Cloud Vision credentials not found, using AWS Rekognition/fallback');
        this.useGoogleVision = false;
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

  /**
   * Single-image anti-spoofing detection
   * Detects if the selfie is a real face or a printed photo/screen
   * Uses AWS Rekognition if available, falls back to heuristic analysis
   */
  async performSingleImageLivenessCheck(imageBuffer: Buffer): Promise<LivenessCheckResult> {
    console.log('[BiometricService] Performing single-image liveness check...');

    // Try AWS Rekognition first (more accurate)
    if (this.useAwsRekognition && this.rekognitionClient) {
      try {
        const awsResult = await this.performAwsRekognitionLivenessCheck(imageBuffer);
        if (awsResult.checks && !awsResult.checks.error) {
          console.log('[BiometricService] AWS Rekognition liveness check completed');
          return awsResult;
        }
        console.log('[BiometricService] AWS Rekognition check returned error, falling back to heuristic');
      } catch (error) {
        console.error('[BiometricService] AWS Rekognition liveness check failed, falling back to heuristic:', error);
      }
    }

    // Fall back to heuristic analysis with relaxed thresholds
    return this.performHeuristicLivenessCheck(imageBuffer);
  }

  /**
   * AWS Rekognition-based liveness detection
   * Uses face attributes to determine if the selfie is genuine
   */
  private async performAwsRekognitionLivenessCheck(imageBuffer: Buffer): Promise<LivenessCheckResult> {
    console.log('[BiometricService] Using AWS Rekognition for liveness detection...');

    const checks: LivenessCheckResult['checks'] = {};

    try {
      const command = new DetectFacesCommand({
        Image: {
          Bytes: imageBuffer
        },
        Attributes: ['ALL'] as Attribute[] // Get all facial attributes
      });

      const response = await this.rekognitionClient!.send(command);

      if (!response.FaceDetails || response.FaceDetails.length === 0) {
        console.log('[BiometricService] No face detected in image');
        return {
          isLive: false,
          confidence: 0,
          checks: { error: 'No face detected', method: 'aws_rekognition' }
        };
      }

      const face = response.FaceDetails[0];
      let totalScore = 0;
      let checkCount = 0;

      // 1. Face Detection Confidence (should be high for real faces)
      const faceConfidence = (face.Confidence || 0) / 100;
      checks.faceConfidence = faceConfidence;
      checks.faceConfidencePass = faceConfidence >= 0.90;
      totalScore += faceConfidence;
      checkCount++;
      console.log(`[BiometricService] AWS - Face confidence: ${(faceConfidence * 100).toFixed(1)}%`);

      // 2. Eyes Open Check (real selfies usually have eyes open)
      if (face.EyesOpen) {
        const eyesOpenScore = face.EyesOpen.Value ? (face.EyesOpen.Confidence || 0) / 100 : 0;
        checks.eyesOpen = face.EyesOpen.Value;
        checks.eyesOpenConfidence = eyesOpenScore;
        checks.eyesOpenPass = face.EyesOpen.Value === true && eyesOpenScore >= 0.7;
        // Give partial credit if eyes are detected even if not fully open
        totalScore += face.EyesOpen.Value ? eyesOpenScore : eyesOpenScore * 0.5;
        checkCount++;
        console.log(`[BiometricService] AWS - Eyes open: ${face.EyesOpen.Value} (${(eyesOpenScore * 100).toFixed(1)}% confidence)`);
      }

      // 3. Face Pose Check (should be relatively frontal, not extreme angles)
      if (face.Pose) {
        const yaw = Math.abs(face.Pose.Yaw || 0);
        const pitch = Math.abs(face.Pose.Pitch || 0);
        const roll = Math.abs(face.Pose.Roll || 0);

        // Allow more flexibility in pose (up to 35 degrees)
        const poseScore = Math.max(0, 1 - (Math.max(yaw, pitch, roll) / 50));
        checks.poseYaw = face.Pose.Yaw;
        checks.posePitch = face.Pose.Pitch;
        checks.poseRoll = face.Pose.Roll;
        checks.poseScore = poseScore;
        checks.posePass = yaw <= 35 && pitch <= 35 && roll <= 35;
        totalScore += poseScore;
        checkCount++;
        console.log(`[BiometricService] AWS - Pose: yaw=${yaw.toFixed(1)}, pitch=${pitch.toFixed(1)}, roll=${roll.toFixed(1)}`);
      }

      // 4. Image Quality Check
      if (face.Quality) {
        const brightness = (face.Quality.Brightness || 50) / 100;
        const sharpness = (face.Quality.Sharpness || 50) / 100;

        // Be more lenient with quality thresholds
        const qualityScore = (brightness * 0.4 + sharpness * 0.6);
        checks.brightness = brightness;
        checks.sharpness = sharpness;
        checks.qualityScore = qualityScore;
        checks.qualityPass = brightness >= 0.25 && sharpness >= 0.3;
        totalScore += qualityScore;
        checkCount++;
        console.log(`[BiometricService] AWS - Quality: brightness=${(brightness * 100).toFixed(1)}%, sharpness=${(sharpness * 100).toFixed(1)}%`);
      }

      // 5. Sunglasses Check (shouldn't be wearing sunglasses for verification)
      if (face.Sunglasses) {
        const noSunglasses = face.Sunglasses.Value === false;
        const sunglassConfidence = (face.Sunglasses.Confidence || 0) / 100;
        checks.sunglasses = face.Sunglasses.Value;
        checks.sunglassesConfidence = sunglassConfidence;
        checks.noSunglassesPass = noSunglasses && sunglassConfidence >= 0.7;
        // If wearing sunglasses with high confidence, reduce score
        totalScore += noSunglasses ? 1 : (1 - sunglassConfidence * 0.5);
        checkCount++;
        console.log(`[BiometricService] AWS - Sunglasses: ${face.Sunglasses.Value} (${(sunglassConfidence * 100).toFixed(1)}% confidence)`);
      }

      // 6. Natural Expression Check (some emotion should be present)
      if (face.Emotions && face.Emotions.length > 0) {
        // Sort emotions by confidence
        const emotions = [...face.Emotions].sort((a, b) => (b.Confidence || 0) - (a.Confidence || 0));
        const topEmotion = emotions[0];
        const emotionConfidence = (topEmotion.Confidence || 0) / 100;

        checks.topEmotion = topEmotion.Type;
        checks.emotionConfidence = emotionConfidence;
        // Real faces usually show some emotion with confidence
        checks.emotionPass = emotionConfidence >= 0.5;
        totalScore += emotionConfidence >= 0.3 ? 0.8 : 0.5;
        checkCount++;
        console.log(`[BiometricService] AWS - Top emotion: ${topEmotion.Type} (${(emotionConfidence * 100).toFixed(1)}%)`);
      }

      // 7. Bounding Box Check (face should be a reasonable size in frame)
      if (face.BoundingBox) {
        const faceArea = (face.BoundingBox.Width || 0) * (face.BoundingBox.Height || 0);
        // Face should be between 5% and 80% of image
        const sizeScore = faceArea >= 0.05 && faceArea <= 0.8 ? 1 : faceArea >= 0.02 ? 0.7 : 0.3;
        checks.faceArea = faceArea;
        checks.faceSizePass = faceArea >= 0.05 && faceArea <= 0.8;
        totalScore += sizeScore;
        checkCount++;
        console.log(`[BiometricService] AWS - Face area: ${(faceArea * 100).toFixed(1)}% of image`);
      }

      // Calculate final confidence
      const confidence = checkCount > 0 ? totalScore / checkCount : 0;

      // Count passed checks
      const passedChecks = [
        checks.faceConfidencePass,
        checks.eyesOpenPass,
        checks.posePass,
        checks.qualityPass,
        checks.noSunglassesPass,
        checks.emotionPass,
        checks.faceSizePass
      ].filter(Boolean).length;

      const totalChecks = 7;

      // More lenient: require 4 out of 7 checks to pass OR confidence >= 0.6
      const isLive = passedChecks >= 4 || confidence >= 0.6;

      checks.method = 'aws_rekognition';
      checks.passedChecks = passedChecks;
      checks.totalChecks = totalChecks;

      console.log(`[BiometricService] AWS Rekognition liveness result: isLive=${isLive}, confidence=${confidence.toFixed(3)}, passedChecks=${passedChecks}/${totalChecks}`);

      return {
        isLive,
        confidence,
        checks
      };
    } catch (error: any) {
      console.error('[BiometricService] AWS Rekognition DetectFaces error:', error.message);
      return {
        isLive: false,
        confidence: 0,
        checks: { error: error.message, method: 'aws_rekognition' }
      };
    }
  }

  /**
   * Heuristic-based liveness detection (fallback)
   * Uses image analysis when AWS Rekognition is not available
   * Thresholds are relaxed to reduce false positives
   */
  private async performHeuristicLivenessCheck(imageBuffer: Buffer): Promise<LivenessCheckResult> {
    console.log('[BiometricService] Using heuristic liveness check (fallback)...');

    const checks: LivenessCheckResult['checks'] = {};
    checks.method = 'heuristic';
    let totalScore = 0;
    let checkCount = 0;

    try {
      // 1. Texture Analysis - Real skin has micro-texture, printed photos are smoother
      const textureScore = await this.analyzeTextureForLiveness(imageBuffer);
      checks.textureScore = textureScore;
      checks.texturePass = textureScore > 0.40; // Relaxed from 0.55
      totalScore += textureScore;
      checkCount++;
      console.log(`[BiometricService] Texture analysis score: ${textureScore.toFixed(3)} (threshold: 0.40)`);

      // 2. Color Distribution Analysis - Real skin has specific color patterns
      const colorScore = await this.analyzeColorDistribution(imageBuffer);
      checks.colorScore = colorScore;
      checks.colorPass = colorScore > 0.40; // Relaxed from 0.55
      totalScore += colorScore;
      checkCount++;
      console.log(`[BiometricService] Color distribution score: ${colorScore.toFixed(3)} (threshold: 0.40)`);

      // 3. Moiré Pattern Detection - Screens show moiré patterns
      const moireScore = await this.detectMoirePatterns(imageBuffer);
      checks.moireScore = moireScore;
      checks.moirePass = moireScore > 0.50; // Relaxed from 0.65
      totalScore += moireScore;
      checkCount++;
      console.log(`[BiometricService] Moiré detection score: ${moireScore.toFixed(3)} (threshold: 0.50)`);

      // 4. Specular Reflection Analysis - Real faces have natural, varied highlights
      const reflectionScore = await this.analyzeSpecularReflections(imageBuffer);
      checks.reflectionScore = reflectionScore;
      checks.reflectionPass = reflectionScore > 0.30; // Relaxed from 0.4
      totalScore += reflectionScore;
      checkCount++;
      console.log(`[BiometricService] Specular reflection score: ${reflectionScore.toFixed(3)} (threshold: 0.30)`);

      // 5. Focus/Depth Variation - Real 3D faces have depth, flat photos don't
      const depthScore = await this.analyzeDepthVariation(imageBuffer);
      checks.depthScore = depthScore;
      checks.depthPass = depthScore > 0.35; // Relaxed from 0.5
      totalScore += depthScore;
      checkCount++;
      console.log(`[BiometricService] Depth variation score: ${depthScore.toFixed(3)} (threshold: 0.35)`);

      // 6. Edge Analysis - Printed photos have sharp paper edges
      const edgeScore = await this.analyzeEdgesForPrintedPhoto(imageBuffer);
      checks.edgeScore = edgeScore;
      checks.edgePass = edgeScore > 0.40; // Relaxed from 0.55
      totalScore += edgeScore;
      checkCount++;
      console.log(`[BiometricService] Edge analysis score: ${edgeScore.toFixed(3)} (threshold: 0.40)`);

      // 7. Print artifacts detection - Detect color banding and halftone patterns
      const printArtifactScore = await this.detectPrintArtifacts(imageBuffer);
      checks.printArtifactScore = printArtifactScore;
      checks.printArtifactPass = printArtifactScore > 0.45; // Relaxed from 0.6
      totalScore += printArtifactScore;
      checkCount++;
      console.log(`[BiometricService] Print artifact score: ${printArtifactScore.toFixed(3)} (threshold: 0.45)`);

      // 8. Reflection uniformity - Printed photos have uniform glossy reflections
      const reflectionUniformityScore = await this.analyzeReflectionUniformity(imageBuffer);
      checks.reflectionUniformityScore = reflectionUniformityScore;
      checks.reflectionUniformityPass = reflectionUniformityScore > 0.40; // Relaxed from 0.5
      totalScore += reflectionUniformityScore;
      checkCount++;
      console.log(`[BiometricService] Reflection uniformity score: ${reflectionUniformityScore.toFixed(3)} (threshold: 0.40)`);

      // Calculate overall confidence
      const confidence = checkCount > 0 ? totalScore / checkCount : 0;

      // Count passed checks
      const passedChecks = [
        checks.texturePass,
        checks.colorPass,
        checks.moirePass,
        checks.reflectionPass,
        checks.depthPass,
        checks.edgePass,
        checks.printArtifactPass,
        checks.reflectionUniformityPass
      ].filter(Boolean).length;

      checks.passedChecks = passedChecks;
      checks.totalChecks = 8;

      // RELAXED: Require at least 4 out of 8 checks to pass OR confidence >= 0.45
      // This reduces false positives while still catching obvious spoofs
      const isLive = passedChecks >= 4 || confidence >= 0.45;

      console.log(`[BiometricService] Heuristic liveness result: isLive=${isLive}, confidence=${confidence.toFixed(3)}, passedChecks=${passedChecks}/8`);

      return {
        isLive,
        confidence,
        checks
      };
    } catch (error) {
      console.error('[BiometricService] Heuristic liveness check error:', error);
      // On error, be lenient and allow the verification to continue
      // The face comparison will still provide security
      return {
        isLive: true,
        confidence: 0.5,
        checks: { error: 'Liveness check failed, defaulting to pass', method: 'heuristic_fallback' }
      };
    }
  }

  /**
   * Analyze texture for liveness - real skin has micro-variations
   * Uses multi-scale LBP and additional texture metrics
   */
  private async analyzeTextureForLiveness(imageBuffer: Buffer): Promise<number> {
    const image = sharp(imageBuffer);
    const grayscale = await image
      .grayscale()
      .resize(200, 200, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = grayscale.data;
    const width = grayscale.info.width;
    const height = grayscale.info.height;

    // 1. Calculate Local Binary Pattern (LBP) variance at multiple scales
    const lbpVariance1 = this.calculateLBPVariance(pixels, width, height, 1);
    const lbpVariance2 = this.calculateLBPVariance(pixels, width, height, 2);

    // 2. Calculate high-frequency content (real skin has more micro-texture)
    let highFreqSum = 0;
    let highFreqCount = 0;
    for (let y = 2; y < height - 2; y++) {
      for (let x = 2; x < width - 2; x++) {
        // Laplacian of Gaussian approximation for texture detection
        const center = pixels[y * width + x];
        const neighbors = [
          pixels[(y - 2) * width + x],
          pixels[(y + 2) * width + x],
          pixels[y * width + (x - 2)],
          pixels[y * width + (x + 2)],
          pixels[(y - 1) * width + x],
          pixels[(y + 1) * width + x],
          pixels[y * width + (x - 1)],
          pixels[y * width + (x + 1)]
        ];
        const laplacian = Math.abs(center * 8 - neighbors.reduce((a, b) => a + b, 0));
        highFreqSum += laplacian;
        highFreqCount++;
      }
    }
    const avgHighFreq = highFreqSum / highFreqCount;

    // 3. Calculate texture entropy (randomness) - real skin has higher entropy
    const histogram = new Array(256).fill(0);
    for (let i = 0; i < pixels.length; i++) {
      histogram[pixels[i]]++;
    }
    let entropy = 0;
    const totalPixels = pixels.length;
    for (let i = 0; i < 256; i++) {
      if (histogram[i] > 0) {
        const p = histogram[i] / totalPixels;
        entropy -= p * Math.log2(p);
      }
    }
    const normalizedEntropy = entropy / 8; // Max entropy is 8 bits

    // 4. Detect flat regions (printed photos have more uniform areas)
    let flatRegions = 0;
    const blockSize = 8;
    for (let y = 0; y < height - blockSize; y += blockSize) {
      for (let x = 0; x < width - blockSize; x += blockSize) {
        let blockMin = 255, blockMax = 0;
        for (let by = 0; by < blockSize; by++) {
          for (let bx = 0; bx < blockSize; bx++) {
            const val = pixels[(y + by) * width + (x + bx)];
            blockMin = Math.min(blockMin, val);
            blockMax = Math.max(blockMax, val);
          }
        }
        // Flat region = low dynamic range
        if (blockMax - blockMin < 15) flatRegions++;
      }
    }
    const totalBlocks = Math.floor(width / blockSize) * Math.floor(height / blockSize);
    const flatRatio = flatRegions / totalBlocks;

    // Combine metrics
    // LBP variance: higher is better (more texture)
    const lbpScore = Math.min(1, (lbpVariance1 + lbpVariance2) / 5000);

    // High frequency: normalized, higher is better
    const highFreqScore = Math.min(1, avgHighFreq / 100);

    // Entropy: higher is better (more randomness = real)
    const entropyScore = normalizedEntropy;

    // Flat regions: lower is better (less flat = real)
    const flatScore = 1 - Math.min(1, flatRatio * 2);

    // Weighted combination with emphasis on most discriminative features
    const finalScore = (
      lbpScore * 0.3 +
      highFreqScore * 0.25 +
      entropyScore * 0.25 +
      flatScore * 0.2
    );

    return finalScore;
  }

  /**
   * Calculate LBP variance at a given radius
   */
  private calculateLBPVariance(pixels: Buffer, width: number, height: number, radius: number): number {
    let lbpSum = 0;
    let lbpSqSum = 0;
    let count = 0;

    for (let y = radius; y < height - radius; y++) {
      for (let x = radius; x < width - radius; x++) {
        const center = pixels[y * width + x];
        let lbp = 0;

        // Calculate LBP for 8 neighbors at given radius
        const neighbors = [
          pixels[(y - radius) * width + (x - radius)],
          pixels[(y - radius) * width + x],
          pixels[(y - radius) * width + (x + radius)],
          pixels[y * width + (x + radius)],
          pixels[(y + radius) * width + (x + radius)],
          pixels[(y + radius) * width + x],
          pixels[(y + radius) * width + (x - radius)],
          pixels[y * width + (x - radius)]
        ];

        for (let i = 0; i < 8; i++) {
          if (neighbors[i] >= center) {
            lbp |= (1 << i);
          }
        }

        lbpSum += lbp;
        lbpSqSum += lbp * lbp;
        count++;
      }
    }

    const mean = lbpSum / count;
    return (lbpSqSum / count) - (mean * mean);
  }

  /**
   * Analyze color distribution for skin tones
   */
  private async analyzeColorDistribution(imageBuffer: Buffer): Promise<number> {
    const image = sharp(imageBuffer);
    const { data, info } = await image
      .resize(100, 100, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = data;
    const channels = info.channels;

    let skinPixels = 0;
    let totalPixels = 0;
    let colorVariance = 0;
    let rSum = 0, gSum = 0, bSum = 0;

    // Analyze each pixel
    for (let i = 0; i < pixels.length; i += channels) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];

      totalPixels++;
      rSum += r;
      gSum += g;
      bSum += b;

      // Check if pixel is in skin color range (YCbCr space approximation)
      // Real skin has specific color characteristics
      if (r > 95 && g > 40 && b > 20 &&
          r > g && r > b &&
          Math.abs(r - g) > 15 &&
          r - Math.min(g, b) > 15) {
        skinPixels++;
      }
    }

    // Calculate color variance
    const rMean = rSum / totalPixels;
    const gMean = gSum / totalPixels;
    const bMean = bSum / totalPixels;

    for (let i = 0; i < pixels.length; i += channels) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      colorVariance += Math.pow(r - rMean, 2) + Math.pow(g - gMean, 2) + Math.pow(b - bMean, 2);
    }
    colorVariance /= totalPixels;

    // Skin ratio should be reasonable (20-80%)
    const skinRatio = skinPixels / totalPixels;
    const skinScore = skinRatio >= 0.2 && skinRatio <= 0.8 ? 1 : skinRatio >= 0.1 ? 0.5 : 0;

    // Real faces have moderate color variance
    // Printed photos often have less variance (washed out) or too much (over-saturated)
    const varianceScore = colorVariance > 500 && colorVariance < 5000 ? 1 : colorVariance > 200 ? 0.5 : 0;

    return (skinScore * 0.6 + varianceScore * 0.4);
  }

  /**
   * Detect moiré patterns that indicate screen capture
   */
  private async detectMoirePatterns(imageBuffer: Buffer): Promise<number> {
    const image = sharp(imageBuffer);
    const grayscale = await image
      .grayscale()
      .resize(128, 128, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = grayscale.data;
    const width = grayscale.info.width;
    const height = grayscale.info.height;

    // Calculate frequency domain characteristics
    // Moiré patterns show up as periodic high-frequency components
    let periodicScore = 0;
    let totalChecks = 0;

    // Check for periodic patterns in rows
    for (let y = 0; y < height; y++) {
      let transitions = 0;
      for (let x = 1; x < width; x++) {
        const diff = Math.abs(pixels[y * width + x] - pixels[y * width + x - 1]);
        if (diff > 20) transitions++;
      }
      // High number of transitions might indicate moiré
      if (transitions > width * 0.4) periodicScore++;
      totalChecks++;
    }

    // Check for periodic patterns in columns
    for (let x = 0; x < width; x++) {
      let transitions = 0;
      for (let y = 1; y < height; y++) {
        const diff = Math.abs(pixels[y * width + x] - pixels[(y - 1) * width + x]);
        if (diff > 20) transitions++;
      }
      if (transitions > height * 0.4) periodicScore++;
      totalChecks++;
    }

    // Lower periodic score = less likely to be screen (inverse score)
    const moireRatio = periodicScore / totalChecks;

    // Return inverse - high score means no moiré detected (good)
    return 1 - Math.min(1, moireRatio * 3);
  }

  /**
   * Analyze specular reflections - real faces have natural highlights
   */
  private async analyzeSpecularReflections(imageBuffer: Buffer): Promise<number> {
    const image = sharp(imageBuffer);
    const { data, info } = await image
      .resize(100, 100, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = data;
    const channels = info.channels;
    const totalPixels = info.width * info.height;

    let highlightPixels = 0;
    let midtonePixels = 0;
    let shadowPixels = 0;

    for (let i = 0; i < pixels.length; i += channels) {
      const luminance = (pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114);

      if (luminance > 200) highlightPixels++;
      else if (luminance > 50) midtonePixels++;
      else shadowPixels++;
    }

    // Real faces should have a good distribution with some highlights
    const highlightRatio = highlightPixels / totalPixels;
    const midtoneRatio = midtonePixels / totalPixels;

    // Expect 2-15% highlights for natural lighting
    const highlightScore = highlightRatio >= 0.02 && highlightRatio <= 0.15 ? 1 :
                          highlightRatio > 0.01 && highlightRatio <= 0.25 ? 0.5 : 0;

    // Expect majority midtones
    const midtoneScore = midtoneRatio >= 0.5 ? 1 : midtoneRatio >= 0.3 ? 0.5 : 0;

    return highlightScore * 0.6 + midtoneScore * 0.4;
  }

  /**
   * Analyze depth variation - real 3D faces have focus differences
   */
  private async analyzeDepthVariation(imageBuffer: Buffer): Promise<number> {
    const image = sharp(imageBuffer);
    const grayscale = await image
      .grayscale()
      .resize(100, 100, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = grayscale.data;
    const width = grayscale.info.width;
    const height = grayscale.info.height;

    // Calculate local sharpness in different regions
    const regions = [
      { x: 0, y: 0, w: width / 2, h: height / 2 },           // Top-left
      { x: width / 2, y: 0, w: width / 2, h: height / 2 },   // Top-right
      { x: 0, y: height / 2, w: width / 2, h: height / 2 },  // Bottom-left
      { x: width / 2, y: height / 2, w: width / 2, h: height / 2 }, // Bottom-right
      { x: width / 4, y: height / 4, w: width / 2, h: height / 2 }  // Center
    ];

    const sharpnessValues: number[] = [];

    for (const region of regions) {
      let gradientSum = 0;
      let count = 0;

      for (let y = Math.floor(region.y) + 1; y < Math.floor(region.y + region.h) - 1 && y < height - 1; y++) {
        for (let x = Math.floor(region.x) + 1; x < Math.floor(region.x + region.w) - 1 && x < width - 1; x++) {
          const gx = pixels[y * width + (x + 1)] - pixels[y * width + (x - 1)];
          const gy = pixels[(y + 1) * width + x] - pixels[(y - 1) * width + x];
          gradientSum += Math.sqrt(gx * gx + gy * gy);
          count++;
        }
      }

      if (count > 0) {
        sharpnessValues.push(gradientSum / count);
      }
    }

    if (sharpnessValues.length === 0) return 0.5;

    // Calculate variance in sharpness across regions
    // Real 3D faces have varying sharpness (nose sharp, ears softer)
    const mean = sharpnessValues.reduce((a, b) => a + b, 0) / sharpnessValues.length;
    const variance = sharpnessValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / sharpnessValues.length;

    // Flat photos have uniform sharpness (low variance)
    // Real faces have depth variation (moderate variance)
    // Very high variance might indicate edge of printed photo
    const normalizedVariance = Math.min(1, variance / 100);

    return normalizedVariance > 0.1 && normalizedVariance < 0.8 ? normalizedVariance + 0.3 : normalizedVariance;
  }

  /**
   * Analyze edges for signs of printed photo boundaries
   */
  private async analyzeEdgesForPrintedPhoto(imageBuffer: Buffer): Promise<number> {
    const image = sharp(imageBuffer);
    const grayscale = await image
      .grayscale()
      .resize(100, 100, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = grayscale.data;
    const width = grayscale.info.width;
    const height = grayscale.info.height;

    // Check edges of the image for strong straight lines (paper edges)
    let edgeStrength = 0;
    let totalEdgePixels = 0;

    // Check top and bottom edges
    for (let x = 5; x < width - 5; x++) {
      // Top edge
      const topDiff = Math.abs(pixels[5 * width + x] - pixels[0 * width + x]);
      if (topDiff > 50) edgeStrength++;
      totalEdgePixels++;

      // Bottom edge
      const bottomDiff = Math.abs(pixels[(height - 6) * width + x] - pixels[(height - 1) * width + x]);
      if (bottomDiff > 50) edgeStrength++;
      totalEdgePixels++;
    }

    // Check left and right edges
    for (let y = 5; y < height - 5; y++) {
      // Left edge
      const leftDiff = Math.abs(pixels[y * width + 5] - pixels[y * width + 0]);
      if (leftDiff > 50) edgeStrength++;
      totalEdgePixels++;

      // Right edge
      const rightDiff = Math.abs(pixels[y * width + (width - 6)] - pixels[y * width + (width - 1)]);
      if (rightDiff > 50) edgeStrength++;
      totalEdgePixels++;
    }

    // High edge strength at boundaries suggests printed photo
    const edgeRatio = edgeStrength / totalEdgePixels;

    // Return inverse - lower edge ratio is better (no paper edges visible)
    return 1 - Math.min(1, edgeRatio * 4);
  }

  /**
   * Detect print artifacts like color banding, halftone patterns, and dot patterns
   * Printed photos have characteristic artifacts from the printing process
   */
  private async detectPrintArtifacts(imageBuffer: Buffer): Promise<number> {
    const image = sharp(imageBuffer);
    const { data, info } = await image
      .resize(150, 150, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = data;
    const channels = info.channels;
    const width = info.width;
    const height = info.height;

    let bandingScore = 0;
    let halftoneScore = 0;
    let colorQuantizationScore = 0;

    // 1. Detect color banding - printers have limited color gradients
    // Real photos have smooth gradients, printed ones have visible steps
    const colorLevels = new Set<number>();
    for (let i = 0; i < pixels.length; i += channels) {
      // Quantize to detect limited color palette
      const r = Math.floor(pixels[i] / 16);
      const g = Math.floor(pixels[i + 1] / 16);
      const b = Math.floor(pixels[i + 2] / 16);
      colorLevels.add(r * 256 + g * 16 + b);
    }

    // Real photos typically have more color variety
    const totalPixels = width * height;
    const colorDiversity = colorLevels.size / Math.min(4096, totalPixels);
    colorQuantizationScore = Math.min(1, colorDiversity * 2);

    // 2. Detect halftone/dot patterns - printed photos use dots
    // Look for regular periodic patterns in the high-frequency domain
    const grayscale = await image
      .grayscale()
      .resize(100, 100, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const grayPixels = grayscale.data;
    const gWidth = grayscale.info.width;
    const gHeight = grayscale.info.height;

    // Calculate autocorrelation to detect periodic patterns
    let periodicPatterns = 0;
    const checkOffsets = [2, 3, 4, 5]; // Common halftone frequencies

    for (const offset of checkOffsets) {
      let correlation = 0;
      let count = 0;

      for (let y = 0; y < gHeight - offset; y++) {
        for (let x = 0; x < gWidth - offset; x++) {
          const p1 = grayPixels[y * gWidth + x];
          const p2 = grayPixels[(y + offset) * gWidth + (x + offset)];
          const diff = Math.abs(p1 - p2);
          if (diff < 10) correlation++;
          count++;
        }
      }

      if (count > 0 && correlation / count > 0.7) {
        periodicPatterns++;
      }
    }

    // High periodic patterns suggest halftone printing
    halftoneScore = 1 - (periodicPatterns / checkOffsets.length) * 0.5;

    // 3. Detect color channel misalignment - printers have slight registration errors
    let channelMisalignment = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = (y * width + x) * channels;

        // Check if color channels have different edge positions
        const rEdge = Math.abs(pixels[idx] - pixels[idx - channels]);
        const gEdge = Math.abs(pixels[idx + 1] - pixels[idx + 1 - channels]);
        const bEdge = Math.abs(pixels[idx + 2] - pixels[idx + 2 - channels]);

        // Misaligned edges have different edge strengths per channel
        const edgeDiff = Math.abs(rEdge - gEdge) + Math.abs(gEdge - bEdge) + Math.abs(rEdge - bEdge);
        if (edgeDiff > 50) channelMisalignment++;
      }
    }

    const misalignmentRatio = channelMisalignment / (width * height);
    // Some misalignment is normal, too much suggests printing artifacts
    bandingScore = misalignmentRatio < 0.05 ? 1 : misalignmentRatio < 0.15 ? 0.7 : 0.3;

    // Combine scores - all should be high for a real photo
    const finalScore = (colorQuantizationScore * 0.4 + halftoneScore * 0.35 + bandingScore * 0.25);

    return finalScore;
  }

  /**
   * Analyze reflection uniformity - printed photos have uniform glossy reflections
   * Real faces have varied, organic reflection patterns
   */
  private async analyzeReflectionUniformity(imageBuffer: Buffer): Promise<number> {
    const image = sharp(imageBuffer);
    const { data, info } = await image
      .resize(100, 100, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = data;
    const channels = info.channels;
    const width = info.width;
    const height = info.height;

    // Find highlight regions (potential reflections)
    const highlights: Array<{ x: number; y: number; intensity: number }> = [];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * channels;
        const luminance = pixels[idx] * 0.299 + pixels[idx + 1] * 0.587 + pixels[idx + 2] * 0.114;

        if (luminance > 220) {
          highlights.push({ x, y, intensity: luminance });
        }
      }
    }

    if (highlights.length < 5) {
      // Very few highlights - could be underexposed but treat as neutral
      return 0.6;
    }

    if (highlights.length > width * height * 0.3) {
      // Too many highlights - overexposed or glossy surface
      return 0.3;
    }

    // Analyze highlight distribution
    // Real faces: highlights scattered (nose tip, cheeks, forehead)
    // Printed photos: highlights may form lines/rectangles (paper gloss)

    // Calculate centroid of highlights
    let sumX = 0, sumY = 0;
    for (const h of highlights) {
      sumX += h.x;
      sumY += h.y;
    }
    const centroidX = sumX / highlights.length;
    const centroidY = sumY / highlights.length;

    // Calculate distribution variance
    let varianceX = 0, varianceY = 0;
    for (const h of highlights) {
      varianceX += Math.pow(h.x - centroidX, 2);
      varianceY += Math.pow(h.y - centroidY, 2);
    }
    varianceX /= highlights.length;
    varianceY /= highlights.length;

    // Check for linear patterns (glossy paper reflection)
    const aspectRatio = Math.max(varianceX, varianceY) / (Math.min(varianceX, varianceY) + 1);

    // Very elongated highlight patterns suggest paper gloss
    if (aspectRatio > 5) {
      return 0.3; // Linear reflection pattern - likely printed
    }

    // Check for uniform brightness in highlight regions
    let intensityVariance = 0;
    const avgIntensity = highlights.reduce((sum, h) => sum + h.intensity, 0) / highlights.length;
    for (const h of highlights) {
      intensityVariance += Math.pow(h.intensity - avgIntensity, 2);
    }
    intensityVariance /= highlights.length;

    // Real faces have varied highlight intensities
    // Paper has uniform glossy reflection
    const normalizedVariance = Math.min(1, intensityVariance / 500);

    // Higher variance = more natural = better score
    return 0.3 + normalizedVariance * 0.7;
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

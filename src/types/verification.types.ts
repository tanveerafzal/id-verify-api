// Import Prisma-generated enums instead of duplicating them
import {
  VerificationStatus,
  VerificationType,
  DocumentType,
  DocumentSide,
  RiskLevel
} from '@prisma/client';

// Re-export for convenience
export {
  VerificationStatus,
  VerificationType,
  DocumentType,
  DocumentSide,
  RiskLevel
};

export interface CreateVerificationRequest {
  userId?: string;
  type: VerificationType;
  webhookUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface DocumentUpload {
  file: Express.Multer.File;
  type: DocumentType;
  side?: DocumentSide;
}

export interface ExtractedDocumentData {
  documentNumber?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  dateOfBirth?: string;
  gender?: string;
  nationality?: string;
  issuingCountry?: string;
  issueDate?: string;
  expiryDate?: string;
  address?: {
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
  mrz?: string;
  confidence?: number;
}

export interface DocumentQualityCheck {
  isBlurry: boolean;
  hasGlare: boolean;
  isComplete: boolean;
  qualityScore: number;
  issues: string[];
}

export interface BiometricData {
  faceDetected: boolean;
  faceCount: number;
  faceQuality?: number;
  landmarks?: FaceLandmarks;
  embedding?: number[];
  googleVisionData?: any; // Full Google Vision face annotation for comparison
}

export interface FaceLandmarks {
  leftEye: Point;
  rightEye: Point;
  nose: Point;
  leftMouth: Point;
  rightMouth: Point;
}

export interface Point {
  x: number;
  y: number;
}

export interface LivenessCheckResult {
  isLive: boolean;
  confidence: number;
  checks: {
    // Method used for liveness check
    method?: string;
    passedChecks?: number;
    totalChecks?: number;

    // Video-based checks
    blinkDetected?: boolean;
    headMovement?: boolean;
    textureAnalysis?: boolean;

    // Single-image anti-spoofing checks (heuristic)
    textureScore?: number;
    texturePass?: boolean;
    colorScore?: number;
    colorPass?: boolean;
    moireScore?: number;
    moirePass?: boolean;
    reflectionScore?: number;
    reflectionPass?: boolean;
    depthScore?: number;
    depthPass?: boolean;
    edgeScore?: number;
    edgePass?: boolean;
    // Print artifact detection
    printArtifactScore?: number;
    printArtifactPass?: boolean;
    // Reflection uniformity (glossy paper detection)
    reflectionUniformityScore?: number;
    reflectionUniformityPass?: boolean;

    // AWS Rekognition-based checks
    faceConfidence?: number;
    faceConfidencePass?: boolean;
    eyesOpen?: boolean;
    eyesOpenConfidence?: number;
    eyesOpenPass?: boolean;
    poseYaw?: number;
    posePitch?: number;
    poseRoll?: number;
    poseScore?: number;
    posePass?: boolean;
    brightness?: number;
    sharpness?: number;
    qualityScore?: number;
    qualityPass?: boolean;
    sunglasses?: boolean;
    sunglassesConfidence?: number;
    noSunglassesPass?: boolean;
    topEmotion?: string;
    emotionConfidence?: number;
    emotionPass?: boolean;
    faceArea?: number;
    faceSizePass?: boolean;

    // Error handling
    error?: string;
  };
}

export interface VerificationResult {
  passed: boolean;
  score: number;
  riskLevel: RiskLevel;
  checks: {
    documentAuthentic: boolean;
    documentExpired: boolean;
    documentTampered: boolean;
    faceMatch?: boolean;
    faceMatchScore?: number;
    nameMatch?: boolean;
    nameMatchScore?: number;
    livenessCheck?: boolean;
    livenessScore?: number;
  };
  extractedData: ExtractedDocumentData;
  flags: string[];
  warnings: string[];
}

export interface WebhookPayload {
  event: WebhookEvent;
  verificationId: string;
  status: VerificationStatus;
  result?: VerificationResult;
  timestamp: string;
}

export enum WebhookEvent {
  VERIFICATION_CREATED = 'verification.created',
  VERIFICATION_UPDATED = 'verification.updated',
  VERIFICATION_COMPLETED = 'verification.completed',
  VERIFICATION_FAILED = 'verification.failed',
  DOCUMENT_UPLOADED = 'document.uploaded',
  DOCUMENT_PROCESSED = 'document.processed'
}

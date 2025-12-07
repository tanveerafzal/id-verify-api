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
    blinkDetected?: boolean;
    headMovement?: boolean;
    textureAnalysis?: boolean;
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

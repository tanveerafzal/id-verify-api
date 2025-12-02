import { PrismaClient } from '@prisma/client';
import {
  VerificationStatus,
  VerificationType,
  ExtractedDocumentData,
  VerificationResult,
  RiskLevel,
  DocumentType
} from '../types/verification.types';
import { DocumentScannerService } from './document-scanner.service';
import { OCRService } from './ocr.service';
import { BiometricService } from './biometric.service';
import { config } from '../config';

const prisma = new PrismaClient();

export class VerificationService {
  private documentScanner: DocumentScannerService;
  private ocrService: OCRService;
  private biometricService: BiometricService;

  constructor() {
    this.documentScanner = new DocumentScannerService();
    this.ocrService = new OCRService();
    this.biometricService = new BiometricService();
  }

  async createVerification(
    userId?: string,
    type: VerificationType = VerificationType.IDENTITY,
    webhookUrl?: string,
    metadata?: Record<string, unknown>,
    partnerId?: string
  ) {
    const verification = await prisma.verification.create({
      data: {
        userId,
        partnerId,
        type,
        status: VerificationStatus.PENDING,
        webhookUrl,
        metadata: (metadata || {}) as any
      }
    });

    // Increment partner's usage count if partnerId provided
    if (partnerId) {
      await prisma.partner.update({
        where: { id: partnerId },
        data: {
          verificationsUsed: {
            increment: 1
          }
        }
      });
    }

    return verification;
  }

  async processDocument(
    verificationId: string,
    imageBuffer: Buffer,
    documentType: DocumentType,
    side?: 'FRONT' | 'BACK'
  ) {
    const preprocessed = await this.documentScanner.preprocessImage(imageBuffer);

    const qualityCheck = await this.documentScanner.checkQuality(preprocessed);

    if (qualityCheck.qualityScore < config.verification.minQualityScore) {
      throw new Error(`Document quality too low: ${qualityCheck.issues.join(', ')}`);
    }

    await this.ocrService.initialize();
    const extractedData = await this.ocrService.extractDocumentData(preprocessed, documentType);
    await this.ocrService.terminate();

    // Generate thumbnail for future use
    await this.documentScanner.generateThumbnail(preprocessed);

    const document = await prisma.document.create({
      data: {
        verificationId,
        type: documentType,
        side,
        originalUrl: 'placeholder-url',
        extractedData: extractedData as any,
        qualityScore: qualityCheck.qualityScore,
        isBlurry: qualityCheck.isBlurry,
        hasGlare: qualityCheck.hasGlare,
        isComplete: qualityCheck.isComplete,
        ocrConfidence: extractedData.confidence
      }
    });

    await prisma.verification.update({
      where: { id: verificationId },
      data: { status: VerificationStatus.IN_PROGRESS }
    });

    return { document, extractedData, qualityCheck };
  }

  async processSelfie(_verificationId: string, imageBuffer: Buffer) {
    const biometricData = await this.biometricService.extractFaceData(imageBuffer);

    if (!biometricData.faceDetected) {
      throw new Error('No face detected in selfie');
    }

    if (biometricData.faceCount > 1) {
      throw new Error('Multiple faces detected in selfie');
    }

    return biometricData;
  }

  async performVerification(verificationId: string): Promise<VerificationResult> {
    const verification = await prisma.verification.findUnique({
      where: { id: verificationId },
      include: { documents: true }
    });

    if (!verification) {
      throw new Error('Verification not found');
    }

    const flags: string[] = [];
    const warnings: string[] = [];

    const documentChecks = await this.verifyDocuments(verification.documents);

    const extractedData = this.mergeExtractedData(verification.documents);

    const documentExpired = this.checkDocumentExpiry(extractedData.expiryDate);
    if (documentExpired) {
      flags.push('DOCUMENT_EXPIRED');
    }

    const documentTampered = this.detectTampering(verification.documents);
    if (documentTampered) {
      flags.push('POSSIBLE_TAMPERING');
    }

    const riskLevel = this.calculateRiskLevel(flags, documentChecks);

    const passed = flags.length === 0 &&
                   documentChecks.averageQuality >= config.verification.minQualityScore &&
                   !documentExpired &&
                   !documentTampered;

    const result: VerificationResult = {
      passed,
      score: documentChecks.averageQuality,
      riskLevel,
      checks: {
        documentAuthentic: !documentTampered,
        documentExpired,
        documentTampered
      },
      extractedData,
      flags,
      warnings
    };

    await prisma.verificationResult.create({
      data: {
        verificationId,
        passed,
        score: result.score,
        riskLevel,
        documentAuthentic: result.checks.documentAuthentic,
        documentExpired: result.checks.documentExpired,
        documentTampered: result.checks.documentTampered,
        extractedName: extractedData.fullName,
        extractedDob: extractedData.dateOfBirth ? new Date(extractedData.dateOfBirth) : null,
        documentNumber: extractedData.documentNumber,
        issuingCountry: extractedData.issuingCountry,
        expiryDate: extractedData.expiryDate ? new Date(extractedData.expiryDate) : null,
        flags,
        warnings
      }
    });

    await prisma.verification.update({
      where: { id: verificationId },
      data: {
        status: passed ? VerificationStatus.COMPLETED : VerificationStatus.FAILED,
        completedAt: new Date()
      }
    });

    return result;
  }

  private async verifyDocuments(documents: any[]) {
    const qualityScores = documents
      .map(doc => doc.qualityScore)
      .filter((score): score is number => score !== null);

    const averageQuality = qualityScores.length > 0
      ? qualityScores.reduce((sum, score) => sum + score, 0) / qualityScores.length
      : 0;

    return {
      averageQuality,
      documentCount: documents.length
    };
  }

  private mergeExtractedData(documents: any[]): ExtractedDocumentData {
    const merged: ExtractedDocumentData = {};

    for (const doc of documents) {
      if (doc.extractedData) {
        Object.assign(merged, doc.extractedData);
      }
    }

    return merged;
  }

  private checkDocumentExpiry(expiryDate?: string): boolean {
    if (!expiryDate) return false;

    const expiry = new Date(expiryDate);
    const today = new Date();

    return expiry < today;
  }

  private detectTampering(documents: any[]): boolean {
    for (const doc of documents) {
      if (doc.qualityScore && doc.qualityScore < 0.3) {
        return true;
      }

      if (doc.extractedData?.confidence && doc.extractedData.confidence < 0.5) {
        return true;
      }
    }

    return false;
  }

  private calculateRiskLevel(flags: string[], documentChecks: any): RiskLevel {
    if (flags.includes('POSSIBLE_TAMPERING')) {
      return RiskLevel.CRITICAL;
    }

    if (flags.includes('DOCUMENT_EXPIRED')) {
      return RiskLevel.HIGH;
    }

    if (documentChecks.averageQuality < 0.5) {
      return RiskLevel.HIGH;
    }

    if (documentChecks.averageQuality < 0.7) {
      return RiskLevel.MEDIUM;
    }

    return RiskLevel.LOW;
  }

  async comparefaces(verificationId: string, documentImageBuffer: Buffer, selfieBuffer: Buffer) {
    const documentFace = await this.biometricService.extractFaceData(documentImageBuffer);
    const selfieFace = await this.biometricService.extractFaceData(selfieBuffer);

    if (!documentFace.faceDetected || !selfieFace.faceDetected) {
      throw new Error('Face not detected in one or both images');
    }

    const matchScore = await this.biometricService.compareFaces(
      documentFace.embedding!,
      selfieFace.embedding!
    );

    const faceMatch = matchScore >= config.verification.faceMatchThreshold;

    await prisma.verificationResult.updateMany({
      where: { verificationId },
      data: {
        faceMatch,
        faceMatchScore: matchScore
      }
    });

    return { faceMatch, matchScore };
  }

  async getVerification(verificationId: string) {
    return await prisma.verification.findUnique({
      where: { id: verificationId },
      include: {
        documents: true,
        results: true
      }
    });
  }
}

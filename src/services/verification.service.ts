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
import { EmailService } from './email.service';
import { s3Service } from './s3.service';
import { config } from '../config';
import { logger } from '../utils/logger';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

export class VerificationService {
  private documentScanner: DocumentScannerService;
  private ocrService: OCRService;
  private biometricService: BiometricService;
  private emailService: EmailService;

  constructor() {
    this.documentScanner = new DocumentScannerService();
    this.ocrService = new OCRService();
    this.biometricService = new BiometricService();
    this.emailService = new EmailService();
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
    documentType?: DocumentType,
    side?: 'FRONT' | 'BACK',
    documentUrl?: string
  ) {
    // Check if this is a retry - if verification is FAILED, delete old documents
    const verification = await prisma.verification.findUnique({
      where: { id: verificationId }
    });

    if (verification?.status === 'FAILED') {
      console.log('[VerificationService] Retry detected - clearing old documents for verification:', verificationId);

      // Delete all existing documents for this verification (including selfies - user will re-upload everything)
      await prisma.document.deleteMany({
        where: { verificationId }
      });

      console.log('[VerificationService] Old documents cleared for retry');
    }

    const preprocessed = await this.documentScanner.preprocessImage(imageBuffer);

    const qualityCheck = await this.documentScanner.checkQuality(preprocessed);

    if (qualityCheck.qualityScore < config.verification.minQualityScore) {
      throw new Error(`Document quality too low: ${qualityCheck.issues.join(', ')}`);
    }

    // Always auto-detect document type to validate against user selection
    console.log('[VerificationService] Auto-detecting document type...');
    const detectionResult = await this.documentScanner.detectDocumentType(preprocessed);
    console.log('[VerificationService] Auto-detected document type:', detectionResult.documentType,
      'confidence:', detectionResult.confidence,
      'method:', detectionResult.method);

    let finalDocumentType = detectionResult.documentType;

    // If user provided a document type, validate it matches the detected type
    if (documentType) {
      console.log('[VerificationService] User selected document type:', documentType);
      console.log('[VerificationService] Detected document type:', detectionResult.documentType);

      // Check if the detected type matches the user-selected type
      if (detectionResult.documentType !== documentType) {
        // Only throw error if detection confidence is high enough
        if (detectionResult.confidence >= 0.7) {
          const userTypeName = this.getDocumentTypeName(documentType);
          const detectedTypeName = this.getDocumentTypeName(detectionResult.documentType);
          throw new Error(
            `Document type mismatch: You selected "${userTypeName}" but the uploaded document appears to be a "${detectedTypeName}". ` +
            `Please upload the correct document type or select the appropriate document type.`
          );
        } else {
          // Low confidence detection - use user's selection but warn
          console.log('[VerificationService] Low detection confidence, using user-selected type:', documentType);
          finalDocumentType = documentType;
        }
      } else {
        finalDocumentType = documentType;
      }
    }

    await this.ocrService.initialize();
    const extractedData = await this.ocrService.extractDocumentData(preprocessed, finalDocumentType);
    await this.ocrService.terminate();

    // Generate thumbnail for future use
    await this.documentScanner.generateThumbnail(preprocessed);

    // Include detection info in extracted data if auto-detected
    const enrichedExtractedData = {
      ...extractedData,
      ...(detectionResult && {
        autoDetected: true,
        detectionConfidence: detectionResult.confidence,
        detectionMethod: detectionResult.method,
        detectedKeywords: detectionResult.detectedKeywords
      })
    };

    const document = await prisma.document.create({
      data: {
        verificationId,
        type: finalDocumentType,
        side,
        originalUrl: documentUrl || 'not-saved',
        extractedData: enrichedExtractedData as any,
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

    return {
      document,
      extractedData: enrichedExtractedData,
      qualityCheck,
      documentType: finalDocumentType,
      ...(detectionResult && { detection: detectionResult })
    };
  }

  async processSelfie(verificationId: string, imageBuffer: Buffer, selfieUrl?: string) {
    const biometricData = await this.biometricService.extractFaceData(imageBuffer);

    if (!biometricData.faceDetected) {
      throw new Error('No face detected in selfie');
    }

    if (biometricData.faceCount > 1) {
      throw new Error('Multiple faces detected in selfie');
    }

    // Save selfie as a document in the Document table
    if (selfieUrl) {
      console.log('[VerificationService] Saving selfie as document:', selfieUrl);

      // Check if selfie document already exists for this verification
      const existingSelfie = await prisma.document.findFirst({
        where: {
          verificationId,
          type: 'SELFIE'
        }
      });

      if (existingSelfie) {
        // Update existing selfie document
        await prisma.document.update({
          where: { id: existingSelfie.id },
          data: {
            originalUrl: selfieUrl,
            updatedAt: new Date()
          }
        });
      } else {
        // Create new selfie document
        await prisma.document.create({
          data: {
            verificationId,
            type: 'SELFIE',
            originalUrl: selfieUrl,
            qualityScore: biometricData.faceQuality || null,
            isBlurry: false,
            isComplete: true
          }
        });
      }
    }

    return biometricData;
  }

  async performVerification(verificationId: string): Promise<VerificationResult> {
    const verification = await prisma.verification.findUnique({
      where: { id: verificationId },
      include: { documents: true, results: true }
    });

    if (!verification) {
      throw new Error('Verification not found');
    }

    // Log if this is a retry
    if (verification.results) {
      console.log('[VerificationService] Re-verification attempt - will update existing result');
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

    // Face comparison - compare document photo with selfie
    let faceMatch = false;
    let faceMatchScore = 0;
    let faceComparisonDetails: any = null;

    const idDocument = verification.documents.find(doc =>
      doc.type === 'DRIVERS_LICENSE' ||
      doc.type === 'PASSPORT' ||
      doc.type === 'NATIONAL_ID' ||
      doc.type === 'RESIDENCE_PERMIT' ||
      doc.type === 'VOTER_ID'
    );
    const selfieDocument = verification.documents.find(doc => doc.type === 'SELFIE');

    if (idDocument && selfieDocument) {
      console.log('[VerificationService] Performing face comparison...');
      console.log('  - ID Document URL:', idDocument.originalUrl);
      console.log('  - Selfie URL:', selfieDocument.originalUrl);

      try {
        // Fetch the images from URLs
        const idImageBuffer = await this.fetchImageFromUrl(idDocument.originalUrl);
        const selfieImageBuffer = await this.fetchImageFromUrl(selfieDocument.originalUrl);

        if (!idImageBuffer) {
          console.error('[VerificationService] Failed to fetch ID document image');
          flags.push('IMAGE_FETCH_FAILED');
          warnings.push('Could not fetch ID document image for face comparison');
        } else if (!selfieImageBuffer) {
          console.error('[VerificationService] Failed to fetch selfie image');
          flags.push('IMAGE_FETCH_FAILED');
          warnings.push('Could not fetch selfie image for face comparison');
        } else {
          const faceComparisonResult = await this.biometricService.compareFacesWithGoogleVision(
            idImageBuffer,
            selfieImageBuffer
          );

          faceMatch = faceComparisonResult.match;
          faceMatchScore = faceComparisonResult.confidence;
          faceComparisonDetails = faceComparisonResult.details;

          console.log('[VerificationService] Face comparison result:');
          console.log('  - Match:', faceMatch);
          console.log('  - Score:', faceMatchScore);
          console.log('  - Details:', JSON.stringify(faceComparisonDetails));

          if (!faceMatch) {
            flags.push('FACE_MISMATCH');
          }
        }
      } catch (faceError) {
        console.error('[VerificationService] Face comparison error:', faceError);
        flags.push('FACE_COMPARISON_ERROR');
        warnings.push('Face comparison failed: ' + (faceError instanceof Error ? faceError.message : 'Unknown error'));
      }
    } else {
      if (!idDocument) {
        warnings.push('No ID document found for face comparison');
      }
      if (!selfieDocument) {
        warnings.push('No selfie found for face comparison');
      }
    }

    const riskLevel = this.calculateRiskLevel(flags, documentChecks);

    // Include face match in pass/fail decision
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
        documentTampered,
        faceMatch,
        faceMatchScore
      },
      extractedData,
      flags,
      warnings
    };

    // Format address as string if it's an object
    let addressString: string | null = null;
    if (extractedData.address) {
      if (typeof extractedData.address === 'object') {
        const addr = extractedData.address;
        addressString = [addr.street, addr.city, addr.state, addr.postalCode, addr.country]
          .filter(Boolean)
          .join(', ');
      } else {
        addressString = extractedData.address as string;
      }
    }

    console.log('[VerificationService] Creating verification result:');
    console.log('  - extractedName:', extractedData.fullName);
    console.log('  - extractedDob:', extractedData.dateOfBirth);
    console.log('  - documentNumber:', extractedData.documentNumber);
    console.log('  - expiryDate:', extractedData.expiryDate);
    console.log('  - issuingCountry:', extractedData.issuingCountry);
    console.log('  - address:', addressString);
    console.log('  - faceMatch:', faceMatch);
    console.log('  - faceMatchScore:', faceMatchScore);

    // Use upsert to handle both new and retry scenarios
    await prisma.verificationResult.upsert({
      where: { verificationId },
      update: {
        passed,
        score: result.score,
        riskLevel,
        documentAuthentic: result.checks.documentAuthentic,
        documentExpired: result.checks.documentExpired,
        documentTampered: result.checks.documentTampered,
        faceMatch,
        faceMatchScore,
        extractedName: extractedData.fullName || null,
        extractedDob: extractedData.dateOfBirth ? new Date(extractedData.dateOfBirth) : null,
        extractedAddress: addressString,
        documentNumber: extractedData.documentNumber || null,
        issuingCountry: extractedData.issuingCountry || null,
        expiryDate: extractedData.expiryDate ? new Date(extractedData.expiryDate) : null,
        extractedData: extractedData as any,
        flags,
        warnings,
        updatedAt: new Date()
      },
      create: {
        verificationId,
        passed,
        score: result.score,
        riskLevel,
        documentAuthentic: result.checks.documentAuthentic,
        documentExpired: result.checks.documentExpired,
        documentTampered: result.checks.documentTampered,
        faceMatch,
        faceMatchScore,
        extractedName: extractedData.fullName || null,
        extractedDob: extractedData.dateOfBirth ? new Date(extractedData.dateOfBirth) : null,
        extractedAddress: addressString,
        documentNumber: extractedData.documentNumber || null,
        issuingCountry: extractedData.issuingCountry || null,
        expiryDate: extractedData.expiryDate ? new Date(extractedData.expiryDate) : null,
        extractedData: extractedData as any,
        flags,
        warnings
      }
    });

    await prisma.verification.update({
      where: { id: verificationId },
      data: {
        status: passed ? VerificationStatus.COMPLETED : VerificationStatus.FAILED,
        completedAt: passed ? new Date() : undefined,
        // Increment retry count if verification failed
        retryCount: passed ? undefined : {
          increment: 1
        }
      }
    });

    // Send email notification to partner
    try {
      const verificationWithDetails = await prisma.verification.findUnique({
        where: { id: verificationId },
        include: {
          partner: true,
          user: true
        }
      });

      if (verificationWithDetails?.partner) {
        logger.info(`[VerificationService] Sending completion email to partner: ${verificationWithDetails.partner.email}`);

        await this.emailService.sendVerificationCompleteEmail(
          verificationWithDetails.partner.email,
          verificationWithDetails.partner.companyName,
          verificationWithDetails.user?.fullName || 'User',
          verificationWithDetails.user?.email || 'Unknown',
          {
            passed: result.passed,
            score: result.score,
            riskLevel: result.riskLevel,
            extractedData: result.extractedData,
            flags: result.flags
          }
        );

        logger.info(`[VerificationService] Partner notification email sent successfully`);
      }
    } catch (emailError) {
      // Log error but don't fail the verification
      logger.error('[VerificationService] Failed to send partner notification email:', emailError);
    }

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

    console.log('[VerificationService] Merging extracted data from', documents.length, 'documents');

    for (const doc of documents) {
      if (doc.extractedData) {
        const data = typeof doc.extractedData === 'string'
          ? JSON.parse(doc.extractedData)
          : doc.extractedData;

        console.log('[VerificationService] Document', doc.id, 'type:', doc.type, 'extractedData:', JSON.stringify(data, null, 2));

        // Merge only non-null/undefined values to avoid overwriting good data with empty values
        for (const [key, value] of Object.entries(data)) {
          if (value !== null && value !== undefined && value !== '') {
            // Don't overwrite existing values with detection metadata
            if (key === 'autoDetected' || key === 'detectionConfidence' || key === 'detectionMethod' || key === 'detectedKeywords') {
              continue;
            }
            // Only overwrite if current value is empty or new value has higher confidence
            if (!merged[key as keyof ExtractedDocumentData] ||
                (key === 'confidence' && (value as number) > (merged.confidence || 0))) {
              (merged as any)[key] = value;
            }
          }
        }
      }
    }

    console.log('[VerificationService] Final merged extracted data:', JSON.stringify(merged, null, 2));

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

    if (flags.includes('FACE_MISMATCH')) {
      return RiskLevel.CRITICAL;
    }

    if (flags.includes('IMAGE_FETCH_FAILED')) {
      return RiskLevel.HIGH;
    }

    if (flags.includes('FACE_COMPARISON_ERROR')) {
      return RiskLevel.HIGH;
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
    console.log('[VerificationService] Starting face comparison for verification:', verificationId);

    // Use the new Google Vision-based comparison
    const result = await this.biometricService.compareFacesWithGoogleVision(
      documentImageBuffer,
      selfieBuffer
    );

    console.log('[VerificationService] Face comparison result:', result);

    const faceMatch = result.match;
    const matchScore = result.confidence;

    await prisma.verificationResult.updateMany({
      where: { verificationId },
      data: {
        faceMatch,
        faceMatchScore: matchScore
      }
    });

    return {
      faceMatch,
      matchScore,
      details: result.details
    };
  }

  async getVerification(verificationId: string) {
    return await prisma.verification.findUnique({
      where: { id: verificationId },
      include: {
        documents: true,
        results: true,
        user: true
      }
    });
  }

  /**
   * Fetch image from URL (supports S3, HTTP/HTTPS, and local files)
   */
  private async fetchImageFromUrl(url: string): Promise<Buffer | null> {
    try {
      console.log('[VerificationService] Fetching image from:', url);

      // Check if it's an S3 URL - use AWS SDK to fetch
      if (url.includes('.s3.') && url.includes('amazonaws.com')) {
        console.log('[VerificationService] Detected S3 URL, using AWS SDK to fetch');
        return await this.fetchFromS3(url);
      }

      // Check if it's a local file path or local URL
      if (url.startsWith('/uploads/') || url.includes('/uploads/')) {
        // Try to read from local filesystem
        const localPath = url.includes('/uploads/')
          ? path.join(__dirname, '../..', url.substring(url.indexOf('/uploads/')))
          : path.join(__dirname, '../..', url);

        console.log('[VerificationService] Trying local path:', localPath);

        if (fs.existsSync(localPath)) {
          return fs.readFileSync(localPath);
        }
      }

      // HTTP/HTTPS URL (non-S3)
      if (url.startsWith('https://')) {
        return await this.fetchFromHttps(url);
      }

      if (url.startsWith('http://')) {
        return await this.fetchFromHttp(url);
      }

      console.error('[VerificationService] Unsupported URL format:', url);
      return null;
    } catch (error) {
      console.error('[VerificationService] Failed to fetch image:', error);
      return null;
    }
  }

  /**
   * Fetch image from S3 using AWS SDK
   */
  private async fetchFromS3(url: string): Promise<Buffer | null> {
    try {
      // Extract key from S3 URL
      // URL format: https://bucket-name.s3.region.amazonaws.com/key
      const key = s3Service.extractKeyFromUrl(url);

      if (!key) {
        console.error('[VerificationService] Could not extract S3 key from URL:', url);
        return null;
      }

      console.log('[VerificationService] Fetching from S3 with key:', key);

      // Use the S3 service to get the object
      const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');

      const s3Client = new S3Client({
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
        }
      });

      const command = new GetObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET!,
        Key: key
      });

      const response = await s3Client.send(command);

      if (!response.Body) {
        console.error('[VerificationService] S3 response has no body');
        return null;
      }

      // Convert stream to buffer
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as any) {
        chunks.push(chunk);
      }

      const buffer = Buffer.concat(chunks);
      console.log('[VerificationService] Successfully fetched from S3, size:', buffer.length, 'bytes');

      return buffer;
    } catch (error) {
      console.error('[VerificationService] Failed to fetch from S3:', error);
      return null;
    }
  }

  private fetchFromHttps(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      https.get(url, (response) => {
        // Handle redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            console.log('[VerificationService] Following redirect to:', redirectUrl);
            this.fetchFromHttps(redirectUrl).then(resolve).catch(reject);
            return;
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: Failed to fetch ${url}`));
          return;
        }

        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      }).on('error', reject);
    });
  }

  private fetchFromHttp(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      http.get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: Failed to fetch ${url}`));
          return;
        }

        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      }).on('error', reject);
    });
  }
}

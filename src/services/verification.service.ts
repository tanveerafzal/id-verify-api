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
// import { documentIdValidator } from './document-id-validator.service';
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
    const verification = await prisma.verification.findUnique({
      where: { id: verificationId },
      include: { documents: true }
    });

    if (!verification) {
      throw new Error('Verification not found');
    }

    // Check if this is a retry (verification was FAILED)
    const isRetry = verification.status === 'FAILED';
    let activeVerificationId = verificationId;

    if (isRetry) {
      // Find the root/original verification (in case of multiple retries)
      const originalVerificationId = verification.parentVerificationId || verificationId;

      // First, check if there's already an IN_PROGRESS or PENDING retry for this verification
      // Also ensure it hasn't been completed (completedAt is null)
      const existingActiveRetry = await prisma.verification.findFirst({
        where: {
          parentVerificationId: originalVerificationId,
          status: { in: ['PENDING', 'IN_PROGRESS'] },
          completedAt: null
        },
        orderBy: { createdAt: 'desc' }
      });

      if (existingActiveRetry) {
        // Use the existing active retry instead of creating a new one
        console.log(`[VerificationService] Found existing active retry ${existingActiveRetry.id} - reusing it`);
        activeVerificationId = existingActiveRetry.id;
      } else {
        // No active retry exists, create a new one
        console.log('[VerificationService] Retry detected - creating new verification record');

        // Count existing retries to set retry number
        const existingRetries = await prisma.verification.count({
          where: { parentVerificationId: originalVerificationId }
        });

        // Create a new verification linked to the original
        const newVerification = await prisma.verification.create({
          data: {
            userId: verification.userId,
            partnerId: verification.partnerId,
            type: verification.type,
            status: VerificationStatus.PENDING,
            webhookUrl: verification.webhookUrl,
            metadata: verification.metadata as any,
            parentVerificationId: originalVerificationId,
            retryCount: existingRetries + 1
          }
        });

        console.log(`[VerificationService] Created new verification ${newVerification.id} (retry #${existingRetries + 1}) linked to original ${originalVerificationId}`);
        activeVerificationId = newVerification.id;
      }
    }

    // Detect if file is PDF (PDFs start with %PDF)
    const isPdf = imageBuffer[0] === 0x25 && imageBuffer[1] === 0x50 &&
                  imageBuffer[2] === 0x44 && imageBuffer[3] === 0x46;

    let preprocessed: Buffer;
    let qualityCheck: { qualityScore: number; isBlurry: boolean; hasGlare: boolean; isComplete: boolean; issues: string[] };

    if (isPdf) {
      // PDFs can't be preprocessed with sharp - send directly to OCR
      console.log('[VerificationService] PDF detected - skipping image preprocessing');
      preprocessed = imageBuffer;
      // Default quality check for PDFs (assume good quality since we can't analyze)
      qualityCheck = {
        qualityScore: 0.85,
        isBlurry: false,
        hasGlare: false,
        isComplete: true,
        issues: []
      };
    } else {
      // Image files - preprocess normally
      preprocessed = await this.documentScanner.preprocessImage(imageBuffer);
      qualityCheck = await this.documentScanner.checkQuality(preprocessed);

      if (qualityCheck.qualityScore < config.verification.minQualityScore) {
        throw new Error(`Document quality too low: ${qualityCheck.issues.join(', ')}`);
      }
    }

    // Use user-provided document type or default to DRIVERS_LICENSE
    const finalDocumentType = documentType || DocumentType.DRIVERS_LICENSE;
    console.log('[VerificationService] Using document type:', finalDocumentType);

    await this.ocrService.initialize();
    // Extract document data using external OCR API (with fallback to Google services)
    const extractedData = await this.ocrService.extractDocumentData(
      preprocessed,
      finalDocumentType
    );
    await this.ocrService.terminate();

    // Validate essential fields were extracted (name, document number)
    const missingFields: string[] = [];

    // Check for name (fullName or firstName+lastName)
    const hasName = extractedData.fullName ||
                    (extractedData.firstName && extractedData.lastName);
    if (!hasName) {
      missingFields.push('name');
    }

    // Check for document number
    if (!extractedData.documentNumber) {
      missingFields.push('document number');
    }

    if (missingFields.length > 0) {
      const typeName = this.getDocumentTypeName(finalDocumentType);
      console.log('[VerificationService] Missing essential fields:', missingFields);
      console.log('[VerificationService] Extracted data:', JSON.stringify(extractedData, null, 2));
      throw new Error(`Unable to extract ${missingFields.join(' and ')} from the document. Please upload a clearer image of your ${typeName} where all text is visible and readable.`);
    }

    // Document ID validation commented out - using external OCR API
    // const idValidation = documentIdValidator.validateDocumentId(
    //   extractedData.documentNumber!,
    //   finalDocumentType,
    //   extractedData.issuingCountry,
    //   {
    //     firstName: extractedData.firstName,
    //     lastName: extractedData.lastName,
    //     fullName: extractedData.fullName,
    //     dateOfBirth: extractedData.dateOfBirth
    //   }
    // );
    //
    // console.log('[VerificationService] Document ID validation:', {
    //   documentNumber: idValidation.normalizedNumber,
    //   isValid: idValidation.isValid,
    //   country: idValidation.country,
    //   state: idValidation.state,
    //   errors: idValidation.errors,
    //   warnings: idValidation.warnings
    // });
    //
    // if (!idValidation.isValid) {
    //   const typeName = this.getDocumentTypeName(finalDocumentType);
    //   throw new Error(`Invalid ${typeName} number format: ${idValidation.errors.join('. ')}. Please ensure you uploaded a valid ${typeName}.`);
    // }

    // Generate thumbnail for future use (skip for PDFs)
    if (!isPdf) {
      await this.documentScanner.generateThumbnail(preprocessed);
    }

    const enrichedExtractedData = {
      ...extractedData
    };

    // Determine mimeType from buffer content
    let mimeType = 'image/jpeg'; // default
    if (isPdf) {
      mimeType = 'application/pdf';
    } else if (imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 &&
               imageBuffer[2] === 0x4E && imageBuffer[3] === 0x47) {
      mimeType = 'image/png';
    }

    // Delete existing documents of the same type (not SELFIE) for this verification
    // This ensures only one ID document is kept per verification
    const existingDocs = await prisma.document.findMany({
      where: {
        verificationId: activeVerificationId,
        type: { not: 'SELFIE' }
      }
    });

    if (existingDocs.length > 0) {
      console.log(`[VerificationService] Deleting ${existingDocs.length} existing document(s) for verification ${activeVerificationId}`);

      // Delete files from S3
      for (const doc of existingDocs) {
        if (doc.originalUrl && doc.originalUrl !== 'not-saved') {
          try {
            await s3Service.deleteFile(doc.originalUrl);
            console.log(`[VerificationService] Deleted S3 file: ${doc.originalUrl}`);
          } catch (err) {
            console.error(`[VerificationService] Failed to delete S3 file: ${doc.originalUrl}`, err);
          }
        }
      }

      // Delete document records from database
      await prisma.document.deleteMany({
        where: {
          verificationId: activeVerificationId,
          type: { not: 'SELFIE' }
        }
      });
    }

    const document = await prisma.document.create({
      data: {
        verificationId: activeVerificationId,
        type: finalDocumentType,
        side,
        originalUrl: documentUrl || 'not-saved',
        mimeType,
        extractedData: enrichedExtractedData as any,
        qualityScore: qualityCheck.qualityScore,
        isBlurry: qualityCheck.isBlurry,
        hasGlare: qualityCheck.hasGlare,
        isComplete: qualityCheck.isComplete,
        ocrConfidence: extractedData.confidence
      }
    });

    await prisma.verification.update({
      where: { id: activeVerificationId },
      data: { status: VerificationStatus.IN_PROGRESS }
    });

    return {
      document,
      extractedData: enrichedExtractedData,
      qualityCheck,
      documentType: finalDocumentType,
      userSelectedType: documentType || null,
      verificationId: activeVerificationId,
      isRetry,
      originalVerificationId: isRetry ? (verification.parentVerificationId || verificationId) : null
    };
  }

  async processSelfie(verificationId: string, imageBuffer: Buffer, selfieUrl?: string) {
    // Check if this verification has a retry - use the retry verification instead
    const verification = await prisma.verification.findUnique({
      where: { id: verificationId }
    });

    let activeVerificationId = verificationId;

    if (verification?.status === 'FAILED') {
      const latestRetry = await this.getLatestRetryVerification(verificationId);
      if (latestRetry && latestRetry.status !== 'COMPLETED') {
        console.log('[VerificationService] Using retry verification for selfie:', latestRetry.id);
        activeVerificationId = latestRetry.id;
      }
    }

    const biometricData = await this.biometricService.extractFaceData(imageBuffer);

    if (!biometricData.faceDetected) {
      throw new Error('No face detected in selfie');
    }

    if (biometricData.faceCount > 1) {
      throw new Error('Multiple faces detected in selfie');
    }

    // Perform liveness/anti-spoofing check
    console.log('[VerificationService] Performing liveness check on selfie...');
    const livenessResult = await this.biometricService.performSingleImageLivenessCheck(imageBuffer);

    console.log('[VerificationService] Liveness check result:', {
      isLive: livenessResult.isLive,
      confidence: livenessResult.confidence,
      passedChecks: Object.entries(livenessResult.checks || {})
        .filter(([key, val]) => key.endsWith('Pass') && val === true)
        .length
    });

    // Add liveness data to biometric result
    const biometricDataWithLiveness = {
      ...biometricData,
      livenessCheck: livenessResult.isLive,
      livenessScore: livenessResult.confidence,
      livenessDetails: livenessResult.checks
    };

    // Save selfie as a document in the Document table
    // Delete existing selfie first to ensure only one per verification
    if (selfieUrl) {
      console.log('[VerificationService] Saving selfie to verification:', activeVerificationId);

      // Delete existing selfie for this verification
      const existingSelfies = await prisma.document.findMany({
        where: {
          verificationId: activeVerificationId,
          type: 'SELFIE'
        }
      });

      if (existingSelfies.length > 0) {
        console.log(`[VerificationService] Deleting ${existingSelfies.length} existing selfie(s) for verification ${activeVerificationId}`);

        // Delete files from S3
        for (const selfie of existingSelfies) {
          if (selfie.originalUrl) {
            try {
              await s3Service.deleteFile(selfie.originalUrl);
              console.log(`[VerificationService] Deleted S3 selfie: ${selfie.originalUrl}`);
            } catch (err) {
              console.error(`[VerificationService] Failed to delete S3 selfie: ${selfie.originalUrl}`, err);
            }
          }
        }

        // Delete selfie records from database
        await prisma.document.deleteMany({
          where: {
            verificationId: activeVerificationId,
            type: 'SELFIE'
          }
        });
      }

      // Determine mimeType from buffer content
      let selfieMimeType = 'image/jpeg'; // default for selfies
      if (imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 &&
          imageBuffer[2] === 0x4E && imageBuffer[3] === 0x47) {
        selfieMimeType = 'image/png';
      }

      await prisma.document.create({
        data: {
          verificationId: activeVerificationId,
          type: 'SELFIE',
          originalUrl: selfieUrl,
          mimeType: selfieMimeType,
          qualityScore: biometricData.faceQuality || null,
          isBlurry: false,
          isComplete: true
        }
      });
    }

    // Store liveness result in verification metadata
    await prisma.verification.update({
      where: { id: activeVerificationId },
      data: {
        metadata: {
          livenessCheck: livenessResult.isLive,
          livenessScore: livenessResult.confidence,
          livenessDetails: livenessResult.checks
        }
      }
    });

    return biometricDataWithLiveness;
  }

  async performVerification(verificationId: string): Promise<VerificationResult> {
    const verification = await prisma.verification.findUnique({
      where: { id: verificationId },
      include: { documents: true, results: true, user: true }
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

    // CRITICAL: Validate required documents based on verification type
    const validIdTypes = ['DRIVERS_LICENSE', 'PASSPORT', 'NATIONAL_ID', 'RESIDENCE_PERMIT', 'PERMANENT_RESIDENT_CARD'];
    const idDocuments = verification.documents.filter(doc => validIdTypes.includes(doc.type));
    const selfieDocuments = verification.documents.filter(doc => doc.type === 'SELFIE');

    console.log('[VerificationService] Documents present:', verification.documents.map(d => d.type));
    console.log('[VerificationService] Verification type:', verification.type);

    // Check ID document requirement (required for all types except SELFIE_ONLY)
    if (verification.type !== 'SELFIE_ONLY' && idDocuments.length === 0) {
      console.log('[VerificationService] FAILED: No valid ID document found');
      throw new Error('No valid ID document found. Please upload a government-issued ID (driver\'s license, passport, national ID, etc.) before submitting verification.');
    }

    // Check selfie requirement (required for IDENTITY, FULL_KYC, and SELFIE_ONLY)
    const requiresSelfie = ['IDENTITY', 'FULL_KYC', 'SELFIE_ONLY'].includes(verification.type);
    if (requiresSelfie && selfieDocuments.length === 0) {
      console.log('[VerificationService] FAILED: No selfie found');
      throw new Error('No selfie found. Please upload a selfie photo for identity verification.');
    }

    console.log('[VerificationService] Valid ID documents found:', idDocuments.map(d => d.type));
    console.log('[VerificationService] Selfie documents found:', selfieDocuments.length);

    const documentChecks = await this.verifyDocuments(verification.documents);

    const extractedData = this.mergeExtractedData(verification.documents);

    // Name validation - compare requester name with extracted name
    let nameMatch = false;
    let nameMatchScore = 0;
    let nameComparisonDetails: string | null = null;

    if (verification.user?.fullName) {
      console.log('[VerificationService] Performing name validation...');
      console.log('  - Requester name:', verification.user.fullName);
      console.log('  - Extracted name:', extractedData.fullName);

      const nameComparison = this.compareNames(verification.user.fullName, extractedData.fullName);
      nameMatch = nameComparison.match;
      nameMatchScore = nameComparison.score;
      nameComparisonDetails = nameComparison.details;

      console.log('[VerificationService] Name comparison result:');
      console.log('  - Match:', nameMatch);
      console.log('  - Score:', nameMatchScore);
      console.log('  - Details:', nameComparisonDetails);

      if (!nameMatch) {
        flags.push('NAME_MISMATCH');
        // Name mismatch is a critical error that fails verification - not a warning
      }
    } else {
      console.log('[VerificationService] No requester name provided, skipping name validation');
      warnings.push('Name validation skipped - no requester name provided');
    }

    // Document expiry validation
    const documentExpired = this.checkDocumentExpiry(extractedData.expiryDate);
    if (documentExpired) {
      flags.push('DOCUMENT_EXPIRED');
      const expiryDate = extractedData.expiryDate ? new Date(extractedData.expiryDate).toLocaleDateString() : 'unknown';
      warnings.push(`Document expired on ${expiryDate}`);
      console.log('[VerificationService] Document is EXPIRED - expiry date:', expiryDate);
    } else if (extractedData.expiryDate) {
      console.log('[VerificationService] Document is valid - expiry date:', extractedData.expiryDate);
    } else {
      console.log('[VerificationService] No expiry date found on document');
      warnings.push('Could not verify document expiry - no expiry date found');
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
      doc.type === 'PERMANENT_RESIDENT_CARD'
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

    // Get liveness check result from verification metadata
    const metadata = verification.metadata as any || {};
    const livenessCheck = metadata.livenessCheck ?? true; // Default to true if not set (for backwards compatibility)
    const livenessScore = metadata.livenessScore ?? 1;

    // Add liveness failure flag if check failed
    if (!livenessCheck) {
      flags.push('LIVENESS_CHECK_FAILED');
      warnings.push('Selfie may not be a live person - possible photo or screen detected');
    }

    const riskLevel = this.calculateRiskLevel(flags, documentChecks);

    // Check if name validation should affect pass/fail
    // Name mismatch only fails if requester name was provided and doesn't match
    const nameMismatchFailure = verification.user?.fullName ? !nameMatch : false;

    // Include face match, name match, AND liveness check in pass/fail decision
    const passed = flags.length === 0 &&
                   documentChecks.averageQuality >= config.verification.minQualityScore &&
                   !documentExpired &&
                   !documentTampered &&
                   !nameMismatchFailure &&
                   faceMatch && // Face must match
                   livenessCheck; // Liveness must pass

    // Calculate weighted verification score
    // Weights: Document Quality 20%, Face Match 35%, Name Match 25%, Liveness 20%
    const documentQualityScore = documentChecks.averageQuality || 0;
    const normalizedFaceScore = faceMatch ? faceMatchScore : 0;
    const normalizedNameScore = nameMatch ? nameMatchScore : 0;
    const normalizedLivenessScore = livenessCheck ? livenessScore : 0;

    const weightedScore = (
      (documentQualityScore * 0.20) +
      (normalizedFaceScore * 0.35) +
      (normalizedNameScore * 0.25) +
      (normalizedLivenessScore * 0.20)
    );

    console.log('[VerificationService] Score calculation:', {
      documentQuality: `${(documentQualityScore * 100).toFixed(1)}% × 20% = ${(documentQualityScore * 0.20 * 100).toFixed(1)}%`,
      faceMatch: `${(normalizedFaceScore * 100).toFixed(1)}% × 35% = ${(normalizedFaceScore * 0.35 * 100).toFixed(1)}%`,
      nameMatch: `${(normalizedNameScore * 100).toFixed(1)}% × 25% = ${(normalizedNameScore * 0.25 * 100).toFixed(1)}%`,
      liveness: `${(normalizedLivenessScore * 100).toFixed(1)}% × 20% = ${(normalizedLivenessScore * 0.20 * 100).toFixed(1)}%`,
      total: `${(weightedScore * 100).toFixed(1)}%`
    });

    const result: VerificationResult = {
      passed,
      score: weightedScore,
      riskLevel,
      checks: {
        documentAuthentic: !documentTampered,
        documentExpired,
        documentTampered,
        faceMatch,
        faceMatchScore,
        nameMatch,
        nameMatchScore,
        livenessCheck,
        livenessScore
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
    console.log('  - expectedName:', verification.user?.fullName || 'not provided');
    console.log('  - nameMatch:', nameMatch, '(score:', nameMatchScore, ')');
    console.log('  - extractedDob:', extractedData.dateOfBirth);
    console.log('  - documentNumber:', extractedData.documentNumber);
    console.log('  - expiryDate:', extractedData.expiryDate);
    console.log('  - documentExpired:', documentExpired);
    console.log('  - issuingCountry:', extractedData.issuingCountry);
    console.log('  - address:', addressString);
    console.log('  - faceMatch:', faceMatch);
    console.log('  - faceMatchScore:', faceMatchScore);
    console.log('  - passed:', passed);

    // Parse dates using helper that handles various formats (including Canadian bilingual)
    const parsedDob = this.parseDate(extractedData.dateOfBirth);
    const parsedExpiry = this.parseDate(extractedData.expiryDate);

    console.log('[VerificationService] Parsed dates:', {
      rawDob: extractedData.dateOfBirth,
      parsedDob: parsedDob?.toISOString() || null,
      rawExpiry: extractedData.expiryDate,
      parsedExpiry: parsedExpiry?.toISOString() || null
    });

    // Update extractedData with parsed dates in ISO format for frontend
    // This ensures the frontend receives dates it can parse
    if (parsedDob) {
      extractedData.dateOfBirth = parsedDob.toISOString().split('T')[0]; // YYYY-MM-DD format
    }
    if (parsedExpiry) {
      extractedData.expiryDate = parsedExpiry.toISOString().split('T')[0]; // YYYY-MM-DD format
    }

    // Update the result object with the formatted extractedData
    result.extractedData = extractedData;

    console.log('Use upsert to handle both new and retry scenarios verificationId:', verificationId);

    try {
      await prisma.verificationResult.upsert({
        where: { verificationId },
        update: {
          passed,
          score: result.score,
          riskLevel,
          nameMatch,
          documentAuthentic: result.checks.documentAuthentic,
          documentExpired: result.checks.documentExpired,
          documentTampered: result.checks.documentTampered,
          faceMatch,
          faceMatchScore,
          extractedName: extractedData.fullName || null,
          extractedDob: parsedDob,
          extractedAddress: addressString,
          documentNumber: extractedData.documentNumber || null,
          issuingCountry: extractedData.issuingCountry || null,
          expiryDate: parsedExpiry,
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
          nameMatch,
          documentAuthentic: result.checks.documentAuthentic,
          documentExpired: result.checks.documentExpired,
          documentTampered: result.checks.documentTampered,
          faceMatch,
          faceMatchScore,
          extractedName: extractedData.fullName || null,
          extractedDob: parsedDob,
          extractedAddress: addressString,
          documentNumber: extractedData.documentNumber || null,
          issuingCountry: extractedData.issuingCountry || null,
          expiryDate: parsedExpiry,
          extractedData: extractedData as any,
          flags,
          warnings
        }
      });
      console.log('verification.update verificationId:', verificationId);
      const newStatus = passed ? VerificationStatus.COMPLETED : VerificationStatus.FAILED;
      const completedAt = new Date();

      // Update the current verification (could be original or retry)
      await prisma.verification.update({
        where: { id: verificationId },
        data: {
          status: newStatus,
          completedAt, // Always set completedAt when verification is processed (success or failure)
          // Increment retry count if verification failed
          retryCount: passed ? undefined : {
            increment: 1
          }
        }
      });

      // If this is a retry verification, also update the parent verification
      // This ensures the parent reflects the latest status
      if (verification.parentVerificationId) {
        console.log('[VerificationService] Updating parent verification:', verification.parentVerificationId);
        await prisma.verification.update({
          where: { id: verification.parentVerificationId },
          data: {
            status: newStatus,
            completedAt,
            // Also update retry count on parent to track total attempts
            retryCount: {
              increment: 1
            }
          }
        });
      }
    } catch (dbError) {
      // Log error but don't fail the verification
      logger.error('[VerificationService] Failed to update verification status:', dbError);
    }
    console.log('Send email notification to partner');
    // Send email notification to partner
    // For retry verifications, get partner info from parent verification
    try {
      const lookupId = verification.parentVerificationId || verificationId;
      const verificationWithDetails = await prisma.verification.findUnique({
        where: { id: lookupId },
        include: {
          partner: {
            include: {
              users: {
                take: 1,
                orderBy: { createdAt: 'asc' }
              }
            }
          },
          user: true
        }
      });

      if (verificationWithDetails?.partner) {
        const partnerEmail = verificationWithDetails.partner.users[0]?.email;
        if (partnerEmail) {
          logger.info(`[VerificationService] Sending completion email to partner: ${partnerEmail}`);

          await this.emailService.sendVerificationCompleteEmail(
            partnerEmail,
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
        } else {
          logger.warn(`[VerificationService] No partner email found for verification: ${lookupId}`);
        }
      } else {
        logger.warn(`[VerificationService] No partner associated with verification: ${lookupId}`);
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

    // Sort documents by updatedAt/createdAt descending (newest first)
    // This ensures the newest document's data takes priority
    const sortedDocs = [...documents].sort((a, b) => {
      const dateA = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const dateB = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return dateB - dateA; // Descending order (newest first)
    });

    // Filter to only include ID documents (exclude selfies from data extraction)
    const idDocTypes = ['DRIVERS_LICENSE', 'PASSPORT', 'NATIONAL_ID', 'RESIDENCE_PERMIT', 'PERMANENT_RESIDENT_CARD'];
    const idDocs = sortedDocs.filter(doc => idDocTypes.includes(doc.type));

    console.log('[VerificationService] Processing', idDocs.length, 'ID documents (sorted by date, newest first)');

    // Process newest documents first - their data takes priority
    for (const doc of idDocs) {
      if (doc.extractedData) {
        const data = typeof doc.extractedData === 'string'
          ? JSON.parse(doc.extractedData)
          : doc.extractedData;

        console.log('[VerificationService] Document', doc.id, 'type:', doc.type,
          'updated:', doc.updatedAt || doc.createdAt,
          'extractedData keys:', Object.keys(data).filter(k => data[k] !== null && data[k] !== undefined));

        // Merge only non-null/undefined values
        for (const [key, value] of Object.entries(data)) {
          if (value !== null && value !== undefined && value !== '') {
            // Skip detection metadata
            if (key === 'autoDetected' || key === 'detectionConfidence' || key === 'detectionMethod' || key === 'detectedKeywords') {
              continue;
            }
            // Since we process newest first, always use the first (newest) non-empty value
            if (!merged[key as keyof ExtractedDocumentData]) {
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

    const expiry = this.parseDate(expiryDate);
    if (!expiry) return false;

    const today = new Date();
    // Set time to start of day for accurate date comparison
    today.setHours(0, 0, 0, 0);
    expiry.setHours(0, 0, 0, 0);

    return expiry < today;
  }

  /**
   * Parse date strings in various formats including:
   * - ISO format: "1988-02-18"
   * - Canadian bilingual: "18 FEB-FEV 1988", "01 MAY - MAI 96"
   * - Korean bilingual: "13 1월-JAN 2002", "06 11월-NOV 2023"
   * - Standard: "February 18, 1988", "18 Feb 1988"
   * Returns null if parsing fails
   */
  private parseDate(dateString?: string): Date | null {
    if (!dateString) return null;

    // Try standard Date parsing first
    let date = new Date(dateString);
    if (!isNaN(date.getTime())) {
      return date;
    }

    // Support both 3-letter abbreviations and full month names
    const months: Record<string, number> = {
      'JAN': 0, 'JANUARY': 0, 'JANVIER': 0,
      'FEB': 1, 'FEBRUARY': 1, 'FEVRIER': 1, 'FEV': 1,
      'MAR': 2, 'MARCH': 2, 'MARS': 2,
      'APR': 3, 'APRIL': 3, 'AVRIL': 3, 'AVR': 3,
      'MAY': 4, 'MAI': 4,
      'JUN': 5, 'JUNE': 5, 'JUIN': 5,
      'JUL': 6, 'JULY': 6, 'JUILLET': 6, 'JUIL': 6,
      'AUG': 7, 'AUGUST': 7, 'AOUT': 7, 'AOU': 7,
      'SEP': 8, 'SEPTEMBER': 8, 'SEPTEMBRE': 8, 'SEPT': 8,
      'OCT': 9, 'OCTOBER': 9, 'OCTOBRE': 9,
      'NOV': 10, 'NOVEMBER': 10, 'NOVEMBRE': 10,
      'DEC': 11, 'DECEMBER': 11, 'DECEMBRE': 11
    };

    // Helper to convert 2-digit year to 4-digit year
    const toFullYear = (year: number): number => {
      if (year >= 100) return year; // Already 4 digits
      // Assume years 00-30 are 2000s, 31-99 are 1900s
      return year <= 30 ? 2000 + year : 1900 + year;
    };

    // Handle Korean bilingual format: "13 1월-JAN 2002", "06 11월-NOV 2023"
    // Korean months use number + 월 (e.g., 1월 = January, 12월 = December)
    const koreanMatch = dateString.match(/(\d{1,2})\s+(\d{1,2})월\s*-\s*[A-Z]{3,9}\s+(\d{2,4})/i);
    if (koreanMatch) {
      const day = parseInt(koreanMatch[1], 10);
      const month = parseInt(koreanMatch[2], 10) - 1; // Korean months are 1-based, JS is 0-based
      const year = toFullYear(parseInt(koreanMatch[3], 10));

      if (month >= 0 && month <= 11) {
        return new Date(year, month, day);
      }
    }

    // Handle Canadian bilingual format: "18 FEB-FEV 1988", "01 MAY - MAI 96", "24 JULY-JUIL 28"
    // Allows optional spaces around hyphen, variable length month names, and 2 or 4 digit years
    const bilingualMatch = dateString.match(/(\d{1,2})\s+([A-Z]{3,9})\s*-\s*[A-Z]{3,9}\s+(\d{2,4})/i);
    if (bilingualMatch) {
      const day = parseInt(bilingualMatch[1], 10);
      const monthStr = bilingualMatch[2].toUpperCase();
      const year = toFullYear(parseInt(bilingualMatch[3], 10));

      const month = months[monthStr];
      if (month !== undefined) {
        return new Date(year, month, day);
      }
    }

    // Handle format: "18 FEB 1988", "18 FEB 88", "FEB 18 1988", "FEB 18 88", "18 JULY 2028"
    const simpleMatch = dateString.match(/(\d{1,2})\s+([A-Z]{3,9})\s+(\d{2,4})/i) ||
                        dateString.match(/([A-Z]{3,9})\s+(\d{1,2})\s+(\d{2,4})/i);
    if (simpleMatch) {
      // Determine if day or month came first
      if (/^\d/.test(simpleMatch[1])) {
        // Day first: "18 FEB 1988" or "18 FEB 88"
        const day = parseInt(simpleMatch[1], 10);
        const month = months[simpleMatch[2].toUpperCase()];
        const year = toFullYear(parseInt(simpleMatch[3], 10));
        if (month !== undefined) {
          return new Date(year, month, day);
        }
      } else {
        // Month first: "FEB 18 1988" or "FEB 18 88"
        const month = months[simpleMatch[1].toUpperCase()];
        const day = parseInt(simpleMatch[2], 10);
        const year = toFullYear(parseInt(simpleMatch[3], 10));
        if (month !== undefined) {
          return new Date(year, month, day);
        }
      }
    }

    // Handle DD/MM/YYYY, DD/MM/YY, MM/DD/YYYY, or MM/DD/YY format
    const slashMatch = dateString.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (slashMatch) {
      const first = parseInt(slashMatch[1], 10);
      const second = parseInt(slashMatch[2], 10);
      const year = toFullYear(parseInt(slashMatch[3], 10));

      // Assume DD/MM/YYYY for values where first > 12
      if (first > 12) {
        return new Date(year, second - 1, first);
      } else if (second > 12) {
        return new Date(year, first - 1, second);
      } else {
        // Ambiguous - assume DD/MM/YYYY (more common internationally)
        return new Date(year, second - 1, first);
      }
    }

    console.log('[VerificationService] Could not parse date:', dateString);
    return null;
  }

  /**
   * Compare two names with fuzzy matching
   * Returns a score between 0 and 1 (1 = exact match)
   */
  private compareNames(expectedName: string | null | undefined, extractedName: string | null | undefined): { match: boolean; score: number; details: string } {
    if (!expectedName || !extractedName) {
      return { match: false, score: 0, details: 'One or both names are missing' };
    }

    // Normalize names: lowercase, remove extra spaces, remove special characters
    const normalize = (name: string): string => {
      return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z\s]/g, '') // Remove non-alpha characters except spaces
        .replace(/\s+/g, ' ');    // Normalize multiple spaces to single space
    };

    const expected = normalize(expectedName);
    const extracted = normalize(extractedName);

    // Exact match after normalization
    if (expected === extracted) {
      return { match: true, score: 1.0, details: 'Exact match' };
    }

    // Split into parts and check if all parts of one exist in the other
    const expectedParts = expected.split(' ').filter(p => p.length > 0);
    const extractedParts = extracted.split(' ').filter(p => p.length > 0);

    // Check if all expected name parts exist in extracted (handles name order differences)
    const allExpectedInExtracted = expectedParts.every(part =>
      extractedParts.some(ep => ep === part || this.levenshteinDistance(part, ep) <= 1)
    );

    const allExtractedInExpected = extractedParts.every(part =>
      expectedParts.some(ep => ep === part || this.levenshteinDistance(part, ep) <= 1)
    );

    if (allExpectedInExtracted && allExtractedInExpected) {
      return { match: true, score: 0.95, details: 'Name parts match (different order or minor typos)' };
    }

    if (allExpectedInExtracted || allExtractedInExpected) {
      return { match: true, score: 0.85, details: 'Partial name match (one contains all parts of the other)' };
    }

    // Calculate similarity score using Levenshtein distance
    const distance = this.levenshteinDistance(expected, extracted);
    const maxLength = Math.max(expected.length, extracted.length);
    const similarity = 1 - (distance / maxLength);

    // Consider it a match if similarity is above 0.8 (allows for minor OCR errors)
    const isMatch = similarity >= 0.8;

    return {
      match: isMatch,
      score: similarity,
      details: isMatch ? `Similar names (${(similarity * 100).toFixed(1)}% match)` : `Names differ significantly (${(similarity * 100).toFixed(1)}% similarity)`
    };
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const m = str1.length;
    const n = str2.length;

    // Create a 2D array to store distances
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    // Initialize base cases
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    // Fill in the rest of the matrix
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = 1 + Math.min(
            dp[i - 1][j],     // deletion
            dp[i][j - 1],     // insertion
            dp[i - 1][j - 1]  // substitution
          );
        }
      }
    }

    return dp[m][n];
  }

  private detectTampering(documents: any[]): boolean {
    // Tampering detection should only flag obvious manipulation
    // Low quality or OCR confidence alone doesn't indicate tampering
    // (could be lighting, camera quality, document wear, etc.)

    for (const doc of documents) {
      // Skip selfie documents - they don't need tampering checks
      if (doc.type === 'SELFIE') continue;

      const qualityScore = doc.qualityScore || 1;
      const confidence = doc.extractedData?.confidence || 1;

      console.log('[VerificationService] Tampering check for document:', {
        type: doc.type,
        qualityScore,
        confidence,
        isBlurry: doc.isBlurry,
        hasGlare: doc.hasGlare
      });

      // Only flag as tampered if quality is EXTREMELY low (< 0.15)
      // This indicates potential digital manipulation or fake document
      if (qualityScore < 0.15) {
        console.log('[VerificationService] Document flagged for very low quality:', qualityScore);
        return true;
      }

      // Only flag if OCR confidence is EXTREMELY low (< 0.2)
      // This could indicate text has been digitally altered
      if (confidence < 0.2) {
        console.log('[VerificationService] Document flagged for very low OCR confidence:', confidence);
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

    if (flags.includes('NAME_MISMATCH')) {
      return RiskLevel.CRITICAL;
    }

    // Liveness check failure is critical - possible spoofing attempt
    if (flags.includes('LIVENESS_CHECK_FAILED')) {
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
   * Get the latest retry verification for a given parent verification ID
   * Returns the most recent retry linked to the parent
   */
  async getLatestRetryVerification(parentVerificationId: string): Promise<Awaited<ReturnType<typeof this.getVerification>> | null> {
    console.log('[VerificationService] Looking for retries of verification:', parentVerificationId);

    // Find the latest retry that has this verification as parent
    const latestRetry = await prisma.verification.findFirst({
      where: { parentVerificationId },
      orderBy: { createdAt: 'desc' },
      include: {
        documents: true,
        results: true,
        user: true
      }
    });

    console.log('[VerificationService] Found retry:', latestRetry ? latestRetry.id : 'none');

    return latestRetry;
  }

  /**
   * Get total retry count for a verification chain
   * Counts all retries linked to the original verification
   */
  async getTotalRetryCount(verificationId: string): Promise<number> {
    // Find the root verification (in case we're given a retry ID)
    const verification = await prisma.verification.findUnique({
      where: { id: verificationId }
    });

    if (!verification) return 0;

    // If this is a retry, get the root verification
    const rootId = verification.parentVerificationId || verificationId;

    // Count all verifications that have this as parent (direct retries)
    const count = await prisma.verification.count({
      where: { parentVerificationId: rootId }
    });

    return count+1;
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
        Bucket: process.env.S3_BUCKET_NAME!,
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

  /**
   * Get human-readable document type name
   */
  private getDocumentTypeName(docType: DocumentType): string {
    const names: Record<DocumentType, string> = {
      [DocumentType.DRIVERS_LICENSE]: "Driver's License",
      [DocumentType.PASSPORT]: 'Passport',
      [DocumentType.NATIONAL_ID]: 'National ID Card',
      [DocumentType.RESIDENCE_PERMIT]: 'Residence Permit',
      [DocumentType.PERMANENT_RESIDENT_CARD]: 'Permanent Resident Card',
      [DocumentType.SELFIE]: 'Selfie',
      [DocumentType.OTHER]: 'Other Document'
    };
    return names[docType] || 'Unknown Document';
  }
}

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
import { documentIdValidator } from './document-id-validator.service';
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

    if (isRetry) {
      console.log('[VerificationService] Retry detected - clearing ALL old ID documents and verification result');

      // On retry, delete ALL old ID documents (not just matching types)
      // This ensures we start fresh with the new document and don't mix old/new data
      const validIdTypes = ['DRIVERS_LICENSE', 'PASSPORT', 'NATIONAL_ID', 'RESIDENCE_PERMIT', 'PERMANENT_RESIDENT_CARD'];
      const oldIdDocs = verification.documents.filter(doc => validIdTypes.includes(doc.type));

      if (oldIdDocs.length > 0) {
        console.log(`[VerificationService] Deleting ${oldIdDocs.length} old ID document(s) from previous attempt`);

        for (const doc of oldIdDocs) {
          // Delete from S3 if URL exists
          if (doc.originalUrl && doc.originalUrl !== 'not-saved') {
            try {
              const key = s3Service.extractKeyFromUrl(doc.originalUrl);
              if (key && s3Service.isEnabled()) {
                await s3Service.deleteFile(key);
                console.log(`[VerificationService] Deleted old document from S3: ${key}`);
              }
            } catch (err) {
              console.error('[VerificationService] Failed to delete old document from S3:', err);
            }
          }

          // Delete from database
          await prisma.document.delete({
            where: { id: doc.id }
          });
        }
      }

      // Clear old verification result data
      const existingResult = await prisma.verificationResult.findUnique({
        where: { verificationId }
      });

      if (existingResult) {
        console.log('[VerificationService] Clearing old verification result extracted data');
        await prisma.verificationResult.update({
          where: { verificationId },
          data: {
            extractedData: {},
            extractedName: null,
            extractedDob: null,
            extractedAddress: null,
            documentNumber: null,
            issuingCountry: null,
            expiryDate: null,
            flags: [],
            warnings: []
          }
        });
      }

      // Reset verification status to allow re-processing
      await prisma.verification.update({
        where: { id: verificationId },
        data: { status: 'PENDING' }
      });

      console.log('[VerificationService] Old data cleared, ready for new document');
    } else if (documentType) {
      // Not a retry - just delete matching documents of the same type/side
      const existingDocs = verification.documents.filter(doc => {
        // For documents with sides (like driver's license), match type AND side
        if (side) {
          return doc.type === documentType && doc.side === side;
        }
        // For documents without sides (like passport), match just the type
        return doc.type === documentType;
      });

      if (existingDocs.length > 0) {
        console.log(`[VerificationService] Deleting ${existingDocs.length} existing ${documentType}${side ? ` (${side})` : ''} document(s) - keeping only the latest upload`);

        for (const doc of existingDocs) {
          // Delete from S3 if URL exists
          if (doc.originalUrl && doc.originalUrl !== 'not-saved') {
            try {
              const key = s3Service.extractKeyFromUrl(doc.originalUrl);
              if (key && s3Service.isEnabled()) {
                await s3Service.deleteFile(key);
                console.log(`[VerificationService] Deleted old document from S3: ${key}`);
              }
            } catch (err) {
              console.error('[VerificationService] Failed to delete old document from S3:', err);
            }
          }

          // Delete from database
          await prisma.document.delete({
            where: { id: doc.id }
          });
        }

        console.log('[VerificationService] Old documents cleared');
      }
    }

    const preprocessed = await this.documentScanner.preprocessImage(imageBuffer);

    const qualityCheck = await this.documentScanner.checkQuality(preprocessed);

    if (qualityCheck.qualityScore < config.verification.minQualityScore) {
      throw new Error(`Document quality too low: ${qualityCheck.issues.join(', ')}`);
    }

    // Auto-detect document type to validate against user selection
    // Pass user-selected type to prioritize matching processors
    console.log('[VerificationService] Auto-detecting document type...');
    const detectionResult = await this.documentScanner.detectDocumentType(preprocessed, documentType);
    console.log('[VerificationService] Auto-detected document type:', detectionResult.documentType,
      'confidence:', detectionResult.confidence,
      'method:', detectionResult.method);

    // Fail if document type cannot be detected (OTHER type with low confidence or fallback method)
    const isUndetectable = detectionResult.documentType === 'OTHER' ||
                           detectionResult.method === 'fallback' ||
                           detectionResult.confidence < 0.4;

    if (isUndetectable && !documentType) {
      // No user-provided type and we couldn't detect it
      throw new Error('Unable to detect document type. Please ensure you upload a valid government-issued ID document (driver\'s license, passport, national ID, etc.)');
    }

    if (isUndetectable && documentType) {
      // User provided a type but we couldn't confirm it's that type of document
      const typeName = this.getDocumentTypeName(documentType);
      throw new Error(`Unable to verify this is a ${typeName}. Please ensure you upload a clear image of a valid ${typeName}.`);
    }

    let finalDocumentType = detectionResult.documentType;
    let documentTypeCorrected = false;
    let documentTypeCorrectionMessage: string | null = null;

    // If user provided a document type, check if it matches the detected type
    if (documentType) {
      console.log('[VerificationService] User selected document type:', documentType);
      console.log('[VerificationService] Detected document type:', detectionResult.documentType);

      // Check if the detected type matches the user-selected type
      if (detectionResult.documentType !== documentType) {
        // Check if detection is reliable (Document AI or high confidence Vision)
        const isReliableDetection = detectionResult.confidence >= 0.5 &&
          (detectionResult.method === 'document_ai' ||
           (detectionResult.method === 'google_vision' && detectionResult.confidence >= 0.7));

        if (isReliableDetection) {
          // Use Document AI detected type and inform the user
          const userTypeName = this.getDocumentTypeName(documentType);
          const detectedTypeName = this.getDocumentTypeName(detectionResult.documentType);

          documentTypeCorrected = true;
          documentTypeCorrectionMessage = `You selected "${userTypeName}" but we detected this document as "${detectedTypeName}". We will proceed with the detected document type for more accurate verification.`;

          console.log('[VerificationService] Document type corrected:', documentTypeCorrectionMessage);
          finalDocumentType = detectionResult.documentType;
        } else {
          // Low confidence detection - trust user's selection
          console.log('[VerificationService] Detection not reliable (confidence:', detectionResult.confidence,
            ', method:', detectionResult.method, '), using user-selected type:', documentType);
          finalDocumentType = documentType;
        }
      } else {
        finalDocumentType = documentType;
      }
    }

    await this.ocrService.initialize();
    // Pass cached Document AI entities if available to avoid redundant API call
    const extractedData = await this.ocrService.extractDocumentData(
      preprocessed,
      finalDocumentType,
      detectionResult.documentAiEntities
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

    // Validate document ID number format
    // Pass extracted person data for cross-validation (e.g., Ontario DL starts with last name initial)
    const idValidation = documentIdValidator.validateDocumentId(
      extractedData.documentNumber!,
      finalDocumentType,
      extractedData.issuingCountry,
      {
        firstName: extractedData.firstName,
        lastName: extractedData.lastName,
        fullName: extractedData.fullName,
        dateOfBirth: extractedData.dateOfBirth
      }
    );

    console.log('[VerificationService] Document ID validation:', {
      documentNumber: idValidation.normalizedNumber,
      isValid: idValidation.isValid,
      country: idValidation.country,
      state: idValidation.state,
      errors: idValidation.errors,
      warnings: idValidation.warnings
    });

    if (!idValidation.isValid) {
      const typeName = this.getDocumentTypeName(finalDocumentType);
      throw new Error(`Invalid ${typeName} number format: ${idValidation.errors.join('. ')}. Please ensure you uploaded a valid ${typeName}.`);
    }

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
      userSelectedType: documentType || null,
      documentTypeCorrected,
      documentTypeCorrectionMessage,
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
        // Delete old selfie from S3 if it exists and is different from new one
        if (existingSelfie.originalUrl &&
            existingSelfie.originalUrl !== 'not-saved' &&
            existingSelfie.originalUrl !== selfieUrl) {
          try {
            const oldKey = s3Service.extractKeyFromUrl(existingSelfie.originalUrl);
            if (oldKey && s3Service.isEnabled()) {
              await s3Service.deleteFile(oldKey);
              console.log('[VerificationService] Deleted old selfie from S3:', oldKey);
            }
          } catch (err) {
            console.error('[VerificationService] Failed to delete old selfie from S3:', err);
          }
        }

        // Update existing selfie document
        await prisma.document.update({
          where: { id: existingSelfie.id },
          data: {
            originalUrl: selfieUrl,
            qualityScore: biometricData.faceQuality || null,
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

    // Store liveness result in verification metadata
    await prisma.verification.update({
      where: { id: verificationId },
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
                   livenessCheck; // Liveness must pass

    const result: VerificationResult = {
      passed,
      score: documentChecks.averageQuality,
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

    // Use upsert to handle both new and retry scenarios
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
        nameMatch,
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
        }
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

    const expiry = new Date(expiryDate);
    const today = new Date();
    // Set time to start of day for accurate date comparison
    today.setHours(0, 0, 0, 0);
    expiry.setHours(0, 0, 0, 0);

    return expiry < today;
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

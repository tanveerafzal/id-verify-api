import { Request, Response } from 'express';
import { VerificationService } from '../services/verification.service';
import { WebhookService } from '../services/webhook.service';
import { s3Service } from '../services/s3.service';
import { VerificationType, DocumentType, WebhookEvent } from '../types/verification.types';

const verificationService = new VerificationService();
const webhookService = new WebhookService();

export interface PartnerRequest extends Request {
  partnerId?: string;
}

export class VerificationController {
  async createVerification(req: PartnerRequest, res: Response) {
    try {
      const { userId, type, webhookUrl, metadata } = req.body;
      const partnerId = req.partnerId; // Set by middleware if API key provided

      const verification = await verificationService.createVerification(
        userId,
        type as VerificationType,
        webhookUrl,
        metadata,
        partnerId
      );

      if (webhookUrl) {
        await webhookService.sendWebhook(webhookUrl, {
          event: WebhookEvent.VERIFICATION_CREATED,
          verificationId: verification.id,
          status: verification.status,
          timestamp: new Date().toISOString()
        });
      }

      res.status(201).json({
        success: true,
        data: verification
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async uploadDocument(req: Request, res: Response) {
    try {
      const { verificationId } = req.params;
      const { documentType, side } = req.body;

      console.log('Upload document request:', { verificationId, documentType, side, hasFile: !!req.file });
      console.log('[DEBUG] uploadDocument - Checking verification status and retry eligibility...');

      // Check if verification exists and can accept uploads
      const verification = await verificationService.getVerification(verificationId);
      if (!verification) {
        return res.status(404).json({
          success: false,
          error: 'Verification not found'
        });
      }

      // Allow uploads for PENDING, IN_PROGRESS, or FAILED (for retry) statuses
      // Check total retries across the entire verification chain
      const totalRetries = await verificationService.getTotalRetryCount(verificationId);
      const maxRetries = verification.maxRetries;

      console.log('[DEBUG] uploadDocument - Verification found:', {
        id: verification.id,
        status: verification.status,
        totalRetries,
        maxRetries
      });

      if (verification.status === 'COMPLETED') {
        console.log('[DEBUG] uploadDocument - BLOCKED: Verification already completed');
        return res.status(400).json({
          success: false,
          error: 'Verification already completed successfully'
        });
      }

      // Check retry limit BEFORE allowing any upload
      if (verification.status === 'FAILED' && totalRetries >= maxRetries) {
        console.log('[DEBUG] uploadDocument - BLOCKED: Max retries reached', {
          totalRetries,
          maxRetries,
          condition: `${totalRetries} >= ${maxRetries} = ${totalRetries >= maxRetries}`
        });
        return res.status(429).json({
          success: false,
          error: 'Maximum retry limit reached',
          message: 'You have exceeded the maximum number of verification attempts. Please contact the organization that requested this verification to generate a new verification link.',
          retryCount: totalRetries,
          maxRetries
        });
      }

      console.log('[DEBUG] uploadDocument - ALLOWED: Proceeding with upload');

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No file uploaded'
        });
      }

      console.log('Processing document...');

      let imageBuffer: Buffer;
      let documentUrl: string;

      // Check if S3 is enabled
      if (s3Service.isEnabled()) {
        // Use memory storage buffer for S3 upload
        imageBuffer = req.file.buffer;

        // Upload to S3
        console.log('Uploading document to S3...');
        const s3Result = await s3Service.uploadDocument(
          verificationId,
          imageBuffer,
          req.file.originalname,
          documentType || 'document',
          req.file.mimetype
        );
        documentUrl = s3Result.url;
        console.log('Document uploaded to S3:', documentUrl);
      } else {
        // Fallback to local disk storage
        console.log('S3 not configured, using local storage');
        console.log('File saved to:', req.file.path);

        const fs = await import('fs');
        imageBuffer = fs.readFileSync(req.file.path);
        documentUrl = `${process.env.API_URL || 'http://localhost:3002'}/uploads/documents/${verificationId}/${req.file.filename}`;
      }

      // documentType is optional - will be auto-detected if not provided
      const result = await verificationService.processDocument(
        verificationId,
        imageBuffer,
        documentType as DocumentType | undefined,
        side,
        documentUrl
      );

      console.log('Document processed successfully');
      console.log('Document type:', result.documentType);
      console.log('Document URL:', documentUrl);

      const updatedVerification = await verificationService.getVerification(verificationId);

      if (updatedVerification?.webhookUrl) {
        await webhookService.sendWebhook(updatedVerification.webhookUrl, {
          event: WebhookEvent.DOCUMENT_UPLOADED,
          verificationId,
          status: updatedVerification.status,
          timestamp: new Date().toISOString()
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          document: result.document,
          extractedData: result.extractedData,
          quality: result.qualityCheck,
          documentType: result.documentType,
          userSelectedType: result.userSelectedType,
          documentUrl,
          storageType: s3Service.isEnabled() ? 's3' : 'local'
        }
      });
    } catch (error) {
      console.error('Document upload error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  }

  async uploadSelfie(req: Request, res: Response) {
    try {
      const { verificationId } = req.params;

      // Check if verification exists and can accept uploads
      const verification = await verificationService.getVerification(verificationId);
      if (!verification) {
        return res.status(404).json({
          success: false,
          error: 'Verification not found'
        });
      }

      // Check total retries across the entire verification chain
      const totalRetries = await verificationService.getTotalRetryCount(verificationId);
      const maxRetries = verification.maxRetries;

      console.log('[DEBUG] uploadSelfie - Verification found:', {
        id: verification.id,
        status: verification.status,
        totalRetries,
        maxRetries
      });

      // Allow uploads for PENDING, IN_PROGRESS, or FAILED (for retry) statuses
      if (verification.status === 'COMPLETED') {
        return res.status(400).json({
          success: false,
          error: 'Verification already completed successfully'
        });
      }

      // Check retry limit BEFORE allowing any upload
      if (verification.status === 'FAILED' && totalRetries >= maxRetries) {
        console.log('[DEBUG] uploadSelfie - BLOCKED: Max retries reached');
        return res.status(429).json({
          success: false,
          error: 'Maximum retry limit reached',
          message: 'You have exceeded the maximum number of verification attempts. Please contact the organization that requested this verification to generate a new verification link.',
          retryCount: totalRetries,
          maxRetries
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No file uploaded'
        });
      }

      let imageBuffer: Buffer;
      let selfieUrl: string;

      // Check if S3 is enabled
      if (s3Service.isEnabled()) {
        // Use memory storage buffer for S3 upload
        imageBuffer = req.file.buffer;

        // Upload to S3
        console.log('Uploading selfie to S3...');
        const s3Result = await s3Service.uploadSelfie(
          verificationId,
          imageBuffer,
          req.file.originalname,
          req.file.mimetype
        );
        selfieUrl = s3Result.url;
        console.log('Selfie uploaded to S3:', selfieUrl);
      } else {
        // Fallback to local disk storage
        console.log('Selfie saved to:', req.file.path);

        const fs = await import('fs');
        imageBuffer = fs.readFileSync(req.file.path);
        selfieUrl = `${process.env.API_URL || 'http://localhost:3002'}/uploads/documents/${verificationId}/${req.file.filename}`;
      }

      const biometricData = await verificationService.processSelfie(
        verificationId,
        imageBuffer,
        selfieUrl
      );

      return res.status(200).json({
        success: true,
        data: {
          ...biometricData,
          selfieUrl,
          storageType: s3Service.isEnabled() ? 's3' : 'local'
        }
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async submitVerification(req: Request, res: Response) {
    try {
      const { verificationId } = req.params;
      console.log('[DEBUG] submitVerification - Request received for:', verificationId);

      // Check retry limit before processing
      let verification = await verificationService.getVerification(verificationId);

      if (!verification) {
        return res.status(404).json({
          success: false,
          error: 'Verification not found'
        });
      }

      // If this verification is FAILED, find the latest retry verification to use instead
      let activeVerificationId = verificationId;
      if (verification.status === 'FAILED') {
        const latestRetry = await verificationService.getLatestRetryVerification(verificationId);
        console.log('[DEBUG] submitVerification - Looking for retry, found:', latestRetry ? {
          id: latestRetry.id,
          status: latestRetry.status,
          parentVerificationId: latestRetry.parentVerificationId,
          documentsCount: latestRetry.documents?.length || 0
        } : 'none');

        // Use the latest retry if it exists and is not already completed
        if (latestRetry && latestRetry.status !== 'COMPLETED') {
          console.log('[DEBUG] submitVerification - Using retry verification:', latestRetry.id);
          activeVerificationId = latestRetry.id;
          verification = latestRetry;
        }
      }

      console.log('[DEBUG] submitVerification - Verification found:', {
        id: verification!.id,
        status: verification!.status,
        retryCount: verification!.retryCount,
        maxRetries: verification!.maxRetries,
        documentsCount: verification!.documents?.length || 0,
        activeVerificationId
      });

      // Check if verification has already been completed successfully
      if (verification!.status === 'COMPLETED') {
        console.log('[DEBUG] submitVerification - BLOCKED: Already completed');
        return res.status(400).json({
          success: false,
          error: 'Verification already completed successfully',
          message: 'This verification has already passed. No further action is required.'
        });
      }

      // Check retry limit (count all retries in the chain)
      const totalRetries = await verificationService.getTotalRetryCount(verificationId);
      const maxRetries = verification!.maxRetries;
      if (totalRetries >= maxRetries) {
        console.log('[DEBUG] submitVerification - BLOCKED: Max retries reached', {
          totalRetries,
          maxRetries,
          condition: `${totalRetries} >= ${maxRetries} = ${totalRetries >= maxRetries}`
        });
        return res.status(429).json({
          success: false,
          error: 'Maximum retry limit reached',
          message: 'You have exceeded the maximum number of verification attempts. Please contact the organization that requested this verification to generate a new verification link.',
          retryCount: totalRetries,
          maxRetries
        });
      }

      console.log('[DEBUG] submitVerification - ALLOWED: Proceeding with verification');

      const result = await verificationService.performVerification(activeVerificationId);

      // Get updated verification to include retry info
      const updatedVerification = await verificationService.getVerification(verificationId);
      const remainingRetries = updatedVerification
        ? updatedVerification.maxRetries - updatedVerification.retryCount
        : 0;

      // Determine the new status based on the verification result
      const newStatus = result.passed ? 'COMPLETED' : 'FAILED';

      if (verification?.webhookUrl) {
        await webhookService.sendWebhook(verification.webhookUrl, {
          event: WebhookEvent.VERIFICATION_COMPLETED,
          verificationId,
          status: newStatus,
          result,
          timestamp: new Date().toISOString()
        });
      }

      // If verification failed, include retry information
      if (!result.passed) {
        return res.status(200).json({
          success: true,
          data: {
            ...result,
            canRetry: remainingRetries > 0,
            remainingRetries,
            retryCount: updatedVerification?.retryCount || 0,
            maxRetries: updatedVerification?.maxRetries || 5,
            message: remainingRetries > 0
              ? `Verification failed. You have ${remainingRetries} attempt(s) remaining. Please re-upload your documents and try again.`
              : 'Verification failed. Maximum retry limit reached. Please contact the organization that requested this verification.'
          }
        });
      }

      return res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async getVerification(req: Request, res: Response) {
    try {
      const { verificationId } = req.params;

      let verification = await verificationService.getVerification(verificationId);

      if (!verification) {
        return res.status(404).json({
          success: false,
          error: 'Verification not found'
        });
      }

      // If this verification is FAILED, check for active retry and return that instead
      let activeRetryId: string | null = null;
      if (verification.status === 'FAILED') {
        const latestRetry = await verificationService.getLatestRetryVerification(verificationId);
        if (latestRetry && latestRetry.status !== 'COMPLETED') {
          console.log('[VerificationController] Returning active retry verification:', latestRetry.id);
          activeRetryId = latestRetry.id;
          verification = latestRetry;
        }
      }

      // Calculate retry info based on total retries in the chain
      const totalRetries = await verificationService.getTotalRetryCount(verificationId);
      const maxRetries = verification.maxRetries;
      const remainingRetries = maxRetries - totalRetries;
      const canRetry = verification.status === 'FAILED' && remainingRetries > 0;

      // Determine if this is a fresh retry attempt (user is starting over)
      // vs. a completed verification (show results)
      const isActiveRetry = activeRetryId !== null;
      const isFreshStart = canRetry && (verification.status === 'PENDING' || verification.status === 'IN_PROGRESS');

      // Only show errors/results when:
      // 1. Verification is COMPLETED (passed)
      // 2. Verification is FAILED and cannot retry (max retries reached)
      // 3. The current verification (not retry) just failed
      const showErrors = verification.status === 'COMPLETED' ||
                         (verification.status === 'FAILED' && !canRetry) ||
                         (verification.status === 'FAILED' && !isActiveRetry && verification.results !== null);

      // If user can retry and is on a fresh attempt, clear old results
      const resultsToReturn = (canRetry && (isFreshStart || isActiveRetry)) ? null : verification.results;

      return res.status(200).json({
        success: true,
        data: {
          ...verification,
          results: resultsToReturn,
          originalVerificationId: activeRetryId ? verificationId : null,
          canRetry,
          remainingRetries,
          retryCount: totalRetries,
          isRetryInProgress: isActiveRetry || isFreshStart,
          showErrors,
          retryMessage: canRetry
            ? `You have ${remainingRetries} attempt(s) remaining. Please re-upload your documents and try again.`
            : verification.status === 'FAILED'
              ? 'Maximum retry limit reached. Please contact the organization that requested this verification.'
              : null
        }
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async compareFaces(req: Request, res: Response) {
    try {
      const { verificationId } = req.params;

      if (!req.files || !Array.isArray(req.files) || req.files.length !== 2) {
        return res.status(400).json({
          success: false,
          error: 'Two images required: document photo and selfie'
        });
      }

      const [documentImage, selfieImage] = req.files as Express.Multer.File[];

      const result = await verificationService.comparefaces(
        verificationId,
        documentImage.buffer,
        selfieImage.buffer
      );

      return res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}

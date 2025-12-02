import { Request, Response } from 'express';
import { VerificationService } from '../services/verification.service';
import { WebhookService } from '../services/webhook.service';
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

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No file uploaded'
        });
      }

      console.log('Processing document...');
      const result = await verificationService.processDocument(
        verificationId,
        req.file.buffer,
        documentType as DocumentType,
        side
      );

      console.log('Document processed successfully');

      const verification = await verificationService.getVerification(verificationId);

      if (verification?.webhookUrl) {
        await webhookService.sendWebhook(verification.webhookUrl, {
          event: WebhookEvent.DOCUMENT_UPLOADED,
          verificationId,
          status: verification.status,
          timestamp: new Date().toISOString()
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          document: result.document,
          extractedData: result.extractedData,
          quality: result.qualityCheck
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

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No file uploaded'
        });
      }

      const biometricData = await verificationService.processSelfie(
        verificationId,
        req.file.buffer
      );

      return res.status(200).json({
        success: true,
        data: biometricData
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

      const result = await verificationService.performVerification(verificationId);

      const verification = await verificationService.getVerification(verificationId);

      if (verification?.webhookUrl) {
        await webhookService.sendWebhook(verification.webhookUrl, {
          event: WebhookEvent.VERIFICATION_COMPLETED,
          verificationId,
          status: verification.status,
          result,
          timestamp: new Date().toISOString()
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

      const verification = await verificationService.getVerification(verificationId);

      if (!verification) {
        return res.status(404).json({
          success: false,
          error: 'Verification not found'
        });
      }

      return res.status(200).json({
        success: true,
        data: verification
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

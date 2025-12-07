import { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { PartnerService } from '../services/partner.service';
import { logger } from '../utils/logger';

const partnerService = new PartnerService();

// Multer configuration for logo uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads/logos');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `partner-logo-${uniqueSuffix}${ext}`);
  }
});

const fileFilter = (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  // Accept images only
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed'));
  }
};

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB max file size
  }
});

export interface AuthRequest extends Request {
  partner?: {
    id: string;
    email: string;
    companyName: string;
  };
}

export class PartnerController {
  async register(req: Request, res: Response) {
    try {
      const { email, password, companyName, contactName, phone } = req.body;

      if (!email || !password || !companyName || !contactName) {
        return res.status(400).json({
          success: false,
          error: 'Email, password, company name, and contact name are required'
        });
      }

      const result = await partnerService.registerPartner({
        email,
        password,
        companyName,
        contactName,
        phone
      });

      logger.info(`New partner registered: ${email}`);

      return res.status(201).json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('Partner registration error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Registration failed'
      });
    }
  }

  async login(req: Request, res: Response) {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({
          success: false,
          error: 'Email and password are required'
        });
      }

      const result = await partnerService.loginPartner(email, password);

      if (!result) {
        return res.status(401).json({
          success: false,
          error: 'Invalid email or password'
        });
      }

      logger.info(`Partner logged in: ${email}`);

      return res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('Partner login error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Login failed'
      });
    }
  }

  async forgotPassword(req: Request, res: Response) {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          error: 'Email is required'
        });
      }

      const result = await partnerService.forgotPassword(email);

      logger.info(`Password reset requested for: ${email}`);

      return res.status(200).json({
        success: true,
        message: result.message
      });
    } catch (error) {
      logger.error('Forgot password error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to process request'
      });
    }
  }

  async resetPassword(req: Request, res: Response) {
    try {
      const { token, password } = req.body;

      if (!token || !password) {
        return res.status(400).json({
          success: false,
          error: 'Token and new password are required'
        });
      }

      if (password.length < 8) {
        return res.status(400).json({
          success: false,
          error: 'Password must be at least 8 characters long'
        });
      }

      const result = await partnerService.resetPassword(token, password);

      logger.info('Password reset successful');

      return res.status(200).json({
        success: true,
        message: result.message
      });
    } catch (error) {
      logger.error('Reset password error:', error);
      return res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to reset password'
      });
    }
  }

  async getProfile(req: AuthRequest, res: Response) {
    try {
      if (!req.partner) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const partner = await partnerService.getPartnerProfile(req.partner.id);

      if (!partner) {
        return res.status(404).json({
          success: false,
          error: 'Partner not found'
        });
      }

      return res.status(200).json({
        success: true,
        data: partner
      });
    } catch (error) {
      logger.error('Get partner profile error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get profile'
      });
    }
  }

  async updateProfile(req: AuthRequest, res: Response): Promise<Response> {
    try {
      if (!req.partner) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const { companyName, contactName, phone, logoUrl, website, address } = req.body;

      const updatedPartner = await partnerService.updatePartnerProfile(req.partner.id, {
        companyName,
        contactName,
        phone,
        logoUrl,
        website,
        address
      });

      return res.status(200).json({
        success: true,
        data: updatedPartner
      });
    } catch (error) {
      logger.error('Update partner profile error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update profile'
      });
    }
  }

  async upgradeTier(req: AuthRequest, res: Response) {
    try {
      if (!req.partner) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const { tierName } = req.body;

      if (!tierName) {
        return res.status(400).json({
          success: false,
          error: 'Tier name is required'
        });
      }

      const result = await partnerService.upgradeTier(req.partner.id, tierName);

      logger.info(`Partner ${req.partner.email} upgraded to ${tierName}`);

      return res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('Tier upgrade error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upgrade failed'
      });
    }
  }

  async getUsageStats(req: AuthRequest, res: Response) {
    try {
      if (!req.partner) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const stats = await partnerService.getUsageStats(req.partner.id);

      return res.status(200).json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error('Get usage stats error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get stats'
      });
    }
  }

  async getTiers(_req: Request, res: Response): Promise<Response> {
    try {
      const tiers = await partnerService.getAllTiers();

      return res.status(200).json({
        success: true,
        data: tiers
      });
    } catch (error) {
      logger.error('Get tiers error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get tiers'
      });
    }
  }

  async getVerifications(req: AuthRequest, res: Response) {
    try {
      if (!req.partner) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const verifications = await partnerService.getPartnerVerifications(req.partner.id);

      return res.status(200).json({
        success: true,
        data: verifications
      });
    } catch (error) {
      logger.error('Get verifications error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get verifications'
      });
    }
  }

  async getVerificationById(req: AuthRequest, res: Response) {
    try {
      if (!req.partner) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const { verificationId } = req.params;

      if (!verificationId) {
        return res.status(400).json({
          success: false,
          error: 'Verification ID is required'
        });
      }

      const verification = await partnerService.getPartnerVerificationById(req.partner.id, verificationId);

      return res.status(200).json({
        success: true,
        data: verification
      });
    } catch (error) {
      logger.error('Get verification by ID error:', error);

      if (error instanceof Error && error.message.includes('not found')) {
        return res.status(404).json({
          success: false,
          error: error.message
        });
      }

      if (error instanceof Error && error.message.includes('Unauthorized')) {
        return res.status(403).json({
          success: false,
          error: error.message
        });
      }

      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get verification'
      });
    }
  }

  async requestVerification(req: AuthRequest, res: Response): Promise<Response> {
    try {
      logger.info('[PartnerController] Request verification called');
      logger.info('[PartnerController] req.partner:', req.partner);

      if (!req.partner) {
        logger.error('[PartnerController] No partner in request');
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      logger.info(`[PartnerController] Partner ID: ${req.partner.id}`);

      const { userName, userEmail, userPhone, type, webhookUrl } = req.body;
      logger.info('[PartnerController] Request body:', { userName, userEmail, userPhone, type });

      if (!userName || !userEmail) {
        return res.status(400).json({
          success: false,
          error: 'User name and email are required'
        });
      }

      const verification = await partnerService.requestVerification(req.partner.id, {
        userName,
        userEmail,
        userPhone,
        type: type || 'IDENTITY',
        webhookUrl
      });

      logger.info(`Partner ${req.partner.email} requested verification for ${userEmail}`);

      return res.status(201).json({
        success: true,
        data: verification
      });
    } catch (error) {
      logger.error('Request verification error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to request verification'
      });
    }
  }

  async resendVerificationEmail(req: AuthRequest, res: Response): Promise<Response> {
    try {
      if (!req.partner) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const { verificationId } = req.params;

      if (!verificationId) {
        return res.status(400).json({
          success: false,
          error: 'Verification ID is required'
        });
      }

      await partnerService.resendVerificationEmail(req.partner.id, verificationId);

      logger.info(`Partner ${req.partner.email} resent email for verification ${verificationId}`);

      return res.status(200).json({
        success: true,
        message: 'Verification email sent successfully'
      });
    } catch (error) {
      logger.error('Resend verification email error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to resend email'
      });
    }
  }

  async getPublicPartnerInfo(req: Request, res: Response): Promise<Response> {
    try {
      const { partnerId } = req.params;

      const partner = await partnerService.getPublicPartnerInfo(partnerId);

      if (!partner) {
        return res.status(404).json({
          success: false,
          error: 'Partner not found'
        });
      }

      return res.status(200).json({
        success: true,
        data: partner
      });
    } catch (error) {
      logger.error('Get public partner info error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get partner info'
      });
    }
  }

  async uploadLogo(req: AuthRequest, res: Response): Promise<Response> {
    try {
      if (!req.partner) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No file uploaded'
        });
      }

      // Generate logo URL
      const logoUrl = `${process.env.API_URL || 'http://localhost:3002'}/uploads/logos/${req.file.filename}`;

      // Update partner with new logo URL
      const updatedPartner = await partnerService.updatePartnerProfile(req.partner.id, {
        logoUrl
      });

      logger.info(`Partner ${req.partner.email} uploaded logo: ${logoUrl}`);

      return res.status(200).json({
        success: true,
        data: {
          logoUrl: updatedPartner.logoUrl
        }
      });
    } catch (error) {
      logger.error('Logo upload error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to upload logo'
      });
    }
  }
}

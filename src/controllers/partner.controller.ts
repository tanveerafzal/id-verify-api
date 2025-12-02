import { Request, Response } from 'express';
import { PartnerService } from '../services/partner.service';
import { logger } from '../utils/logger';

const partnerService = new PartnerService();

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

  async getTiers(req: Request, res: Response): Promise<Response> {
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
}

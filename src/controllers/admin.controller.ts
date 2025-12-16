import { Request, Response } from 'express';
import { AdminService } from '../services/admin.service';
import { AdminRequest } from '../middleware/admin-auth.middleware';
import { logger } from '../utils/logger';

const adminService = new AdminService();

export class AdminController {
  // Authentication
  async login(req: Request, res: Response) {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({
          success: false,
          error: 'Email and password are required'
        });
      }

      const result = await adminService.loginAdmin(email, password);

      if (!result) {
        return res.status(401).json({
          success: false,
          error: 'Invalid email or password'
        });
      }

      logger.info(`[AdminController] Admin logged in: ${email}`);

      return res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('[AdminController] Login error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Login failed'
      });
    }
  }

  async register(req: Request, res: Response) {
    try {
      const { email, password, name, role } = req.body;

      if (!email || !password || !name) {
        return res.status(400).json({
          success: false,
          error: 'Email, password, and name are required'
        });
      }

      const result = await adminService.registerAdmin({ email, password, name, role });

      logger.info(`[AdminController] Admin registered: ${email}`);

      return res.status(201).json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('[AdminController] Registration error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Registration failed'
      });
    }
  }

  // Profile
  async getProfile(req: AdminRequest, res: Response) {
    try {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const profile = await adminService.getAdminProfile(req.admin.id);

      if (!profile) {
        return res.status(404).json({
          success: false,
          error: 'Admin not found'
        });
      }

      return res.status(200).json({
        success: true,
        data: profile
      });
    } catch (error) {
      logger.error('[AdminController] Get profile error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get profile'
      });
    }
  }

  async updateProfile(req: AdminRequest, res: Response) {
    try {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const { name, email } = req.body;

      const profile = await adminService.updateAdminProfile(req.admin.id, { name, email });

      return res.status(200).json({
        success: true,
        data: profile
      });
    } catch (error) {
      logger.error('[AdminController] Update profile error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update profile'
      });
    }
  }

  async changePassword(req: AdminRequest, res: Response) {
    try {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const { currentPassword, newPassword } = req.body;

      if (!currentPassword || !newPassword) {
        return res.status(400).json({
          success: false,
          error: 'Current password and new password are required'
        });
      }

      if (newPassword.length < 8) {
        return res.status(400).json({
          success: false,
          error: 'New password must be at least 8 characters'
        });
      }

      await adminService.changeAdminPassword(req.admin.id, currentPassword, newPassword);

      return res.status(200).json({
        success: true,
        data: { message: 'Password changed successfully' }
      });
    } catch (error) {
      logger.error('[AdminController] Change password error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to change password'
      });
    }
  }

  // Dashboard
  async getDashboardStats(req: AdminRequest, res: Response) {
    try {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const stats = await adminService.getDashboardStats();

      return res.status(200).json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error('[AdminController] Get dashboard stats error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get dashboard stats'
      });
    }
  }

  // Partner Management
  async getPartners(req: AdminRequest, res: Response) {
    try {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const { limit, offset, sort, order, search, tier } = req.query;

      const result = await adminService.getAllPartners({
        limit: limit ? parseInt(limit as string) : undefined,
        offset: offset ? parseInt(offset as string) : undefined,
        sort: sort as string,
        order: order as 'asc' | 'desc',
        search: search as string,
        tierName: tier as string
      });

      return res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('[AdminController] Get partners error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get partners'
      });
    }
  }

  async getPartnerById(req: AdminRequest, res: Response) {
    try {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const { id } = req.params;

      const partner = await adminService.getPartnerById(id);

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
      logger.error('[AdminController] Get partner by ID error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get partner'
      });
    }
  }

  async createPartner(req: AdminRequest, res: Response) {
    try {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const { email, password, companyName, contactName, phone, website, tierName } = req.body;

      if (!email || !password || !companyName || !contactName) {
        return res.status(400).json({
          success: false,
          error: 'Email, password, company name, and contact name are required'
        });
      }

      const partner = await adminService.createPartner({
        email,
        password,
        companyName,
        contactName,
        phone,
        website,
        tierName
      });

      return res.status(201).json({
        success: true,
        data: partner
      });
    } catch (error) {
      logger.error('[AdminController] Create partner error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create partner'
      });
    }
  }

  async updatePartner(req: AdminRequest, res: Response) {
    try {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const { id } = req.params;
      const updateData = req.body;

      const partner = await adminService.updatePartner(id, updateData);

      return res.status(200).json({
        success: true,
        data: partner
      });
    } catch (error) {
      logger.error('[AdminController] Update partner error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update partner'
      });
    }
  }

  async togglePartnerActive(req: AdminRequest, res: Response) {
    try {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const { id } = req.params;

      const result = await adminService.togglePartnerActive(id);

      return res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('[AdminController] Toggle partner active error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to toggle partner status'
      });
    }
  }

  async resetPartnerApiKey(req: AdminRequest, res: Response) {
    try {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const { id } = req.params;

      const result = await adminService.resetPartnerApiKey(id);

      return res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('[AdminController] Reset API key error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to reset API key'
      });
    }
  }

  async deletePartner(req: AdminRequest, res: Response) {
    try {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const { id } = req.params;

      await adminService.deletePartner(id);

      return res.status(200).json({
        success: true,
        data: { message: 'Partner deleted successfully' }
      });
    } catch (error) {
      logger.error('[AdminController] Delete partner error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete partner'
      });
    }
  }

  // Verification Management
  async getVerifications(req: AdminRequest, res: Response) {
    try {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const { limit, offset, sort, order, status, partnerId } = req.query;

      const result = await adminService.getAllVerifications({
        limit: limit ? parseInt(limit as string) : undefined,
        offset: offset ? parseInt(offset as string) : undefined,
        sort: sort as string,
        order: order as 'asc' | 'desc',
        status: status as string,
        partnerId: partnerId as string
      });

      return res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('[AdminController] Get verifications error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get verifications'
      });
    }
  }

  async getVerificationById(req: AdminRequest, res: Response) {
    try {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const { id } = req.params;

      const verification = await adminService.getVerificationById(id);

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
      logger.error('[AdminController] Get verification by ID error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get verification'
      });
    }
  }

  async manualPassVerification(req: AdminRequest, res: Response) {
    try {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const { id } = req.params;

      const result = await adminService.manualPassVerification(id, req.admin.id);

      logger.info(`[AdminController] Verification ${id} manually passed by admin ${req.admin.email}`);

      return res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('[AdminController] Manual pass verification error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to pass verification'
      });
    }
  }

  async manualFailVerification(req: AdminRequest, res: Response) {
    try {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const { id } = req.params;
      const { reason } = req.body;

      if (!reason) {
        return res.status(400).json({
          success: false,
          error: 'Reason is required for manual rejection'
        });
      }

      const result = await adminService.manualFailVerification(id, req.admin.id, reason);

      logger.info(`[AdminController] Verification ${id} manually failed by admin ${req.admin.email}: ${reason}`);

      return res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('[AdminController] Manual fail verification error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to reject verification'
      });
    }
  }

  async resendVerificationEmail(req: AdminRequest, res: Response) {
    try {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const { id } = req.params;

      const result = await adminService.resendVerificationEmail(id, req.admin.id);

      logger.info(`[AdminController] Admin ${req.admin.email} resent verification email for ${id}`);

      return res.status(200).json({
        success: true,
        message: 'Verification email sent successfully',
        data: result
      });
    } catch (error) {
      logger.error('[AdminController] Resend verification email error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to resend email'
      });
    }
  }

  async updateVerificationDetails(req: AdminRequest, res: Response) {
    try {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          error: 'Not authenticated'
        });
      }

      const { id } = req.params;
      const { fullName, email, phone } = req.body;

      // Validate that at least one field is provided
      if (!fullName && !email && !phone) {
        return res.status(400).json({
          success: false,
          error: 'At least one field (fullName, email, or phone) must be provided'
        });
      }

      const result = await adminService.updateVerificationDetails(id, req.admin.id, {
        fullName,
        email,
        phone
      });

      logger.info(`[AdminController] Admin ${req.admin.email} updated verification ${id} details`);

      return res.status(200).json({
        success: true,
        message: 'Verification details updated successfully',
        data: result
      });
    } catch (error) {
      logger.error('[AdminController] Update verification details error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update verification details'
      });
    }
  }
}

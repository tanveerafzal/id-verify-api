import { Request, Response } from 'express';
import { TeamService } from '../services/team.service';
import { logger } from '../utils/logger';

const teamService = new TeamService();

export interface AuthRequest extends Request {
  partner?: {
    id: string;
    email: string;
    companyName: string;
  };
  partnerUser?: {
    id: string;
  };
}

export class TeamController {
  async getTeamMembers(req: AuthRequest, res: Response) {
    try {
      if (!req.partner) {
        return res.status(401).json({ success: false, error: 'Not authenticated' });
      }

      const members = await teamService.getTeamMembers(req.partner.id);
      const invitations = await teamService.getPendingInvitations(req.partner.id);

      return res.status(200).json({
        success: true,
        data: { members, invitations },
      });
    } catch (error) {
      logger.error('Get team members error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get team members',
      });
    }
  }

  async sendInvitation(req: AuthRequest, res: Response) {
    try {
      if (!req.partner) {
        return res.status(401).json({ success: false, error: 'Not authenticated' });
      }

      const { email, name, roleId } = req.body;

      if (!email || !name || !roleId) {
        return res.status(400).json({
          success: false,
          error: 'Email, name, and role are required',
        });
      }

      // Get current user ID from the decoded token
      const currentUserId = req.partnerUser?.id || req.partner.id;

      const invitation = await teamService.sendInvitation(req.partner.id, currentUserId, {
        email,
        name,
        roleId,
      });

      return res.status(201).json({
        success: true,
        data: invitation,
        message: 'Invitation sent successfully',
      });
    } catch (error) {
      logger.error('Send invitation error:', error);
      return res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to send invitation',
      });
    }
  }

  async resendInvitation(req: AuthRequest, res: Response) {
    try {
      if (!req.partner) {
        return res.status(401).json({ success: false, error: 'Not authenticated' });
      }

      const { invitationId } = req.params;

      const result = await teamService.resendInvitation(req.partner.id, invitationId);

      return res.status(200).json({
        success: true,
        message: result.message,
      });
    } catch (error) {
      logger.error('Resend invitation error:', error);
      return res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to resend invitation',
      });
    }
  }

  async cancelInvitation(req: AuthRequest, res: Response) {
    try {
      if (!req.partner) {
        return res.status(401).json({ success: false, error: 'Not authenticated' });
      }

      const { invitationId } = req.params;

      await teamService.cancelInvitation(req.partner.id, invitationId);

      return res.status(200).json({
        success: true,
        message: 'Invitation cancelled',
      });
    } catch (error) {
      logger.error('Cancel invitation error:', error);
      return res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to cancel invitation',
      });
    }
  }

  async toggleUserStatus(req: AuthRequest, res: Response) {
    try {
      if (!req.partner) {
        return res.status(401).json({ success: false, error: 'Not authenticated' });
      }

      const { userId } = req.params;
      const currentUserId = req.partnerUser?.id || '';

      const result = await teamService.toggleUserStatus(req.partner.id, userId, currentUserId);

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('Toggle user status error:', error);
      return res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update user status',
      });
    }
  }

  async updateUserRole(req: AuthRequest, res: Response) {
    try {
      if (!req.partner) {
        return res.status(401).json({ success: false, error: 'Not authenticated' });
      }

      const { userId } = req.params;
      const { roleId } = req.body;
      const currentUserId = req.partnerUser?.id || '';

      if (!roleId) {
        return res.status(400).json({
          success: false,
          error: 'Role ID is required',
        });
      }

      const result = await teamService.updateUserRole(
        req.partner.id,
        userId,
        roleId,
        currentUserId
      );

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('Update user role error:', error);
      return res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update user role',
      });
    }
  }

  async getRoles(_req: AuthRequest, res: Response) {
    try {
      const roles = await teamService.getRoles();

      return res.status(200).json({
        success: true,
        data: roles,
      });
    } catch (error) {
      logger.error('Get roles error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to get roles',
      });
    }
  }

  // Public endpoint for accepting invitations
  async getInvitationInfo(req: Request, res: Response) {
    try {
      const { token } = req.params;

      const invitation = await teamService.getInvitationByToken(token);

      if (!invitation) {
        return res.status(404).json({
          success: false,
          error: 'Invalid or expired invitation',
        });
      }

      return res.status(200).json({
        success: true,
        data: invitation,
      });
    } catch (error) {
      logger.error('Get invitation info error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to get invitation info',
      });
    }
  }

  async acceptInvitation(req: Request, res: Response) {
    try {
      const { token, password } = req.body;

      if (!token || !password) {
        return res.status(400).json({
          success: false,
          error: 'Token and password are required',
        });
      }

      if (password.length < 8) {
        return res.status(400).json({
          success: false,
          error: 'Password must be at least 8 characters',
        });
      }

      const result = await teamService.acceptInvitation(token, password);

      return res.status(200).json({
        success: true,
        data: result,
        message: 'Invitation accepted. You can now log in.',
      });
    } catch (error) {
      logger.error('Accept invitation error:', error);
      return res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to accept invitation',
      });
    }
  }
}

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { config } from '../config';
import { EmailService } from './email.service';
import { logger } from '../utils/logger';
import { Permission } from '../types/permissions';

const prisma = new PrismaClient();
const emailService = new EmailService();

export class TeamService {
  // Get all team members for a partner
  async getTeamMembers(partnerId: string) {
    const members = await prisma.partnerUser.findMany({
      where: { partnerId },
      include: {
        role: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return members.map((member) => ({
      id: member.id,
      email: member.email,
      name: member.name,
      role: {
        id: member.role.id,
        name: member.role.name,
        description: member.role.description,
      },
      status: member.status,
      lastLogin: member.lastLogin,
      invitedAt: member.invitedAt,
      createdAt: member.createdAt,
    }));
  }

  // Get pending invitations
  async getPendingInvitations(partnerId: string) {
    const invitations = await prisma.partnerInvitation.findMany({
      where: {
        partnerId,
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
      include: {
        role: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return invitations.map((inv) => ({
      id: inv.id,
      email: inv.email,
      name: inv.name,
      role: {
        id: inv.role.id,
        name: inv.role.name,
      },
      status: inv.status,
      expiresAt: inv.expiresAt,
      createdAt: inv.createdAt,
    }));
  }

  // Send invitation
  async sendInvitation(
    partnerId: string,
    invitedBy: string,
    data: {
      email: string;
      name: string;
      roleId: string;
    }
  ) {
    // Check if user already exists
    const existingUser = await prisma.partnerUser.findFirst({
      where: {
        partnerId,
        email: data.email,
      },
    });

    if (existingUser) {
      throw new Error('A user with this email already exists in your team');
    }

    // Check for pending invitation
    const existingInvite = await prisma.partnerInvitation.findFirst({
      where: {
        partnerId,
        email: data.email,
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
    });

    if (existingInvite) {
      throw new Error('An invitation is already pending for this email');
    }

    // Verify role exists
    const role = await prisma.role.findUnique({
      where: { id: data.roleId },
    });

    if (!role) {
      throw new Error('Invalid role specified');
    }

    // Get partner info for email
    const partner = await prisma.partner.findUnique({
      where: { id: partnerId },
    });

    // Generate invitation token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    // Create invitation
    const invitation = await prisma.partnerInvitation.create({
      data: {
        partnerId,
        roleId: data.roleId,
        email: data.email,
        name: data.name,
        token,
        expiresAt,
        invitedBy,
      },
      include: { role: true },
    });

    // Send invitation email
    const inviteLink = `${config.server.frontendUrl}/partner/accept-invite?token=${token}`;
    await emailService.sendTeamInvitationEmail(
      data.email,
      data.name,
      partner?.companyName || 'ID Verify Partner',
      inviteLink,
      role.name
    );

    logger.info(
      `[TeamService] Invitation sent to ${data.email} for partner ${partnerId}`
    );

    return {
      id: invitation.id,
      email: invitation.email,
      name: invitation.name,
      role: {
        id: invitation.role.id,
        name: invitation.role.name,
      },
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
    };
  }

  // Resend invitation
  async resendInvitation(partnerId: string, invitationId: string) {
    const invitation = await prisma.partnerInvitation.findFirst({
      where: {
        id: invitationId,
        partnerId,
        status: 'pending',
      },
      include: { role: true },
    });

    if (!invitation) {
      throw new Error('Invitation not found or already accepted');
    }

    // Generate new token and extend expiry
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.partnerInvitation.update({
      where: { id: invitationId },
      data: { token, expiresAt, updatedAt: new Date() },
    });

    // Get partner info
    const partner = await prisma.partner.findUnique({
      where: { id: partnerId },
    });

    // Resend email
    const inviteLink = `${config.server.frontendUrl}/partner/accept-invite?token=${token}`;
    await emailService.sendTeamInvitationEmail(
      invitation.email,
      invitation.name,
      partner?.companyName || 'ID Verify Partner',
      inviteLink,
      invitation.role.name
    );

    logger.info(`[TeamService] Invitation resent to ${invitation.email}`);

    return { success: true, message: 'Invitation resent successfully' };
  }

  // Cancel invitation
  async cancelInvitation(partnerId: string, invitationId: string) {
    const invitation = await prisma.partnerInvitation.findFirst({
      where: {
        id: invitationId,
        partnerId,
        status: 'pending',
      },
    });

    if (!invitation) {
      throw new Error('Invitation not found');
    }

    await prisma.partnerInvitation.update({
      where: { id: invitationId },
      data: { status: 'cancelled' },
    });

    return { success: true };
  }

  // Accept invitation (called when user registers via invite link)
  async acceptInvitation(token: string, password: string) {
    const invitation = await prisma.partnerInvitation.findFirst({
      where: {
        token,
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
      include: { partner: true, role: true },
    });

    if (!invitation) {
      throw new Error('Invalid or expired invitation');
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Create the partner user
    const partnerUser = await prisma.partnerUser.create({
      data: {
        partnerId: invitation.partnerId,
        roleId: invitation.roleId,
        email: invitation.email,
        name: invitation.name,
        password: hashedPassword,
        status: 'active',
        invitedBy: invitation.invitedBy,
        invitedAt: invitation.createdAt,
      },
    });

    // Mark invitation as accepted
    await prisma.partnerInvitation.update({
      where: { id: invitation.id },
      data: { status: 'accepted' },
    });

    logger.info(`[TeamService] Invitation accepted by ${invitation.email}`);

    return {
      success: true,
      partnerUser: {
        id: partnerUser.id,
        email: partnerUser.email,
        name: partnerUser.name,
      },
      partner: {
        id: invitation.partner.id,
        companyName: invitation.partner.companyName,
      },
    };
  }

  // Toggle user status (activate/deactivate)
  async toggleUserStatus(
    partnerId: string,
    userId: string,
    currentUserId: string
  ) {
    if (userId === currentUserId) {
      throw new Error('You cannot deactivate your own account');
    }

    const user = await prisma.partnerUser.findFirst({
      where: { id: userId, partnerId },
    });

    if (!user) {
      throw new Error('User not found');
    }

    const newStatus = user.status === 'active' ? 'inactive' : 'active';

    const updated = await prisma.partnerUser.update({
      where: { id: userId },
      data: { status: newStatus },
    });

    logger.info(`[TeamService] User ${userId} status changed to ${newStatus}`);

    return {
      success: true,
      status: updated.status,
      message: `User ${
        newStatus === 'active' ? 'activated' : 'deactivated'
      } successfully`,
    };
  }

  // Update user role
  async updateUserRole(
    partnerId: string,
    userId: string,
    roleId: string,
    currentUserId: string
  ) {
    if (userId === currentUserId) {
      throw new Error('You cannot change your own role');
    }

    const user = await prisma.partnerUser.findFirst({
      where: { id: userId, partnerId },
    });

    if (!user) {
      throw new Error('User not found');
    }

    const role = await prisma.role.findUnique({
      where: { id: roleId },
    });

    if (!role) {
      throw new Error('Invalid role');
    }

    const updated = await prisma.partnerUser.update({
      where: { id: userId },
      data: { roleId },
      include: { role: true },
    });

    return {
      success: true,
      user: {
        id: updated.id,
        role: {
          id: updated.role.id,
          name: updated.role.name,
        },
      },
    };
  }

  // Get available roles
  async getRoles() {
    const roles = await prisma.role.findMany({
      orderBy: { name: 'asc' },
    });

    return roles.map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      permissions: role.permissions,
    }));
  }

  // Check if user has permission
  async hasPermission(userId: string, permission: Permission): Promise<boolean> {
    const user = await prisma.partnerUser.findUnique({
      where: { id: userId },
      include: { role: true },
    });

    if (!user) return false;

    let permissions: string[] = [];
    try {
      const perms = user.role.permissions;
      if (typeof perms === 'string') {
        permissions = JSON.parse(perms);
      } else if (Array.isArray(perms)) {
        permissions = perms as string[];
      }
    } catch {
      permissions = [];
    }

    return permissions.includes('all') || permissions.includes(permission);
  }

  // Get invitation by token (for accept-invite page)
  async getInvitationByToken(token: string) {
    const invitation = await prisma.partnerInvitation.findFirst({
      where: {
        token,
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
      include: {
        partner: {
          select: { companyName: true, logoUrl: true },
        },
        role: {
          select: { name: true, description: true },
        },
      },
    });

    if (!invitation) {
      return null;
    }

    return {
      email: invitation.email,
      name: invitation.name,
      partner: invitation.partner,
      role: invitation.role,
    };
  }
}

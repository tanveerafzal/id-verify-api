import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config';
import { EmailService } from './email.service';
import { s3Service } from './s3.service';
import { logger } from '../utils/logger';
import { generateVerificationLink } from '../utils/crypto';

const prisma = new PrismaClient();
const emailService = new EmailService();

interface RegisterPartnerData {
  email: string;
  password: string;
  companyName: string;
  contactName: string;
  phone?: string;
}

export class PartnerService {
  async registerPartner(data: RegisterPartnerData) {
    // Normalize email to lowercase for case-insensitive storage
    const normalizedEmail = data.email.toLowerCase().trim();

    // Check if user with this email already exists
    const existingUser = await prisma.partnerUser.findUnique({
      where: { email: normalizedEmail }
    });

    if (existingUser) {
      throw new Error('Partner with this email already exists');
    }

    // Get Free tier
    let freeTier = await prisma.tier.findUnique({
      where: { name: 'free' }
    });

    // Create Free tier if it doesn't exist
    if (!freeTier) {
      freeTier = await this.initializeTiers();
    }

    // Get or create admin role
    let adminRole = await prisma.role.findUnique({
      where: { name: 'admin' }
    });

    if (!adminRole) {
      adminRole = await prisma.role.create({
        data: {
          name: 'admin',
          permissions: JSON.stringify(['all'])
        }
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(data.password, 10);

    // Create partner first
    const partner = await prisma.partner.create({
      data: {
        companyName: data.companyName,
        contactName: data.contactName,
        phone: data.phone,
        tierId: freeTier.id
      },
      include: {
        tier: true
      }
    });

    // Create partner user for authentication
    const partnerUser = await prisma.partnerUser.create({
      data: {
        partnerId: partner.id,
        roleId: adminRole.id,
        email: normalizedEmail,
        name: data.contactName,
        password: hashedPassword
      }
    });

    // Generate JWT token
    const token = this.generateToken({
      id: partner.id,
      odoo: partnerUser.id,
      email: partnerUser.email,
      companyName: partner.companyName
    });

    return {
      partner: {
        id: partner.id,
        email: partnerUser.email,
        companyName: partner.companyName,
        contactName: partner.contactName,
        phone: partner.phone,
        tier: partner.tier,
        apiKey: partner.apiKey,
        createdAt: partner.createdAt
      },
      token
    };
  }

  async loginPartner(email: string, password: string) {
    // Normalize email to lowercase for case-insensitive lookup
    const normalizedEmail = email.toLowerCase().trim();

    // Find user by email
    const partnerUser = await prisma.partnerUser.findUnique({
      where: { email: normalizedEmail },
      include: {
        partner: {
          include: {
            tier: true
          }
        }
      }
    });

    if (!partnerUser || partnerUser.status !== 'active') {
      return null;
    }

    if (!partnerUser.partner.isActive) {
      return null;
    }

    const isValidPassword = await bcrypt.compare(password, partnerUser.password);

    if (!isValidPassword) {
      return null;
    }

    // Update last login
    await prisma.partnerUser.update({
      where: { id: partnerUser.id },
      data: { lastLogin: new Date() }
    });

    const token = this.generateToken({
      id: partnerUser.partner.id,
      odoo: partnerUser.id,
      email: partnerUser.email,
      companyName: partnerUser.partner.companyName
    });

    return {
      partner: {
        id: partnerUser.partner.id,
        email: partnerUser.email,
        companyName: partnerUser.partner.companyName,
        contactName: partnerUser.partner.contactName,
        phone: partnerUser.partner.phone,
        tier: partnerUser.partner.tier,
        apiKey: partnerUser.partner.apiKey,
        verificationsUsed: partnerUser.partner.verificationsUsed,
        createdAt: partnerUser.partner.createdAt
      },
      token
    };
  }

  async getPartnerProfile(partnerId: string) {
    const partner = await prisma.partner.findUnique({
      where: { id: partnerId },
      include: {
        tier: true,
        users: {
          take: 1,
          orderBy: { createdAt: 'asc' }
        }
      }
    });

    if (!partner) {
      return null;
    }

    const primaryUser = partner.users[0];

    // Generate signed URL for logo if stored in S3
    let signedLogoUrl = partner.logoUrl;
    if (partner.logoUrl && s3Service.isEnabled()) {
      try {
        const key = s3Service.extractKeyFromUrl(partner.logoUrl);
        if (key) {
          signedLogoUrl = await s3Service.getSignedUrl(key);
        }
      } catch (error) {
        logger.error(`[PartnerService] Failed to generate signed URL for profile logo:`, error);
      }
    }

    return {
      id: partner.id,
      email: primaryUser?.email || '',
      companyName: partner.companyName,
      contactName: partner.contactName,
      phone: partner.phone,
      logoUrl: signedLogoUrl,
      website: partner.website,
      address: partner.address,
      tier: partner.tier,
      apiKey: partner.apiKey,
      apiSecret: partner.apiSecret,
      verificationsUsed: partner.verificationsUsed,
      isActive: partner.isActive,
      createdAt: partner.createdAt,
      updatedAt: partner.updatedAt
    };
  }

  async updatePartnerProfile(partnerId: string, data: {
    companyName?: string;
    contactName?: string;
    phone?: string;
    logoUrl?: string;
    website?: string;
    address?: string;
  }) {
    const updatedPartner = await prisma.partner.update({
      where: { id: partnerId },
      data: {
        companyName: data.companyName,
        contactName: data.contactName,
        phone: data.phone,
        logoUrl: data.logoUrl,
        website: data.website,
        address: data.address
      },
      include: {
        tier: true,
        users: {
          take: 1,
          orderBy: { createdAt: 'asc' }
        }
      }
    });

    const primaryUser = updatedPartner.users[0];

    // Generate signed URL for logo if stored in S3
    let signedLogoUrl = updatedPartner.logoUrl;
    if (updatedPartner.logoUrl && s3Service.isEnabled()) {
      try {
        const key = s3Service.extractKeyFromUrl(updatedPartner.logoUrl);
        if (key) {
          signedLogoUrl = await s3Service.getSignedUrl(key);
        }
      } catch (error) {
        logger.error(`[PartnerService] Failed to generate signed URL for updated logo:`, error);
      }
    }

    return {
      id: updatedPartner.id,
      email: primaryUser?.email || '',
      companyName: updatedPartner.companyName,
      contactName: updatedPartner.contactName,
      phone: updatedPartner.phone,
      logoUrl: signedLogoUrl,
      website: updatedPartner.website,
      address: updatedPartner.address,
      tier: updatedPartner.tier,
      apiKey: updatedPartner.apiKey,
      apiSecret: updatedPartner.apiSecret,
      verificationsUsed: updatedPartner.verificationsUsed,
      isActive: updatedPartner.isActive,
      createdAt: updatedPartner.createdAt,
      updatedAt: updatedPartner.updatedAt
    };
  }

  async changePassword(partnerId: string, currentPassword: string, newPassword: string) {
    // Find the primary user for this partner
    const partnerUser = await prisma.partnerUser.findFirst({
      where: { partnerId },
      orderBy: { createdAt: 'asc' }
    });

    if (!partnerUser) {
      throw new Error('Partner user not found');
    }

    const isValidPassword = await bcrypt.compare(currentPassword, partnerUser.password);

    if (!isValidPassword) {
      throw new Error('Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.partnerUser.update({
      where: { id: partnerUser.id },
      data: { password: hashedPassword }
    });

    logger.info(`[PartnerService] Password changed for partner user: ${partnerUser.email}`);

    return { success: true };
  }

  async upgradeTier(partnerId: string, tierName: string) {
    const tier = await prisma.tier.findUnique({
      where: { name: tierName.toLowerCase() }
    });

    if (!tier) {
      throw new Error('Invalid tier');
    }

    const updatedPartner = await prisma.partner.update({
      where: { id: partnerId },
      data: {
        tierId: tier.id
      },
      include: {
        tier: true
      }
    });

    return {
      id: updatedPartner.id,
      tier: updatedPartner.tier,
      updatedAt: updatedPartner.updatedAt
    };
  }

  async getUsageStats(partnerId: string) {
    const partner = await prisma.partner.findUnique({
      where: { id: partnerId },
      include: {
        tier: true,
        verifications: {
          where: {
            createdAt: {
              gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
            }
          }
        }
      }
    });

    if (!partner) {
      throw new Error('Partner not found');
    }

    const thisMonthVerifications = partner.verifications.length;
    const remainingVerifications = Math.max(
      0,
      partner.tier.monthlyVerifications - thisMonthVerifications
    );

    return {
      currentTier: partner.tier,
      thisMonthUsage: thisMonthVerifications,
      totalUsage: partner.verificationsUsed,
      remainingVerifications,
      usagePercentage: (thisMonthVerifications / partner.tier.monthlyVerifications) * 100
    };
  }

  async getAllTiers() {
    const tiers = await prisma.tier.findMany({
      orderBy: {
        monthlyPrice: 'asc'
      }
    });

    if (tiers.length === 0) {
      await this.initializeTiers();
      return await prisma.tier.findMany({
        orderBy: {
          monthlyPrice: 'asc'
        }
      });
    }

    return tiers;
  }

  private async initializeTiers() {
    // Create default tiers
    const freeTier = await prisma.tier.create({
      data: {
        name: 'free',
        displayName: 'Free Tier',
        monthlyPrice: 0,
        yearlyPrice: 0,
        monthlyVerifications: 100,
        apiCallsPerMinute: 5,
        features: {
          documentVerification: true,
          faceMatch: true,
          livenessDetection: false,
          webhooks: false,
          apiAccess: true,
          support: 'Community'
        }
      }
    });

    await prisma.tier.create({
      data: {
        name: 'starter',
        displayName: 'Starter',
        monthlyPrice: 49,
        yearlyPrice: 490,
        monthlyVerifications: 1000,
        apiCallsPerMinute: 20,
        features: {
          documentVerification: true,
          faceMatch: true,
          livenessDetection: true,
          webhooks: true,
          apiAccess: true,
          support: 'Email'
        }
      }
    });

    await prisma.tier.create({
      data: {
        name: 'professional',
        displayName: 'Professional',
        monthlyPrice: 199,
        yearlyPrice: 1990,
        monthlyVerifications: 5000,
        apiCallsPerMinute: 50,
        features: {
          documentVerification: true,
          faceMatch: true,
          livenessDetection: true,
          webhooks: true,
          apiAccess: true,
          customIntegration: true,
          support: 'Priority Email & Chat'
        }
      }
    });

    await prisma.tier.create({
      data: {
        name: 'enterprise',
        displayName: 'Enterprise',
        monthlyPrice: 999,
        yearlyPrice: 9990,
        monthlyVerifications: 50000,
        apiCallsPerMinute: 200,
        features: {
          documentVerification: true,
          faceMatch: true,
          livenessDetection: true,
          webhooks: true,
          apiAccess: true,
          customIntegration: true,
          dedicatedSupport: true,
          sla: true,
          support: 'Dedicated Account Manager'
        }
      }
    });

    return freeTier;
  }

  async getPartnerVerifications(partnerId: string) {
    const verifications = await prisma.verification.findMany({
      where: { partnerId },
      include: {
        results: true,
        documents: true,
        user: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    // Map to include user info in response format
    return verifications.map(v => ({
      ...v,
      userName: v.user?.fullName,
      userEmail: v.user?.email,
      userPhone: v.user?.phone
    }));
  }

  async getPartnerVerificationById(partnerId: string, verificationId: string) {
    const verification = await prisma.verification.findUnique({
      where: { id: verificationId },
      include: {
        documents: true,
        results: true,
        user: true
      }
    });

    if (!verification) {
      throw new Error('Verification not found');
    }

    // Verify it belongs to this partner
    if (verification.partnerId !== partnerId) {
      throw new Error('Unauthorized: Verification does not belong to this partner');
    }

    // Generate pre-signed URLs for documents if S3 is enabled
    logger.info(`[PartnerService] Getting verification ${verificationId}, found ${verification.documents.length} documents, S3 enabled: ${s3Service.isEnabled()}`);

    const documentsWithSignedUrls = await Promise.all(
      verification.documents.map(async (doc) => {
        let signedOriginalUrl = doc.originalUrl;
        let signedProcessedUrl = doc.processedUrl;
        let signedThumbnailUrl = doc.thumbnailUrl;

        logger.info(`[PartnerService] Document ${doc.id}: type=${doc.type}, originalUrl=${doc.originalUrl ? 'present' : 'missing'}`);

        // Generate pre-signed URLs for S3 objects (8 hour expiry for dashboard sessions)
        if (s3Service.isEnabled()) {
          try {
            if (doc.originalUrl) {
              const key = s3Service.extractKeyFromUrl(doc.originalUrl);
              logger.info(`[PartnerService] Document ${doc.id}: extracted key=${key}`);
              if (key) {
                signedOriginalUrl = await s3Service.getSignedUrl(key);
                logger.info(`[PartnerService] Document ${doc.id}: generated signed URL`);
              }
            }
            if (doc.processedUrl) {
              const key = s3Service.extractKeyFromUrl(doc.processedUrl);
              if (key) {
                signedProcessedUrl = await s3Service.getSignedUrl(key);
              }
            }
            if (doc.thumbnailUrl) {
              const key = s3Service.extractKeyFromUrl(doc.thumbnailUrl);
              if (key) {
                signedThumbnailUrl = await s3Service.getSignedUrl(key);
              }
            }
          } catch (error) {
            logger.error(`[PartnerService] Failed to generate signed URL for document ${doc.id}:`, error);
          }
        }

        return {
          id: doc.id,
          type: doc.type,
          side: doc.side,
          originalUrl: signedOriginalUrl,
          processedUrl: signedProcessedUrl,
          thumbnailUrl: signedThumbnailUrl,
          qualityScore: doc.qualityScore,
          isBlurry: doc.isBlurry,
          hasGlare: doc.hasGlare,
          isComplete: doc.isComplete,
          ocrConfidence: doc.ocrConfidence,
          extractedData: doc.extractedData,
          createdAt: doc.createdAt
        };
      })
    );

    // Format the response with the required structure
    const response: any = {
      id: verification.id,
      status: verification.status,
      type: verification.type,
      userName: verification.user?.fullName,
      userEmail: verification.user?.email,
      userPhone: verification.user?.phone,
      createdAt: verification.createdAt,
      updatedAt: verification.updatedAt,
      completedAt: verification.completedAt,
      retryCount: verification.retryCount,
      maxRetries: verification.maxRetries,
      documents: documentsWithSignedUrls,
      results: null
    };

    // Add results if available
    if (verification.results) {
      const r = verification.results;
      response.results = {
        id: r.id,
        passed: r.passed,
        score: r.score,
        riskLevel: r.riskLevel,
        checks: {
          documentAuthentic: r.documentAuthentic,
          documentExpired: r.documentExpired,
          documentTampered: r.documentTampered,
          faceMatch: r.faceMatch,
          faceMatchScore: r.faceMatchScore,
          livenessCheck: r.livenessCheck,
          livenessScore: r.livenessScore,
          nameMatch: r.nameMatch,
          dateOfBirthMatch: r.dateOfBirthMatch,
          addressMatch: r.addressMatch
        },
        extractedData: r.extractedData || {
          fullName: r.extractedName,
          dateOfBirth: r.extractedDob,
          documentNumber: r.documentNumber,
          expiryDate: r.expiryDate,
          issuingCountry: r.issuingCountry,
          address: r.extractedAddress
        },
        flags: r.flags || [],
        warnings: r.warnings || [],
        createdAt: r.createdAt
      };
    }

    return response;
  }

  async requestVerification(partnerId: string, data: {
    userName: string;
    userEmail: string;
    userPhone?: string;
    type: string;
    webhookUrl?: string;
  }) {
    try {
      logger.info(`[PartnerService] Requesting verification for partner: ${partnerId}`);

      // Verify partner exists
      const partner = await prisma.partner.findUnique({
        where: { id: partnerId }
      });

      if (!partner) {
        logger.error(`[PartnerService] Partner not found: ${partnerId}`);
        throw new Error('Partner not found');
      }

      logger.info(`[PartnerService] Partner found: ${partner.companyName} (${partnerId})`);

      // Check if user exists with same email AND name, create if not
      // Users are uniquely identified by email + fullName combination
      let user = await prisma.user.findUnique({
        where: {
          email_fullName: {
            email: data.userEmail,
            fullName: data.userName || ''
          }
        }
      });

      if (!user) {
        logger.info(`[PartnerService] Creating new user: ${data.userEmail} (${data.userName})`);

        user = await prisma.user.create({
          data: {
            email: data.userEmail,
            fullName: data.userName,
            phone: data.userPhone
          }
        });

        logger.info(`[PartnerService] User created with ID: ${user.id}`);
      } else {
        // Update phone if changed (email and name are already matched)
        logger.info(`[PartnerService] User already exists: ${user.id}, updating phone if needed`);
        if (data.userPhone && data.userPhone !== user.phone) {
          user = await prisma.user.update({
            where: { id: user.id },
            data: {
              phone: data.userPhone
            }
          });
        }
      }

      // Create verification request
      const verification = await prisma.verification.create({
        data: {
          partnerId,
          userId: user.id,
          type: data.type as any,
          webhookUrl: data.webhookUrl,
          status: 'PENDING'
        },
        include: {
          results: true,
          user: true
        }
      });

      logger.info(`[PartnerService] Verification created with ID: ${verification.id}`);

      // Increment partner's verification count
      await prisma.partner.update({
        where: { id: partnerId },
        data: {
          verificationsUsed: {
            increment: 1
          }
        }
      });

      // Generate verification link with encrypted ID
      const verificationLink = generateVerificationLink(verification.id, config.server.frontendUrl);

      // Send email to user
      try {
        logger.info(`[PartnerService] Sending verification email to: ${user.email}`);

        await emailService.sendVerificationEmail(
          user.email,
          user.fullName || 'User',
          verificationLink
        );

        logger.info(`[PartnerService] Email sent successfully to: ${user.email}`);
      } catch (emailError) {
        // Log error but don't fail the verification creation
        logger.error('[PartnerService] Failed to send email:', emailError);
        // Continue without failing - partner can still share link manually
      }

      return verification;
    } catch (error) {
      logger.error('[PartnerService] Error in requestVerification:', error);
      throw error;
    }
  }

  async resendVerificationEmail(partnerId: string, verificationId: string) {
    try {
      logger.info(`[PartnerService] Resending email for verification: ${verificationId}`);

      // Get verification with user
      const verification = await prisma.verification.findUnique({
        where: { id: verificationId },
        include: { user: true }
      });

      if (!verification) {
        throw new Error('Verification not found');
      }

      // Verify it belongs to this partner
      if (verification.partnerId !== partnerId) {
        throw new Error('Unauthorized: Verification does not belong to this partner');
      }

      if (!verification.user) {
        throw new Error('Verification missing user information');
      }

      // Generate verification link with encrypted ID
      const verificationLink = generateVerificationLink(verification.id, config.server.frontendUrl);

      // Send email
      await emailService.sendVerificationEmail(
        verification.user.email,
        verification.user.fullName || 'User',
        verificationLink
      );

      logger.info(`[PartnerService] Email resent successfully to: ${verification.user.email}`);
    } catch (error) {
      logger.error('[PartnerService] Error resending email:', error);
      throw error;
    }
  }

  async forgotPassword(email: string) {
    // Normalize email to lowercase for case-insensitive lookup
    const normalizedEmail = email.toLowerCase().trim();

    try {
      logger.info(`[PartnerService] Forgot password request for: ${normalizedEmail}`);

      const partnerUser = await prisma.partnerUser.findUnique({
        where: { email: normalizedEmail },
        include: { partner: true }
      });

      if (!partnerUser) {
        // Don't reveal if email exists or not for security
        logger.info(`[PartnerService] Partner user not found for email: ${email}`);
        return { success: true, message: 'If an account exists with this email, a reset link has been sent.' };
      }

      // Generate reset token
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

      // Save token to database
      await prisma.partnerUser.update({
        where: { id: partnerUser.id },
        data: {
          resetToken,
          resetTokenExpiry
        }
      });

      // Generate reset link - points to frontend reset page
      const resetLink = `${config.server.frontendUrl}/partner/reset-password?token=${resetToken}`;

      // Send reset email
      await emailService.sendPasswordResetEmail(
        partnerUser.email,
        partnerUser.partner.contactName,
        resetLink
      );

      logger.info(`[PartnerService] Password reset email sent to: ${email}`);

      return { success: true, message: 'If an account exists with this email, a reset link has been sent.' };
    } catch (error) {
      logger.error('[PartnerService] Forgot password error:', error);
      throw error;
    }
  }

  async resetPassword(token: string, newPassword: string) {
    try {
      logger.info(`[PartnerService] Reset password attempt with token`);

      const partnerUser = await prisma.partnerUser.findFirst({
        where: {
          resetToken: token,
          resetTokenExpiry: {
            gt: new Date()
          }
        }
      });

      if (!partnerUser) {
        logger.info(`[PartnerService] Invalid or expired reset token`);
        throw new Error('Invalid or expired reset token');
      }

      // Hash new password
      const hashedPassword = await bcrypt.hash(newPassword, 10);

      // Update password and clear reset token
      await prisma.partnerUser.update({
        where: { id: partnerUser.id },
        data: {
          password: hashedPassword,
          resetToken: null,
          resetTokenExpiry: null
        }
      });

      logger.info(`[PartnerService] Password reset successful for: ${partnerUser.email}`);

      return { success: true, message: 'Password has been reset successfully' };
    } catch (error) {
      logger.error('[PartnerService] Reset password error:', error);
      throw error;
    }
  }

  private generateToken(payload: { id: string; odoo?: string; email: string; companyName: string }) {
    return jwt.sign(payload, config.server.jwtSecret, { expiresIn: '7d' });
  }

  verifyToken(token: string) {
    try {
      return jwt.verify(token, config.server.jwtSecret) as {
        id: string;
        odoo?: string;
        email: string;
        companyName: string;
      };
    } catch (error) {
      return null;
    }
  }

  extractTokenFromHeader(authHeader?: string) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    return authHeader.substring(7);
  }

  async getPublicPartnerInfo(partnerId: string) {
    const partner = await prisma.partner.findUnique({
      where: { id: partnerId },
      select: {
        companyName: true,
        logoUrl: true
      }
    });

    if (!partner) {
      return null;
    }

    // Generate signed URL for logo if stored in S3
    let signedLogoUrl = partner.logoUrl;
    if (partner.logoUrl && s3Service.isEnabled()) {
      try {
        const key = s3Service.extractKeyFromUrl(partner.logoUrl);
        if (key) {
          signedLogoUrl = await s3Service.getSignedUrl(key);
        }
      } catch (error) {
        logger.error(`[PartnerService] Failed to generate signed URL for logo:`, error);
      }
    }

    return {
      companyName: partner.companyName,
      logoUrl: signedLogoUrl
    };
  }

  // Update verification user details (partner can only update their own verifications)
  async updateVerificationDetails(
    partnerId: string,
    verificationId: string,
    updates: { fullName?: string; email?: string; phone?: string }
  ) {
    try {
      logger.info(`[PartnerService] Partner ${partnerId} updating verification ${verificationId} details:`, updates);

      // Get verification with user
      const verification = await prisma.verification.findUnique({
        where: { id: verificationId },
        include: { user: true }
      });

      if (!verification) {
        throw new Error('Verification not found');
      }

      // Verify it belongs to this partner
      if (verification.partnerId !== partnerId) {
        throw new Error('Unauthorized: Verification does not belong to this partner');
      }

      if (!verification.user) {
        throw new Error('Verification has no associated user');
      }

      // Build update object with only provided fields
      const userUpdates: any = {};
      if (updates.fullName !== undefined) userUpdates.fullName = updates.fullName;
      if (updates.email !== undefined) userUpdates.email = updates.email;
      if (updates.phone !== undefined) userUpdates.phone = updates.phone;

      if (Object.keys(userUpdates).length === 0) {
        throw new Error('No valid fields to update');
      }

      // Update the user record
      const updatedUser = await prisma.user.update({
        where: { id: verification.user.id },
        data: {
          ...userUpdates,
          updatedAt: new Date()
        }
      });

      logger.info(`[PartnerService] Verification ${verificationId} user details updated successfully`);

      return {
        success: true,
        user: {
          id: updatedUser.id,
          fullName: updatedUser.fullName,
          email: updatedUser.email,
          phone: updatedUser.phone
        }
      };
    } catch (error) {
      logger.error('[PartnerService] Error updating verification details:', error);
      throw error;
    }
  }

  // Update verification retry count (partner can only update their own verifications)
  async updateRetryCount(
    partnerId: string,
    verificationId: string,
    retryCount: number
  ) {
    try {
      logger.info(`[PartnerService] Partner ${partnerId} updating retry count for verification ${verificationId} to ${retryCount}`);

      const verification = await prisma.verification.findUnique({
        where: { id: verificationId }
      });

      if (!verification) {
        throw new Error('Verification not found');
      }

      // Verify it belongs to this partner
      if (verification.partnerId !== partnerId) {
        throw new Error('Unauthorized: Verification does not belong to this partner');
      }

      // Validate retry count
      if (retryCount < 0) {
        throw new Error('Retry count cannot be negative');
      }

      if (retryCount > verification.maxRetries) {
        throw new Error(`Retry count cannot exceed max retries (${verification.maxRetries})`);
      }

      const updated = await prisma.verification.update({
        where: { id: verificationId },
        data: {
          retryCount,
          // If retry count is reset to less than max, and status is FAILED, set back to PENDING
          status: retryCount < verification.maxRetries && verification.status === 'FAILED'
            ? 'PENDING'
            : verification.status,
          updatedAt: new Date()
        }
      });

      logger.info(`[PartnerService] Retry count updated successfully for verification ${verificationId}`);

      return {
        success: true,
        retryCount: updated.retryCount,
        maxRetries: updated.maxRetries,
        status: updated.status
      };
    } catch (error) {
      logger.error('[PartnerService] Error updating retry count:', error);
      throw error;
    }
  }
}

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { logger } from '../utils/logger';
import { s3Service } from './s3.service';

const prisma = new PrismaClient();

interface RegisterAdminData {
  email: string;
  password: string;
  name: string;
  role?: 'ADMIN' | 'SUPER_ADMIN';
}

interface UpdatePartnerData {
  companyName?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  website?: string;
  tierName?: string;
  verificationsUsed?: number;
  isActive?: boolean;
}

interface CreatePartnerData {
  email: string;
  password: string;
  companyName: string;
  contactName: string;
  phone?: string;
  website?: string;
  tierName?: string;
}

export class AdminService {
  // Admin Authentication
  async registerAdmin(data: RegisterAdminData) {
    const existingAdmin = await prisma.admin.findUnique({
      where: { email: data.email }
    });

    if (existingAdmin) {
      throw new Error('Admin with this email already exists');
    }

    const hashedPassword = await bcrypt.hash(data.password, 10);

    const admin = await prisma.admin.create({
      data: {
        email: data.email,
        password: hashedPassword,
        name: data.name,
        role: data.role || 'ADMIN'
      }
    });

    const token = this.generateToken({
      id: admin.id,
      email: admin.email,
      role: admin.role
    });

    return {
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        createdAt: admin.createdAt
      },
      token
    };
  }

  async loginAdmin(email: string, password: string) {
    const admin = await prisma.admin.findUnique({
      where: { email }
    });

    if (!admin || !admin.isActive) {
      return null;
    }

    const isValidPassword = await bcrypt.compare(password, admin.password);

    if (!isValidPassword) {
      return null;
    }

    const token = this.generateToken({
      id: admin.id,
      email: admin.email,
      role: admin.role
    });

    return {
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        createdAt: admin.createdAt
      },
      token
    };
  }

  async getAdminProfile(adminId: string) {
    const admin = await prisma.admin.findUnique({
      where: { id: adminId }
    });

    if (!admin) {
      return null;
    }

    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      isActive: admin.isActive,
      createdAt: admin.createdAt,
      updatedAt: admin.updatedAt
    };
  }

  async updateAdminProfile(adminId: string, data: { name?: string; email?: string }) {
    const admin = await prisma.admin.update({
      where: { id: adminId },
      data: {
        name: data.name,
        email: data.email
      }
    });

    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      isActive: admin.isActive,
      createdAt: admin.createdAt,
      updatedAt: admin.updatedAt
    };
  }

  async changeAdminPassword(adminId: string, currentPassword: string, newPassword: string) {
    const admin = await prisma.admin.findUnique({
      where: { id: adminId }
    });

    if (!admin) {
      throw new Error('Admin not found');
    }

    const isValidPassword = await bcrypt.compare(currentPassword, admin.password);

    if (!isValidPassword) {
      throw new Error('Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.admin.update({
      where: { id: adminId },
      data: { password: hashedPassword }
    });

    return { success: true };
  }

  // Dashboard Stats
  async getDashboardStats() {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalPartners,
      activePartners,
      totalVerifications,
      verificationsThisMonth,
      pendingVerifications,
      completedVerifications,
      failedVerifications
    ] = await Promise.all([
      prisma.partner.count(),
      prisma.partner.count({ where: { isActive: true } }),
      prisma.verification.count(),
      prisma.verification.count({
        where: { createdAt: { gte: startOfMonth } }
      }),
      prisma.verification.count({ where: { status: { in: ['PENDING', 'IN_PROGRESS'] } } }),
      prisma.verification.count({ where: { status: 'COMPLETED' } }),
      prisma.verification.count({ where: { status: 'FAILED' } })
    ]);

    // Calculate revenue (sum of partner tier prices)
    const partnersWithTiers = await prisma.partner.findMany({
      where: { isActive: true },
      include: { tier: true }
    });

    const revenueThisMonth = partnersWithTiers.reduce(
      (sum, partner) => sum + (partner.tier?.monthlyPrice || 0),
      0
    );

    return {
      totalPartners,
      activePartners,
      totalVerifications,
      verificationsThisMonth,
      pendingVerifications,
      completedVerifications,
      failedVerifications,
      revenueThisMonth
    };
  }

  // Partner Management
  async getAllPartners(options?: {
    limit?: number;
    offset?: number;
    sort?: string;
    order?: 'asc' | 'desc';
    search?: string;
    tierName?: string;
  }) {
    const where: any = {};

    if (options?.search) {
      where.OR = [
        { companyName: { contains: options.search, mode: 'insensitive' } },
        { email: { contains: options.search, mode: 'insensitive' } },
        { contactName: { contains: options.search, mode: 'insensitive' } }
      ];
    }

    if (options?.tierName && options.tierName !== 'all') {
      where.tier = { name: options.tierName };
    }

    const orderBy: any = {};
    if (options?.sort) {
      orderBy[options.sort] = options?.order || 'desc';
    } else {
      orderBy.createdAt = 'desc';
    }

    const [partners, total] = await Promise.all([
      prisma.partner.findMany({
        where,
        include: { tier: true },
        orderBy,
        take: options?.limit || 100,
        skip: options?.offset || 0
      }),
      prisma.partner.count({ where })
    ]);

    return {
      partners: partners.map(p => ({
        id: p.id,
        email: p.email,
        companyName: p.companyName,
        contactName: p.contactName,
        phone: p.phone,
        website: p.website,
        tier: p.tier,
        apiKey: p.apiKey,
        verificationsUsed: p.verificationsUsed,
        isActive: p.isActive,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
      })),
      total
    };
  }

  async getPartnerById(partnerId: string) {
    const partner = await prisma.partner.findUnique({
      where: { id: partnerId },
      include: { tier: true }
    });

    if (!partner) {
      return null;
    }

    return {
      id: partner.id,
      email: partner.email,
      companyName: partner.companyName,
      contactName: partner.contactName,
      phone: partner.phone,
      website: partner.website,
      address: partner.address,
      logoUrl: partner.logoUrl,
      tier: partner.tier,
      apiKey: partner.apiKey,
      apiSecret: partner.apiSecret,
      verificationsUsed: partner.verificationsUsed,
      isActive: partner.isActive,
      createdAt: partner.createdAt,
      updatedAt: partner.updatedAt
    };
  }

  async createPartner(data: CreatePartnerData) {
    // Check if partner already exists
    const existingPartner = await prisma.partner.findUnique({
      where: { email: data.email }
    });

    if (existingPartner) {
      throw new Error('Partner with this email already exists');
    }

    // Get tier
    let tier = await prisma.tier.findUnique({
      where: { name: data.tierName || 'free' }
    });

    if (!tier) {
      tier = await prisma.tier.findFirst();
      if (!tier) {
        throw new Error('No tiers available. Please create tiers first.');
      }
    }

    const hashedPassword = await bcrypt.hash(data.password, 10);

    const partner = await prisma.partner.create({
      data: {
        email: data.email,
        password: hashedPassword,
        companyName: data.companyName,
        contactName: data.contactName,
        phone: data.phone,
        website: data.website,
        tierId: tier.id
      },
      include: { tier: true }
    });

    logger.info(`[AdminService] Partner created by admin: ${partner.email}`);

    return {
      id: partner.id,
      email: partner.email,
      companyName: partner.companyName,
      contactName: partner.contactName,
      phone: partner.phone,
      tier: partner.tier,
      apiKey: partner.apiKey,
      createdAt: partner.createdAt
    };
  }

  async updatePartner(partnerId: string, data: UpdatePartnerData) {
    const updateData: any = {};

    if (data.companyName !== undefined) updateData.companyName = data.companyName;
    if (data.contactName !== undefined) updateData.contactName = data.contactName;
    if (data.email !== undefined) updateData.email = data.email;
    if (data.phone !== undefined) updateData.phone = data.phone;
    if (data.website !== undefined) updateData.website = data.website;
    if (data.verificationsUsed !== undefined) updateData.verificationsUsed = parseInt(String(data.verificationsUsed));
    if (data.isActive !== undefined) updateData.isActive = data.isActive;

    // Handle tier update
    if (data.tierName) {
      const tier = await prisma.tier.findUnique({
        where: { name: data.tierName }
      });

      if (tier) {
        updateData.tierId = tier.id;
      }
    }

    const partner = await prisma.partner.update({
      where: { id: partnerId },
      data: updateData,
      include: { tier: true }
    });

    logger.info(`[AdminService] Partner updated by admin: ${partner.email}`);

    return {
      id: partner.id,
      email: partner.email,
      companyName: partner.companyName,
      contactName: partner.contactName,
      phone: partner.phone,
      website: partner.website,
      tier: partner.tier,
      apiKey: partner.apiKey,
      verificationsUsed: partner.verificationsUsed,
      isActive: partner.isActive,
      createdAt: partner.createdAt,
      updatedAt: partner.updatedAt
    };
  }

  async togglePartnerActive(partnerId: string) {
    const partner = await prisma.partner.findUnique({
      where: { id: partnerId }
    });

    if (!partner) {
      throw new Error('Partner not found');
    }

    const updated = await prisma.partner.update({
      where: { id: partnerId },
      data: { isActive: !partner.isActive },
      include: { tier: true }
    });

    logger.info(`[AdminService] Partner ${updated.isActive ? 'activated' : 'deactivated'}: ${updated.email}`);

    return {
      id: updated.id,
      isActive: updated.isActive
    };
  }

  async resetPartnerApiKey(partnerId: string) {
    const { v4: uuidv4 } = await import('uuid');

    const partner = await prisma.partner.update({
      where: { id: partnerId },
      data: {
        apiKey: uuidv4(),
        apiSecret: uuidv4()
      }
    });

    logger.info(`[AdminService] API key reset for partner: ${partner.email}`);

    return {
      id: partner.id,
      apiKey: partner.apiKey,
      apiSecret: partner.apiSecret
    };
  }

  async deletePartner(partnerId: string) {
    // First delete related verifications
    await prisma.verification.deleteMany({
      where: { partnerId }
    });

    await prisma.partner.delete({
      where: { id: partnerId }
    });

    logger.info(`[AdminService] Partner deleted: ${partnerId}`);

    return { success: true };
  }

  // Verification Management
  async getAllVerifications(options?: {
    limit?: number;
    offset?: number;
    sort?: string;
    order?: 'asc' | 'desc';
    status?: string;
    partnerId?: string;
  }) {
    const where: any = {};

    if (options?.status && options.status !== 'all') {
      where.status = options.status;
    }

    if (options?.partnerId) {
      where.partnerId = options.partnerId;
    }

    const orderBy: any = {};
    if (options?.sort) {
      orderBy[options.sort] = options?.order || 'desc';
    } else {
      orderBy.createdAt = 'desc';
    }

    const [verifications, total] = await Promise.all([
      prisma.verification.findMany({
        where,
        include: {
          partner: {
            select: {
              id: true,
              companyName: true,
              email: true
            }
          },
          user: {
            select: {
              id: true,
              fullName: true,
              email: true
            }
          },
          results: {
            select: {
              score: true,
              riskLevel: true,
              passed: true
            }
          }
        },
        orderBy,
        take: options?.limit || 100,
        skip: options?.offset || 0
      }),
      prisma.verification.count({ where })
    ]);

    return {
      verifications: verifications.map(v => ({
        id: v.id,
        userName: v.user?.fullName,
        userEmail: v.user?.email,
        type: v.type,
        status: v.status,
        riskLevel: v.results?.riskLevel,
        score: v.results?.score,
        passed: v.results?.passed,
        partner: v.partner,
        createdAt: v.createdAt,
        completedAt: v.completedAt
      })),
      total
    };
  }

  async getVerificationById(verificationId: string) {
    const verification = await prisma.verification.findUnique({
      where: { id: verificationId },
      include: {
        partner: true,
        user: true,
        documents: true,
        results: true
      }
    });

    if (!verification) {
      return null;
    }

    // Generate pre-signed URLs for documents if S3 is enabled
    const documentsWithSignedUrls = await Promise.all(
      verification.documents.map(async (doc) => {
        let signedOriginalUrl = doc.originalUrl;
        let signedProcessedUrl = doc.processedUrl;
        let signedThumbnailUrl = doc.thumbnailUrl;

        // Generate pre-signed URLs for S3 objects (8 hour expiry for dashboard sessions)
        if (s3Service.isEnabled()) {
          try {
            if (doc.originalUrl) {
              const key = s3Service.extractKeyFromUrl(doc.originalUrl);
              if (key) {
                signedOriginalUrl = await s3Service.getSignedUrl(key);
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
            logger.error(`[AdminService] Failed to generate signed URL for document ${doc.id}:`, error);
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
          createdAt: doc.createdAt
        };
      })
    );

    // Format the response with results in the expected structure
    const response: any = {
      id: verification.id,
      status: verification.status,
      type: verification.type,
      userName: verification.user?.fullName,
      userEmail: verification.user?.email,
      userPhone: verification.user?.phone,
      partner: verification.partner ? {
        id: verification.partner.id,
        companyName: verification.partner.companyName,
        email: verification.partner.email
      } : null,
      documents: documentsWithSignedUrls,
      createdAt: verification.createdAt,
      completedAt: verification.completedAt,
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

  // Manual verification actions
  async manualPassVerification(verificationId: string, adminId: string) {
    const verification = await prisma.verification.findUnique({
      where: { id: verificationId },
      include: { results: true }
    });

    if (!verification) {
      throw new Error('Verification not found');
    }

    // Update or create verification result
    if (verification.results) {
      await prisma.verificationResult.update({
        where: { id: verification.results.id },
        data: {
          passed: true,
          score: 1.0,
          riskLevel: 'LOW',
          warnings: {
            push: `Manually approved by admin (${adminId}) on ${new Date().toISOString()}`
          }
        }
      });
    } else {
      await prisma.verificationResult.create({
        data: {
          verificationId,
          passed: true,
          score: 1.0,
          riskLevel: 'LOW',
          documentAuthentic: true,
          documentExpired: false,
          documentTampered: false,
          warnings: [`Manually approved by admin (${adminId}) on ${new Date().toISOString()}`]
        }
      });
    }

    // Update verification status
    const updated = await prisma.verification.update({
      where: { id: verificationId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date()
      },
      include: {
        results: true,
        partner: true,
        user: true
      }
    });

    logger.info(`[AdminService] Verification ${verificationId} manually passed by admin ${adminId}`);

    return updated;
  }

  async manualFailVerification(verificationId: string, adminId: string, reason: string) {
    const verification = await prisma.verification.findUnique({
      where: { id: verificationId },
      include: { results: true }
    });

    if (!verification) {
      throw new Error('Verification not found');
    }

    // Update or create verification result
    if (verification.results) {
      await prisma.verificationResult.update({
        where: { id: verification.results.id },
        data: {
          passed: false,
          score: 0,
          riskLevel: 'HIGH',
          flags: {
            push: `MANUAL_REJECTION`
          },
          warnings: {
            push: `Manually rejected by admin (${adminId}): ${reason}`
          }
        }
      });
    } else {
      await prisma.verificationResult.create({
        data: {
          verificationId,
          passed: false,
          score: 0,
          riskLevel: 'HIGH',
          flags: ['MANUAL_REJECTION'],
          warnings: [`Manually rejected by admin (${adminId}): ${reason}`]
        }
      });
    }

    // Update verification status
    const updated = await prisma.verification.update({
      where: { id: verificationId },
      data: {
        status: 'FAILED',
        completedAt: new Date()
      },
      include: {
        results: true,
        partner: true,
        user: true
      }
    });

    logger.info(`[AdminService] Verification ${verificationId} manually failed by admin ${adminId}: ${reason}`);

    return updated;
  }

  // Token management
  private generateToken(payload: { id: string; email: string; role: string }) {
    return jwt.sign(payload, config.server.jwtSecret, { expiresIn: '24h' });
  }

  verifyToken(token: string) {
    try {
      return jwt.verify(token, config.server.jwtSecret) as {
        id: string;
        email: string;
        role: string;
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
}

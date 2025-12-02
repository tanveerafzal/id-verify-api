import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config';

const prisma = new PrismaClient();

interface RegisterPartnerData {
  email: string;
  password: string;
  companyName: string;
  contactName: string;
  phone?: string;
}

export class PartnerService {
  async registerPartner(data: RegisterPartnerData) {
    // Check if partner already exists
    const existingPartner = await prisma.partner.findUnique({
      where: { email: data.email }
    });

    if (existingPartner) {
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

    // Hash password
    const hashedPassword = await bcrypt.hash(data.password, 10);

    // Create partner with Free tier
    const partner = await prisma.partner.create({
      data: {
        email: data.email,
        password: hashedPassword,
        companyName: data.companyName,
        contactName: data.contactName,
        phone: data.phone,
        tierId: freeTier.id
      },
      include: {
        tier: true
      }
    });

    // Generate JWT token
    const token = this.generateToken({
      id: partner.id,
      email: partner.email,
      companyName: partner.companyName
    });

    return {
      partner: {
        id: partner.id,
        email: partner.email,
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
    const partner = await prisma.partner.findUnique({
      where: { email },
      include: {
        tier: true
      }
    });

    if (!partner || !partner.isActive) {
      return null;
    }

    const isValidPassword = await bcrypt.compare(password, partner.password);

    if (!isValidPassword) {
      return null;
    }

    const token = this.generateToken({
      id: partner.id,
      email: partner.email,
      companyName: partner.companyName
    });

    return {
      partner: {
        id: partner.id,
        email: partner.email,
        companyName: partner.companyName,
        contactName: partner.contactName,
        phone: partner.phone,
        tier: partner.tier,
        apiKey: partner.apiKey,
        verificationsUsed: partner.verificationsUsed,
        createdAt: partner.createdAt
      },
      token
    };
  }

  async getPartnerProfile(partnerId: string) {
    const partner = await prisma.partner.findUnique({
      where: { id: partnerId },
      include: {
        tier: true
      }
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
      tier: partner.tier,
      apiKey: partner.apiKey,
      apiSecret: partner.apiSecret,
      verificationsUsed: partner.verificationsUsed,
      isActive: partner.isActive,
      createdAt: partner.createdAt,
      updatedAt: partner.updatedAt
    };
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
        results: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    return verifications;
  }

  private generateToken(payload: { id: string; email: string; companyName: string }) {
    return jwt.sign(payload, config.server.jwtSecret, { expiresIn: '7d' });
  }

  verifyToken(token: string) {
    try {
      return jwt.verify(token, config.server.jwtSecret) as {
        id: string;
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
}

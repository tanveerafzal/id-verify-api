import { Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { PartnerRequest } from '../controllers/verification.controller';

const prisma = new PrismaClient();

export const apiKeyMiddleware = async (
  req: PartnerRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Check for API key in query parameter or header
    const apiKey = req.query.apiKey as string || req.headers['x-api-key'] as string;

    if (apiKey) {
      // Look up partner by API key
      const partner = await prisma.partner.findUnique({
        where: { apiKey },
        include: { tier: true }
      });

      if (partner && partner.isActive) {
        // Check if partner has reached their monthly limit
        const thisMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        const verificationsThisMonth = await prisma.verification.count({
          where: {
            partnerId: partner.id,
            createdAt: {
              gte: thisMonth
            }
          }
        });

        if (verificationsThisMonth >= partner.tier.monthlyVerifications) {
          res.status(429).json({
            success: false,
            error: 'Monthly verification limit reached. Please upgrade your plan.',
            limit: partner.tier.monthlyVerifications,
            used: verificationsThisMonth
          });
          return;
        }

        // Attach partner ID to request
        req.partnerId = partner.id;
      }
    }

    // Continue even if no API key (for demo mode)
    next();
  } catch (error) {
    console.error('API key middleware error:', error);
    next(); // Continue without partner tracking on error
  }
};

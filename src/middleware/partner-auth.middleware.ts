import { Response, NextFunction } from 'express';
import { PartnerService } from '../services/partner.service';
import { AuthRequest } from '../controllers/partner.controller';

const partnerService = new PartnerService();

export const partnerAuthMiddleware = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const token = partnerService.extractTokenFromHeader(req.headers.authorization);

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required. Please provide a valid Bearer token.'
      });
    }

    const payload = partnerService.verifyToken(token);

    if (!payload) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }

    req.partner = {
      id: payload.id,
      email: payload.email,
      companyName: payload.companyName
    };

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: 'Authentication failed'
    });
  }
};

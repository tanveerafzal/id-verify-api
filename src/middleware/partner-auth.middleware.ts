import { Response, NextFunction } from 'express';
import { PartnerService } from '../services/partner.service';
import { AuthRequest } from '../controllers/partner.controller';

const partnerService = new PartnerService();

export const partnerAuthMiddleware = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  try {
    const token = partnerService.extractTokenFromHeader(req.headers.authorization);

    if (!token) {
      res.status(401).json({
        success: false,
        error: 'Authentication required. Please provide a valid Bearer token.'
      });
      return;
    }

    const payload = partnerService.verifyToken(token);

    if (!payload) {
      res.status(401).json({
        success: false,
        error: 'Invalid or expired token'
      });
      return;
    }

    req.partner = {
      id: payload.id,
      email: payload.email,
      companyName: payload.companyName
    };

    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      error: 'Authentication failed'
    });
  }
};

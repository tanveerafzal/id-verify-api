import { Request, Response, NextFunction } from 'express';
import { AdminService } from '../services/admin.service';

const adminService = new AdminService();

export interface AdminRequest extends Request {
  admin?: {
    id: string;
    email: string;
    role: string;
  };
}

export const adminAuthMiddleware = (
  req: AdminRequest,
  res: Response,
  next: NextFunction
): void => {
  try {
    const token = adminService.extractTokenFromHeader(req.headers.authorization);

    if (!token) {
      res.status(401).json({
        success: false,
        error: 'Authentication required. Please provide a valid Bearer token.'
      });
      return;
    }

    const payload = adminService.verifyToken(token);

    if (!payload) {
      res.status(401).json({
        success: false,
        error: 'Invalid or expired token'
      });
      return;
    }

    req.admin = {
      id: payload.id,
      email: payload.email,
      role: payload.role
    };

    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      error: 'Authentication failed'
    });
  }
};

// Middleware to check for super admin role
export const superAdminMiddleware = (
  req: AdminRequest,
  res: Response,
  next: NextFunction
): void => {
  if (!req.admin) {
    res.status(401).json({
      success: false,
      error: 'Authentication required'
    });
    return;
  }

  if (req.admin.role !== 'SUPER_ADMIN') {
    res.status(403).json({
      success: false,
      error: 'Super admin access required'
    });
    return;
  }

  next();
};

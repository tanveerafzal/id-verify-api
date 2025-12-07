import { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';
import { logger } from '../utils/logger';

const authService = new AuthService();

export class AuthController {
  /**
   * User authentication is not supported.
   * Partners should use the partner authentication endpoints.
   */
  async register(_req: Request, res: Response) {
    return res.status(400).json({
      success: false,
      error: 'User registration is not supported. Please use partner authentication.',
      message: 'Partners can register at /api/partners/register'
    });
  }

  /**
   * User authentication is not supported.
   * Partners should use the partner authentication endpoints.
   */
  async login(_req: Request, res: Response) {
    return res.status(400).json({
      success: false,
      error: 'User login is not supported. Please use partner authentication.',
      message: 'Partners can login at /api/partners/login'
    });
  }

  /**
   * Create or find a user for verification purposes
   */
  async createUser(req: Request, res: Response) {
    try {
      const { email, fullName, phone } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          error: 'Email is required'
        });
      }

      // Email validation
      if (!email.includes('@')) {
        return res.status(400).json({
          success: false,
          error: 'Invalid email format'
        });
      }

      const user = await authService.findOrCreateUser(email, fullName, phone);

      logger.info(`User created/found: ${email}`);

      return res.status(201).json({
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            fullName: user.fullName,
            phone: user.phone
          }
        }
      });
    } catch (error) {
      logger.error('User creation error:', error);

      return res.status(500).json({
        success: false,
        error: 'Failed to create user. Please try again.'
      });
    }
  }
}

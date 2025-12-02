import { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';
import { UserRole } from '@prisma/client';
import { logger } from '../utils/logger';

const authService = new AuthService();

export class AuthController {
  async register(req: Request, res: Response) {
    try {
      const { username, email, password, role } = req.body;

      // Validation
      if (!username || !password) {
        return res.status(400).json({
          success: false,
          error: 'Username and password are required'
        });
      }

      // Password strength validation
      if (password.length < 6) {
        return res.status(400).json({
          success: false,
          error: 'Password must be at least 6 characters long'
        });
      }

      // Username validation
      if (username.length < 3) {
        return res.status(400).json({
          success: false,
          error: 'Username must be at least 3 characters long'
        });
      }

      // Email validation (basic)
      if (email && !email.includes('@')) {
        return res.status(400).json({
          success: false,
          error: 'Invalid email format'
        });
      }

      // Validate role if provided
      if (role && !Object.values(UserRole).includes(role)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid role. Must be ADMIN, USER, or API_CLIENT'
        });
      }

      const user = await authService.register({
        username,
        email,
        password,
        role
      });

      logger.info(`New user registered: ${username}`);

      return res.status(201).json({
        success: true,
        data: {
          user: {
            id: user?.id,
            username: user?.username,
            email: user?.email,
            role: user?.role
          }
        },
        message: 'User registered successfully'
      });
    } catch (error) {
      logger.error('Registration error:', error);

      if (error instanceof Error) {
        if (error.message.includes('already exists')) {
          return res.status(409).json({
            success: false,
            error: error.message
          });
        }
      }

      return res.status(500).json({
        success: false,
        error: 'Registration failed. Please try again.'
      });
    }
  }

  async login(req: Request, res: Response) {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({
          success: false,
          error: 'Username and password are required'
        });
      }

      const token = await authService.login(username, password);

      if (!token) {
        logger.warn(`Failed login attempt for username: ${username}`);
        return res.status(401).json({
          success: false,
          error: 'Invalid username or password'
        });
      }

      logger.info(`Successful login for username: ${username}`);

      return res.status(200).json({
        success: true,
        data: {
          token,
          expiresIn: '24h',
          tokenType: 'Bearer'
        }
      });
    } catch (error) {
      logger.error('Login error:', error);

      if (error instanceof Error && error.message === 'Account is deactivated') {
        return res.status(403).json({
          success: false,
          error: 'Account is deactivated. Please contact support.'
        });
      }

      return res.status(500).json({
        success: false,
        error: 'Login failed. Please try again.'
      });
    }
  }
}

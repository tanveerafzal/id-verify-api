import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { config } from '../config';

const prisma = new PrismaClient();

export interface TokenPayload {
  userId: string;
  email: string;
}

export interface CreateUserData {
  email: string;
  fullName?: string;
  phone?: string;
}

export class AuthService {
  /**
   * Create a new user (for verification purposes)
   * Users are uniquely identified by email + fullName combination
   */
  async createUser(data: CreateUserData) {
    // Check if user with same email AND name already exists
    const existingUser = await prisma.user.findUnique({
      where: {
        email_fullName: {
          email: data.email,
          fullName: data.fullName || ''
        }
      }
    });

    if (existingUser) {
      return existingUser;
    }

    // Create user
    const user = await prisma.user.create({
      data: {
        email: data.email,
        fullName: data.fullName,
        phone: data.phone
      }
    });

    return user;
  }

  /**
   * Find or create user by email AND name
   * Users are uniquely identified by email + fullName combination
   */
  async findOrCreateUser(email: string, fullName?: string, phone?: string) {
    let user = await prisma.user.findUnique({
      where: {
        email_fullName: {
          email: email,
          fullName: fullName || ''
        }
      }
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          fullName,
          phone
        }
      });
    }

    return user;
  }

  generateToken(payload: TokenPayload): string {
    return jwt.sign(
      payload,
      config.security.jwtSecret,
      { expiresIn: '24h' }
    );
  }

  verifyToken(token: string): TokenPayload | null {
    try {
      const decoded = jwt.verify(token, config.security.jwtSecret) as TokenPayload;
      return decoded;
    } catch (error) {
      return null;
    }
  }

  extractTokenFromHeader(authHeader: string | undefined): string | null {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    return authHeader.substring(7);
  }

  async getUserById(userId: string) {
    return await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        createdAt: true
      }
    });
  }

  /**
   * Find users by email (may return multiple if same email with different names)
   * Use findFirst to get any user with this email
   */
  async getUserByEmail(email: string) {
    return await prisma.user.findFirst({
      where: { email },
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        createdAt: true
      }
    });
  }

  /**
   * Find user by email AND fullName (exact match)
   */
  async getUserByEmailAndName(email: string, fullName: string) {
    return await prisma.user.findUnique({
      where: {
        email_fullName: {
          email: email,
          fullName: fullName || ''
        }
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        createdAt: true
      }
    });
  }
}

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
   */
  async createUser(data: CreateUserData) {
    // Check if email already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: data.email }
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
   * Find or create user by email
   */
  async findOrCreateUser(email: string, fullName?: string, phone?: string) {
    let user = await prisma.user.findUnique({
      where: { email }
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

  async getUserByEmail(email: string) {
    return await prisma.user.findUnique({
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
}

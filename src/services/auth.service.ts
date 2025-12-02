import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { PrismaClient, UserRole } from '@prisma/client';
import { config } from '../config';

const prisma = new PrismaClient();

export interface TokenPayload {
  userId: string;
  username: string;
  role: string;
}

export interface RegisterUserData {
  username: string;
  email?: string;
  password: string;
  role?: UserRole;
}

export class AuthService {
  async register(data: RegisterUserData): Promise<{ id: string; username: string; email?: string | null; role: string } | null> {
    try {
      // Check if username already exists
      const existingUser = await prisma.user.findUnique({
        where: { username: data.username }
      });

      if (existingUser) {
        throw new Error('Username already exists');
      }

      // Check if email already exists (if provided)
      if (data.email) {
        const existingEmail = await prisma.user.findUnique({
          where: { email: data.email }
        });

        if (existingEmail) {
          throw new Error('Email already exists');
        }
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(data.password, 10);

      // Create user
      const user = await prisma.user.create({
        data: {
          username: data.username,
          email: data.email,
          password: hashedPassword,
          role: data.role || UserRole.USER
        },
        select: {
          id: true,
          username: true,
          email: true,
          role: true
        }
      });

      return user;
    } catch (error) {
      throw error;
    }
  }

  async login(username: string, password: string): Promise<string | null> {
    const user = await prisma.user.findUnique({
      where: { username }
    });

    if (!user) {
      return null;
    }

    if (!user.isActive) {
      throw new Error('Account is deactivated');
    }

    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      return null;
    }

    const token = this.generateToken({
      userId: user.id,
      username: user.username,
      role: user.role
    });

    return token;
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
        username: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true
      }
    });
  }

  async getUserByUsername(username: string) {
    return await prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true
      }
    });
  }
}

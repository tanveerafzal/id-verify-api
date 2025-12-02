import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

export const config = {
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    jwtSecret: process.env.JWT_SECRET || 'your-secret-key'
  },

  database: {
    url: process.env.DATABASE_URL || ''
  },

  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    region: process.env.AWS_REGION || 'us-east-1',
    s3BucketName: process.env.S3_BUCKET_NAME || 'id-verification-documents'
  },

  security: {
    jwtSecret: process.env.JWT_SECRET || 'your-secret-key',
    encryptionKey: process.env.ENCRYPTION_KEY || 'your-encryption-key',
    webhookSecret: process.env.WEBHOOK_SECRET || 'your-webhook-secret'
  },

  externalServices: {
    faceDetectionApiUrl: process.env.FACE_DETECTION_API_URL || 'http://localhost:5000',
    ocrServiceUrl: process.env.OCR_SERVICE_URL || 'http://localhost:5001'
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10)
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info'
  },

  verification: {
    documentMaxSizeMB: 10,
    supportedImageFormats: ['image/jpeg', 'image/png', 'image/jpg'],
    minQualityScore: 0.3,
    maxVerificationAgeDays: 30,
    faceMatchThreshold: 0.85,
    livenessThreshold: 0.7
  }
};

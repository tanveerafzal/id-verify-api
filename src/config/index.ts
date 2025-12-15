import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

export const config = {
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    jwtSecret: process.env.JWT_SECRET || 'your-secret-key',
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
    apiUrl: process.env.API_URL || 'http://localhost:3002'
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

  googleCloud: {
    projectId: process.env.GOOGLE_CLOUD_PROJECT || '',
    credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
    location: process.env.GOOGLE_CLOUD_LOCATION || 'us',
    documentAi: {
      // US Processors (built-in)
      usDriversLicenseProcessorId: process.env.DOCAI_US_DRIVERS_LICENSE_PROCESSOR_ID || '',
      usPassportProcessorId: process.env.DOCAI_US_PASSPORT_PROCESSOR_ID || '',
      // Canadian Custom Extractors
      caDriversLicenseProcessorId: process.env.DOCAI_CA_DRIVERS_LICENSE_PROCESSOR_ID || '',
      caPassportProcessorId: process.env.DOCAI_CA_PASSPORT_PROCESSOR_ID || '',
      // Generic ID Processor (fallback for other countries)
      genericIdProcessorId: process.env.DOCAI_GENERIC_ID_PROCESSOR_ID || '',
      // ID Proofing (fraud detection)
      idProofingProcessorId: process.env.DOCAI_ID_PROOFING_PROCESSOR_ID || ''
    }
  },

  ultrareach360: {
    apiUrl: process.env.ULTRAREACH360_API_URL || 'https://ultrareach360-api.vercel.app/v1',
    username: process.env.ULTRAREACH360_USERNAME || 'ussols@gmail.com',
    password: process.env.ULTRAREACH360_PASSWORD || 'Ultrareach360',
    apiKey: process.env.ULTRAREACH360_API_KEY || 'ur360_822338bc2791636164f56dc8c5e27d04d9f47c2a9b537ef88d2d861003d05347',
    businessGroup: process.env.ULTRAREACH360_BUSINESS_GROUP || 'The ID verification Company'
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

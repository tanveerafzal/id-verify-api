import { Router, Request } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { VerificationController } from '../controllers/verification.controller';
import { apiKeyMiddleware } from '../middleware/api-key.middleware';
import { config } from '../config';

const router = Router();
const controller = new VerificationController();

// Check if S3 is configured
const isS3Configured = !!(process.env.S3_BUCKET_NAME && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

// Use memory storage for S3, disk storage for local
const storage = isS3Configured
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req: Request, _file, cb) => {
        const verificationId = req.params.verificationId || 'unknown';
        const uploadDir = path.join(__dirname, '../../uploads/documents', verificationId);

        // Create directory if it doesn't exist
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }

        cb(null, uploadDir);
      },
      filename: (_req, file, cb) => {
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
      }
    });

console.log(`[VerificationRoutes] Storage mode: ${isS3Configured ? 'AWS S3' : 'Local disk'}`);

const upload = multer({
  storage,
  limits: {
    fileSize: config.verification.documentMaxSizeMB * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    if (config.verification.supportedImageFormats.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file format. Supported formats: JPEG, PNG, PDF.'));
    }
  }
});

// Decrypt verification request - no API key needed as this is called from public verify page
// IMPORTANT: This route must be defined BEFORE /verifications/:verificationId to avoid matching "decrypt" as a verificationId
router.get(
  '/verifications/decrypt',
  controller.decryptVerificationRequest.bind(controller)
);

// API key middleware tracks partner usage
router.post('/verifications', apiKeyMiddleware, controller.createVerification.bind(controller));

router.get('/verifications/:verificationId', apiKeyMiddleware, controller.getVerification.bind(controller));

router.post(
  '/verifications/:verificationId/documents',
  apiKeyMiddleware,
  upload.single('document'),
  controller.uploadDocument.bind(controller)
);

router.post(
  '/verifications/:verificationId/selfie',
  apiKeyMiddleware,
  upload.single('selfie'),
  controller.uploadSelfie.bind(controller)
);

router.post(
  '/verifications/:verificationId/compare-faces',
  apiKeyMiddleware,
  upload.array('images', 2),
  controller.compareFaces.bind(controller)
);

router.post(
  '/verifications/:verificationId/submit',
  apiKeyMiddleware,
  controller.submitVerification.bind(controller)
);

export default router;

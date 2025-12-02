import { Router } from 'express';
import multer from 'multer';
import { VerificationController } from '../controllers/verification.controller';
import { apiKeyMiddleware } from '../middleware/api-key.middleware';
import { config } from '../config';

const router = Router();
const controller = new VerificationController();

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: config.verification.documentMaxSizeMB * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    if (config.verification.supportedImageFormats.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file format. Use JPEG or PNG.'));
    }
  }
});

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

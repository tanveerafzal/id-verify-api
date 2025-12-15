import { Router } from 'express';
import { PartnerController, upload } from '../controllers/partner.controller';
import { partnerAuthMiddleware } from '../middleware/partner-auth.middleware';

const router = Router();
const controller = new PartnerController();

// Public routes
router.post('/register', controller.register.bind(controller));
router.post('/login', controller.login.bind(controller));
router.post('/forgot-password', controller.forgotPassword.bind(controller));
router.post('/reset-password', controller.resetPassword.bind(controller));
router.get('/tiers', controller.getTiers.bind(controller));
router.get('/:partnerId/public', controller.getPublicPartnerInfo.bind(controller));

// Protected routes
router.get('/profile', partnerAuthMiddleware, controller.getProfile.bind(controller));
router.put('/profile', partnerAuthMiddleware, controller.updateProfile.bind(controller));
router.post('/change-password', partnerAuthMiddleware, controller.changePassword.bind(controller));
router.post('/upload-logo', partnerAuthMiddleware, upload.single('logo'), controller.uploadLogo.bind(controller));
router.post('/upgrade-tier', partnerAuthMiddleware, controller.upgradeTier.bind(controller));
router.get('/usage-stats', partnerAuthMiddleware, controller.getUsageStats.bind(controller));
router.get('/verifications', partnerAuthMiddleware, controller.getVerifications.bind(controller));
router.get('/verifications/:verificationId', partnerAuthMiddleware, controller.getVerificationById.bind(controller));
router.post('/verifications/request', partnerAuthMiddleware, controller.requestVerification.bind(controller));
router.post('/verifications/:verificationId/resend-email', partnerAuthMiddleware, controller.resendVerificationEmail.bind(controller));

export default router;

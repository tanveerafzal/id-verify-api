import { Router } from 'express';
import { AdminController } from '../controllers/admin.controller';
import { adminAuthMiddleware } from '../middleware/admin-auth.middleware';

const router = Router();
const controller = new AdminController();

// Public routes (no auth required)
router.post('/login', controller.login.bind(controller));
router.post('/register', controller.register.bind(controller)); // Consider protecting this in production

// Protected routes (auth required)
// Profile
router.get('/profile', adminAuthMiddleware, controller.getProfile.bind(controller));
router.put('/profile', adminAuthMiddleware, controller.updateProfile.bind(controller));
router.post('/change-password', adminAuthMiddleware, controller.changePassword.bind(controller));

// Dashboard
router.get('/dashboard-stats', adminAuthMiddleware, controller.getDashboardStats.bind(controller));

// Partner Management
router.get('/partners', adminAuthMiddleware, controller.getPartners.bind(controller));
router.post('/partners', adminAuthMiddleware, controller.createPartner.bind(controller));
router.get('/partners/:id', adminAuthMiddleware, controller.getPartnerById.bind(controller));
router.put('/partners/:id', adminAuthMiddleware, controller.updatePartner.bind(controller));
router.delete('/partners/:id', adminAuthMiddleware, controller.deletePartner.bind(controller));
router.post('/partners/:id/toggle-active', adminAuthMiddleware, controller.togglePartnerActive.bind(controller));
router.post('/partners/:id/reset-api-key', adminAuthMiddleware, controller.resetPartnerApiKey.bind(controller));

// Verification Management
router.get('/verifications', adminAuthMiddleware, controller.getVerifications.bind(controller));
router.get('/verifications/:id', adminAuthMiddleware, controller.getVerificationById.bind(controller));
router.post('/verifications/:id/manual-pass', adminAuthMiddleware, controller.manualPassVerification.bind(controller));
router.post('/verifications/:id/manual-fail', adminAuthMiddleware, controller.manualFailVerification.bind(controller));
router.post('/verifications/:id/resend-email', adminAuthMiddleware, controller.resendVerificationEmail.bind(controller));
router.put('/verifications/:id/details', adminAuthMiddleware, controller.updateVerificationDetails.bind(controller));
router.put('/verifications/:id/retry-count', adminAuthMiddleware, controller.updateRetryCount.bind(controller));

export default router;

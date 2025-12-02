import { Router } from 'express';
import { PartnerController } from '../controllers/partner.controller';
import { partnerAuthMiddleware } from '../middleware/partner-auth.middleware';

const router = Router();
const controller = new PartnerController();

// Public routes
router.post('/register', controller.register.bind(controller));
router.post('/login', controller.login.bind(controller));
router.get('/tiers', controller.getTiers.bind(controller));

// Protected routes
router.get('/profile', partnerAuthMiddleware, controller.getProfile.bind(controller));
router.post('/upgrade-tier', partnerAuthMiddleware, controller.upgradeTier.bind(controller));
router.get('/usage-stats', partnerAuthMiddleware, controller.getUsageStats.bind(controller));
router.get('/verifications', partnerAuthMiddleware, controller.getVerifications.bind(controller));

export default router;

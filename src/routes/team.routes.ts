import { Router } from 'express';
import { TeamController } from '../controllers/team.controller';
import { partnerAuthMiddleware } from '../middleware/partner-auth.middleware';

const router = Router();
const controller = new TeamController();

// Public routes (for accepting invitations)
router.get('/invitations/:token', controller.getInvitationInfo.bind(controller));
router.post('/invitations/accept', controller.acceptInvitation.bind(controller));

// Protected routes
router.get('/members', partnerAuthMiddleware, controller.getTeamMembers.bind(controller));
router.get('/roles', partnerAuthMiddleware, controller.getRoles.bind(controller));
router.post('/invitations', partnerAuthMiddleware, controller.sendInvitation.bind(controller));
router.post(
  '/invitations/:invitationId/resend',
  partnerAuthMiddleware,
  controller.resendInvitation.bind(controller)
);
router.delete(
  '/invitations/:invitationId',
  partnerAuthMiddleware,
  controller.cancelInvitation.bind(controller)
);
router.post(
  '/members/:userId/toggle-status',
  partnerAuthMiddleware,
  controller.toggleUserStatus.bind(controller)
);
router.put(
  '/members/:userId/role',
  partnerAuthMiddleware,
  controller.updateUserRole.bind(controller)
);

export default router;

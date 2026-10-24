import { Router } from 'express';
import * as ctrl from '../controllers/auth.controller';
import { requireAuth } from '../middlewares/auth';
import { authLimiter } from '../middlewares/rateLimit';
import { validate } from '../middlewares/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  updateProfileSchema,
} from '../validators/auth.validators';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), asyncHandler(ctrl.register));
router.post('/login', authLimiter, validate(loginSchema), asyncHandler(ctrl.login));
router.post('/refresh', asyncHandler(ctrl.refresh));
router.post('/logout', requireAuth, asyncHandler(ctrl.logout));
router.patch('/change-password', requireAuth, validate(changePasswordSchema), asyncHandler(ctrl.changePassword));
router.get('/me', requireAuth, asyncHandler(ctrl.me));
router.patch('/me', requireAuth, validate(updateProfileSchema), asyncHandler(ctrl.updateMe));

export default router;

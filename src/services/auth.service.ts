import bcrypt from 'bcryptjs';
import { User, type UserDoc } from '../models/user.model';
import { AppError } from '../utils/AppError';
import type {
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
  UpdateProfileInput,
} from '../validators/auth.validators';
import { hashToken, signAccessToken, signRefreshToken, verifyRefreshToken } from './token.service';

const BCRYPT_ROUNDS = 10;

export interface AuthResult {
  user: UserDoc;
  accessToken: string;
  refreshToken: string;
}

async function issueTokens(user: UserDoc): Promise<AuthResult> {
  const id = String(user._id);
  const accessToken = signAccessToken(id, id);
  const refreshToken = signRefreshToken(id);
  await User.updateOne({ _id: user._id }, { refreshTokenHash: hashToken(refreshToken) });
  return { user, accessToken, refreshToken };
}

export async function register(input: RegisterInput): Promise<AuthResult> {
  const exists = await User.exists({ phone: input.phone });
  if (exists) throw AppError.conflict('An account with this phone number already exists');

  const user = await User.create({
    name: input.name,
    shopName: input.shopName,
    phone: input.phone,
    email: input.email,
    preferredLanguage: input.preferredLanguage,
    passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
  });
  return issueTokens(user);
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const user = await User.findOne({ phone: input.phone }).select('+passwordHash');
  const valid = user ? await bcrypt.compare(input.password, user.passwordHash) : false;
  if (!user || !valid) throw AppError.unauthorized('Incorrect phone number or password');
  return issueTokens(user);
}

/** Rotates the refresh token: the old one stops working once a new one is issued. */
export async function refresh(refreshToken: string | undefined): Promise<AuthResult> {
  if (!refreshToken) throw AppError.unauthorized('Session expired, please login again');

  let userId: string;
  try {
    userId = verifyRefreshToken(refreshToken).sub;
  } catch {
    throw AppError.unauthorized('Session expired, please login again');
  }

  const user = await User.findById(userId).select('+refreshTokenHash');
  if (!user || user.refreshTokenHash !== hashToken(refreshToken)) {
    throw AppError.unauthorized('Session expired, please login again');
  }
  return issueTokens(user);
}

export async function logout(userId: string): Promise<void> {
  await User.updateOne({ _id: userId }, { $unset: { refreshTokenHash: 1 } });
}

export async function changePassword(userId: string, input: ChangePasswordInput): Promise<void> {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw AppError.notFound('User not found');
  const valid = await bcrypt.compare(input.currentPassword, user.passwordHash);
  if (!valid) throw AppError.badRequest('Current password is incorrect');
  user.passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);
  await user.save();
}

export async function getProfile(userId: string): Promise<UserDoc> {
  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('User not found');
  return user;
}

export async function updateProfile(userId: string, input: UpdateProfileInput): Promise<UserDoc> {
  const { settings, ...rest } = input;
  const update: Record<string, unknown> = { ...rest };
  if (settings) {
    for (const [k, v] of Object.entries(settings)) update[`settings.${k}`] = v;
  }
  const user = await User.findByIdAndUpdate(userId, { $set: update }, { new: true, runValidators: true });
  if (!user) throw AppError.notFound('User not found');
  return user;
}

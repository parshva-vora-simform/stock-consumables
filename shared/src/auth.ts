import { z } from 'zod';
import { userRole } from './enums.js';

export const loginRequest = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(1, 'Password is required.'),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const refreshRequest = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof refreshRequest>;

export const authTokens = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int(),
});
export type AuthTokens = z.infer<typeof authTokens>;

export const locationSummary = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
});
export type LocationSummary = z.infer<typeof locationSummary>;

export const currentUser = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  role: userRole,
  /**
   * The locations this user may act on. A manager gets every active location;
   * a handler gets only their granted ones. The client uses this to populate
   * location pickers — but the server enforces it independently, so a client
   * that ignores this list gets a 403, not a surprise (AC-3).
   */
  locations: z.array(locationSummary),
});
export type CurrentUser = z.infer<typeof currentUser>;

export const loginResponse = z.object({
  user: currentUser,
  tokens: authTokens,
});
export type LoginResponse = z.infer<typeof loginResponse>;

// --- Password reset -------------------------------------------------------

export const forgotPasswordRequest = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
});
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequest>;

/**
 * Always the same answer, whether or not the address is registered. Telling a
 * caller "no account with that email" turns this endpoint into a way to
 * discover who works here.
 */
export const forgotPasswordResponse = z.object({
  message: z.string(),
  /**
   * The reset link, returned ONLY outside production, where there is no mail
   * provider to deliver it. Never populated in production.
   */
  devResetUrl: z.string().optional(),
});
export type ForgotPasswordResponse = z.infer<typeof forgotPasswordResponse>;

/** Shared by the reset form and the API, so both enforce the same minimum. */
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(200, 'That is longer than necessary.');

export const resetPasswordRequest = z.object({
  token: z.string().min(1, 'This reset link is incomplete.'),
  password: passwordSchema,
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequest>;

export const changePasswordRequest = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  newPassword: passwordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequest>;

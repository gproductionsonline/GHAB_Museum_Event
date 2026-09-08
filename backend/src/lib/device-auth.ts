import crypto from "node:crypto";
import type { Request, RequestHandler } from "express";
import { prisma } from "./prisma.js";
import { sha256, generateCredentialCode } from "./codes.js";
import { asyncHandler, unauthorized, forbidden } from "./http.js";
import type { Device } from "../generated/prisma/client.js";

// Device-scoped credentials (OFFLINE_MODE.md): a check-in device holds only
// its own device token — never a staff/admin session. The token is a bearer
// secret shown once at registration; only its SHA-256 hash is stored.
const DEVICE_TOKEN_PREFIX = "dev_";

export function generateDeviceToken(): string {
  return `${DEVICE_TOKEN_PREFIX}${generateCredentialCode(32).toLowerCase()}`;
}

export function hashDeviceToken(token: string): string {
  return sha256(token.trim());
}

export function isDeviceToken(token: string): boolean {
  return token.startsWith(DEVICE_TOKEN_PREFIX);
}

export function extractDeviceToken(req: Request): string | null {
  const header = req.headers["x-device-token"];
  if (typeof header === "string" && header.length > 0) return header;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ") && isDeviceToken(auth.slice(7))) return auth.slice(7);
  return null;
}

/** Resolves an ACTIVE, unexpired device from its token. */
export async function authenticateDeviceByToken(token: string): Promise<Device> {
  const device = await prisma.device.findUnique({ where: { tokenHash: hashDeviceToken(token) } });
  if (!device) throw unauthorized("Unknown device token");
  if (device.status !== "ACTIVE") throw forbidden("Device is revoked");
  if (device.expiresAt && device.expiresAt < new Date()) {
    throw forbidden("Device authorization has expired");
  }
  return device;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      device?: Device;
    }
  }
}

/** Middleware: the request authenticates as a pre-authorized device. */
export const requireDevice: RequestHandler = asyncHandler(async (req, _res, next) => {
  const token = extractDeviceToken(req);
  if (!token) throw unauthorized("Device token required");
  req.device = await authenticateDeviceByToken(token);
  await prisma.device.update({
    where: { id: req.device.id },
    data: { lastSeenAt: new Date() },
  });
  next();
});

export function newDeviceTokenPair(): { token: string; tokenHash: string } {
  const token = generateDeviceToken();
  return { token, tokenHash: hashDeviceToken(token) };
}

export const DEVICE_TOKEN_REGEXP = /^dev_[a-z0-9]{20,64}$/;
export function isValidDeviceTokenShape(token: string): boolean {
  return DEVICE_TOKEN_REGEXP.test(token);
}

export function randomPassword(): string {
  // Admin password reset helper (M5): readable, random temporary password.
  const raw = crypto.randomBytes(9).toString("base64url"); // 72 bits
  return `Gh-${raw.slice(0, 10)}`;
}

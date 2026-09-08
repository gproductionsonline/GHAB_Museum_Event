import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Request, RequestHandler } from "express";
import { config, type AppUser } from "../config.js";
import { unauthorized, forbidden, asyncHandler } from "./http.js";
import { prisma } from "./prisma.js";

export type PrimaryRole = AppUser["role"];

// Higher rank wins when deriving the single primary role for a user.
export const ROLE_RANK: Record<string, number> = {
  CHECKIN_OPERATOR: 1,
  STAFF: 2,
  ADMIN: 3,
};

export type AuthContext = {
  permissions: Set<string>;
  roles: string[];
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AppUser;
      auth?: AuthContext;
    }
  }
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function primaryRoleOf(roleCodes: string[]): PrimaryRole {
  if (roleCodes.includes("ADMIN")) return "ADMIN";
  if (roleCodes.includes("STAFF")) return "STAFF";
  return "CHECKIN_OPERATOR";
}

export function signToken(user: AppUser): string {
  const maxAgeSeconds =
    user.role === "CHECKIN_OPERATOR"
      ? config.SCANNER_TOKEN_DAYS * 24 * 3600
      : config.ADMIN_TOKEN_HOURS * 3600;
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role, roles: user.roles },
    config.JWT_SECRET,
    { expiresIn: maxAgeSeconds },
  );
}

export function verifyToken(token: string): AppUser {
  let payload: jwt.JwtPayload & {
    sub?: string;
    email?: string;
    name?: string;
    role?: string;
    roles?: string[];
  };
  try {
    payload = jwt.verify(token, config.JWT_SECRET) as jwt.JwtPayload & {
      sub?: string;
      email?: string;
      name?: string;
      role?: string;
      roles?: string[];
    };
  } catch {
    // Malformed, expired, or wrongly-signed tokens are all simply "invalid".
    throw unauthorized("Invalid token");
  }
  if (!payload.sub || !payload.role) throw unauthorized("Invalid token");
  return {
    id: payload.sub,
    email: payload.email ?? "",
    name: payload.name ?? "",
    role: payload.role as AppUser["role"],
    roles: payload.roles ?? [payload.role],
  };
}

/**
 * Loads fresh role/permission data from the database for a user.
 * Authorization is never taken from the token alone: disabling a user or
 * changing their roles takes effect on the next request.
 */
export async function loadAuthContext(userId: string): Promise<AppUser & AuthContext> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
    },
  });
  if (!user || !user.active) throw unauthorized("Session is no longer valid");

  const roleCodes = user.roles.map((ur) => ur.role.code);
  const permissions = new Set<string>();
  for (const ur of user.roles) {
    for (const rp of ur.role.permissions) permissions.add(rp.permission.code);
  }
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: primaryRoleOf(roleCodes),
    roles: roleCodes,
    permissions,
  };
}

export function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  // EventSource cannot set headers; the stats stream authenticates via query.
  const query = req.query.token;
  if (typeof query === "string" && query.length > 0) return query;
  return null;
}

async function authenticate(req: Request): Promise<void> {
  const token = extractToken(req);
  if (!token) throw unauthorized();
  const tokenUser = verifyToken(token);
  const ctx = await loadAuthContext(tokenUser.id);
  req.user = { id: ctx.id, email: ctx.email, name: ctx.name, role: ctx.role, roles: ctx.roles };
  req.auth = { permissions: ctx.permissions, roles: ctx.roles };
}

/** Any authenticated, active user. */
export const requireAuth: RequestHandler = asyncHandler(async (req, _res, next) => {
  await authenticate(req);
  next();
});

/** Requires ALL listed permission codes (server-side RBAC enforcement). */
export function requirePermission(...codes: string[]): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    await authenticate(req);
    const missing = codes.filter((code) => !req.auth!.permissions.has(code));
    if (missing.length > 0) {
      throw forbidden(`Missing permission: ${missing.join(", ")}`);
    }
    next();
  });
}

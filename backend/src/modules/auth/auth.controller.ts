import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { unauthorized, badRequest } from "../../lib/http.js";
import {
  signToken,
  verifyPassword,
  loadAuthContext,
  primaryRoleOf,
} from "../../lib/auth.js";
import { audit } from "../../lib/audit.js";
import type { AppUser } from "../../config.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function login(req: Request, res: Response) {
  const parsed = loginSchema.safeParse(req.body);

  if (!parsed.success) {
    throw badRequest("Email and password are required");
  }

  const user = await prisma.user.findUnique({
    where: {
      email: parsed.data.email.toLowerCase(),
    },
    include: {
      roles: {
        include: {
          role: true,
        },
      },
    },
  });

  if (!user || !user.active) {
    await audit({
      action: "LOGIN_FAILED",
      entityType: "User",
      result: "FAILURE",
      summary: `Failed login attempt for ${parsed.data.email}`,
      requestId: req.requestId,
    });

    // Generic error: no credential enumeration.
    throw unauthorized("Invalid email or password");
  }

  const ok = await verifyPassword(parsed.data.password, user.passwordHash);

  if (!ok) {
    await audit({
      action: "LOGIN_FAILED",
      entityType: "User",
      entityId: user.id,
      result: "FAILURE",
      summary: `Failed login attempt for ${user.email}`,
      requestId: req.requestId,
    });

    throw unauthorized("Invalid email or password");
  }

  const roleCodes = user.roles.map((ur) => ur.role.code);

  const appUser: AppUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: primaryRoleOf(roleCodes),
    roles: roleCodes,
  };

  await prisma.user.update({
    where: {
      id: user.id,
    },
    data: {
      lastLoginAt: new Date(),
    },
  });

  await audit({
    actor: appUser,
    action: "LOGIN",
    entityType: "User",
    entityId: user.id,
    summary: `${user.email} signed in (${appUser.role})`,
    requestId: req.requestId,
  });

  res.json({
    token: signToken(appUser),
    user: appUser,
  });
}

export async function getMe(req: Request, res: Response) {
  const ctx = await loadAuthContext(req.user!.id);

  res.json({
    user: req.user,
    permissions: [...ctx.permissions].sort(),
  });
}

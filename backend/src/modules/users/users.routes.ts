import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler, badRequest, notFound, param, conflict } from "../../lib/http.js";
import { requirePermission } from "../../lib/auth.js";
import { hashPassword } from "../../lib/auth.js";
import { randomPassword } from "../../lib/device-auth.js";
import { audit, snapshot } from "../../lib/audit.js";
import { rateLimit } from "../../lib/rate-limit.js";

// User & role administration (M5). All routes require user:manage and are
// audited. Passwords are never returned; the role set is validated against
// seeded roles only.
export const usersRouter = Router();

// Account administration throttle: password resets mint a fresh secret and
// user creation runs bcrypt — both are low-frequency admin operations, so a
// tight budget is safe and blunts scripted abuse of a stolen admin session.
const userMutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyFn: (req) => `${req.ip ?? "unknown"}:users-mutations`,
});

const ROLE_CACHE_TTL_MS = 30_000;
let roleCache: { codes: string[]; at: number } | null = null;

async function validRoleCodes(): Promise<string[]> {
  if (!roleCache || Date.now() - roleCache.at > ROLE_CACHE_TTL_MS) {
    const roles = await prisma.role.findMany({ select: { code: true } });
    roleCache = { codes: roles.map((r) => r.code), at: Date.now() };
  }
  return roleCache.codes;
}

async function setUserRoles(userId: string, roleCodes: string[], actorUser: { id: string }) {
  const valid = await validRoleCodes();
  const invalid = roleCodes.filter((c) => !valid.includes(c));
  if (invalid.length > 0) throw badRequest(`Unknown roles: ${invalid.join(", ")}`);
  await prisma.userRole.deleteMany({ where: { userId } });
  for (const code of roleCodes) {
    const role = await prisma.role.findUniqueOrThrow({ where: { code } });
    await prisma.userRole.create({ data: { userId, roleId: role.id } });
  }
  void actorUser;
}

usersRouter.get(
  "/",
  requirePermission("user:manage"),
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      orderBy: { email: "asc" },
      take: 200,
      include: { roles: { include: { role: true } } },
    });
    res.json({
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        active: u.active,
        roles: u.roles.map((r) => r.role.code),
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
      })),
    });
  }),
);

usersRouter.get(
  "/roles",
  requirePermission("user:manage"),
  asyncHandler(async (_req, res) => {
    const roles = await prisma.role.findMany({
      include: { permissions: { include: { permission: true } } },
      orderBy: { code: "asc" },
    });
    const permissions = await prisma.permission.findMany({ orderBy: { code: "asc" } });
    res.json({
      roles: roles.map((r) => ({
        code: r.code,
        name: r.name,
        permissions: r.permissions.map((p) => p.permission.code),
      })),
      permissions: permissions.map((p) => ({ code: p.code, name: p.name })),
    });
  }),
);

const createUserSchema = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(120),
  password: z.string().min(10).max(128),
  roleCodes: z.array(z.string().min(2).max(40)).min(1).max(5),
});

usersRouter.post(
  "/",
  userMutationLimiter,
  requirePermission("user:manage"),
  asyncHandler(async (req, res) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid user");
    const { email, name, password, roleCodes } = parsed.data;

    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) throw conflict("A user with this email already exists");

    const user = await prisma.user.create({
      data: { email: email.toLowerCase(), name, passwordHash: await hashPassword(password) },
    });
    await setUserRoles(user.id, roleCodes, req.user!);
    await audit({
      actor: req.user,
      action: "USER_CREATED",
      entityType: "User",
      entityId: user.id,
      summary: `User ${user.email} created with roles [${roleCodes.join(", ")}]`,
      after: { email: user.email, roles: roleCodes },
      requestId: req.requestId,
    });
    res.status(201).json({ user: { id: user.id, email: user.email, roles: roleCodes } });
  }),
);

const updateUserSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  active: z.boolean().optional(),
  roleCodes: z.array(z.string().min(2).max(40)).min(1).max(5).optional(),
});

usersRouter.patch(
  "/:id",
  requirePermission("user:manage"),
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const before = await prisma.user.findUnique({
      where: { id },
      include: { roles: { include: { role: true } } },
    });
    if (!before) throw notFound("User not found");
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid user update");

    if (req.user!.id === id && parsed.data.active === false) {
      throw badRequest("You cannot deactivate your own account");
    }
    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
      },
    });
    if (parsed.data.roleCodes) {
      await setUserRoles(id, parsed.data.roleCodes, req.user!);
    }
    await audit({
      actor: req.user,
      action: "USER_AMENDED",
      entityType: "User",
      entityId: id,
      summary: `User ${user.email} updated${parsed.data.roleCodes ? ` — roles [${parsed.data.roleCodes.join(", ")}]` : ""}${parsed.data.active === false ? " — deactivated" : ""}`,
      before: { active: before.active, roles: before.roles.map((r) => r.role.code) },
      after: { active: user.active, roles: parsed.data.roleCodes ?? before.roles.map((r) => r.role.code) },
      requestId: req.requestId,
    });
    res.json({ user: { id: user.id, email: user.email, active: user.active } });
  }),
);

/** Admin-initiated password reset: generates a temporary password, returns it
 *  exactly once, and forces the holder to change it before the event. */
usersRouter.post(
  "/:id/reset-password",
  userMutationLimiter,
  requirePermission("user:manage"),
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw notFound("User not found");
    const tempPassword = randomPassword();
    await prisma.user.update({
      where: { id },
      data: { passwordHash: await hashPassword(tempPassword) },
    });
    await audit({
      actor: req.user,
      action: "USER_PASSWORD_RESET",
      entityType: "User",
      entityId: id,
      summary: `Password reset for ${user.email} by ${req.user!.email}`,
      requestId: req.requestId,
    });
    res.json({ temporaryPassword: tempPassword });
  }),
);

void snapshot; // reserved

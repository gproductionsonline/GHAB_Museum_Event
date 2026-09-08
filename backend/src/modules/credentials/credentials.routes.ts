import { Router } from "express";
import { z } from "zod";
import { asyncHandler, badRequest, param } from "../../lib/http.js";
import { requirePermission } from "../../lib/auth.js";
import { prisma } from "../../lib/prisma.js";
import { rateLimit } from "../../lib/rate-limit.js";
import { bulkIssueAndEmail, credentialQrPng } from "./credentials.service.js";

export const credentialsRouter = Router();

// Bulk email is an expensive fan-out (credential issuance + up to 500 queued
// deliveries per call); a double-clicked or scripted caller must not multiply
// the email worker's workload.
const bulkEmailLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

// QR rendering is CPU work (PNG generation) — bounded per IP, not per guest id.
const qrLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyFn: (req) => `${req.ip ?? "unknown"}:qr-png`,
});

/**
 * Bulk operation: issue any missing credentials and email confirmed primary
 * guests. Optional `guestIds` restricts the operation to an admin selection.
 * Every attempt is recorded in EmailDelivery with an idempotency key, so
 * re-running the operation never duplicates a delivery for the same
 * credential version.
 */
credentialsRouter.post(
  "/bulk-email",
  bulkEmailLimiter,
  requirePermission("credential:issue", "email:send"),
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        eventId: z.string(),
        guestIds: z.array(z.string().uuid()).max(500).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid bulk email request");
    const result = await bulkIssueAndEmail(parsed.data.eventId, req.user!, parsed.data.guestIds);
    res.json(result);
  }),
);

/** Render the guest's active QR as PNG (controlled re-display, admin-only). */
credentialsRouter.get(
  "/:guestId/qr.png",
  qrLimiter,
  requirePermission("credential:read"),
  asyncHandler(async (req, res) => {
    const { code, png } = await credentialQrPng(param(req, "guestId"));
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `inline; filename="credential-${code.slice(-4)}.png"`);
    res.send(png);
  }),
);

/** Guests whose credentials are pending email (used by the bulk-email UI). */
credentialsRouter.get(
  "/pending",
  requirePermission("guest:read"),
  asyncHandler(async (req, res) => {
    const eventId = z.string().parse(req.query.eventId ?? "");
    const guests = await prisma.guest.findMany({
      where: {
        eventId,
        parentId: null,
        rsvpStatus: { code: "CONFIRMED" },
        OR: [{ email: null }, { activeCredentialId: null }, { credential: { emailDeliveries: { none: { status: "SENT" } } } }],
      },
      orderBy: { lastName: "asc" },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        displayName: true,
        email: true,
        credential: { select: { status: true, codeLast4: true } },
      },
    });
    res.json({ guests });
  }),
);

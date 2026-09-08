import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler, badRequest } from "../../lib/http.js";
import { requirePermission } from "../../lib/auth.js";
import {
  extractDeviceToken,
  authenticateDeviceByToken,
} from "../../lib/device-auth.js";
import { prisma } from "../../lib/prisma.js";
import { rateLimit } from "../../lib/rate-limit.js";
import { buildSnapshot, syncBatchSchema, applySyncBatch } from "./sync.service.js";

export const syncRouter = Router();

// Snapshot builds serialize the event's whole admission dataset; a polling
// loop or misbehaving device must not monopolize that work.
const snapshotLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

/**
 * Combined authorization for sync endpoints: a pre-authorized DEVICE TOKEN
 * (primary path — devices never hold staff credentials) or a user token with
 * checkin:operate (compat path; the named device must be pre-registered).
 */
const syncAuth: RequestHandler = asyncHandler(async (req, res, next) => {
  const deviceToken = extractDeviceToken(req);
  if (deviceToken) {
    req.device = await authenticateDeviceByToken(deviceToken);
    await prisma.device.update({ where: { id: req.device.id }, data: { lastSeenAt: new Date() } });
    return next();
  }
  return requirePermission("checkin:operate")(req, res, next);
});

/** Offline package download: event-scoped minimum admission dataset. */
syncRouter.get(
  "/snapshot",
  snapshotLimiter,
  syncAuth,
  asyncHandler(async (req, res) => {
    // Device tokens are bound to one event; user tokens must specify it.
    const eventId = req.device
      ? req.device.eventId
      : z.string().parse(req.query.eventId ?? "");
    const snapshot = await buildSnapshot(eventId);
    const clientVersion = typeof req.query.version === "string" ? req.query.version : null;
    if (clientVersion && clientVersion === snapshot.version) {
      res.status(304).json({ version: snapshot.version, unchanged: true });
      return;
    }
    res.json(snapshot);
  }),
);

const syncLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

/** Idempotent batch reconciliation of a device's offline check-in queue. */
syncRouter.post(
  "/checkins",
  syncLimiter,
  syncAuth,
  asyncHandler(async (req, res) => {
    const parsed = syncBatchSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid sync batch");
    const result = await applySyncBatch(parsed.data, req.user ?? null, req.device ?? null);
    res.json(result);
  }),
);

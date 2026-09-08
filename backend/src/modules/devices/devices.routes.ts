import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler, badRequest, notFound, param } from "../../lib/http.js";
import { requirePermission } from "../../lib/auth.js";
import { requireDevice, newDeviceTokenPair } from "../../lib/device-auth.js";
import { audit, snapshot } from "../../lib/audit.js";
import { rateLimit } from "../../lib/rate-limit.js";

// Device lifecycle (OFFLINE_MODE.md "Provisioning"): devices are
// PRE-AUTHORIZED by an administrator. A device token is returned exactly
// once at registration; only its hash is stored. Revocation blocks future
// provisioning and sync immediately.
export const devicesRouter = Router();

// Token issuance is security-sensitive: a bounded rate keeps a compromised
// admin session from mass-minting device tokens.
const deviceMutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyFn: (req) => `${req.ip ?? "unknown"}:devices-mutations`,
});

const registerSchema = z.object({
  eventId: z.string(),
  name: z.string().min(1).max(100),
  deviceType: z.enum(["PHONE", "TABLET", "KIOSK"]).optional(),
  expiresInHours: z.coerce.number().int().min(1).max(24 * 30).optional(),
});

devicesRouter.post(
  "/",
  deviceMutationLimiter,
  requirePermission("device:manage"),
  asyncHandler(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid device");
    const { eventId, name, deviceType, expiresInHours } = parsed.data;

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) throw notFound("Event not found");
    const existing = await prisma.device.findFirst({ where: { eventId, name } });
    if (existing) throw badRequest(`A device named "${name}" already exists for this event`);

    const { token, tokenHash } = newDeviceTokenPair();
    const device = await prisma.device.create({
      data: {
        eventId,
        name,
        deviceType: deviceType ?? null,
        tokenHash,
        status: "ACTIVE",
        expiresAt: expiresInHours ? new Date(Date.now() + expiresInHours * 3600 * 1000) : null,
      },
    });
    await audit({
      actor: req.user,
      eventId,
      deviceId: device.id,
      action: "DEVICE_REGISTERED",
      entityType: "Device",
      entityId: device.id,
      summary: `Check-in device "${name}" registered${expiresInHours ? ` (expires in ${expiresInHours}h)` : ""}`,
      after: { id: device.id, name, status: device.status },
      requestId: req.requestId,
    });
    // The token is shown exactly once.
    res.status(201).json({
      device: { id: device.id, publicId: device.publicId, name: device.name, status: device.status, expiresAt: device.expiresAt },
      token,
    });
  }),
);

devicesRouter.get(
  "/",
  requirePermission("device:manage"),
  asyncHandler(async (req, res) => {
    const eventId = typeof req.query.eventId === "string" ? req.query.eventId : null;
    const devices = await prisma.device.findMany({
      where: eventId ? { eventId } : undefined,
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { _count: { select: { offlineCheckIns: true } } },
    });
    res.json({
      devices: devices.map((d) => ({
        id: d.id,
        publicId: d.publicId,
        name: d.name,
        deviceType: d.deviceType,
        status: d.status,
        expiresAt: d.expiresAt,
        lastSeenAt: d.lastSeenAt,
        createdAt: d.createdAt,
        offlineCheckInCount: d._count.offlineCheckIns,
      })),
    });
  }),
);

/** Device-authenticated self-info: used by the scanner setup screen. */
devicesRouter.get(
  "/me",
  requireDevice,
  asyncHandler(async (req, res) => {
    const device = req.device!;
    const event = await prisma.event.findUniqueOrThrow({
      where: { id: device.eventId },
      include: { gates: { where: { active: true }, orderBy: { sort: "asc" } } },
    });
    res.json({
      device: {
        id: device.id,
        publicId: device.publicId,
        name: device.name,
        deviceType: device.deviceType,
        status: device.status,
        expiresAt: device.expiresAt,
      },
      event: { id: event.id, name: event.name, gates: event.gates },
    });
  }),
);

devicesRouter.post(
  "/:id/revoke",
  deviceMutationLimiter,
  requirePermission("device:manage"),
  asyncHandler(async (req, res) => {
    const device = await prisma.device.findUnique({ where: { id: param(req, "id") } });
    if (!device) throw notFound("Device not found");
    if (device.status === "REVOKED") throw badRequest("Device is already revoked");
    const updated = await prisma.device.update({
      where: { id: device.id },
      data: { status: "REVOKED" },
    });
    await audit({
      actor: req.user,
      eventId: device.eventId,
      deviceId: device.id,
      action: "DEVICE_REVOKED",
      entityType: "Device",
      entityId: device.id,
      summary: `Check-in device "${device.name}" revoked`,
      before: { status: device.status },
      after: { status: updated.status },
      requestId: req.requestId,
    });
    res.json({ device: { id: updated.id, status: updated.status } });
  }),
);

/**
 * Per-device sync history (device management UI): the device's retained
 * offline operations with their reconciliation results. Evidence rows are
 * kept even for rejected operations (OFFLINE_MODE.md); no code hashes or
 * other secret material is returned.
 */
devicesRouter.get(
  "/:id/sync-history",
  requirePermission("device:manage"),
  asyncHandler(async (req, res) => {
    const device = await prisma.device.findUnique({ where: { id: param(req, "id") } });
    if (!device) throw notFound("Device not found");
    const operations = await prisma.offlineCheckIn.findMany({
      where: { deviceId: device.id },
      orderBy: { receivedAt: "desc" },
      take: 100,
      include: { checkIn: { select: { id: true, scannedAt: true, gate: true } } },
    });
    res.json({
      device: { id: device.id, name: device.name, status: device.status },
      operations: operations.map((o) => ({
        id: o.id,
        operationId: o.operationId,
        status: o.status,
        resultDetail: o.resultDetail,
        gate: o.gate,
        clientTimestamp: o.clientTimestamp,
        receivedAt: o.receivedAt,
        checkInId: o.checkInId,
        checkIn: o.checkIn ? { scannedAt: o.checkIn.scannedAt, gate: o.checkIn.gate } : null,
      })),
    });
  }),
);

devicesRouter.post(
  "/:id/activate",
  deviceMutationLimiter,
  requirePermission("device:manage"),
  asyncHandler(async (req, res) => {
    const device = await prisma.device.findUnique({ where: { id: param(req, "id") } });
    if (!device) throw notFound("Device not found");
    const updated = await prisma.device.update({
      where: { id: device.id },
      data: { status: "ACTIVE" },
    });
    await audit({
      actor: req.user,
      eventId: device.eventId,
      deviceId: device.id,
      action: "DEVICE_ACTIVATED",
      entityType: "Device",
      entityId: device.id,
      summary: `Check-in device "${device.name}" activated`,
      before: { status: device.status },
      after: { status: updated.status },
      requestId: req.requestId,
    });
    res.json({ device: { id: updated.id, status: updated.status } });
  }),
);

void snapshot; // reserved for future device detail snapshots

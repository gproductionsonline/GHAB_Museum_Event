import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler, badRequest } from "../../lib/http.js";
import { requirePermission } from "../../lib/auth.js";

// Email delivery history (M5): admin visibility into the delivery queue,
// retries, and failures. Read-only; retries are driven by the email worker's
// bounded schedule.
export const emailRouter = Router();

emailRouter.get(
  "/deliveries",
  requirePermission("email:send"),
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        eventId: z.string().optional(),
        status: z.enum(["QUEUED", "SENDING", "SENT", "FAILED"]).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(50),
      })
      .safeParse(req.query);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid delivery query");
    const q = parsed.data;
    const where = {
      ...(q.eventId ? { guest: { eventId: q.eventId } } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const [total, deliveries] = await Promise.all([
      prisma.emailDelivery.count({ where }),
      prisma.emailDelivery.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { guest: { select: { firstName: true, lastName: true, displayName: true } } },
      }),
    ]);
    res.json({
      total,
      page: q.page,
      pageSize: q.pageSize,
      deliveries: deliveries.map((d) => ({
        id: d.id,
        recipient: d.recipient,
        guest: d.guest.displayName ?? `${d.guest.firstName} ${d.guest.lastName}`,
        status: d.status,
        attempts: d.attempts,
        nextAttemptAt: d.nextAttemptAt,
        error: d.error,
        sentAt: d.sentAt,
        createdAt: d.createdAt,
      })),
    });
  }),
);

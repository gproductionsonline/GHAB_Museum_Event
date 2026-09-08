import { Request, Response } from "express";
import { z } from "zod";

import { prisma } from "../../lib/prisma.js";
import { badRequest } from "../../lib/http.js";

const auditQuerySchema = z.object({
  eventId: z.string().optional(),
  action: z.string().max(80).optional(),
  entityType: z.string().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export async function getAuditLogs(req: Request, res: Response) {
  const parsed = auditQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? "Invalid audit query");
  }

  const q = parsed.data;

  const where = {
    ...(q.eventId
      ? {
          OR: [{ eventId: q.eventId }, { eventId: null }],
        }
      : {}),
    ...(q.action ? { action: q.action } : {}),
    ...(q.entityType ? { entityType: q.entityType } : {}),
  };

  const [total, logs] = await Promise.all([
    prisma.auditLog.count({ where }),

    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
  ]);

  res.json({
    total,
    page: q.page,
    pageSize: q.pageSize,
    logs: logs.map((l) => ({
      id: l.id,
      at: l.createdAt,
      actor: l.actorLabel,
      action: l.action,
      result: l.result,
      entityType: l.entityType,
      entityId: l.entityId,
      eventId: l.eventId,
      summary: l.summary,
    })),
  });
}

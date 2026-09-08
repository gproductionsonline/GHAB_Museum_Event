import type { Request, Response } from "express";
import { z } from "zod";

import { badRequest } from "../../lib/http.js";
import { prisma } from "../../lib/prisma.js";
import { sha256 } from "../../lib/codes.js";
import { extractCode } from "../credentials/credentials.service.js";
import { attemptCheckIn } from "./checkin.service.js";
import { undoCheckIn as undoCheckInService } from "./checkin.service.js";
const scanSchema = z.object({
  eventId: z.string(),
  code: z.string().min(4).max(80),
  gate: z.string().max(100).nullish(),
  deviceName: z.string().max(100).nullish(),
  clientTimestamp: z.string().datetime().optional(),
  operationId: z.string().min(8).max(64).optional(),
});

const manualSchema = z.object({
  eventId: z.string(),
  guestId: z.string(),
  gate: z.string().max(100).nullish(),
  deviceName: z.string().max(100).nullish(),
  operationId: z.string().min(8).max(64).optional(),
});

export async function scanCheckIn(req: Request, res: Response) {
  const parsed = scanSchema.safeParse(req.body);

  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? "Invalid scan payload");
  }

  const { code, ...rest } = parsed.data;

  const outcome = await attemptCheckIn({
    ...rest,
    clientTimestamp: rest.clientTimestamp
      ? new Date(rest.clientTimestamp)
      : null,
    method: "QR",
    codeHash: sha256(extractCode(code)),
    actor: req.user ?? null,
  });

  res.json(outcome);
}

export async function manualCheckIn(req: Request, res: Response) {
  const parsed = manualSchema.safeParse(req.body);

  if (!parsed.success) {
    throw badRequest(
      parsed.error.issues[0]?.message ?? "Invalid manual check-in",
    );
  }

  const outcome = await attemptCheckIn({
    ...parsed.data,
    method: "MANUAL",
    actor: req.user ?? null,
  });

  res.json(outcome);
}

export async function undoCheckIn(req: Request, res: Response) {
  const checkInId = z.string().parse(req.body?.checkInId);

  const result = await undoCheckInService(checkInId, req.user!);

  res.json(result);
}

export async function getRecentCheckIns(req: Request, res: Response) {
  const eventId = z.string().parse(req.query.eventId ?? "");

  const limit = Math.min(Number(req.query.limit ?? 30) || 30, 100);

  const checkIns = await prisma.checkIn.findMany({
    where: {
      eventId,
    },
    orderBy: {
      scannedAt: "desc",
    },
    take: limit,
    include: {
      guest: {
        include: {
          category: true,
        },
      },
      device: true,
    },
  });

  res.json({
    checkIns: checkIns.map((c) => ({
      id: c.id,
      guestId: c.guestId,
      guest: c.guest.displayName ?? `${c.guest.firstName} ${c.guest.lastName}`,
      category: c.guest.category.code,
      method: c.method,
      gate: c.gate,
      deviceName: c.device?.name ?? null,
      scannedAt: c.scannedAt,
      clientTimestamp: c.clientTimestamp,
    })),
  });
}

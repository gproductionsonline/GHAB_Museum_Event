import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler, unauthorized } from "../../lib/http.js";
import { requirePermission, extractToken, verifyToken, loadAuthContext } from "../../lib/auth.js";
import { computeStats } from "./stats.service.js";
import { addSseClient, sseSend, startHeartbeat } from "../../lib/sse.js";
import { rateLimit } from "../../lib/rate-limit.js";

export const statsRouter = Router();

// Each SSE connection is a long-lived socket; a client that reconnect-loops
// must not accumulate connections. Normal dashboards hold one stream.
const streamLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

statsRouter.get(
  "/",
  requirePermission("guest:read"),
  asyncHandler(async (req, res) => {
    const eventId = z.string().parse(req.query.eventId ?? "");
    res.json(await computeStats(eventId));
  }),
);

/** SSE stream of live attendance. EventSource cannot set headers, so the
 *  token travels as ?token=. Authorization is FRESH from the database (audit
 *  M-5): a deactivated user, or a user whose permissions were removed, loses
 *  stream access on their next connection — the JWT payload alone is never
 *  trusted. Access requires the guest:read permission, consistent with the
 *  JSON stats endpoint (no role heuristics). */
statsRouter.get("/stream", streamLimiter, asyncHandler(async (req: Request, res: Response) => {
  const token = extractToken(req);
  if (!token) throw unauthorized();
  const payload = verifyToken(token);
  const ctx = await loadAuthContext(payload.id);
  if (!ctx.permissions.has("guest:read")) throw unauthorized();
  const eventId = z.string().parse(req.query.eventId ?? "");

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  sseSend(res, "hello", { eventId, at: new Date().toISOString() });
  addSseClient(res, eventId);

  const stats = await computeStats(eventId);
  sseSend(res, "stats", stats);
}));

startHeartbeat();

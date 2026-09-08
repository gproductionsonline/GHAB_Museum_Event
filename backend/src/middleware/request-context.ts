import crypto from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { logger } from "../lib/logger.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

/**
 * Assigns a correlation ID to every request (honoring an inbound
 * X-Request-Id) and emits one structured access-log line on completion.
 * Only safe fields are logged; never bodies, tokens, or credentials.
 */
export function requestContext(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const inbound = req.headers["x-request-id"];
    const requestId =
      typeof inbound === "string" && /^[a-zA-Z0-9-]{8,64}$/.test(inbound)
        ? inbound
        : crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);

    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      logger.info("http_request", {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        userId: req.user?.id,
      });
    });

    next();
  };
}

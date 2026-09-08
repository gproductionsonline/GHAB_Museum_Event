import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { config } from "../config.js";
import { HttpError } from "../lib/http.js";
import { logger } from "../lib/logger.js";

const CODE_BY_STATUS: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  422: "VALIDATION_ERROR",
  429: "RATE_LIMITED",
  500: "INTERNAL_ERROR",
  503: "UNAVAILABLE",
};

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: "Not found",
      requestId: req.requestId,
      details: [],
    },
  });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.requestId;

  // Upload-limit violations (audit M-4): oversized files must surface as a
  // clean 413, not an opaque 500.
  if (err instanceof multer.MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "The uploaded file is too large. Maximum size is 5 MB."
        : "The upload was rejected.";
    res.status(413).json({
      error: { code: "PAYLOAD_TOO_LARGE", message, requestId, details: [] },
    });
    return;
  }

  if (err instanceof HttpError) {
    if (err.status >= 500) {
      logger.error("request_failed", { requestId, status: err.status, error: err.message });
    }
    res.status(err.status).json({
      error: {
        code: err.code ?? CODE_BY_STATUS[err.status] ?? "ERROR",
        message: err.message,
        requestId,
        details: [],
      },
    });
    return;
  }

  // Never expose stack traces, SQL errors, or internals to clients.
  logger.error("request_failed", {
    requestId,
    status: 500,
    error: err instanceof Error ? err.message : String(err),
    stack: config.isProd ? undefined : err instanceof Error ? err.stack : undefined,
  });

  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
      requestId,
      details: [],
    },
  });
}

import { Router } from "express";

import { asyncHandler } from "../../lib/http.js";
import { requirePermission } from "../../lib/auth.js";
import { rateLimit } from "../../lib/rate-limit.js";
import {
  scanCheckIn,
  manualCheckIn,
  undoCheckIn,
  getRecentCheckIns,
} from "./checkin.controller.js";

// Gate-operation rate limit: generous enough that normal entrance flow never
// trips it, tight enough to blunt QR token guessing and request floods.
const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
});

// Undo is a correction workflow, not an entrance flow — bounded separately so
// a stuck client cannot churn attendance history.
const undoLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

export const checkinRouter = Router();

checkinRouter.post(
  "/scan",
  scanLimiter,
  requirePermission("checkin:operate"),
  asyncHandler(scanCheckIn),
);

checkinRouter.post(
  "/manual",
  scanLimiter,
  requirePermission("checkin:operate"),
  asyncHandler(manualCheckIn),
);

checkinRouter.post(
  "/undo",
  undoLimiter,
  requirePermission("checkin:void"),
  asyncHandler(undoCheckIn),
);

checkinRouter.get(
  "/recent",
  requirePermission("checkin:operate"),
  asyncHandler(getRecentCheckIns),
);

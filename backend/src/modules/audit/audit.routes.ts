import { Router } from "express";

import { asyncHandler } from "../../lib/http.js";
import { requirePermission } from "../../lib/auth.js";
import { getAuditLogs } from "./audit.controller.js";

// Audit log viewer (M5): paginated JSON read access to the append-only trail.
// No update/delete routes exist by design (SECURITY.md audit integrity).

export const auditRouter = Router();

auditRouter.get(
  "/",
  requirePermission("audit:read"),
  asyncHandler(getAuditLogs),
);
